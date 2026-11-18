import { DO_STATUSES, type DoStatus } from './delivery-order';
import { DO_DELIVERED_STATUSES } from './stop-projection';
import type { TripStatus } from './trip';

/**
 * ST9-T01 Dashboard ปฏิบัติการ (docs/04 H, spec/09 §1) — นิยามของการ์ดแต่ละใบ = ตัวกรองของรายการต้นทาง
 * API นับด้วยตัวกรองเหล่านี้ผ่านตัวสร้าง where ชุดเดียวกับ endpoint รายการ และหน้าเว็บใช้ค่าเดียวกันเป็นตัวกรองตอนคลิกการ์ด
 * (RPT-001 ตัวเลขบน dashboard = จำนวนแถวของรายการเมื่อใช้ตัวกรองเดียวกัน, RPT-005 drill-down)
 * "วันนี้" = วันที่ตามเวลาไทย (Asia/Bangkok — RPT-002) ของวันที่ DO (`do_date` = วันที่ส่งตามแผน)
 */
/** เที่ยวกำลังวิ่ง — ปล่อยรถแล้ว ยังไม่ปิดเที่ยว */
export const OPS_TRIP_RUNNING = [
  'DISPATCHED',
  'IN_PROGRESS',
] as const satisfies readonly TripStatus[];
/** งานรถร่วมรอตอบ — เสนองานแล้ว รอรถร่วมรับ/ปฏิเสธ (ลิงก์ข้อเสนอ ST3-T23) */
export const OPS_TRIP_AWAITING_CARRIER = ['OFFERED'] as const satisfies readonly TripStatus[];
/** งานวันนี้ — DO วันนี้ทุกสถานะยกเว้นยกเลิก (spec/09 §1 "งานวันนี้") */
export const OPS_DO_TODAY: readonly DoStatus[] = DO_STATUSES.filter((s) => s !== 'CANCELLED');
/** ส่งแล้ว — ส่งถึงแล้ว (รวมรอ POD / รอวางบิล / วางบิลแล้ว) */
export const OPS_DO_DELIVERED: readonly DoStatus[] = DO_DELIVERED_STATUSES;
/** ส่งไม่สำเร็จ */
export const OPS_DO_FAILED = ['FAILED'] as const satisfies readonly DoStatus[];
/** ใบสั่งรอจัดรถ — รับแล้วยังไม่เข้าเที่ยว (พร้อมจัด) + ใบค้าง (แยกตามรหัสเหตุผล) */
export const OPS_ORDER_WAITING = ['received', 'on_hold'] as const;
