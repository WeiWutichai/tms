import { describe, expect, it } from 'vitest';
import { canTransition, InvalidTransitionError, transition } from './state-machine';
import {
  TRIP_EVENTS,
  TRIP_STATUSES,
  TRIP_STATUS_LABEL_TH,
  TRIP_TRANSITIONS,
  backwardStops,
  estimateLeg,
  intersectWindows,
  routeTotals,
  stopOrderViolations,
  TRIP_AVG_SPEED_KMH,
  isTripEditable,
  planStops,
  vehicleOverlaps,
  type OverlapTrip,
  type TripDoInput,
  type TripEvent,
  type TripStatus,
} from './trip';

/** ทุกคู่ (สถานะ × event) ที่ถูกต้องตาม docs/01 §4.2 + plan/00a (DISPATCHED → CANCELLED) — นอกนั้นต้องเป็น 409 */
const EXPECTED: Partial<Record<`${TripStatus}.${TripEvent}`, TripStatus>> = {
  'PLANNING.offer': 'OFFERED',
  'PLANNING.assign': 'ASSIGNED',
  'PLANNING.cancel': 'CANCELLED',
  'OFFERED.accept': 'ASSIGNED',
  'OFFERED.reject': 'PLANNING',
  'OFFERED.expire': 'PLANNING',
  'OFFERED.cancel': 'CANCELLED',
  'ASSIGNED.reassign': 'ASSIGNED',
  'ASSIGNED.dispatch': 'DISPATCHED',
  'ASSIGNED.cancel': 'CANCELLED',
  'DISPATCHED.start': 'IN_PROGRESS',
  'DISPATCHED.cancel': 'CANCELLED',
  'IN_PROGRESS.complete': 'COMPLETED',
  'COMPLETED.cost': 'COSTED',
  'COSTED.settle': 'SETTLED',
};

describe('trip state machine (ST3-T11)', () => {
  it('ทุกคู่สถานะ × event: ถูก → สถานะใหม่, ผิด → InvalidTransitionError (409)', () => {
    let allowed = 0;
    for (const s of TRIP_STATUSES)
      for (const e of TRIP_EVENTS) {
        const want = EXPECTED[`${s}.${e}`];
        if (want) {
          allowed++;
          expect(transition('trip', TRIP_TRANSITIONS, s, e)).toBe(want);
        } else {
          expect(canTransition(TRIP_TRANSITIONS, s, e)).toBe(false);
          expect(() => transition('trip', TRIP_TRANSITIONS, s, e)).toThrow(InvalidTransitionError);
        }
      }
    expect(allowed).toBe(Object.keys(EXPECTED).length);
  });

  it('ยกเลิกไม่ได้หลังเริ่มวิ่ง · SETTLED/CANCELLED สิ้นสุด · แก้ DO ได้เฉพาะ PLANNING/ASSIGNED · ป้ายไทยครบ', () => {
    for (const s of ['IN_PROGRESS', 'COMPLETED', 'COSTED', 'SETTLED', 'CANCELLED'] as const)
      expect(canTransition(TRIP_TRANSITIONS, s, 'cancel')).toBe(false);
    expect(TRIP_TRANSITIONS.SETTLED).toBeUndefined();
    expect(TRIP_TRANSITIONS.CANCELLED).toBeUndefined();
    expect(TRIP_STATUSES.filter(isTripEditable)).toEqual(['PLANNING', 'ASSIGNED']);
    for (const s of TRIP_STATUSES) expect(TRIP_STATUS_LABEL_TH[s]).toBeTruthy();
  });
});

const w = (start: string | null = null, end: string | null = null) => ({ start, end });
const d = (id: string, o: string, t: string, drop = w(), pick = w()): TripDoInput => ({
  id,
  originSiteId: o,
  destSiteId: t,
  pickupWindow: pick,
  dropWindow: drop,
});

