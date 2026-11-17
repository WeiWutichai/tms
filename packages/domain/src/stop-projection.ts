import { DO_TRANSITIONS, type DoEvent, type DoStatus } from './delivery-order';
import { SO_TRANSITIONS, type SoEvent, type SoStatus } from './sales-order';
import type { StopExecState, StopOutcome } from './stop-event';
import { STOP_TERMINAL_STATUSES, TRIP_TRANSITIONS, type TripEvent, type TripStatus } from './trip';

/**
 * ไล่สถานะจาก stop event (ST4-T03; docs/04 D1 "สถานะ trip ส่วนคำนวณจาก stops", docs/01 §3.9, §4.1–4.3) — ฟังก์ชันล้วน
 * ผู้เรียกส่งผลของ `effectiveStopSequence` (เฉพาะ event ที่นับ) ต่อจุด แล้วได้ projection ของ trip_stop
 * และ event ที่ต้องเปลี่ยนของเที่ยว / DO / SO — เรียกซ้ำกี่ครั้งก็ได้ผลเดิม (idempotent)
 *
 * กติกาไม่ถอยหลัง (docs/01 §4.2/§4.3 ไม่มีเส้นย้อน): เที่ยว IN_PROGRESS/COMPLETED ไม่กลับ · DO ที่ส่งแล้ว/ไม่สำเร็จไม่เปลี่ยนกลับ
 * — trip_stop เป็น projection ล้วนจึงตาม event ที่มีผลเสมอ (ขณะเที่ยวยังวิ่ง) แม้ผลจะต่างจาก DO ที่ไล่ไปแล้ว (spec/12 §3)
 */

/** สถานะ `trip_stop.status` (enum stop_status) */
export type StopRowStatus = 'PENDING' | 'ARRIVED' | 'COMPLETED' | 'FAILED' | 'SKIPPED';

/** สถานะการปฏิบัติงาน (คำนวณ) → คอลัมน์ trip_stop (EN_ROUTE ไม่มีใน enum → PENDING; เวลาออกเดินทางอยู่ที่ departedAt ของจุดก่อนหน้า) */
export function stopRowStatusOf(state: StopExecState): StopRowStatus {
  switch (state) {
    case 'PENDING':
    case 'EN_ROUTE':
      return 'PENDING';
    case 'ARRIVED':
      return 'ARRIVED';
    case 'COMPLETED':
      return 'COMPLETED';
    case 'FAILED':
      return 'FAILED';
  }
}

export interface StopProjectionInput {
  id: string;
  sequence: number;
  /** สถานะในแถวตอนนี้ — SKIPPED (ผู้จัดรถข้ามจุด) ไม่ถูก event ทับ */
  currentStatus: StopRowStatus;
  state: StopExecState;
  outcome: StopOutcome | null;
  enRouteAt: Date | null;
  arrivedAt: Date | null;
  closedAt: Date | null;
  lastEventId: string | null;
  /** เหตุผลของ event ที่ปิดงาน (เมื่อ FAILED) */
  closeReasonCodeId: string | null;
}

export interface StopProjection {
  id: string;
  status: StopRowStatus;
  outcome: StopOutcome | null;
  arrivedAt: Date | null;
  departedAt: Date | null;
  lastEventId: string | null;
  failReasonCodeId: string | null;
}

/**
 * projection ของทุกจุดที่ยังใช้ของเที่ยว (docs/01 §3.9): `arrived_at = min(ARRIVE)` ·
 * `departed_at` = DEPART ของจุดถัดไป (ตามลำดับ) ถ้ามี ไม่งั้นเวลาปิดงานของจุดนี้ (COMPLETE/FAIL) — เฉพาะจุดที่ถึงแล้ว
 * · `last_event_id` = event ที่เปลี่ยนสถานะล่าสุด
 */
