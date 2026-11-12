/**
 * กติกาเตือนวันหมดอายุ (ST2-T18) — ฟังก์ชันบริสุทธิ์ ไม่แตะฐานข้อมูล
 *
 * - เอกสารรถ: 60/30/7 วัน (docs/04 B2.1 ส่วน 2; spec/06 FLT-040)
 * - ใบขับขี่: 60/30/7 วัน (backlog ST2-T18; spec/06 FLT-300)
 * - rate card: 30/7 วัน — docs/04 B "เตือน NEAR_EXPIRY 30 วัน" (ตรงกับธง nearExpiry ของ T13)
 *   backlog เขียน 60/30/7 รวมทุกอย่าง → ใช้จุดที่ไม่ขัด docs [OPEN #40 — spec/12 §3]
 * - หมดแล้ว: เตือน "หมดอายุแล้ว" ครั้งเดียว (FLT-041 สถานะ expired) เฉพาะที่เพิ่งหมดภายใน 30 วัน
 *   (กันเปิดใช้ครั้งแรกแล้วเตือนของเก่าที่หมดไปนานทั้งก้อน)
 *
 * แต่ละระดับเตือนครั้งเดียวต่อวันหมดหนึ่งวัน (FLT-040) — ถ้า job ไม่ได้รันหลายวัน ส่งเฉพาะระดับที่ใกล้ที่สุด ณ วันนี้
 * (ไม่ส่งย้อนระดับที่ข้ามไปแล้ว) · ต้นแบบ "แจ้งซ้ำทุกวันเมื่อเหลือ 7 วัน" ขัดกับ FLT-040 → ยึด spec [OPEN #40]
 */
export type ReminderLevel = 'D60' | 'D30' | 'D7' | 'EXPIRED';
export type ReminderEntityType = 'VEHICLE_DOCUMENT' | 'DRIVER_LICENCE' | 'RATE_CARD';

export const REMINDER_THRESHOLDS: Record<ReminderEntityType, readonly number[]> = {
  VEHICLE_DOCUMENT: [60, 30, 7],
  DRIVER_LICENCE: [60, 30, 7],
  RATE_CARD: [30, 7],
};

/** เตือน "หมดอายุแล้ว" เฉพาะที่หมดไปไม่เกินกี่วัน */
export const EXPIRED_NOTICE_WINDOW_DAYS = 30;

/**
 * ระดับที่ "ถึงกำหนด" ณ วันนี้ (null = ยังไม่ถึง/เลยช่วงเตือนแล้ว)
 * @param daysToExpiry วันหมด − วันนี้ (วันหมดใช้ได้ทั้งวัน — FLT-042: 0 = หมดวันนี้ ยังไม่ expired)
 */
export function dueLevel(
  daysToExpiry: number,
  thresholds: readonly number[],
): ReminderLevel | null {
  if (daysToExpiry < 0) return daysToExpiry >= -EXPIRED_NOTICE_WINDOW_DAYS ? 'EXPIRED' : null;
  const t = [...thresholds].sort((a, b) => a - b).find((x) => daysToExpiry <= x);
  return t === undefined ? null : (`D${t}` as ReminderLevel);
}

/** ช่วงวันหมดที่ต้องดึงมาตรวจ ณ วันนี้: [วันนี้ − 30, วันนี้ + เกณฑ์สูงสุด] */
export function lookahead(thresholds: readonly number[]): number {
  return Math.max(0, ...thresholds);
}
