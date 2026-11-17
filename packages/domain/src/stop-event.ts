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
