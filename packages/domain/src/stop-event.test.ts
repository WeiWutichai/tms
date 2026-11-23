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
    expect(STOP_EVENT_TYPES).toEqual(['ARRIVE', 'DEPART', 'LOADED', 'COMPLETE', 'FAIL']);
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
    // D68-39 LOADED (ขึ้นของเสร็จ — จุดรับ) ไม่มี outcome
    expect(ok('LOADED', null)).toBeNull();
    expect(ok('LOADED', 'DELIVERED')).toBe('not_applicable');
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
    expect(stopEventReasonRule('LOADED', null)).toEqual({ required: false, categories: [] });
    expect(stopEventReasonRule('FAIL', null).required).toBe(true);
    expect(stopEventReasonRule('FAIL', 'UNDELIVERED_RETAIN').categories).toEqual([
      'DELIVERY_FAILED',
    ]);
  });
});

describe('ST4-T02 ลำดับ event ต่อจุด (effectiveStopSequence)', () => {
  let n = 0;
  type Ex = Partial<Omit<StopSeqEvent, 'resolutions'>> & {
    dec?: 'ACCEPT' | 'IGNORE';
    decFlags?: string[];
  };
  const e = (type: StopEventType, at: string, extra: Ex = {}): StopSeqEvent => {
    const { dec, decFlags, ...rest } = extra;
    return {
      id: `e${String(++n).padStart(3, '0')}`,
      type,
      outcome: type === 'COMPLETE' ? 'DELIVERED' : null,
      occurredAt: new Date(`2026-11-17T${at}:00+07:00`),
      receivedAt: new Date(`2026-11-17T12:00:${String(n % 60).padStart(2, '0')}+07:00`),
      lateReason: null,
      clockSkew: false,
      resolutions: dec
        ? [{ decision: dec, flags: decFlags ?? ['SEQUENCE_CONFLICT'], at: new Date() }]
        : [],
      ...rest,
    };
  };

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

  it('D68-39 LOADED ปิดจุดรับ = COMPLETED ผลรับของครบ · ก่อนถึงจุด = ขัดลำดับ · ปิดแข่งกับ COMPLETE = ธงทั้งคู่', () => {
    const r = effectiveStopSequence([e('ARRIVE', '09:00'), e('LOADED', '09:30')]);
    expect(r.state).toBe('COMPLETED');
    expect(r.outcome).toBe('DELIVERED');
    expect(r.closedAt?.toISOString()).toBe('2026-11-17T02:30:00.000Z');
    expect(r.events.map((x) => x.seqStatus)).toEqual(['APPLIED', 'APPLIED']);
    const early = effectiveStopSequence([e('LOADED', '09:30')]);
    expect(early.state).toBe('PENDING');
    expect(early.events[0]).toMatchObject({ seqStatus: 'CONFLICT', counted: false });
    const race = effectiveStopSequence([
      e('ARRIVE', '09:00'),
      e('LOADED', '09:30'),
      e('COMPLETE', '09:31'),
    ]);
    expect(race.events.filter((x) => x.flags.includes('SEQUENCE_CONFLICT'))).toHaveLength(2);
  });

  it('มาถึงสลับลำดับ แต่เวลาเครื่องถูก → ผลเท่าเดิมไม่ว่าลำดับรับ', () => {
    const evs = [e('COMPLETE', '09:30'), e('ARRIVE', '09:00'), e('DEPART', '08:00')];
    const a = effectiveStopSequence(evs);
    const b = effectiveStopSequence([...evs].reverse());
    expect(a.state).toBe('COMPLETED');
    expect(a.events.map((x) => x.id)).toEqual(b.events.map((x) => x.id));
    expect(a.events.every((x) => !x.conflict && x.flags.length === 0)).toBe(true);
  });

  it('ปิดงานก่อนถึงจุด (docs/01 §3.9) = ขัดแย้ง ไม่นับ · dispatcher ยอมรับ → นับ', () => {
    const r = effectiveStopSequence([e('DEPART', '08:00'), e('COMPLETE', '09:30')]);
    expect(r.state).toBe('EN_ROUTE');
    expect(r.events[1]).toMatchObject({
      seqStatus: 'CONFLICT',
      conflict: true,
      counted: false,
      flags: ['SEQUENCE_CONFLICT'],
    });
    const ok = effectiveStopSequence([
      e('DEPART', '08:00'),
      e('COMPLETE', '09:30', { dec: 'ACCEPT' }),
    ]);
    expect(ok.state).toBe('COMPLETED');
    expect(ok.events[1]).toMatchObject({ seqStatus: 'ACCEPTED', conflict: true, counted: true });
  });

  it('การตัดสินหมดผลเมื่อธงเปลี่ยน: ไม่ใช้ (ขัดลำดับ) แล้ว "ถึงจุด" ที่เวลาก่อนมาถึง → ธงหาย ปิดงานนับตามปกติ', () => {
    const c = e('COMPLETE', '09:40', { dec: 'IGNORE' });
    const before = effectiveStopSequence([c]);
    expect(before.events[0]).toMatchObject({ seqStatus: 'IGNORED' });
    expect(before.events[0]!.resolution?.decision).toBe('IGNORE');
    const after = effectiveStopSequence([c, e('ARRIVE', '09:10')]);
    const done = after.events.find((x) => x.id === c.id)!;
    expect(done).toMatchObject({ seqStatus: 'APPLIED', flags: [], resolution: null });
    expect(after.state).toBe('COMPLETED');
  });

  it('ถึงซ้ำ = ไม่ขัด arrivedAt = เวลาแรก · ออกเดินทางหลังถึงแล้ว = ขัด', () => {
    const r = effectiveStopSequence([
      e('ARRIVE', '09:05'),
      e('ARRIVE', '09:00'),
      e('DEPART', '09:10'),
    ]);
    expect(r.events.map((x) => x.seqStatus)).toEqual(['APPLIED', 'REDUNDANT', 'CONFLICT']);
    expect(r.arrivedAt?.toISOString()).toBe('2026-11-17T02:00:00.000Z');
  });

  it('ปิดงานแข่งกัน: ทั้งคู่ขึ้นธง · ผลคงตามตัวที่ server รับก่อน แม้ตัวมาทีหลังมีเวลาก่อน · ยอมรับ/ไม่ใช้ เปลี่ยนตัวที่มีผล', () => {
    const arrive = e('ARRIVE', '09:00');
    const first = e('COMPLETE', '10:30', { receivedAt: new Date('2026-11-17T04:00:00Z') });
    const late = e('COMPLETE', '10:20', {
      outcome: 'PARTIAL',
      receivedAt: new Date('2026-11-17T05:00:00Z'),
    });
    const r = effectiveStopSequence([arrive, first, late]);
    expect(r).toMatchObject({ state: 'COMPLETED', outcome: 'DELIVERED' });
    const byId = (x: typeof r, id: string) => x.events.find((y) => y.id === id)!;
    expect(byId(r, first.id)).toMatchObject({ conflict: true, seqStatus: 'APPLIED' });
    expect(byId(r, late.id)).toMatchObject({ conflict: true, seqStatus: 'CONFLICT' });
    // ยอมรับตัวที่มาทีหลัง → ผลเปลี่ยนเป็นของตัวนั้น
    const acc = effectiveStopSequence([
      arrive,
      first,
      { ...late, ...e('COMPLETE', '10:20', { dec: 'ACCEPT' }), id: late.id, outcome: 'PARTIAL' },
    ]);
    expect(acc.outcome).toBe('PARTIAL');
    // ไม่ใช้ตัวที่รับก่อน → ตัวที่เหลือมีผล
    const ign = effectiveStopSequence([
      arrive,
      {
        ...first,
        resolutions: [{ decision: 'IGNORE', flags: ['SEQUENCE_CONFLICT'], at: new Date() }],
      },
      late,
    ]);
    expect(ign.outcome).toBe('PARTIAL');
  });

  it('ส่งไม่สำเร็จได้โดยไม่ถึงจุด · outcome ของ FAIL ว่าง = FAILED', () => {
    expect(effectiveStopSequence([e('FAIL', '10:00')])).toMatchObject({
      state: 'FAILED',
      outcome: 'FAILED',
    });
  });

  it('มาหลังปิดเที่ยว (LATE) / เวลาเพี้ยน (SKEWED) ไม่นับจนกว่ายอมรับ (ธงตรง)', () => {
    const late = effectiveStopSequence([e('ARRIVE', '09:00', { lateReason: 'TRIP_CANCELLED' })]);
    expect(late).toMatchObject({ state: 'PENDING', arrivedAt: null });
    expect(late.events[0]!.seqStatus).toBe('LATE');
    const acc = effectiveStopSequence([
      e('ARRIVE', '09:00', { lateReason: 'TRIP_CANCELLED', dec: 'ACCEPT', decFlags: ['LATE'] }),
    ]);
    expect(acc.state).toBe('ARRIVED');
    const sk = effectiveStopSequence([e('ARRIVE', '09:00', { clockSkew: true })]);
    expect(sk).toMatchObject({ state: 'PENDING', arrivedAt: null });
    expect(sk.events[0]).toMatchObject({ seqStatus: 'SKEWED', flags: ['CLOCK_SKEW'] });
  });

  it('ยอมรับเวลาเพี้ยนแล้ว event อื่นทำให้ขัดลำดับ → ธงเปลี่ยน การยอมรับหมดผล', () => {
    const dep = e('DEPART', '11:00', { clockSkew: true, dec: 'ACCEPT', decFlags: ['CLOCK_SKEW'] });
    expect(effectiveStopSequence([dep]).state).toBe('EN_ROUTE');
    const r = effectiveStopSequence([dep, e('ARRIVE', '10:00')]);
    const d = r.events.find((x) => x.id === dep.id)!;
    expect(d).toMatchObject({
      flags: ['SEQUENCE_CONFLICT', 'CLOCK_SKEW'],
      resolution: null,
      seqStatus: 'SKEWED',
    });
    expect(r.state).toBe('ARRIVED');
  });

  it('ยอมรับ event ที่ถอยสถานะ (ถึงจุดหลังปิดงาน) → นับเวลา แต่ไม่ถอยสถานะ', () => {
    const r = effectiveStopSequence([
      e('ARRIVE', '09:00'),
      e('COMPLETE', '09:10'),
      e('ARRIVE', '09:20', { dec: 'ACCEPT' }),
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
  it('เที่ยวยกเลิก/จบแล้ว/จุดถูกถอด = รับ + ธง · ยังไม่เคยปล่อยรถ = ปฏิเสธ', () => {
    expect(stopEventAdmission('IN_PROGRESS', false, true)).toEqual({ kind: 'ok' });
    expect(stopEventAdmission('DISPATCHED', true, true)).toEqual({
      kind: 'late',
      reason: 'STOP_REMOVED',
    });
    expect(stopEventAdmission('CANCELLED', false, true)).toEqual({
      kind: 'late',
      reason: 'TRIP_CANCELLED',
    });
    expect(stopEventAdmission('CANCELLED', false, false)).toEqual({ kind: 'reject' });
    expect(stopEventAdmission('PLANNING', true, false)).toEqual({ kind: 'reject' });
    for (const s of ['COMPLETED', 'COSTED', 'SETTLED'] as const)
      expect(stopEventAdmission(s, false, true)).toEqual({
        kind: 'late',
        reason: 'TRIP_COMPLETED',
      });
    for (const s of ['PLANNING', 'OFFERED', 'ASSIGNED'] as const)
      expect(stopEventAdmission(s, false, false)).toEqual({ kind: 'reject' });
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

describe('ST4-T03 ธงจุดรับยังไม่ปิด / ผลไม่ตรง DO / ถึงจุดหลังปิดที่ยอมรับ', () => {
  let n = 0;
  const e = (
    type: StopEventType,
    at: string,
    extra: Partial<StopSeqEvent> & { dec?: 'ACCEPT' | 'IGNORE'; decFlags?: string[] } = {},
  ): StopSeqEvent => {
    const { dec, decFlags, ...rest } = extra;
    return {
      id: `t${String(++n).padStart(3, '0')}`,
      type,
      outcome: type === 'COMPLETE' ? 'DELIVERED' : null,
      occurredAt: new Date(`2026-11-17T${at}:00+07:00`),
      receivedAt: new Date(`2026-11-17T12:00:${String(n % 60).padStart(2, '0')}+07:00`),
      lateReason: null,
      clockSkew: false,
      resolutions: dec ? [{ decision: dec, flags: decFlags ?? [], at: new Date() }] : [],
      ...rest,
    };
  };

  it('ปิดงานส่งขณะจุดรับยังไม่ปิด → ธง PICKUP_NOT_DONE ไม่นับ · "ใช้" → นับ', () => {
    const r = effectiveStopSequence([
      e('ARRIVE', '09:00'),
      e('COMPLETE', '09:30', { pickupPending: true }),
    ]);
    expect(r.state).toBe('ARRIVED');
    expect(r.events[1]).toMatchObject({
      seqStatus: 'PICKUP_PENDING',
      counted: false,
      flags: ['PICKUP_NOT_DONE'],
    });
    const ok = effectiveStopSequence([
      e('ARRIVE', '09:00'),
      e('COMPLETE', '09:30', {
        pickupPending: true,
        dec: 'ACCEPT',
        decFlags: ['PICKUP_NOT_DONE'],
      }),
    ]);
    expect(ok.state).toBe('COMPLETED');
    expect(ok.events[1]!.seqStatus).toBe('ACCEPTED');
  });

  it('OUTCOME_MISMATCH เป็นธงแจ้ง: ไม่กระทบการนับ และไม่ทำให้การตัดสินเดิมหมดผล · ปิดธงได้ด้วยการตัดสินที่เห็นธงแล้ว', () => {
    const accepted = e('COMPLETE', '09:30', {
      outcomeMismatch: true,
      dec: 'ACCEPT',
      decFlags: ['SEQUENCE_CONFLICT'],
    });
    const r = effectiveStopSequence([e('DEPART', '08:00'), accepted]);
    expect(r.state).toBe('COMPLETED');
    expect(r.events[1]).toMatchObject({
      counted: true,
      flags: ['SEQUENCE_CONFLICT', 'OUTCOME_MISMATCH'],
      resolution: null,
    });
    const pure = e('COMPLETE', '09:30', { outcomeMismatch: true });
    const p = effectiveStopSequence([e('ARRIVE', '09:00'), pure]);
    expect(p.events[1]).toMatchObject({ counted: true, flags: ['OUTCOME_MISMATCH'] });
    const ack = effectiveStopSequence([
      e('ARRIVE', '09:00'),
      e('COMPLETE', '09:30', {
        outcomeMismatch: true,
        dec: 'ACCEPT',
        decFlags: ['OUTCOME_MISMATCH'],
      }),
    ]);
    expect(ack.events[1]!.resolution).not.toBeNull();
    expect(ack.events[1]!.counted).toBe(true);
  });

  it('ยอมรับปิดงานขัดลำดับ (เวลาก่อนถึงจุด) → ถึงจุดที่ถูกต้องยังนับเวลา ไม่ขึ้นธง (QA L1)', () => {
    const r = effectiveStopSequence([
      e('ARRIVE', '09:10'),
      e('COMPLETE', '09:00', { dec: 'ACCEPT', decFlags: ['SEQUENCE_CONFLICT'] }),
    ]);
    expect(r.state).toBe('COMPLETED');
    expect(r.arrivedAt).toEqual(new Date('2026-11-17T09:10:00+07:00'));
    expect(r.events[1]).toMatchObject({ type: 'ARRIVE', conflict: false, counted: true });
  });
});