describe('planStops (ST3-T11)', () => {
  it('รับทั้งหมดก่อน แล้วส่ง · หลาย DO จุดเดียวกันใช้จุดเดียว (หลาย SO ลูกค้าเดียว) · ลำดับ 1..n', () => {
    const p = planStops([], [d('a', 'W1', 'C1'), d('b', 'W1', 'C1'), d('c', 'W2', 'C2')]);
    expect(p.stops.map((s) => [s.sequence, s.type, s.siteId, s.doIds])).toEqual([
      [1, 'PICKUP', 'W1', ['a', 'b']],
      [2, 'PICKUP', 'W2', ['c']],
      [3, 'DELIVERY', 'C1', ['a', 'b']],
      [4, 'DELIVERY', 'C2', ['c']],
    ]);
    expect(p.pickupOf).toEqual({ a: 0, b: 0, c: 1 });
    expect(p.dropOf).toEqual({ a: 2, b: 2, c: 3 });
    expect(p.removed).toEqual([]);
  });

  it('คงจุดเดิม (ลำดับที่ผู้จัดรถเรียง) · จุดไม่มี DO → removed · จุดรับใหม่อยู่ก่อนจุดส่งแรก', () => {
    const existing = [
      { id: 's1', type: 'PICKUP' as const, siteId: 'W1', sequence: 1 },
      { id: 's2', type: 'DELIVERY' as const, siteId: 'C2', sequence: 2 },
      { id: 's3', type: 'DELIVERY' as const, siteId: 'C1', sequence: 3 },
    ];
    const p = planStops(existing, [d('a', 'W1', 'C1'), d('n', 'W9', 'C3')]);
    expect(p.stops.map((s) => [s.id, s.type, s.siteId])).toEqual([
      ['s1', 'PICKUP', 'W1'],
      [null, 'PICKUP', 'W9'],
      ['s3', 'DELIVERY', 'C1'],
      [null, 'DELIVERY', 'C3'],
    ]);
    expect(p.removed).toEqual(['s2']);
  });

  it('จุดส่งเดิมที่อยู่ก่อนจุดรับของ DO ใหม่ → เปิดจุดส่งใหม่ท้ายเที่ยว (รับก่อนส่งเสมอ)', () => {
    const existing = [
      { id: 'p1', type: 'PICKUP' as const, siteId: 'W1', sequence: 1 },
      { id: 'd1', type: 'DELIVERY' as const, siteId: 'C1', sequence: 2 },
      { id: 'p2', type: 'PICKUP' as const, siteId: 'W2', sequence: 3 },
      { id: 'd2', type: 'DELIVERY' as const, siteId: 'C2', sequence: 4 },
    ];
    const p = planStops(existing, [d('a', 'W1', 'C1'), d('b', 'W2', 'C2'), d('x', 'W2', 'C1')]);
    for (const id of ['a', 'b', 'x']) expect(p.pickupOf[id]!).toBeLessThan(p.dropOf[id]!);
    expect(p.stops.at(-1)).toMatchObject({
      id: null,
      type: 'DELIVERY',
      siteId: 'C1',
      doIds: ['x'],
    });
  });

  it('ช่วงเวลาของจุด = ส่วนที่ทุก DO รับได้ · ไม่ทับกัน → windowConflicts', () => {
    expect(
      intersectWindows([
        w('2026-11-13T01:00:00Z', '2026-11-13T05:00:00Z'),
        w('2026-11-13T03:00:00Z', null),
      ]),
    ).toEqual({ window: w('2026-11-13T03:00:00Z', '2026-11-13T05:00:00Z'), conflict: false });
    const p = planStops(
      [],
      [
        d('a', 'W', 'C', w('2026-11-13T01:00:00Z', '2026-11-13T02:00:00Z')),
        d('b', 'W', 'C', w('2026-11-13T05:00:00Z', '2026-11-13T06:00:00Z')),
      ],
    );
    expect(p.windowConflicts).toEqual([1]);
  });

  it('DO ใหม่เรียงจุดส่งตามต้นช่วงเวลา (ไม่มีช่วงไว้ท้าย) · จุดเดิมคงตำแหน่ง · เวลาถอยหลัง → backwardStops', () => {
    const p = planStops(
      [],
      [
        d('late', 'W', 'C1', w('2026-11-13T09:00:00Z', null)),
        d('none', 'W', 'C2'),
        d('early', 'W', 'C3', w('2026-11-13T02:00:00Z', null)),
      ],
    );
    expect(p.stops.filter((s) => s.type === 'DELIVERY').map((s) => s.siteId)).toEqual([
      'C3',
      'C1',
      'C2',
    ]);
    const kept = planStops(
      [
        { id: 'x', type: 'DELIVERY', siteId: 'C1', sequence: 2 },
        { id: 'p', type: 'PICKUP', siteId: 'W', sequence: 1 },
      ],
      [
        d('late', 'W', 'C1', w('2026-11-13T09:00:00Z', null)),
        d('early', 'W', 'C3', w('2026-11-13T02:00:00Z', null)),
      ],
    );
    expect(kept.stops.map((s) => s.siteId)).toEqual(['W', 'C1', 'C3']);
    expect(
      backwardStops([
        { sequence: 1, plannedArrival: '2026-11-13T01:00:00Z' },
        { sequence: 2, plannedArrival: '2026-11-13T09:00:00Z' },
        { sequence: 3, plannedArrival: null },
        { sequence: 4, plannedArrival: '2026-11-13T02:00:00Z' },
      ]),
    ).toEqual([4]);
  });
});

