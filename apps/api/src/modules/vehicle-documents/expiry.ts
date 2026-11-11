import type { VehicleDocStatusKey } from './vehicle-document.dto';

/**
 * สถานะวันหมดของเอกสารรถ (docs/01 §3.8 `EXPIRING` ≤ 60 วัน; spec/06 FLT-C ข้อ 6, FLT-042)
 * ฟังก์ชันบริสุทธิ์ — รับ "วันนี้" จากผู้เรียก (test ส่งวันคงที่ได้)
 * job รายวัน ST2-T18 จะตั้งคอลัมน์ status ให้ตรง + เตือน 60/30/7 แต่ API คำนวณจากวันหมดเสมอ (ไม่รอ job)
 */
export const EXPIRING_DAYS = 60;
/** สถานะในฐานที่ถือว่าเป็น "ฉบับปัจจุบัน" (ยังไม่ถูกต่ออายุ/ยกเลิก) */
export const CURRENT_DB_STATUSES = ['ACTIVE', 'EXPIRING', 'EXPIRED'] as const;

const DAY_MS = 86_400_000;

/** วันนี้ตามเวลาไทย (UTC+7 ไม่มี DST) รูปแบบ YYYY-MM-DD */
export function bangkokToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
}

/** YYYY-MM-DD + n วัน */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** จำนวนวันจาก `from` ถึง `to` (YYYY-MM-DD) */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** วันที่ถูกต้องจริง (กัน 2026-02-31) */
export function isRealDate(day: string): boolean {
  const t = Date.parse(`${day}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === day;
}

export function expiryStatus(
  dbStatus: string,
  expiresOn: string,
  today: string,
): { status: VehicleDocStatusKey; daysToExpiry: number } {
  const daysToExpiry = daysBetween(today, expiresOn);
  if (dbStatus === 'SUPERSEDED') return { status: 'superseded', daysToExpiry };
  if (dbStatus === 'CANCELLED') return { status: 'cancelled', daysToExpiry };
  if (daysToExpiry < 0) return { status: 'expired', daysToExpiry };
  if (daysToExpiry <= EXPIRING_DAYS) return { status: 'expiring', daysToExpiry };
  return { status: 'active', daysToExpiry };
}
