import { describe, expect, it } from 'vitest';
import {
  deliveryOrderStopEvent,
  orderDeliveryEvent,
  projectStops,
  stopRowStatusOf,
  tripExecutionEvents,
  tripOdometerReading,
  type StopProjectionInput,
} from './stop-projection';

const t = (h: number) => new Date(Date.UTC(2026, 10, 17, h));
const stop = (over: Partial<StopProjectionInput> & { id: string; sequence: number }) =>
  ({
    currentStatus: 'PENDING',
    state: 'PENDING',
    outcome: null,
    enRouteAt: null,
    arrivedAt: null,
    closedAt: null,
    lastEventId: null,
    closeReasonCodeId: null,
    ...over,
  }) as StopProjectionInput;

describe('stopRowStatusOf', () => {
  it('EN_ROUTE ไม่มีในคอลัมน์ → PENDING', () => {
    expect(stopRowStatusOf('EN_ROUTE')).toBe('PENDING');
    expect(stopRowStatusOf('ARRIVED')).toBe('ARRIVED');
    expect(stopRowStatusOf('FAILED')).toBe('FAILED');
  });
});

describe('projectStops', () => {
  it('departedAt = DEPART ของจุดถัดไป ไม่งั้นเวลาปิดงาน; outcome/เหตุผลเฉพาะจุดที่ปิด', () => {
    const p = projectStops([
      stop({ id: 'b', sequence: 2, state: 'EN_ROUTE', enRouteAt: t(3) }),
      stop({
        id: 'a',
        sequence: 1,
        state: 'COMPLETED',
        outcome: 'DELIVERED',
        arrivedAt: t(1),
        closedAt: t(2),
        lastEventId: 'e1',
        closeReasonCodeId: 'r',
      }),
      stop({
        id: 'c',
        sequence: 3,
        state: 'FAILED',
        outcome: 'FAILED',
        closedAt: t(5),
        closeReasonCodeId: 'r2',
      }),
    ]);
    expect(p.map((x) => x.id)).toEqual(['a', 'b', 'c']);
    expect(p[0]).toMatchObject({
      status: 'COMPLETED',
      outcome: 'DELIVERED',
      departedAt: t(3),
      failReasonCodeId: null,
    });
    expect(p[1]).toMatchObject({ status: 'PENDING', outcome: null, departedAt: null });
    expect(p[2]).toMatchObject({ status: 'FAILED', departedAt: t(5), failReasonCodeId: 'r2' });
  });

  it('จุดที่ผู้จัดรถข้าม (SKIPPED) ไม่มี event → คงเดิม', () => {
    expect(
      projectStops([stop({ id: 'a', sequence: 1, currentStatus: 'SKIPPED' })])[0]!.status,
    ).toBe('SKIPPED');
  });
});

describe('tripExecutionEvents', () => {
  it('ถึงจุดแรก → start; ทุกจุดจบ → start + complete ในครั้งเดียว', () => {
    expect(tripExecutionEvents('DISPATCHED', ['ARRIVED', 'PENDING'])).toEqual(['start']);
    expect(tripExecutionEvents('DISPATCHED', ['PENDING', 'PENDING'])).toEqual([]);
    expect(tripExecutionEvents('DISPATCHED', ['FAILED', 'SKIPPED'])).toEqual(['start', 'complete']);
    expect(tripExecutionEvents('IN_PROGRESS', ['COMPLETED', 'FAILED'])).toEqual(['complete']);
  });
  it('ไม่ถอยหลัง: IN_PROGRESS ที่จุดกลับเป็น PENDING ไม่เปลี่ยน · COMPLETED/CANCELLED ไม่ไล่', () => {
    expect(tripExecutionEvents('IN_PROGRESS', ['PENDING'])).toEqual([]);
    expect(tripExecutionEvents('COMPLETED', ['COMPLETED'])).toEqual([]);
    expect(tripExecutionEvents('CANCELLED', ['COMPLETED'])).toEqual([]);
    expect(tripExecutionEvents('IN_PROGRESS', [])).toEqual([]);
  });
});