describe('vehicleOverlaps (ST3-T12)', () => {
  const T = (
    id: string,
    start: string | null,
    end: string | null,
    o: { vehicleId?: string | null; status?: TripStatus; tripDate?: string } = {},
  ): OverlapTrip => ({
    id,
    vehicleId: o.vehicleId === undefined ? 'v1' : o.vehicleId,
    status: o.status ?? 'PLANNING',
    tripDate: o.tripDate ?? '2026-11-13',
    start,
    end,
  });
  it('ช่วงวิ่งทับกัน → ซ้อนทั้งสองฝั่ง · ขอบชนพอดีไม่ซ้อน', () => {
    const m = vehicleOverlaps([
      T('a', '2026-11-13T02:00:00Z', '2026-11-13T05:00:00Z'),
      T('b', '2026-11-13T04:00:00Z', '2026-11-13T07:00:00Z'),
      T('c', '2026-11-13T07:00:00Z', '2026-11-13T08:00:00Z'),
    ]);
    expect(m.get('a')).toEqual(['b']);
    expect(m.get('b')).toEqual(['a']);
    expect(m.has('c')).toBe(false);
  });
  it('คนละรถ / ไม่มีรถ / จบหรือยกเลิกแล้ว ไม่นับ', () => {
    const m = vehicleOverlaps([
      T('a', '2026-11-13T02:00:00Z', '2026-11-13T05:00:00Z'),
      T('b', '2026-11-13T02:00:00Z', '2026-11-13T05:00:00Z', { vehicleId: 'v2' }),
      T('c', '2026-11-13T02:00:00Z', '2026-11-13T05:00:00Z', { vehicleId: null }),
      T('d', '2026-11-13T02:00:00Z', '2026-11-13T05:00:00Z', { status: 'COMPLETED' }),
      T('e', '2026-11-13T02:00:00Z', '2026-11-13T05:00:00Z', { status: 'CANCELLED' }),
    ]);
    expect(m.size).toBe(0);
  });
  it('ฝั่งใดไม่มีช่วงวิ่ง → วันเดียวกัน = ซ้อน', () => {
    const m = vehicleOverlaps([
      T('a', null, null),
      T('b', '2026-11-13T02:00:00Z', '2026-11-13T05:00:00Z'),
      T('c', null, null, { tripDate: '2026-11-14' }),
    ]);
    expect(m.get('a')).toEqual(['b']);
    expect(m.has('c')).toBe(false);
  });
});

