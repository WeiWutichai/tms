import type { TripStatus } from './trip';

/**
 * Stop event (ST4-T01; docs/04 E1 "Stop event", docs/01 §3.9 `stop_event`) — event หน้างานต่อจุดแวะ (append-only)
 * ฟังก์ชันล้วน ใช้ได้ทั้ง API และเว็บ · การเรียงลำดับ/ธงขัดแย้ง = ST4-T02 · ไล่สถานะ trip_stop → trip → DO → SO = ST4-T03
 */

/**
 * ชนิด event (docs/04 E1): `DEPART` = ออกเดินทางมุ่งหน้าไปจุดนี้ (docs/01 §3.9 — เวลาออกจากจุดก่อนหน้า =
 * DEPART ของจุดถัดไปหรือ COMPLETE) · `ARRIVE` = ถึงจุด · `COMPLETE` = ปิดงานที่จุด (มี outcome) · `FAIL` = ส่งไม่สำเร็จ
 * · `LOADED` = ขึ้นของเสร็จ — **จุดรับเท่านั้น** (docs/01 §3.9; D-81 · D68-39) ปิดจุดรับสำเร็จ (ผลเท่ากับรับของครบ, ไม่มี outcome)
 */
export const STOP_EVENT_TYPES = ['ARRIVE', 'DEPART', 'LOADED', 'COMPLETE', 'FAIL'] as const;
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
    case 'LOADED':
      return { required: false, categories: [] };
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
 * `required` = COMPLETE ไม่มี outcome · `not_applicable` = ARRIVE/DEPART/LOADED มี outcome · `invalid` = FAIL กับ DELIVERED/PARTIAL
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
    case 'LOADED':
      return 'COMPLETED';
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
    case 'LOADED':
      return state === 'ARRIVED' ? 'apply' : 'conflict';
    case 'FAIL':
      return 'apply';
  }
}

/** ลำดับชนิดเมื่อ `occurredAt` เท่ากัน (ออกเดินทาง → ถึง → ปิดงาน) */
const TYPE_RANK: Record<StopEventType, number> = {
  DEPART: 0,
  ARRIVE: 1,
  LOADED: 2,
  COMPLETE: 2,
  FAIL: 2,
};

/**
 * เหตุที่ event มาหลังเที่ยว/จุดปิดไปแล้ว (spec/04 DRV-072/075 — รับเก็บเป็นประวัติ ไม่ทิ้งหลักฐาน + ธงให้ dispatcher ตัดสิน)
 * STOP_REMOVED จุดถูกถอดออกจากเที่ยว (ยกเลิก/ย้าย DO) · TRIP_CANCELLED เที่ยวถูกยกเลิก · TRIP_COMPLETED เที่ยวจบแล้ว (COMPLETED ขึ้นไป)
 * · BILLING_LOCKED (ST5-T06) DO ของจุดส่งบัญชีแล้ว/อยู่ในใบแจ้งหนี้ — event จากเครื่อง/ลิงก์/API (เช่น offline) รับเก็บ ไม่นับ
 */
export const STOP_EVENT_LATE_REASONS = [
  'STOP_REMOVED',
  'TRIP_CANCELLED',
  'TRIP_COMPLETED',
  'BILLING_LOCKED',
] as const;
export type StopEventLateReason = (typeof STOP_EVENT_LATE_REASONS)[number];

/**
 * event ของจุด/เที่ยวนี้รับได้ไหม: `ok` = ปกติ · `late` = รับ + ธง (เหตุ) · `reject` = เที่ยวยังไม่ปล่อยรถ (409 trip_not_in_progress)
 * รับแบบ late เฉพาะเที่ยวที่เคยปล่อยรถแล้ว (`dispatched`) — จุดที่ถอด/เที่ยวที่ยกเลิกก่อนปล่อยรถ คนขับไม่เคยได้งาน → ปฏิเสธเหมือนปกติ
 */
