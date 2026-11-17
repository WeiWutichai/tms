import { describe, expect, it } from 'vitest';
import {
  beforeFloor,
  hasPendingClose,
  realDeparture,
  reasonRule,
  restStops,
  stepActions,
  stepKey,
  stopTimes,
  timeError,
  timeFloor,
  type StepEvent,
  type TripStop,
} from './tripStepper';

/** ST4-T04 ตรรกะ stepper: ปุ่มตามสถานะจุด, "ออกจากจุด" = DEPART ของจุดถัดไป, ตรวจเวลา, หมวดเหตุผล */
const st = (id: string, status: string) => ({ id, status }) as TripStop;
const e = (x: Partial<StepEvent> & Pick<StepEvent, 'stopId' | 'type'>): StepEvent => ({
  seqStatus: 'APPLIED',
  counted: true,
  occurredAt: '2026-11-17T02:00:00.000Z',
  flags: [],
  resolution: null,
  ...x,
});

describe('stepActions', () => {
  const stops = [st('a', 'COMPLETED'), st('b', 'PENDING'), st('c', 'ARRIVED'), st('d', 'FAILED')];

  it('จุดรอดำเนินการ: ถึงจุด / ปิดงาน / ส่งไม่สำเร็จ · ถึงแล้ว: ปิดงานอย่างเดียว', () => {
    expect(stepActions(stops, [], 1)).toEqual({
      arrive: true,
      complete: true,
      fail: true,
      depart: null,
      pendingClose: false,
    });
    expect(stepActions(stops, [], 2)).toEqual({
      arrive: false,
      complete: true,
      fail: false,
      depart: null,
      pendingClose: false,
    });
  });

  it('จุดปิดแล้ว + จุดถัดไปยังรอ → "ออกจากจุด" ส่ง DEPART ของจุดถัดไป · มี DEPART แล้ว/จุดสุดท้าย → ไม่มีปุ่ม', () => {
    expect(stepActions(stops, [], 0).depart?.id).toBe('b');
    expect(stepActions(stops, [e({ stopId: 'b', type: 'DEPART' })], 0).depart).toBeNull();
    // DEPART ที่ผู้จัดรถ "ไม่ใช้" ไม่นับ → กดใหม่ได้
    expect(
      stepActions(
        stops,
        [e({ stopId: 'b', type: 'DEPART', seqStatus: 'IGNORED', counted: false })],
        0,
      ).depart?.id,
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

describe('เวลาต่ำสุด / ปิดงานรอตัดสิน (review/QA ST4-T04 M1/M2)', () => {
  const T = (hh: string) => `2026-11-17T${hh}:00.000Z`;
  const evs = [
    e({ stopId: 'a', type: 'ARRIVE', occurredAt: T('02:10') }),
    e({ stopId: 'a', type: 'COMPLETE', occurredAt: T('02:40') }),
    e({ stopId: 'b', type: 'DEPART', occurredAt: T('02:50') }),
    // ปิดงานขัดลำดับที่ยังไม่นับ — ไม่ใช้เป็นเวลา
    e({
      stopId: 'b',
      type: 'COMPLETE',
      occurredAt: T('01:00'),
      counted: false,
      seqStatus: 'CONFLICT',
      flags: ['SEQUENCE_CONFLICT'],
    }),
  ];

  it('stopTimes ใช้เฉพาะ event ที่นับ', () => {
    expect(stopTimes('a', evs)).toEqual({ enRoute: null, arrived: T('02:10'), closed: T('02:40') });
    expect(stopTimes('b', evs)).toEqual({ enRoute: T('02:50'), arrived: null, closed: null });
  });

  it('ถึงจุด ≥ ออกเดินทางมา · ปิดงาน ≥ ถึงจุด · ออกจากจุด ≥ ปิดงานของจุดเดิม', () => {
    expect(timeFloor('arrive', 'b', evs)).toEqual({ at: T('02:50'), what: 'depart' });
    expect(timeFloor('close', 'a', evs)).toEqual({ at: T('02:10'), what: 'arrive' });
    expect(timeFloor('close', 'b', evs)).toEqual({ at: T('02:50'), what: 'depart' });
    expect(timeFloor('depart', 'a', evs)).toEqual({ at: T('02:40'), what: 'close' });
    expect(timeFloor('arrive', 'a', evs)).toBeNull();
    expect(beforeFloor('2026-11-17T09:30:00+07:00', timeFloor('depart', 'a', evs))).toBe(true);
    expect(beforeFloor('2026-11-17T09:40:00+07:00', timeFloor('depart', 'a', evs))).toBe(false);
  });

  it('ปิดงานรอตัดสิน → ไม่มีปุ่มปิดงาน/ไม่สำเร็จ และไม่อยู่ใน "จุดที่เหลือ" · ตัดสินแล้ว = ปกติ', () => {
    const stops = [st('a', 'COMPLETED'), st('b', 'PENDING'), st('c', 'PENDING')];
    expect(hasPendingClose('b', evs)).toBe(true);
    expect(stepActions(stops, evs, 1)).toMatchObject({
      arrive: true,
      complete: false,
      fail: false,
      pendingClose: true,
    });
    expect(restStops(stops, evs).map((s) => s.id)).toEqual(['c']);
    const resolved = evs.map((x) =>
      x.flags.length ? { ...x, resolution: { decision: 'IGNORE' } as StepEvent['resolution'] } : x,
    );
    expect(hasPendingClose('b', resolved)).toBe(false);
  });

  it('ออกจริง = DEPART ที่นับของจุดถัดไป · บางส่วนแยกหน้าตา', () => {
    const stops = [st('a', 'COMPLETED'), st('b', 'PENDING')];
    expect(realDeparture(stops, evs, 0)).toBe(T('02:50'));
    expect(realDeparture(stops, evs, 1)).toBeNull();
    expect(realDeparture(stops, [], 0)).toBeNull();
    expect(stepKey({ status: 'COMPLETED', outcome: 'PARTIAL' })).toBe('PARTIAL');
    expect(stepKey({ status: 'COMPLETED', outcome: 'DELIVERED' })).toBe('COMPLETED');
  });
});
