import { describe, expect, it } from 'vitest';
import {
  STOP_EVENT_TYPES,
  STOP_OUTCOMES,
  TRIP_EXECUTION_STATUSES,
  isTripExecutable,
  stopEventReasonRule,
  stopOutcomeError,
  type StopEventType,
  type StopOutcome,
} from './stop-event';
import { TRIP_STATUSES } from './trip';

describe('stop event (ST4-T01)', () => {
  it('ชนิด/ผลตาม docs/04 E1', () => {
    expect(STOP_EVENT_TYPES).toEqual(['ARRIVE', 'DEPART', 'COMPLETE', 'FAIL']);
    expect(STOP_OUTCOMES).toEqual(['DELIVERED', 'PARTIAL', 'FAILED', 'UNDELIVERED_RETAIN']);
  });

  it('บันทึกได้เฉพาะเที่ยวที่ปล่อยรถแล้วและยังไม่จบ', () => {
    expect(TRIP_STATUSES.filter(isTripExecutable)).toEqual([...TRIP_EXECUTION_STATUSES]);
    expect(isTripExecutable('DISPATCHED')).toBe(true);
    expect(isTripExecutable('IN_PROGRESS')).toBe(true);
    for (const s of ['PLANNING', 'ASSIGNED', 'COMPLETED', 'CANCELLED'] as const)
      expect(isTripExecutable(s)).toBe(false);
  });

  it('คู่ชนิด/ผล ตรงกับ CHECK stop_event_outcome', () => {
    const ok = (t: StopEventType, o: StopOutcome | null) => stopOutcomeError(t, o);
    expect(ok('COMPLETE', null)).toBe('required');
    for (const o of STOP_OUTCOMES) expect(ok('COMPLETE', o)).toBeNull();
    expect(ok('FAIL', null)).toBeNull();
    expect(ok('FAIL', 'FAILED')).toBeNull();
    expect(ok('FAIL', 'UNDELIVERED_RETAIN')).toBeNull();
    expect(ok('FAIL', 'DELIVERED')).toBe('invalid');
    expect(ok('FAIL', 'PARTIAL')).toBe('invalid');
    expect(ok('ARRIVE', null)).toBeNull();
    expect(ok('DEPART', 'DELIVERED')).toBe('not_applicable');
  });

  it('เหตุผล: บังคับเมื่อส่งไม่สำเร็จ · ส่งสำเร็จไม่รับเหตุผล', () => {
    expect(stopEventReasonRule('ARRIVE', null)).toEqual({
      required: false,
      categories: ['DELAY', 'OVERRIDE'],
    });
    expect(stopEventReasonRule('COMPLETE', 'DELIVERED')).toEqual({
      required: false,
      categories: [],
    });
    expect(stopEventReasonRule('COMPLETE', 'PARTIAL').required).toBe(false);
    expect(stopEventReasonRule('COMPLETE', 'FAILED')).toEqual({
      required: true,
      categories: ['DELIVERY_FAILED', 'REJECTED_BY_RECEIVER'],
    });
    expect(stopEventReasonRule('COMPLETE', 'UNDELIVERED_RETAIN')).toEqual({
      required: true,
      categories: ['DELIVERY_FAILED'],
    });
    expect(stopEventReasonRule('FAIL', null).required).toBe(true);
    expect(stopEventReasonRule('FAIL', 'UNDELIVERED_RETAIN').categories).toEqual([
      'DELIVERY_FAILED',
    ]);
  });
});