export function stopEventAdmission(
  tripStatus: TripStatus,
  stopRemoved: boolean,
  dispatched: boolean,
): { kind: 'ok' } | { kind: 'late'; reason: StopEventLateReason } | { kind: 'reject' } {
  if (stopRemoved)
    return dispatched ? { kind: 'late', reason: 'STOP_REMOVED' } : { kind: 'reject' };
  if (tripStatus === 'CANCELLED')
    return dispatched ? { kind: 'late', reason: 'TRIP_CANCELLED' } : { kind: 'reject' };
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

/**
 * ธงที่ dispatcher ต้องตัดสิน (หน้า ศูนย์ข้อยกเว้น) — event หนึ่งมีได้หลายธง เรียงตามความสำคัญ
 * ST4-T03: `PICKUP_NOT_DONE` = ปิดงานส่งสำเร็จ/บางส่วนที่จุดส่ง ขณะจุดรับของ DO ที่ส่งที่นี่ยังไม่ปิดสำเร็จ (ไม่นับจนกว่ารับของเสร็จหรือ "ใช้")
 * · `OUTCOME_MISMATCH` = ผลปิดจุดที่มีผลขัดกับสถานะ DO ที่ไล่ไปแล้ว (DO ไม่ถอยหลัง) — **ธงแจ้งเท่านั้น** ไม่กระทบการนับ ตัดสินได้แค่ "รับทราบ" (ACCEPT)
 */
export const STOP_EVENT_FLAGS = [
  'LATE',
  'SEQUENCE_CONFLICT',
  'PICKUP_NOT_DONE',
  'CLOCK_SKEW',
  'OUTCOME_MISMATCH',
] as const;
export type StopEventFlag = (typeof STOP_EVENT_FLAGS)[number];
export function stopEventFlagsOf(e: {
  lateReason: string | null;
  sequenceConflict: boolean;
  clockSkew: boolean;
  pickupPending?: boolean;
  outcomeMismatch?: boolean;
}): StopEventFlag[] {
  const out: StopEventFlag[] = [];
  if (e.lateReason) out.push('LATE');
  if (e.sequenceConflict) out.push('SEQUENCE_CONFLICT');
  if (e.pickupPending) out.push('PICKUP_NOT_DONE');
  if (e.clockSkew) out.push('CLOCK_SKEW');
  if (e.outcomeMismatch) out.push('OUTCOME_MISMATCH');
  return out;
}

/** ธงแจ้งเท่านั้น (ไม่กระทบการนับ — การตัดสิน = รับทราบ) */
export const INFO_ONLY_FLAGS = ['OUTCOME_MISMATCH'] as const satisfies readonly StopEventFlag[];
const isInfoFlag = (f: string) => (INFO_ONLY_FLAGS as readonly string[]).includes(f);

/**
 * การตัดสินของ dispatcher (แถวใหม่ใน `stop_event_resolution` + เหตุผล + audit — ไม่ใช่พลิกธง)
 * ACCEPT = ใช้ event นี้ (นับในลำดับแม้ขัด / มาหลังปิด / เวลาเพี้ยน) · IGNORE = ไม่ใช้ (เก็บเป็นประวัติเท่านั้น)
 * การตัดสินมีผลเฉพาะเมื่อชุดธง ณ เวลาตัดสิน = ชุดธงปัจจุบัน — ธงเปลี่ยน (event อื่นมาถึงทีหลัง) = การตัดสินหมดผล
 * ต้องตัดสินใหม่ (หลักเดียวกับการยืนยันคำเตือนของ ST3-T14)
 */
export const STOP_EVENT_DECISIONS = ['ACCEPT', 'IGNORE'] as const;
export type StopEventDecision = (typeof STOP_EVENT_DECISIONS)[number];

export interface StopSeqResolution {
  decision: StopEventDecision;
  /** ธง ณ เวลาตัดสิน */
  flags: readonly string[];
  /** เวลาตัดสิน (ใหม่สุดที่ธงตรงมีผล) */
  at: Date;
}

export interface StopSeqEvent<R extends StopSeqResolution = StopSeqResolution> {
  id: string;
  type: StopEventType;
  outcome: StopOutcome | null;
  occurredAt: Date;
  receivedAt: Date;
  lateReason: StopEventLateReason | null;
  clockSkew: boolean;
  /** ST4-T03: ปิดงานส่งขณะจุดรับยังไม่ปิด (คำนวณโดย projection ของเที่ยว) */
  pickupPending?: boolean;
  /** ST4-T03: ผลปิดจุดขัดกับ DO (ธงแจ้งเท่านั้น) */
  outcomeMismatch?: boolean;
  /** การตัดสินทั้งหมดของ event (ลำดับใดก็ได้) */
  resolutions: readonly R[];
}

/**
 * ผลของ event ในลำดับ: APPLIED เปลี่ยนสถานะ · REDUNDANT ซ้ำความหมาย (นับเวลา ไม่เปลี่ยนสถานะ)
 * · CONFLICT ขัดลำดับ รอ dispatcher (ไม่นับ) · ACCEPTED dispatcher ยอมรับ (นับ) · IGNORED dispatcher ไม่ใช้
 * · LATE มาหลังเที่ยว/จุดปิด รอ dispatcher (ไม่นับ) · SKEWED เวลาเครื่องเพี้ยน รอ dispatcher (ไม่นับ)
 */
export type StopSeqStatus =
  | 'APPLIED'
  | 'REDUNDANT'
  | 'CONFLICT'
  | 'ACCEPTED'
  | 'IGNORED'
  | 'LATE'
  | 'SKEWED'
  | 'PICKUP_PENDING';

export interface StopSeqResult<E extends StopSeqEvent, R extends StopSeqResolution> {
  /** event ทั้งหมดเรียงตามลำดับที่ใช้ตัดสิน */
  events: (E & {
    seqStatus: StopSeqStatus;
    /** ขัดลำดับ (→ คอลัมน์ `sequence_conflict`) — ไม่ขึ้นกับการตัดสินของ event ตัวเอง */
    conflict: boolean;
    /** ธงปัจจุบัน */
    flags: StopEventFlag[];
    /** การตัดสินที่มีผล (ใหม่สุดที่ธงตรงกับธงปัจจุบัน) */
    resolution: R | null;
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
  /** เวลาของ event ที่ทำให้ปิดงาน */
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

const sameFlags = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/**
 * การตัดสินที่มีผล: ใหม่สุดที่ชุดธงตรงกับธงปัจจุบัน (ธงเปลี่ยน = การตัดสินเดิมหมดผล) — เทียบเฉพาะธงที่กระทบการนับ
 * (ธงแจ้งเท่านั้นมา/หายไม่ทำให้การตัดสินเดิมหมดผล — กันวนไปมา) · ไม่มีธงที่กระทบการนับ = null
 */
export function applicableResolution<R extends StopSeqResolution>(
  resolutions: readonly R[],
  flags: readonly string[],
): R | null {
  const core = flags.filter((f) => !isInfoFlag(f));
  if (!core.length) return null;
  return newestMatching(resolutions, core);
}

function newestMatching<R extends StopSeqResolution>(
  resolutions: readonly R[],
  core: readonly string[],
): R | null {
  let best: R | null = null;
  for (const r of resolutions)
    if (
      sameFlags(
        r.flags.filter((f) => !isInfoFlag(f)),
        core,
      ) &&
      (!best || r.at.getTime() >= best.at.getTime())
    )
      best = r;
  return best;
}

/**
 * การตัดสินที่แสดง/ปิดธง (`resolution_id`): ไม่มีธงแจ้ง = ตัวเดียวกับที่นับ · มีธงแจ้ง (OUTCOME_MISMATCH) = ใหม่สุดที่ตรง
 * และตัดสินหลังเห็นธงแจ้งแล้ว (ธงของการตัดสินมี OUTCOME_MISMATCH)
 */
export function displayResolution<R extends StopSeqResolution>(
  resolutions: readonly R[],
  flags: readonly string[],
): R | null {
  if (!flags.some(isInfoFlag)) return applicableResolution(resolutions, flags);
  const core = flags.filter((f) => !isInfoFlag(f));
  // ธงที่กระทบการนับต้องตัดสินแล้วก่อน แล้วธงแจ้งต้องมีการ "รับทราบ" ของมันเอง (ST4-T11 QA M3):
  // การตัดสินแบบเดิมที่บันทึกธงครบ (หลักธง + ธงแจ้ง) หรือการรับทราบธงแจ้งอย่างเดียว (หลักธงว่าง) — ใหม่สุด
  if (core.length && !newestMatching(resolutions, core)) return null;
  let best: R | null = null;
  for (const r of resolutions) {
    if (!r.flags.some(isInfoFlag)) continue;
    const rc = r.flags.filter((f) => !isInfoFlag(f));
    if (rc.length && !sameFlags(rc, core)) continue;
    if (!best || r.at.getTime() >= best.at.getTime()) best = r;
  }
  return best;
}

/** event ปิดงานของจุด (ปิดจุดรับด้วย LOADED ได้ — D68-39) */
export const isStopCloseType = (t: string) => t === 'COMPLETE' || t === 'FAIL' || t === 'LOADED';
const isClose = (t: StopEventType) => isStopCloseType(t);

/**
 * ลำดับ event ที่มีผลของจุดหนึ่ง (docs/01 §3.9 "เรียงด้วย occurred_at ต่อ trip_stop_id ก่อน apply state machine") —
 * ฟังก์ชันล้วน: เรียกซ้ำได้ทุกครั้งที่มี event/การตัดสินใหม่ ผลเหมือนเดิมไม่ว่า event มาถึงลำดับใด
 * - ธงของ event ไม่ขึ้นกับการตัดสินของตัวเอง (ขัดลำดับ = เทียบกับ event ก่อนหน้าที่นับ) → การตัดสินที่ธงไม่ตรงหมดผล
 * - event มาหลังปิด (LATE) / เวลาเพี้ยน (SKEWED) ไม่นับจนกว่า dispatcher ยอมรับ
 * - ปิดงานแข่งกัน (COMPLETE/FAIL ≥ 2 ตัวที่ไม่ใช่ LATE/เวลาเพี้ยน — docs/04 E1 "ขัดแย้ง → เก็บทั้งคู่ + flag"): **ทุกตัวขึ้นธง**
 *   ตัวที่มีผล = ตัวที่ dispatcher ยอมรับล่าสุด ถ้าไม่มี = ตัวที่ server รับก่อน (ไม่ให้ event ที่มาทีหลังพลิกผลเงียบ ๆ)
 *   ตัวที่ dispatcher ไม่ใช้ ไม่นับ · ตัวอื่นที่ยังไม่ตัดสิน ไม่นับ
 * ST4-T03 ใช้ `state` / `outcome` / `arrivedAt` / `closedAt` / `lastEventId` ไปไล่สถานะ trip_stop → trip → DO → SO
 */
export function effectiveStopSequence<E extends StopSeqEvent>(
  input: readonly E[],
): StopSeqResult<E, E['resolutions'][number]> {
  type R = E['resolutions'][number];
  const sorted = [...input].sort(compareStopEvents);
  // ปิดงานที่แข่งกัน — ธงของผู้แข่งคงที่ (= SEQUENCE_CONFLICT เท่านั้น) จึงหาการตัดสินได้ก่อนเดินลำดับ
  const rivals = sorted.filter((e) => isClose(e.type) && !e.lateReason && !e.clockSkew);
  let winner: string | null = null;
  if (rivals.length >= 2) {
    const dec = rivals.map((e) => ({
      e,
      r: applicableResolution(e.resolutions, ['SEQUENCE_CONFLICT']),
    }));
    const accepted = dec
      .filter((x) => x.r?.decision === 'ACCEPT')
      .sort((a, b) => b.r!.at.getTime() - a.r!.at.getTime());
    const open = dec
      .filter((x) => x.r?.decision !== 'IGNORE')
      .sort(
        (a, b) => a.e.receivedAt.getTime() - b.e.receivedAt.getTime() || (a.e.id < b.e.id ? -1 : 1),
      );
    winner = accepted[0]?.e.id ?? open[0]?.e.id ?? null;
  }
  const racing = new Set(rivals.length >= 2 ? rivals.map((e) => e.id) : []);

  let state: StopExecState = 'PENDING';
  /** ปิดงานด้วย event ขัดลำดับที่ผู้จัดรถ "ใช้" → ถึง/ออกที่ตามมา (เวลาเครื่อง) นับเป็นเวลา ไม่ขึ้นธง (ไม่ลบเวลาถึงที่ถูกต้อง) */
  let closedByAccept = false;
  let outcome: StopOutcome | null = null;
  let enRouteAt: Date | null = null;
  let arrivedAt: Date | null = null;
  let closedAt: Date | null = null;
  let lastEventId: string | null = null;
  const events: StopSeqResult<E, R>['events'] = [];

  for (const e of sorted) {
    const before = state;
    let tr = stopEventTransition(state, e.type);
    if (
      tr === 'conflict' &&
      closedByAccept &&
      (e.type === 'ARRIVE' || e.type === 'DEPART') &&
      !racing.has(e.id)
    )
      tr = 'redundant';
    const conflict = tr === 'conflict' || racing.has(e.id);
    const flags = stopEventFlagsOf({
      lateReason: e.lateReason,
      sequenceConflict: conflict,
      clockSkew: e.clockSkew,
      pickupPending: !!e.pickupPending,
      outcomeMismatch: !!e.outcomeMismatch,
    });
    const counting: R | null = applicableResolution<R>(e.resolutions, flags);
    const resolution: R | null = displayResolution<R>(e.resolutions, flags);
    const decision = counting?.decision ?? null;
    const base = { ...e, stateBefore: before, conflict, flags, resolution };
    const hold = (seqStatus: StopSeqStatus) => events.push({ ...base, seqStatus, counted: false });
    if (decision === 'IGNORE') {
      hold('IGNORED');
      continue;
    }
    if (e.lateReason && decision !== 'ACCEPT') {
      hold('LATE');
      continue;
    }
    if (e.clockSkew && decision !== 'ACCEPT') {
      hold('SKEWED');
      continue;
    }
    if (e.pickupPending && decision !== 'ACCEPT') {
      hold('PICKUP_PENDING');
      continue;
    }
    // ปิดงานแข่งกัน: นับเฉพาะตัวที่มีผล
    if (racing.has(e.id) && e.id !== winner) {
      hold('CONFLICT');
      continue;
    }
    if (tr === 'conflict' && decision !== 'ACCEPT') {
      hold('CONFLICT');
      continue;
    }
    const target = stopEventTarget(e.type, e.outcome);
    if (tr === 'apply' || (tr === 'conflict' && STATE_RANK[target] >= STATE_RANK[state])) {
      state = target;
      if (isTerminalStopState(target)) {
        // LOADED (ขึ้นของเสร็จที่จุดรับ) = ผลเท่ากับรับของครบ
        outcome =
          e.type === 'FAIL'
            ? (e.outcome ?? 'FAILED')
            : e.type === 'LOADED'
              ? 'DELIVERED'
              : e.outcome;
        closedAt = e.occurredAt;
        closedByAccept = tr === 'conflict';
      }
      lastEventId = e.id;
    }
    const seqStatus: StopSeqStatus =
      decision === 'ACCEPT' ? 'ACCEPTED' : tr === 'apply' ? 'APPLIED' : 'REDUNDANT';
    if (e.type === 'DEPART' && !enRouteAt) enRouteAt = e.occurredAt;
    if (e.type === 'ARRIVE' && (!arrivedAt || e.occurredAt < arrivedAt)) arrivedAt = e.occurredAt;
    events.push({ ...base, seqStatus, counted: true });
  }
  return { events, state, outcome, enRouteAt, arrivedAt, closedAt, lastEventId };
}
