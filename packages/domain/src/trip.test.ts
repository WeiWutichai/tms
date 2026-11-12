import { describe, expect, it } from 'vitest';
import { canTransition, InvalidTransitionError, transition } from './state-machine';
import {
  TRIP_EVENTS,
  TRIP_STATUSES,
  TRIP_STATUS_LABEL_TH,
  TRIP_TRANSITIONS,
  intersectWindows,
  isTripEditable,
  planStops,
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
});