export function projectStops(stops: readonly StopProjectionInput[]): StopProjection[] {
  const ordered = [...stops].sort((a, b) => a.sequence - b.sequence);
  return ordered.map((s, i) => {
    const next = ordered[i + 1];
    const skipped = s.currentStatus === 'SKIPPED' && s.state === 'PENDING';
    const status = skipped ? 'SKIPPED' : stopRowStatusOf(s.state);
    return {
      id: s.id,
      status,
      outcome: status === 'COMPLETED' || status === 'FAILED' ? s.outcome : null,
      arrivedAt: s.arrivedAt,
      // ไม่เคยถึงจุด (เช่น ส่งไม่สำเร็จระหว่างทาง) = ไม่มีเวลาออกจากจุด (review L2)
      departedAt: s.arrivedAt ? (next?.enRouteAt ?? s.closedAt) : null,
      lastEventId: s.lastEventId,
      failReasonCodeId: status === 'FAILED' ? s.closeReasonCodeId : null,
    };
  });
}

export function isStopRowTerminal(s: StopRowStatus): boolean {
  return (STOP_TERMINAL_STATUSES as readonly string[]).includes(s);
}

/**
 * เหตุการณ์ของเที่ยวจากสถานะจุด (docs/01 §4.2): DISPATCHED → `start` เมื่อมีจุดที่ถึงแล้ว/ปิดแล้ว ("stop แรก ARRIVED" —
 * ปิดงานโดยไม่กดถึงก็นับ) · IN_PROGRESS → `complete` เมื่อทุกจุด COMPLETED/FAILED/SKIPPED · สถานะอื่น = ไม่ไล่ (ไม่ถอยหลัง)
 */
export function tripExecutionEvents(
  status: TripStatus,
  stops: readonly StopRowStatus[],
): Extract<TripEvent, 'start' | 'complete'>[] {
  const out: Extract<TripEvent, 'start' | 'complete'>[] = [];
  let s = status;
  if (s === 'DISPATCHED' && stops.some((x) => x !== 'PENDING' && x !== 'SKIPPED')) {
    out.push('start');
    s = TRIP_TRANSITIONS.DISPATCHED!.start!;
  }
  if (s === 'IN_PROGRESS' && stops.length > 0 && stops.every(isStopRowTerminal))
    out.push('complete');
  return out;
}

/**
 * เหตุการณ์ถัดไปของ DO จากจุดรับ/ส่งของใบ (docs/01 §4.3 + D-23) — ผู้เรียกวนจนได้ null:
 * DISPATCHED + จุดรับ COMPLETED → `pick_up` (ก่อน) · จุดส่ง COMPLETED (DELIVERED/PARTIAL) → `deliver` · จุดส่ง FAILED → `fail`
 * (เหตุผลจาก event) · DISPATCHED + จุดรับ FAILED → `fail` (รับของไม่ได้ = ส่งไม่ได้)
 * ทำได้เฉพาะเมื่อ transition มีในตาราง — DO ที่ไปต่อแล้ว (ส่งแล้ว/ไม่สำเร็จ/รอวางบิล) ไม่เปลี่ยน (คืน null)
 */
export function deliveryOrderStopEvent(
  status: DoStatus,
  pickup: StopRowStatus | null,
  drop: StopRowStatus | null,
): Extract<DoEvent, 'pick_up' | 'deliver' | 'fail'> | null {
  let ev: Extract<DoEvent, 'pick_up' | 'deliver' | 'fail'> | null = null;
  if (status === 'DISPATCHED' && pickup === 'COMPLETED') ev = 'pick_up';
  else if (drop === 'COMPLETED') ev = 'deliver';
  else if (drop === 'FAILED') ev = 'fail';
  else if (status === 'DISPATCHED' && pickup === 'FAILED') ev = 'fail';
  if (!ev) return null;
  return DO_TRANSITIONS[status]?.[ev] ? ev : null;
}

/** DO ที่ส่งถึงแล้ว (นับเป็น "DELIVERED" ของ SO — รวมขั้นหลังส่ง) */
export const DO_DELIVERED_STATUSES = [
  'DELIVERED',
  'POD_PENDING',
  'UNBILLED',
  'BILLED',
] as const satisfies readonly DoStatus[];
/** DO ที่ออกรถแล้วแต่ยังไม่จบการส่ง */
export const DO_MOVING_STATUSES = [
  'DISPATCHED',
  'PICKED_UP',
] as const satisfies readonly DoStatus[];
/** DO ที่จบการส่งแบบไม่สำเร็จ (รอส่งใหม่/คืนคลัง — ST4-T11) */
export const DO_UNDELIVERED_STATUSES = [
  'FAILED',
  'RETURNED',
] as const satisfies readonly DoStatus[];

