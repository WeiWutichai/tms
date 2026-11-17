import type { TripStatus } from './trip';

/**
 * Stop event (ST4-T01; docs/04 E1 "Stop event", docs/01 §3.9 `stop_event`) — event หน้างานต่อจุดแวะ (append-only)
 * ฟังก์ชันล้วน ใช้ได้ทั้ง API และเว็บ · การเรียงลำดับ/ธงขัดแย้ง = ST4-T02 · ไล่สถานะ trip_stop → trip → DO → SO = ST4-T03
 */

/**
 * ชนิด event (docs/04 E1): `DEPART` = ออกเดินทางมุ่งหน้าไปจุดนี้ (docs/01 §3.9 — เวลาออกจากจุดก่อนหน้า =
 * DEPART ของจุดถัดไปหรือ COMPLETE) · `ARRIVE` = ถึงจุด · `COMPLETE` = ปิดงานที่จุด (มี outcome) · `FAIL` = ส่งไม่สำเร็จ
 */
export const STOP_EVENT_TYPES = ['ARRIVE', 'DEPART', 'COMPLETE', 'FAIL'] as const;
export type StopEventType = (typeof STOP_EVENT_TYPES)[number];

/** ผลปิดงาน (docs/04 E1: delivered / partial / failed / undelivered_retain) */
export const STOP_OUTCOMES = ['DELIVERED', 'PARTIAL', 'FAILED', 'UNDELIVERED_RETAIN'] as const;
export type StopOutcome = (typeof STOP_OUTCOMES)[number];

/** outcome ที่ใช้กับ FAIL ได้ (ไม่ส่ง = ไม่ระบุ) — DELIVERED/PARTIAL ต้องปิดด้วย COMPLETE */
export const FAIL_OUTCOMES = [
  'FAILED',
  'UNDELIVERED_RETAIN',
] as const satisfies readonly StopOutcome[];

/**
 * แหล่งของ event (docs/01 §3.9): APP = แอปคนขับ (P1) · LINK = ลิงก์รถร่วม M10 (ST4-T08) · WEB = ผู้ใช้บันทึกแทนผ่านเว็บ
 * · API = ระบบภายนอก · GPS = connector — server เป็นผู้กำหนดจากชนิดผู้เรียก (ไม่รับจาก body)
 */
export const STOP_EVENT_SOURCES = ['APP', 'LINK', 'WEB', 'API', 'GPS'] as const;
export type StopEventSource = (typeof STOP_EVENT_SOURCES)[number];

/** เที่ยวที่บันทึก event หน้างานได้: ปล่อยรถแล้วและยังไม่จบ (docs/01 §4.2 DISPATCHED → IN_PROGRESS → COMPLETED) */
export const TRIP_EXECUTION_STATUSES = [
  'DISPATCHED',
  'IN_PROGRESS',
] as const satisfies readonly TripStatus[];

export function isTripExecutable(status: TripStatus): boolean {
  return (TRIP_EXECUTION_STATUSES as readonly string[]).includes(status);
}

/** หมวดเหตุผล (reason master — ST2-T12) ที่ใช้อ้างกับ event ได้ */
export type StopEventReasonCategory =
  'DELIVERY_FAILED' | 'REJECTED_BY_RECEIVER' | 'DELAY' | 'OVERRIDE';

export interface StopEventReasonRule {
  /** ต้องเลือกเหตุผล */
  required: boolean;
  /** หมวดที่รับ (ว่าง = event นี้ไม่รับเหตุผล) */
  categories: readonly StopEventReasonCategory[];
}

const FAIL_REASON: readonly StopEventReasonCategory[] = ['DELIVERY_FAILED', 'REJECTED_BY_RECEIVER'];

