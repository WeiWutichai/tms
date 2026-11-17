import { describe, expect, it } from 'vitest';
import {
  STOP_EVENT_TYPES,
  STOP_OUTCOMES,
  TRIP_EXECUTION_STATUSES,
  effectiveStopSequence,
  isClockSkewed,
  isTripExecutable,
  stopEventAdmission,
  stopEventFlagsOf,
  stopEventReasonRule,
  stopOutcomeError,
  type StopEventType,
  type StopOutcome,
  type StopSeqEvent,
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

describe('ST4-T02 ลำดับ event ต่อจุด (effectiveStopSequence)', () => {
  let n = 0;
  const e = (type: StopEventType, at: string, extra: Partial<StopSeqEvent> = {}): StopSeqEvent => ({
    id: `e${String(++n).padStart(3, '0')}`,
    type,
    outcome: type === 'COMPLETE' ? 'DELIVERED' : null,
    occurredAt: new Date(`2026-11-17T${at}:00+07:00`),
    receivedAt: new Date(`2026-11-17T12:00:00+07:00`),
    lateReason: null,
    decision: null,
    ...extra,
  });

  it('ลำดับปกติ ออก → ถึง → ปิดงาน = COMPLETED ไม่มีขัดแย้ง', () => {
    const r = effectiveStopSequence([
      e('DEPART', '08:00'),
      e('ARRIVE', '09:00'),
      e('COMPLETE', '09:30'),
    ]);
    expect(r.state).toBe('COMPLETED');
    expect(r.outcome).toBe('DELIVERED');
    expect(r.events.map((x) => x.seqStatus)).toEqual(['APPLIED', 'APPLIED', 'APPLIED']);
    expect(r.enRouteAt?.toISOString()).toBe('2026-11-17T01:00:00.000Z');
    expect(r.arrivedAt?.toISOString()).toBe('2026-11-17T02:00:00.000Z');
    expect(r.closedAt?.toISOString()).toBe('2026-11-17T02:30:00.000Z');
  });

  it('มาถึงสลับลำดับ แต่เวลาเครื่องถูก → ผลเท่าเดิมไม่ว่าลำดับรับ', () => {
    const evs = [e('COMPLETE', '09:30'), e('ARRIVE', '09:00'), e('DEPART', '08:00')];
    const a = effectiveStopSequence(evs);
    const b = effectiveStopSequence([...evs].reverse());
    expect(a.state).toBe('COMPLETED');
    expect(a.events.map((x) => x.id)).toEqual(b.events.map((x) => x.id));
    expect(a.events.every((x) => !x.conflict)).toBe(true);
  });

  it('ปิดงานก่อนถึงจุด (docs/01 §3.9) = ขัดแย้ง ไม่นับ · dispatcher ยอมรับ → นับ', () => {
    const c = e('COMPLETE', '09:30');
    const r = effectiveStopSequence([e('DEPART', '08:00'), c]);
    expect(r.state).toBe('EN_ROUTE');
    expect(r.events[1]).toMatchObject({ seqStatus: 'CONFLICT', conflict: true, counted: false });
    const ok = effectiveStopSequence([e('DEPART', '08:00'), { ...c, decision: 'ACCEPT' }]);
    expect(ok.state).toBe('COMPLETED');
    expect(ok.events[1]).toMatchObject({ seqStatus: 'ACCEPTED', conflict: true, counted: true });
  });

  it('ถึงซ้ำ = ไม่ขัดแย้ง arrivedAt = เวลาแรก · ออกเดินทางหลังถึงแล้ว / event หลังปิดงาน = ขัดแย้ง', () => {
    const r = effectiveStopSequence([
      e('ARRIVE', '09:05'),
      e('ARRIVE', '09:00'),
      e('DEPART', '09:10'),
      e('COMPLETE', '09:30'),
      e('COMPLETE', '09:40', { outcome: 'PARTIAL' }),
    ]);
    expect(r.events.map((x) => x.seqStatus)).toEqual([
      'APPLIED',
      'REDUNDANT',
      'CONFLICT',
      'APPLIED',
      'CONFLICT',
    ]);
    expect(r.arrivedAt?.toISOString()).toBe('2026-11-17T02:00:00.000Z');
    expect(r.outcome).toBe('DELIVERED');
  });

  it('ส่งไม่สำเร็จได้โดยไม่ถึงจุด · outcome ของ FAIL ว่าง = FAILED', () => {
    const r = effectiveStopSequence([e('FAIL', '10:00')]);
    expect(r).toMatchObject({ state: 'FAILED', outcome: 'FAILED' });
  });

  it('ไม่ใช้ (IGNORE) → ไม่นับ และ event ถัดไปไม่ขัดแย้งอีก · event มาหลังปิดเที่ยว = LATE จนกว่าจะยอมรับ', () => {
    const r = effectiveStopSequence([
      e('ARRIVE', '09:00'),
      e('COMPLETE', '09:10', { decision: 'IGNORE' }),
      e('COMPLETE', '09:20', { outcome: 'PARTIAL' }),
    ]);
    expect(r.events.map((x) => x.seqStatus)).toEqual(['APPLIED', 'IGNORED', 'APPLIED']);
    expect(r.outcome).toBe('PARTIAL');
    const late = effectiveStopSequence([e('ARRIVE', '09:00', { lateReason: 'TRIP_CANCELLED' })]);
    expect(late).toMatchObject({ state: 'PENDING' });
    expect(late.events[0]!.seqStatus).toBe('LATE');
    const acc = effectiveStopSequence([
      e('ARRIVE', '09:00', { lateReason: 'TRIP_CANCELLED', decision: 'ACCEPT' }),
    ]);
    expect(acc.state).toBe('ARRIVED');
    expect(acc.events[0]!.seqStatus).toBe('ACCEPTED');
  });

  it('ยอมรับ event ที่ถอยสถานะ (ถึงจุดหลังปิดงาน) → นับเวลา แต่ไม่ถอยสถานะ', () => {
    const r = effectiveStopSequence([
      e('ARRIVE', '09:00'),
      e('COMPLETE', '09:10'),
      e('ARRIVE', '09:20', { decision: 'ACCEPT' }),
    ]);
    expect(r.state).toBe('COMPLETED');
    expect(r.events[2]!.seqStatus).toBe('ACCEPTED');
  });

  it('เวลาเท่ากัน → เรียงตามชนิด (ออก → ถึง → ปิด) แล้วเวลารับ', () => {
    const r = effectiveStopSequence([
      e('COMPLETE', '09:00'),
      e('ARRIVE', '09:00'),
      e('DEPART', '09:00'),
    ]);
    expect(r.events.map((x) => x.type)).toEqual(['DEPART', 'ARRIVE', 'COMPLETE']);
    expect(r.state).toBe('COMPLETED');
  });
});

describe('ST4-T02 นาฬิกาเพี้ยน / การรับ event ของเที่ยวที่ปิดแล้ว / ธง', () => {
  const recv = new Date('2026-11-17T12:00:00Z');
  it('อนาคตเกิน 5 นาที หรือย้อนหลังเกิน 24 ชม. = เพี้ยน', () => {
    expect(isClockSkewed(new Date('2026-11-17T12:05:00Z'), recv)).toBe(false);
    expect(isClockSkewed(new Date('2026-11-17T12:05:01Z'), recv)).toBe(true);
    expect(isClockSkewed(new Date('2026-11-16T12:00:00Z'), recv)).toBe(false);
    expect(isClockSkewed(new Date('2026-11-16T11:59:59Z'), recv)).toBe(true);
  });
  it('เที่ยวยกเลิก/จบแล้ว/จุดถูกถอด = รับ + ธง · ยังไม่ปล่อยรถ = ปฏิเสธ', () => {
    expect(stopEventAdmission('IN_PROGRESS', false)).toEqual({ kind: 'ok' });
    expect(stopEventAdmission('DISPATCHED', true)).toEqual({
      kind: 'late',
      reason: 'STOP_REMOVED',
    });
    expect(stopEventAdmission('CANCELLED', false)).toEqual({
      kind: 'late',
      reason: 'TRIP_CANCELLED',
    });
    for (const s of ['COMPLETED', 'COSTED', 'SETTLED'] as const)
      expect(stopEventAdmission(s, false)).toEqual({ kind: 'late', reason: 'TRIP_COMPLETED' });
    for (const s of ['PLANNING', 'OFFERED', 'ASSIGNED'] as const)
      expect(stopEventAdmission(s, false)).toEqual({ kind: 'reject' });
  });
  it('ธงเรียงตามความสำคัญ', () => {
    expect(
      stopEventFlagsOf({ lateReason: 'TRIP_CANCELLED', sequenceConflict: true, clockSkew: true }),
    ).toEqual(['LATE', 'SEQUENCE_CONFLICT', 'CLOCK_SKEW']);
    expect(
      stopEventFlagsOf({ lateReason: null, sequenceConflict: false, clockSkew: false }),
    ).toEqual([]);
  });
});
