import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api';
import {
  EditLockController,
  HEARTBEAT_MS,
  lockedBy,
  type EditLock,
  type LockState,
} from './editLock';

const lock = (userName: string, mine: boolean): EditLock => ({
  userId: 'usr_1',
  userName,
  acquiredAt: '2026-11-13T02:00:00.000Z',
  lastSeenAt: '2026-11-13T02:00:00.000Z',
  expiresAt: '2026-11-13T02:10:00.000Z',
  mine,
});
const taken = (name: string) =>
  new ApiError({
    type: '',
    title: '',
    status: 409,
    code: 'order_locked_by_user',
    editLock: lock(name, false),
  } as never);

/** ST3-T08: ขอล็อกเมื่อเปิด · heartbeat เฉพาะเมื่อมีกิจกรรม · ปลดเมื่อปิด · ผู้อื่นถือ = อ่านอย่างเดียว */
describe('EditLockController', () => {
  let states: LockState[];
  const flush = () => vi.advanceTimersByTimeAsync(0);
  beforeEach(() => {
    vi.useFakeTimers();
    states = [];
  });
  afterEach(() => vi.useRealTimers());

  it('ขอล็อกตอนเปิด → mine; heartbeat ทุก 60 วิ เฉพาะเมื่อมีกิจกรรม; ปิด → ปลด', async () => {
    const acquire = vi.fn().mockResolvedValue(lock('ฉัน', true));
    const release = vi.fn().mockResolvedValue(undefined);
    const c = new EditLockController({ acquire, release }, (s) => states.push(s));
    c.start();
    await flush();
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(c.state.kind).toBe('mine');
    // ไม่มีกิจกรรม → ไม่ต่ออายุ (server ปล่อยเองเมื่อครบ 10 นาที)
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    expect(acquire).toHaveBeenCalledTimes(1);
    // มีกิจกรรม → ต่ออายุรอบถัดไปครั้งเดียว
    c.activity();
    c.activity();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(acquire).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(acquire).toHaveBeenCalledTimes(2);
    c.stop(true);
    expect(release).toHaveBeenCalledWith(true);
    // หยุดแล้วไม่มี heartbeat อีก
    c.activity();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it('ผู้อื่นถืออยู่ → other (อ่านอย่างเดียว) ไม่ปลดตอนปิด; ลองใหม่ทุกรอบจนได้ล็อก', async () => {
    const acquire = vi
      .fn()
      .mockRejectedValueOnce(taken('สมชาย'))
      .mockRejectedValueOnce(taken('สมชาย'))
      .mockResolvedValue(lock('ฉัน', true));
    const release = vi.fn().mockResolvedValue(undefined);
    const c = new EditLockController({ acquire, release }, (s) => states.push(s));
    c.start();
    await flush();
    expect(c.state).toMatchObject({ kind: 'other', lock: { userName: 'สมชาย' } });
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(c.state.kind).toBe('other');
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(c.state.kind).toBe('mine');
    expect(acquire).toHaveBeenCalledTimes(3);
  });

  it('heartbeat ได้ 409 (ถูกปลด/หมดอายุแล้วคนอื่นเอาไป) → other และปิดแล้วไม่ปลดของคนอื่น', async () => {
    const acquire = vi
      .fn()
      .mockResolvedValueOnce(lock('ฉัน', true))
      .mockRejectedValue(taken('ผู้จัดการ'));
    const release = vi.fn().mockResolvedValue(undefined);
    const c = new EditLockController({ acquire, release }, (s) => states.push(s));
    c.start();
    await flush();
    c.activity();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(c.state).toMatchObject({ kind: 'other', lock: { userName: 'ผู้จัดการ' } });
    c.stop();
    expect(release).not.toHaveBeenCalled();
  });

  it('ขอไม่สำเร็จด้วยเหตุอื่น → free (แก้ต่อได้ server ตรวจตอนบันทึก)', async () => {
    const acquire = vi.fn().mockRejectedValue(new Error('network'));
    const c = new EditLockController({ acquire, release: vi.fn() }, (s) => states.push(s));
    c.start();
    await flush();
    expect(c.state.kind).toBe('free');
    c.stop();
  });

  it('ปิดฟอร์มก่อนได้ผลการขอ → ปลดทันทีเมื่อได้ล็อก (ไม่ค้าง 10 นาที)', async () => {
    let resolve!: (l: EditLock) => void;
    const acquire = vi.fn(() => new Promise<EditLock>((r) => (resolve = r)));
    const release = vi.fn().mockResolvedValue(undefined);
    const c = new EditLockController({ acquire, release }, (s) => states.push(s));
    c.start();
    c.stop(true);
    expect(release).not.toHaveBeenCalled();
    resolve(lock('ฉัน', true));
    await flush();
    expect(release).toHaveBeenCalledWith(true);
    expect(states).toEqual([]);
  });

  it('lockedBy อ่านผู้ถือจาก problem 409 เท่านั้น', () => {
    expect(lockedBy(taken('สมชาย'))?.userName).toBe('สมชาย');
    expect(lockedBy(new Error('x'))).toBeNull();
  });
});