/**
 * เหตุผลต่อชนิด/ผล (docs/01 §3.9 `reason_code_id` "geofence นอกรัศมี / ส่งไม่สำเร็จ / ล่าช้า"; docs/01 §4.3 "stop FAILED + reason_code"):
 * - ARRIVE / DEPART: ไม่บังคับ — ล่าช้า (DELAY) หรือกดนอกรัศมี (OVERRIDE)
 * - COMPLETE DELIVERED: ไม่มีเหตุผล · PARTIAL: ไม่บังคับ (เหตุต่อรายการ = ST4-T10)
 * - COMPLETE FAILED / FAIL: บังคับ ส่งไม่สำเร็จ หรือ ปฏิเสธรับ
 * - COMPLETE UNDELIVERED_RETAIN: บังคับ ส่งไม่สำเร็จ (ธง auto-reschedule = ST4-T12)
 */
export function stopEventReasonRule(
  type: StopEventType,
  outcome: StopOutcome | null,
): StopEventReasonRule {
  switch (type) {
    case 'ARRIVE':
    case 'DEPART':
      return { required: false, categories: ['DELAY', 'OVERRIDE'] };
    case 'FAIL':
      return {
        required: true,
        categories: outcome === 'UNDELIVERED_RETAIN' ? ['DELIVERY_FAILED'] : FAIL_REASON,
      };
    case 'COMPLETE':
      if (outcome === 'DELIVERED') return { required: false, categories: [] };
      if (outcome === 'PARTIAL') return { required: false, categories: FAIL_REASON };
      if (outcome === 'UNDELIVERED_RETAIN')
        return { required: true, categories: ['DELIVERY_FAILED'] };
      return { required: true, categories: FAIL_REASON };
  }
}

/**
 * ตรวจคู่ชนิด/ผล (CHECK `stop_event_outcome` ในฐานตัวเดียวกัน) — คืนรหัสข้อผิดพลาดของช่อง `outcome` หรือ null
 * `required` = COMPLETE ไม่มี outcome · `not_applicable` = ARRIVE/DEPART มี outcome · `invalid` = FAIL กับ DELIVERED/PARTIAL
 */
export function stopOutcomeError(
  type: StopEventType,
  outcome: StopOutcome | null,
): 'required' | 'not_applicable' | 'invalid' | null {
  if (type === 'COMPLETE') return outcome === null ? 'required' : null;
  if (type === 'FAIL')
    return outcome === null || (FAIL_OUTCOMES as readonly string[]).includes(outcome)
      ? null
      : 'invalid';
  return outcome === null ? null : 'not_applicable';
}

/* ------------------------------------------------------------------------------------------------
 * ST4-T02 Server idempotent + ลำดับ + ธงขัดแย้ง (docs/04 E1 "Idempotent server", docs/01 §3.9)
 * ---------------------------------------------------------------------------------------------- */

/**
 * สถานะการปฏิบัติงานของจุด (คำนวณจาก event ที่เรียงแล้ว — ไม่ใช่คอลัมน์ `trip_stop.status`; ST4-T03 แมปลง projection)
 * PENDING ยังไม่มี event · EN_ROUTE ออกเดินทางมุ่งหน้าไปจุดนี้ (DEPART) · ARRIVED ถึงจุด
 * COMPLETED ปิดงาน DELIVERED/PARTIAL · FAILED ปิดงาน FAILED/UNDELIVERED_RETAIN หรือ FAIL
 */
export const STOP_EXEC_STATES = ['PENDING', 'EN_ROUTE', 'ARRIVED', 'COMPLETED', 'FAILED'] as const;
export type StopExecState = (typeof STOP_EXEC_STATES)[number];

const STATE_RANK: Record<StopExecState, number> = {
  PENDING: 0,
  EN_ROUTE: 1,
  ARRIVED: 2,
  COMPLETED: 3,
  FAILED: 3,
};

export function isTerminalStopState(s: StopExecState): boolean {
  return s === 'COMPLETED' || s === 'FAILED';
}

/** สถานะปลายทางของ event (ใช้ทั้งการเปลี่ยนปกติและเมื่อ dispatcher ยอมรับ event ที่ขัดลำดับ) */
export function stopEventTarget(type: StopEventType, outcome: StopOutcome | null): StopExecState {
  switch (type) {
    case 'DEPART':
      return 'EN_ROUTE';
    case 'ARRIVE':
      return 'ARRIVED';
    case 'FAIL':
      return 'FAILED';
    case 'COMPLETE':
      return outcome === 'DELIVERED' || outcome === 'PARTIAL' ? 'COMPLETED' : 'FAILED';
  }
}

