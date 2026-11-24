import type { DoStatus } from './delivery-order';
import type { TripStatus } from './trip';

/**
 * หน้ารายการเที่ยวรถ `/trips` และใบส่งของ `/do` (UAT 24 พ.ย. 2569 — ต้นแบบ TMS v4 specTrp / specDo + kpis)
 * แท็บ/การ์ดของต้นแบบใช้ชื่อกลุ่ม (วางแผน / ระหว่างส่ง / ส่งแล้ว …) — แปลงเป็นสถานะจริงตาม state machine ของ docs/01 §4.2/§4.3
 * API นับ (`/trips/summary`, `/delivery-orders/summary`) ด้วยชุดเดียวกับที่หน้าเว็บส่งเป็นตัวกรอง `status` → ตัวเลขการ์ด = จำนวนแถว
 * [DECISION — lead 24 พ.ย. เพื่อ UAT, ย้อนได้] spec/12 §3 · ไฟล์นี้ไม่มี import ตอนรัน (web ใช้ซอร์สตรงได้)
 */
/** เที่ยว "วางแผน" = ก่อนปล่อยรถ (วางแผน / รอรถร่วมตอบ / จัดรถแล้ว) */
export const TRIP_TAB_PLANNING = [
  'PLANNING',
  'OFFERED',
  'ASSIGNED',
] as const satisfies readonly TripStatus[];
/** เที่ยว "ระหว่างส่ง" = ปล่อยรถแล้ว / กำลังวิ่ง */
export const TRIP_TAB_IN_TRANSIT = [
  'DISPATCHED',
  'IN_PROGRESS',
] as const satisfies readonly TripStatus[];
/** เที่ยว "ส่งแล้ว" = จบเที่ยว / ปิดต้นทุนแล้ว / จ่ายรถร่วมแล้ว */
export const TRIP_TAB_DONE = [
  'COMPLETED',
  'COSTED',
  'SETTLED',
] as const satisfies readonly TripStatus[];
/** เที่ยวที่นับใน "ใช้รถร่วม" (ไม่นับที่ยกเลิก) */
export const TRIP_NOT_CANCELLED = [
  ...TRIP_TAB_PLANNING,
  ...TRIP_TAB_IN_TRANSIT,
  ...TRIP_TAB_DONE,
] as const satisfies readonly TripStatus[];

/** DO "ร่าง" = ยังไม่ปล่อยรถ (รอจัดรถ / อยู่ในเที่ยว) */
export const DO_TAB_DRAFT = ['DRAFT', 'PLANNED'] as const satisfies readonly DoStatus[];
/** DO "ระหว่างส่ง" = ปล่อยรถแล้ว / รับของแล้ว */
export const DO_TAB_IN_TRANSIT = ['DISPATCHED', 'PICKED_UP'] as const satisfies readonly DoStatus[];
/**
 * DO ส่งถึงแล้วแต่ยังไม่วางบิล (ส่งสำเร็จ / รอ POD / รอวางบิล) — การ์ด "ยังไม่วางบิล" · แท็บ "ส่งแล้ว" = ชุดนี้ + `rejected=false`
 * · แท็บ "ตีกลับบางส่วน" (ต้นแบบ) = ชุดนี้ + `rejected=true` (มีบรรทัดปฏิเสธรับ — ไม่ใช่สถานะใน state machine)
 */
export const DO_TAB_DELIVERED = [
  'DELIVERED',
  'POD_PENDING',
  'UNBILLED',
] as const satisfies readonly DoStatus[];
/**
 * DO "ส่งไม่สำเร็จ" = FAILED + RETURNED (คืนคลังหลังส่งไม่สำเร็จ/ปฏิเสธรับ — docs/01 §4.3 `FAILED → RETURNED`)
 * ต้นแบบไม่มีแท็บ RETURNED → อยู่ในแท็บที่ใกล้ที่สุดตาม state machine
 */
export const DO_TAB_FAILED = ['FAILED', 'RETURNED'] as const satisfies readonly DoStatus[];
/** DO "วางบิลแล้ว" */
export const DO_TAB_BILLED = ['BILLED'] as const satisfies readonly DoStatus[];