describe('deliveryOrderStopEvent', () => {
  it('จุดส่ง COMPLETED → deliver (จาก DISPATCHED/PICKED_UP) · FAILED → fail', () => {
    expect(deliveryOrderStopEvent('DISPATCHED', 'PENDING', 'COMPLETED')).toBe('deliver');
    expect(deliveryOrderStopEvent('PICKED_UP', 'COMPLETED', 'COMPLETED')).toBe('deliver');
    expect(deliveryOrderStopEvent('DISPATCHED', 'PENDING', 'FAILED')).toBe('fail');
    // รับของแล้วต้องผ่าน PICKED_UP ก่อน (ประวัติครบ)
    expect(deliveryOrderStopEvent('DISPATCHED', 'COMPLETED', 'FAILED')).toBe('pick_up');
    expect(deliveryOrderStopEvent('PICKED_UP', 'COMPLETED', 'FAILED')).toBe('fail');
  });
  it('จุดรับ COMPLETED → pick_up · จุดรับ FAILED → fail', () => {
    expect(deliveryOrderStopEvent('DISPATCHED', 'COMPLETED', 'PENDING')).toBe('pick_up');
    expect(deliveryOrderStopEvent('PICKED_UP', 'COMPLETED', 'ARRIVED')).toBeNull();
    expect(deliveryOrderStopEvent('DISPATCHED', 'FAILED', 'PENDING')).toBe('fail');
    expect(deliveryOrderStopEvent('PICKED_UP', 'FAILED', 'PENDING')).toBeNull();
  });
  it('ไม่ถอยหลัง/ไม่สลับผล: DO ส่งแล้วไม่กลายเป็น FAILED และกลับไม่ได้', () => {
    expect(deliveryOrderStopEvent('DELIVERED', 'COMPLETED', 'FAILED')).toBeNull();
    expect(deliveryOrderStopEvent('FAILED', 'COMPLETED', 'COMPLETED')).toBeNull();
    expect(deliveryOrderStopEvent('DELIVERED', null, 'ARRIVED')).toBeNull();
    expect(deliveryOrderStopEvent('CANCELLED', null, 'COMPLETED')).toBeNull();
  });
});

describe('orderDeliveryEvent', () => {
  const f = (anyDelivered: boolean, allDelivered: boolean, moving: boolean) => ({
    anyDelivered,
    allDelivered,
    moving,
  });
  it('ส่งครบ → DELIVERED จาก IN_TRANSIT / PARTIALLY_DELIVERED', () => {
    expect(orderDeliveryEvent('IN_TRANSIT', f(true, true, false))).toBe('deliver');
    expect(orderDeliveryEvent('PARTIALLY_DELIVERED', f(true, true, false))).toBe('deliver');
  });
  it('ส่งบางส่วนและไม่มี DO วิ่ง → PARTIALLY_DELIVERED; ยังวิ่ง → คง IN_TRANSIT', () => {
    expect(orderDeliveryEvent('IN_TRANSIT', f(true, false, false))).toBe('deliver_partial');
    expect(orderDeliveryEvent('IN_TRANSIT', f(true, false, true))).toBeNull();
    expect(orderDeliveryEvent('IN_TRANSIT', f(false, false, false))).toBeNull();
  });
  it('DO ที่เหลือออกรถ → resume; สถานะอื่นไม่เปลี่ยน', () => {
    expect(orderDeliveryEvent('PARTIALLY_DELIVERED', f(true, false, true))).toBe('resume');
    expect(orderDeliveryEvent('DELIVERED', f(true, true, false))).toBeNull();
    expect(orderDeliveryEvent('CLOSED', f(true, true, false))).toBeNull();
  });
});

describe('tripOdometerReading', () => {
  it('ค่าก่อนหน้า + ระยะเที่ยว (ปัด 0.1)', () => {
    expect(tripOdometerReading(1000, 85.25, null)).toBe(1085.3);
  });
  it('ไม่มีฐาน / ไม่ทราบระยะ / ระยะ 0 / เกินค่าหลังจากนั้น → ไม่บันทึก', () => {
    expect(tripOdometerReading(null, 10, null)).toBeNull();
    expect(tripOdometerReading(1000, null, null)).toBeNull();
    expect(tripOdometerReading(1000, 0, null)).toBeNull();
    expect(tripOdometerReading(1000, 50, 1020)).toBeNull();
    expect(tripOdometerReading(1000, 20, 1020)).toBe(1020);
  });
});