export interface OrderDeliveryFacts {
  /** มี DO ที่ส่งถึงแล้ว ≥ 1 */
  anyDelivered: boolean;
  /** DO ที่ไม่ยกเลิกทุกใบส่งถึงแล้ว และทุกบรรทัด SO จัดลง DO ครบ ("DO ครบทุก line") */
  allDelivered: boolean;
  /** มี DO ออกรถอยู่ (DISPATCHED/PICKED_UP) */
  moving: boolean;
}

/**
 * ความคืบหน้าการส่งของ SO (docs/01 §4.1) — สถานะคำนวณจากชุด DO ทุกครั้ง (ไม่ขึ้นกับลำดับที่เรียก):
 * - ส่งครบทุกบรรทัด → `deliver` (IN_TRANSIT / PARTIALLY_DELIVERED → DELIVERED)
 * - ส่งแล้วบางส่วน และไม่มี DO วิ่งอยู่ → `deliver_partial` (IN_TRANSIT → PARTIALLY_DELIVERED)
 * - PARTIALLY_DELIVERED แล้วมี DO ที่เหลือออกรถ → `resume` (→ IN_TRANSIT)
 * [DECISION spec/12 §3] ส่งแล้วบางใบขณะ DO อื่นของ SO ยังวิ่งอยู่ = คง IN_TRANSIT (ไม่สลับไปมาระหว่างวิ่ง)
 */
export function orderDeliveryEvent(
  status: SoStatus,
  f: OrderDeliveryFacts,
): Extract<SoEvent, 'deliver' | 'deliver_partial' | 'resume'> | null {
  let ev: Extract<SoEvent, 'deliver' | 'deliver_partial' | 'resume'> | null = null;
  if (f.allDelivered) ev = 'deliver';
  else if (status === 'IN_TRANSIT' && f.anyDelivered && !f.moving) ev = 'deliver_partial';
  else if (status === 'PARTIALLY_DELIVERED' && f.moving) ev = 'resume';
  if (!ev) return null;
  return SO_TRANSITIONS[status]?.[ev] ? ev : null;
}

/**
 * เลขไมล์ประมาณเมื่อจบเที่ยว (docs/04 B2.1 ส่วน 1 "เลขไมล์ปัจจุบัน อัปเดตอัตโนมัติจาก DO ที่ปิด") —
 * ค่าก่อนหน้า (ตามเวลา) + ระยะของเที่ยว · ไม่มีค่าก่อนหน้า / ไม่ทราบระยะ / ระยะ ≤ 0 / เกินค่าที่บันทึกหลังจากนั้น = ไม่บันทึก (null)
 * ไม่ถอยหลังโดยโครงสร้าง (floor + ระยะ ≥ floor) — ST2-T06 กฎเลขไมล์ถอยหลัง
 */
export function tripOdometerReading(
  floorKm: number | null,
  distanceKm: number | null,
  nextKm: number | null,
): number | null {
  if (floorKm === null || distanceKm === null || !(distanceKm > 0)) return null;
  const km = Math.round((floorKm + distanceKm) * 10) / 10;
  if (nextKm !== null && km > nextKm) return null;
  return km;
}

/**
 * ผลปิดจุดขัดกับสถานะ DO ที่ไล่ไปแล้ว (DO ไม่ถอยหลัง — ธง `OUTCOME_MISMATCH` ให้ผู้จัดรถรับทราบ):
 * จุดส่ง COMPLETED แต่ DO ส่งไม่สำเร็จ/คืนคลัง · จุดส่ง FAILED แต่ DO ส่งถึงแล้ว
 */
export function isOutcomeMismatch(drop: StopRowStatus, doStatus: DoStatus): boolean {
  if (drop === 'COMPLETED')
    return (DO_UNDELIVERED_STATUSES as readonly string[]).includes(doStatus);
  if (drop === 'FAILED') return (DO_DELIVERED_STATUSES as readonly string[]).includes(doStatus);
  return false;
}

/** ปิดงานแบบส่งของ (DELIVERED/PARTIAL) — ต้องรับของที่จุดรับก่อน (ธง PICKUP_NOT_DONE) */
export function isDeliveringClose(type: string, outcome: StopOutcome | null): boolean {
  return type === 'COMPLETE' && (outcome === 'DELIVERED' || outcome === 'PARTIAL');
}