/**
 * state machine ต่อจุด (docs/01 §3.9 + spec/04 §0.1 ตาราง Stop) — ผลของ event หนึ่งตัวต่อสถานะปัจจุบัน
 * - `apply`     เปลี่ยนตามปกติ: DEPART จาก PENDING · ARRIVE จาก PENDING/EN_ROUTE · COMPLETE จาก ARRIVED
 *               · FAIL จาก PENDING/EN_ROUTE/ARRIVED (ไปไม่ถึงจุดก็ส่งไม่สำเร็จได้)
 * - `redundant` ซ้ำความหมาย ไม่เปลี่ยนสถานะ ไม่ขัดแย้ง: ARRIVE ขณะ ARRIVED (DRV-073 `occurredAt` ก่อนชนะ) · DEPART ขณะ EN_ROUTE
 * - `conflict`  ขัดลำดับ: COMPLETE ก่อน ARRIVE (ตัวอย่างใน docs/01 §3.9) · DEPART หลังถึงจุดแล้ว · ทุก event หลังปิดงาน
 */
export function stopEventTransition(
  state: StopExecState,
  type: StopEventType,
): 'apply' | 'redundant' | 'conflict' {
  if (isTerminalStopState(state)) return 'conflict';
  switch (type) {
    case 'DEPART':
      return state === 'PENDING' ? 'apply' : state === 'EN_ROUTE' ? 'redundant' : 'conflict';
    case 'ARRIVE':
      return state === 'ARRIVED' ? 'redundant' : 'apply';
    case 'COMPLETE':
      return state === 'ARRIVED' ? 'apply' : 'conflict';
    case 'FAIL':
      return 'apply';
  }
}

/** ลำดับชนิดเมื่อ `occurredAt` เท่ากัน (ออกเดินทาง → ถึง → ปิดงาน) */
const TYPE_RANK: Record<StopEventType, number> = { DEPART: 0, ARRIVE: 1, COMPLETE: 2, FAIL: 2 };

/**
 * เหตุที่ event มาหลังเที่ยว/จุดปิดไปแล้ว (spec/04 DRV-072/075 — รับเก็บเป็นประวัติ ไม่ทิ้งหลักฐาน + ธงให้ dispatcher ตัดสิน)
 * STOP_REMOVED จุดถูกถอดออกจากเที่ยว (ยกเลิก/ย้าย DO) · TRIP_CANCELLED เที่ยวถูกยกเลิก · TRIP_COMPLETED เที่ยวจบแล้ว (COMPLETED ขึ้นไป)
 */
export const STOP_EVENT_LATE_REASONS = [
  'STOP_REMOVED',
  'TRIP_CANCELLED',
  'TRIP_COMPLETED',
] as const;
export type StopEventLateReason = (typeof STOP_EVENT_LATE_REASONS)[number];

/**
 * event ของจุด/เที่ยวนี้รับได้ไหม: `ok` = ปกติ · `late` = รับ + ธง (เหตุ) · `reject` = เที่ยวยังไม่ปล่อยรถ (409 trip_not_in_progress)
 */
export function stopEventAdmission(
  tripStatus: TripStatus,
  stopRemoved: boolean,
): { kind: 'ok' } | { kind: 'late'; reason: StopEventLateReason } | { kind: 'reject' } {
  if (stopRemoved) return { kind: 'late', reason: 'STOP_REMOVED' };
  if (tripStatus === 'CANCELLED') return { kind: 'late', reason: 'TRIP_CANCELLED' };
  if (tripStatus === 'COMPLETED' || tripStatus === 'COSTED' || tripStatus === 'SETTLED')
    return { kind: 'late', reason: 'TRIP_COMPLETED' };
  return isTripExecutable(tripStatus) ? { kind: 'ok' } : { kind: 'reject' };
}

