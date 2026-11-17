import { describe, expect, it } from 'vitest';
import { reasonRule, stepActions, timeError, type TripStop } from './tripStepper';

/** ST4-T04 ตรรกะ stepper: ปุ่มตามสถานะจุด, "ออกจากจุด" = DEPART ของจุดถัดไป, ตรวจเวลา, หมวดเหตุผล */
const st = (id: string, status: string) => ({ id, status }) as TripStop;

describe('stepActions', () => {
  const stops = [st('a', 'COMPLETED'), st('b', 'PENDING'), st('c', 'ARRIVED'), st('d', 'FAILED')];

  it('จุดรอดำเนินการ: ถึงจุด / ปิดงาน / ส่งไม่สำเร็จ · ถึงแล้ว: ปิดงานอย่างเดียว', () => {
    expect(stepActions(stops, [], 1)).toEqual({
      arrive: true,
      complete: true,
      fail: true,
      depart: null,
    });
    expect(stepActions(stops, [], 2)).toEqual({
      arrive: false,
      complete: true,
      fail: false,
      depart: null,
    });
  });

  it('จุดปิดแล้ว + จุดถัดไปยังรอ → "ออกจากจุด" ส่ง DEPART ของจุดถัดไป · มี DEPART แล้ว/จุดสุดท้าย → ไม่มีปุ่ม', () => {
    expect(stepActions(stops, [], 0).depart?.id).toBe('b');
    expect(
      stepActions(stops, [{ stopId: 'b', type: 'DEPART', seqStatus: 'APPLIED' }], 0).depart,
    ).toBeNull();
    // DEPART ที่ผู้จัดรถ "ไม่ใช้" ไม่นับ → กดใหม่ได้
    expect(
      stepActions(stops, [{ stopId: 'b', type: 'DEPART', seqStatus: 'IGNORED' }], 0).depart?.id,
    ).toBe('b');
    expect(stepActions(stops, [], 3).depart).toBeNull();
    // จุดถัดไปไม่ได้รอ (ถึงแล้ว) → ไม่มีปุ่มออก
    expect(stepActions([st('a', 'COMPLETED'), st('b', 'ARRIVED')], [], 0).depart).toBeNull();
  });
});

describe('timeError', () => {
  const now = new Date('2026-11-17T05:00:00Z');
  it('ย้อนเวลาได้ · อนาคตไม่ได้ · ถึงจุดต้องไม่หลังปิดงาน · ว่าง = ต้องกรอก', () => {
    expect(timeError(['2026-11-15T08:00:00+07:00'], now)).toBeNull();
    expect(timeError(['2026-11-17T12:30:00+07:00'], now)).toBe('future');
    expect(timeError(['2026-11-17T11:00:00+07:00', '2026-11-17T10:00:00+07:00'], now)).toBe(
      'order',
    );
    expect(timeError(['2026-11-17T10:00:00+07:00', '2026-11-17T10:00:00+07:00'], now)).toBeNull();
    expect(timeError([null], now)).toBe('time');
  });
});

describe('reasonRule (ตรงกับ domain stopEventReasonRule)', () => {
  it('ส่งสำเร็จไม่มีเหตุผล · บางส่วนไม่บังคับ · ไม่สำเร็จบังคับ · ของยังอยู่บนรถ = ส่งไม่สำเร็จเท่านั้น', () => {
    expect(reasonRule('complete', 'DELIVERED')).toBeNull();
    expect(reasonRule('complete', 'PARTIAL')?.required).toBe(false);
    expect(reasonRule('complete', 'FAILED')).toEqual({
      required: true,
      categories: ['DELIVERY_FAILED', 'REJECTED_BY_RECEIVER'],
    });
    expect(reasonRule('complete', 'UNDELIVERED_RETAIN')?.categories).toEqual(['DELIVERY_FAILED']);
    expect(reasonRule('fail', null)?.required).toBe(true);
  });
});