describe('stopOrderViolations (ST3-T16)', () => {
  const dos = [
    { id: 'd1', pickupStopId: 'p1', dropStopId: 'q1' },
    { id: 'd2', pickupStopId: 'p1', dropStopId: 'q2' },
  ];
  it('ลำดับถูก (รับก่อนส่ง) → ไม่มีข้อผิด', () => {
    expect(stopOrderViolations(['p1', 'q2', 'q1'], dos)).toEqual([]);
  });
  it('ย้ายจุดส่งไปก่อนจุดรับของ DO เดียวกัน → ชี้ DO นั้นพร้อมลำดับใหม่', () => {
    expect(stopOrderViolations(['q1', 'p1', 'q2'], dos)).toEqual([
      {
        deliveryOrderId: 'd1',
        pickupStopId: 'p1',
        dropStopId: 'q1',
        pickupSequence: 2,
        dropSequence: 1,
      },
    ]);
  });
  it('ย้ายจุดรับไปท้ายสุด → ทุก DO ที่รับที่นั่นผิด', () => {
    expect(stopOrderViolations(['q1', 'q2', 'p1'], dos).map((v) => v.deliveryOrderId)).toEqual([
      'd1',
      'd2',
    ]);
  });
  it('DO ที่ไม่มีจุด/จุดไม่อยู่ในลำดับ → ข้าม', () => {
    expect(
      stopOrderViolations(['q1'], [{ id: 'd3', pickupStopId: null, dropStopId: 'q1' }, ...dos]),
    ).toEqual([]);
  });
});

describe('estimateLeg / routeTotals (ST3-T16)', () => {
  const bkk = { lat: 13.7563, lng: 100.5018 };
  const cbi = { lat: 13.3611, lng: 100.9847 };
  it('จุดเดียวกัน = 0', () => {
    expect(
      estimateLeg({ fromSiteId: 'a', toSiteId: 'a', route: null, from: null, to: null }),
    ).toEqual({ km: 0, minutes: 0, source: 'SAME_SITE' });
  });
  it('route master มาก่อนค่าประมาณ · เวลามาตรฐานว่าง → ระยะ ÷ ความเร็วเฉลี่ย', () => {
    expect(
      estimateLeg({
        fromSiteId: 'a',
        toSiteId: 'b',
        route: { distanceKm: 82.4, standardMinutes: 95 },
        from: bkk,
        to: cbi,
      }),
    ).toEqual({ km: 82.4, minutes: 95, source: 'ROUTE' });
    expect(
      estimateLeg({
        fromSiteId: 'a',
        toSiteId: 'b',
        route: { distanceKm: 100, standardMinutes: null },
        from: null,
        to: null,
      }),
    ).toEqual({ km: 100, minutes: Math.round((100 / TRIP_AVG_SPEED_KMH) * 60), source: 'ROUTE' });
  });
  it('ไม่มีเส้นทาง แต่มีพิกัด → ค่าประมาณ (เส้นตรง × 1.3)', () => {
    const l = estimateLeg({ fromSiteId: 'a', toSiteId: 'b', route: null, from: bkk, to: cbi });
    expect(l.source).toBe('ESTIMATE');
    // เส้นตรงกรุงเทพ–ชลบุรี ≈ 68 กม. → × 1.3 ≈ 88 กม.
    expect(l.km).toBeGreaterThan(80);
    expect(l.km).toBeLessThan(95);
    expect(l.minutes).toBe(Math.round((l.km! / TRIP_AVG_SPEED_KMH) * 60));
  });
  it('ไม่มีทั้งเส้นทางและพิกัด → ไม่ทราบ', () => {
    expect(
      estimateLeg({ fromSiteId: 'a', toSiteId: 'b', route: null, from: bkk, to: null }),
    ).toEqual({ km: null, minutes: null, source: null });
  });
  it('ยอดรวมนับเฉพาะช่วงที่ทราบ + บอกจำนวนช่วงที่ขาด', () => {
    expect(
      routeTotals([
        { km: 10.15, minutes: 12, source: 'ROUTE' },
        { km: 0, minutes: 0, source: 'SAME_SITE' },
        { km: 5, minutes: 6, source: 'ESTIMATE' },
        { km: null, minutes: null, source: null },
      ]),
    ).toEqual({ distanceKm: 15.2, minutes: 18, missingLegs: 1, estimated: true });
    expect(routeTotals([])).toEqual({
      distanceKm: 0,
      minutes: 0,
      missingLegs: 0,
      estimated: false,
    });
    expect(routeTotals([{ km: null, minutes: null, source: null }])).toEqual({
      distanceKm: null,
      minutes: null,
      missingLegs: 1,
      estimated: false,
    });
  });
});