/**
 * นาฬิกาเครื่องเพี้ยน (docs/01 §3.9 "ถ้าเพี้ยนจาก received_at > 24 ชม. → flag clock_skew") — ธงอย่างเดียว ไม่แก้ค่า `occurredAt`
 * + เวลาอนาคตเกิน 5 นาที (ค่าเผื่อจาก spec/04 DRV-066) ซึ่งเกิดจริงไม่ได้
 */
export const CLOCK_SKEW_FUTURE_MS = 5 * 60_000;
export const CLOCK_SKEW_PAST_MS = 24 * 3600_000;
export function isClockSkewed(occurredAt: Date, receivedAt: Date): boolean {
  const d = occurredAt.getTime() - receivedAt.getTime();
  return d > CLOCK_SKEW_FUTURE_MS || -d > CLOCK_SKEW_PAST_MS;
}

/** ธงที่ dispatcher ต้องตัดสิน (หน้า ศูนย์ข้อยกเว้น) — event หนึ่งมีได้หลายธง เรียงตามความสำคัญ */
export const STOP_EVENT_FLAGS = ['LATE', 'SEQUENCE_CONFLICT', 'CLOCK_SKEW'] as const;
export type StopEventFlag = (typeof STOP_EVENT_FLAGS)[number];
export function stopEventFlagsOf(e: {
  lateReason: string | null;
  sequenceConflict: boolean;
  clockSkew: boolean;
}): StopEventFlag[] {
  const out: StopEventFlag[] = [];
  if (e.lateReason) out.push('LATE');
  if (e.sequenceConflict) out.push('SEQUENCE_CONFLICT');
  if (e.clockSkew) out.push('CLOCK_SKEW');
  return out;
}

/**
 * การตัดสินของ dispatcher (แถวใหม่ใน `stop_event_resolution` + เหตุผล + audit — ไม่ใช่พลิกธง)
 * ACCEPT = ใช้ event นี้ (นับในลำดับแม้ขัด / มาหลังปิด) · IGNORE = ไม่ใช้ (เก็บเป็นประวัติเท่านั้น)
 */
export const STOP_EVENT_DECISIONS = ['ACCEPT', 'IGNORE'] as const;
export type StopEventDecision = (typeof STOP_EVENT_DECISIONS)[number];

export interface StopSeqEvent {
  id: string;
  type: StopEventType;
  outcome: StopOutcome | null;
  occurredAt: Date;
  receivedAt: Date;
  lateReason: StopEventLateReason | null;
  decision: StopEventDecision | null;
}

/**
 * ผลของ event ในลำดับ: APPLIED เปลี่ยนสถานะ · REDUNDANT ซ้ำความหมาย (นับเวลา ไม่เปลี่ยนสถานะ)
 * · CONFLICT ขัดลำดับ รอ dispatcher (ไม่นับ) · ACCEPTED ขัด/มาหลังปิด แต่ dispatcher ยอมรับ (นับ)
 * · IGNORED dispatcher ไม่ใช้ · LATE มาหลังเที่ยว/จุดปิด รอ dispatcher (ไม่นับ)
 */
export type StopSeqStatus = 'APPLIED' | 'REDUNDANT' | 'CONFLICT' | 'ACCEPTED' | 'IGNORED' | 'LATE';

export interface StopSeqResult<E extends StopSeqEvent = StopSeqEvent> {
  /** event ทั้งหมดเรียงตามลำดับที่ใช้ตัดสิน */
  events: (E & {
    seqStatus: StopSeqStatus;
    conflict: boolean;
    counted: boolean;
    /** สถานะของจุดก่อน event นี้ (ตามลำดับที่มีผล) */
    stateBefore: StopExecState;
  })[];
  state: StopExecState;
  outcome: StopOutcome | null;
  /** DEPART แรกที่นับ (ออกเดินทางมุ่งหน้าไปจุดนี้) */
  enRouteAt: Date | null;
  /** min(ARRIVE ที่นับ) — docs/01 §3.9 `arrived_at` */
  arrivedAt: Date | null;
  /** เวลาของ event ที่ทำให้ปิดงาน (COMPLETE/FAIL ที่นับล่าสุด) */
  closedAt: Date | null;
  /** event ที่เปลี่ยนสถานะล่าสุด (`trip_stop.last_event_id` — ST4-T03) */
  lastEventId: string | null;
}

