import type { DoStatus } from './delivery-order';
import type { TripStatus } from './trip';

/**
 * ST9-T01 Dashboard ปฏิบัติการ (docs/04 H, spec/09 §1) — นิยามของการ์ดแต่ละใบ = ตัวกรองของรายการต้นทาง
 * API นับด้วยตัวกรองเหล่านี้ผ่านตัวสร้าง where ชุดเดียวกับ endpoint รายการ และหน้าเว็บ import ค่าเดียวกันเป็นตัวกรองตอนคลิกการ์ด
 * (RPT-001 ตัวเลขบน dashboard = จำนวนแถวของรายการเมื่อใช้ตัวกรองเดียวกัน, RPT-005 drill-down)
 * "วันนี้" = วันที่ตามเวลาไทย (Asia/Bangkok — RPT-002) · ไฟล์นี้ไม่มี import ตอนรัน (web ใช้ซอร์สตรงได้)
 */
/** กำลังวิ่ง (spec/09 §1: Trip status = IN_PROGRESS) */
export const OPS_TRIP_RUNNING = ['IN_PROGRESS'] as const satisfies readonly TripStatus[];
/** รถ "ใช้งาน" = เป็นรถ/หางของเที่ยวที่ปล่อยแล้วยังไม่ปิด (รวมปล่อยแล้วยังไม่ออกวิ่ง) */
export const OPS_TRIP_ON_ROAD = [
  'DISPATCHED',
  'IN_PROGRESS',
] as const satisfies readonly TripStatus[];
/** งานรถร่วมรอตอบ — เสนองานแล้ว รอรถร่วมรับ/ปฏิเสธ (ลิงก์ข้อเสนอ ST3-T23) */
export const OPS_TRIP_AWAITING_CARRIER = ['OFFERED'] as const satisfies readonly TripStatus[];
/** งานวันนี้ — DO วันนี้ทุกสถานะยกเว้นยกเลิก (spec/09 §1 "งานวันนี้") */
export const OPS_DO_TODAY = [
  'DRAFT',
  'PLANNED',
  'DISPATCHED',
  'PICKED_UP',
  'DELIVERED',
  'FAILED',
  'RETURNED',
  'POD_PENDING',
  'UNBILLED',
  'BILLED',
] as const satisfies readonly DoStatus[];
/**
 * ส่งแล้ว — spec/09 {DELIVERED, PARTIALLY_DELIVERED} แปลงเป็นสถานะ DO จริง: ส่งถึงแล้วทั้งหมด/บางส่วน (ส่งบางส่วน = DELIVERED
 * + จำนวนจริงต่อบรรทัด — ST4) รวมขั้นถัดไป รอ POD / รอวางบิล / วางบิลแล้ว (= DO_DELIVERED_STATUSES)
 */
export const OPS_DO_DELIVERED = [
  'DELIVERED',
  'POD_PENDING',
  'UNBILLED',
  'BILLED',
] as const satisfies readonly DoStatus[];
/** ส่งไม่สำเร็จ */
export const OPS_DO_FAILED = ['FAILED'] as const satisfies readonly DoStatus[];
/** ใบสั่งรอจัดรถ — ยังไม่อยู่ในเที่ยว (รับแล้ว + ค้าง) — ค่าของตัวกรอง `status` ของ `GET /orders` */
export const OPS_ORDER_WAITING = ['received', 'on_hold'] as const;
/** รอจัดรถนับใบที่วันรับของ ≤ วันนี้ + N วัน (spec/09 §1 `plannedPickupDate ≤ today + 1`) */
export const OPS_ORDER_WAITING_DAYS_AHEAD = 1;
