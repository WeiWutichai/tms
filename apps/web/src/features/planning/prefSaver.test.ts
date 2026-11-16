import { describe, expect, it, vi } from 'vitest';
import { createPrefSaver, type PrefBody, type PrefValue } from './prefSaver';

const ALL = ['ORDER_NO', 'CUSTOMER', 'TIME', 'ROUTE', 'WEIGHT'];
const P412 = Object.assign(new Error('precondition_failed'), { problem: { status: 412 } });
const P500 = Object.assign(new Error('internal_error'), { problem: { status: 500 } });

/** server จำลอง: version + If-Match ตามจริง */
function harness(start: PrefValue | undefined) {
  const srv = { value: start ? { ...start } : { view: 'FLEET', cardFields: ALL, version: 0 } };
  let cache = start;
  const calls: { body: PrefBody; version: number | undefined }[] = [];
  const gate: (() => void)[] = [];
  let hold = false;
  const put = vi.fn(async (body: PrefBody, version: number | undefined) => {
    calls.push({ body, version });
    if (hold) await new Promise<void>((r) => gate.push(r));
    if (version !== undefined && version !== srv.value.version) throw P412;
    srv.value = { ...body, version: srv.value.version + 1 };
    return { ...srv.value };
  });
  const fail = vi.fn();
  const saver = createPrefSaver({
    put,
    get: async () => ({ ...srv.value }),
    read: () => cache,
    write: (v) => (cache = v),
    fail,
    fallback: { view: 'FLEET', cardFields: ALL, version: 0 },
  });
  return {
    srv,
    calls,
    put,
    fail,
    saver,
    cache: () => cache,
    hold: (h: boolean) => (hold = h),
    release: () => gate.splice(0).forEach((r) => r()),
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('createPrefSaver (ST3-T13 review/QA)', () => {
  it('กดรัว ๆ: ทีละคำขอ รวมเป็นค่าล่าสุด และใช้ version จากคำตอบก่อนหน้า — ไม่ 412', async () => {
    const h = harness({ view: 'FLEET', cardFields: ALL, version: 3 });
    h.srv.value.version = 3;
    h.hold(true);
    const done = h.saver.save({ view: 'VEHICLE', cardFields: ALL });
    h.saver.save({ view: 'DRIVER', cardFields: ALL });
    h.saver.save({ view: 'CARRIER', cardFields: ['ORDER_NO'] });
    expect(h.cache()?.view).toBe('CARRIER'); // แสดงผลทันที
    h.hold(false);
    h.release();
    await done;
    expect(h.calls.map((c) => [c.body.view, c.version])).toEqual([
      ['VEHICLE', 3],
      ['CARRIER', 4],
    ]);
    expect(h.srv.value).toEqual({ view: 'CARRIER', cardFields: ['ORDER_NO'], version: 5 });
    expect(h.cache()).toEqual(h.srv.value);
    expect(h.fail).not.toHaveBeenCalled();
  });

  it('อีกแท็บบันทึกไปก่อน (412) → อ่านใหม่แล้วลองซ้ำด้วยค่าของผู้ใช้ — สำเร็จไม่แจ้ง', async () => {
    const h = harness({ view: 'FLEET', cardFields: ALL, version: 1 });
    h.srv.value = { view: 'DRIVER', cardFields: ALL, version: 2 }; // แท็บอื่น
    await h.saver.save({ view: 'VEHICLE', cardFields: ALL });
    expect(h.calls.map((c) => c.version)).toEqual([1, 2]);
    expect(h.srv.value.view).toBe('VEHICLE');
    expect(h.cache()?.view).toBe('VEHICLE');
    expect(h.fail).not.toHaveBeenCalled();
  });

  it('ลองซ้ำแล้วยัง 412 → ย้อน UI เป็นค่าที่ server ยืนยัน + แจ้งว่าเปลี่ยนจากที่อื่น', async () => {
    const h = harness({ view: 'FLEET', cardFields: ALL, version: 1 });
    h.put.mockRejectedValue(P412);
    h.srv.value = { view: 'DRIVER', cardFields: ALL, version: 2 };
    await h.saver.save({ view: 'VEHICLE', cardFields: ALL });
    expect(h.put).toHaveBeenCalledTimes(2);
    expect(h.cache()).toEqual({ view: 'DRIVER', cardFields: ALL, version: 2 });
    expect(h.fail).toHaveBeenCalledWith(true);
  });

  it('โหลดค่าไม่สำเร็จ (ไม่มี cache) → บันทึกแบบไม่ส่ง If-Match · ล้มเหลว → ย้อนเป็นค่าเริ่มต้น + แจ้ง', async () => {
    const ok = harness(undefined);
    await ok.saver.save({ view: 'VEHICLE', cardFields: ALL });
    expect(ok.calls[0]!.version).toBeUndefined();
    expect(ok.cache()?.view).toBe('VEHICLE');

    const bad = harness(undefined);
    bad.put.mockRejectedValue(P500);
    await bad.saver.save({ view: 'VEHICLE', cardFields: ALL });
    expect(bad.put).toHaveBeenCalledTimes(1);
    expect(bad.cache()).toEqual({ view: 'FLEET', cardFields: ALL, version: 0 });
    expect(bad.fail).toHaveBeenCalledWith(false);
    await tick();
  });
});