/** เรียง: `occurredAt` → ชนิด (ออก → ถึง → ปิด) → `receivedAt` → id (คงที่ทุกครั้ง) */
export function compareStopEvents(a: StopSeqEvent, b: StopSeqEvent): number {
  return (
    a.occurredAt.getTime() - b.occurredAt.getTime() ||
    TYPE_RANK[a.type] - TYPE_RANK[b.type] ||
    a.receivedAt.getTime() - b.receivedAt.getTime() ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * ลำดับ event ที่มีผลของจุดหนึ่ง (docs/01 §3.9 "เรียงด้วย occurred_at ต่อ trip_stop_id ก่อน apply state machine") —
 * ฟังก์ชันล้วน: เรียกซ้ำได้ทุกครั้งที่มี event/การตัดสินใหม่ ผลเหมือนเดิมไม่ว่า event มาถึงลำดับใด
 * `conflict` ของแต่ละ event = ขัด state machine เมื่อเทียบกับ event ก่อนหน้าที่นับ (ไม่ขึ้นกับการตัดสินของตัวเอง) → คอลัมน์ `sequence_conflict`
 * ST4-T03 ใช้ `state` / `outcome` / `arrivedAt` / `closedAt` / `lastEventId` ไปไล่สถานะ trip_stop → trip → DO → SO
 */
export function effectiveStopSequence<E extends StopSeqEvent>(
  input: readonly E[],
): StopSeqResult<E> {
  const sorted = [...input].sort(compareStopEvents);
  let state: StopExecState = 'PENDING';
  let outcome: StopOutcome | null = null;
  let enRouteAt: Date | null = null;
  let arrivedAt: Date | null = null;
  let closedAt: Date | null = null;
  let lastEventId: string | null = null;
  const events: StopSeqResult<E>['events'] = [];

  for (const e of sorted) {
    const before = state;
    if (e.decision === 'IGNORE') {
      // ธงขัดลำดับคงตามจริง (ไม่ขึ้นกับการตัดสินของตัวเอง) — แต่ไม่นับ
      const conflict = !e.lateReason && stopEventTransition(state, e.type) === 'conflict';
      events.push({
        ...e,
        stateBefore: before,
        seqStatus: 'IGNORED',
        conflict,
        counted: false,
      });
      continue;
    }
    if (e.lateReason && e.decision !== 'ACCEPT') {
      events.push({
        ...e,
        stateBefore: before,
        seqStatus: 'LATE',
        conflict: false,
        counted: false,
      });
      continue;
    }
    const tr = stopEventTransition(state, e.type);
    const conflict = tr === 'conflict';
    let seqStatus: StopSeqStatus;
    if (tr === 'conflict' && e.decision !== 'ACCEPT') {
      events.push({ ...e, stateBefore: before, seqStatus: 'CONFLICT', conflict, counted: false });
      continue;
    }
    const target = stopEventTarget(e.type, e.outcome);
    if (tr === 'apply' || (tr === 'conflict' && STATE_RANK[target] >= STATE_RANK[state])) {
      state = target;
      if (isTerminalStopState(target)) {
        outcome = e.type === 'FAIL' ? (e.outcome ?? 'FAILED') : e.outcome;
        closedAt = e.occurredAt;
      }
      lastEventId = e.id;
    }
    seqStatus = conflict || e.lateReason ? 'ACCEPTED' : tr === 'apply' ? 'APPLIED' : 'REDUNDANT';
    if (e.type === 'DEPART' && !enRouteAt) enRouteAt = e.occurredAt;
    if (e.type === 'ARRIVE' && (!arrivedAt || e.occurredAt < arrivedAt)) arrivedAt = e.occurredAt;
    events.push({ ...e, stateBefore: before, seqStatus, conflict, counted: true });
  }
  return { events, state, outcome, enRouteAt, arrivedAt, closedAt, lastEventId };
}
