/**
 * ตารางรถ/คนขับรายวัน (ST3-T19; docs/04 D2 "ภาระงาน ว่าง ซ่อม ลา (คลิกขวาใส่วันลา/โน้ต)"; spec/06 FLT-302)
 * ฟังก์ชันบริสุทธิ์ — ใช้ร่วมกัน API (กฎตอนจัด ST3-T14, รถที่รับได้ ST3-T15, กระดาน) และหน้าเว็บ (ช่องตาราง 7 วัน)
 * วันที่เป็นวันไทย `YYYY-MM-DD` รวมสองปลาย
 */
export const SCHEDULE_ENTRY_KINDS = ['LEAVE', 'NOTE'] as const;
export type ScheduleEntryKind = (typeof SCHEDULE_ENTRY_KINDS)[number];

/** ช่วงยาวสุดของรายการเดียว = 366 วัน**รวมสองปลาย** (`endsOn - startsOn ≤ 365` — CHECK ในฐาน 0074, QA L4) */
export const SCHEDULE_MAX_SPAN_DAYS = 366;

export interface DaySpan {
  startsOn: string;
  endsOn: string;
}

/** ช่วงครอบวันนั้น */
export const spanCovers = (s: DaySpan, day: string): boolean =>
  s.startsOn <= day && day <= s.endsOn;

/** สองช่วงทับกัน (รวมปลาย) */
export const spansOverlap = (a: DaySpan, b: DaySpan): boolean =>
  a.startsOn <= b.endsOn && b.startsOn <= a.endsOn;

/** วันใน `days` ที่ช่วงลาใดช่วงหนึ่งครอบ (เรียง ไม่ซ้ำ) */
export function leaveDaysIn(spans: readonly DaySpan[], days: readonly string[]): string[] {
  return [...new Set(days)].filter((d) => spans.some((s) => spanCovers(s, d))).sort();
}

/**
 * สถานะช่องตาราง (แถวรถ × วัน):
 * BUSY = มีเที่ยว (ภาระงาน) · REPAIR = รถซ่อม · PARKED = รถจอด · LEAVE = คนขับประจำลา · FREE = ว่าง
 * ไม่มีเที่ยว → สถานะรถมาก่อนคนขับ (รถซ่อม/จอดใช้ไม่ได้อยู่แล้ว) · มีเที่ยวแต่คนขับลา → BUSY (ผู้เรียกแสดงป้ายลาเพิ่ม)
 * "ว่าง" = รถพร้อม + ไม่มีเที่ยว + คนขับประจำ (ถ้ามี) ไม่ลา — รถติดกฎห้ามจ่ายงานแสดงแยกด้วยลาย hatch เดิม
 */
export type DayCellState = 'BUSY' | 'REPAIR' | 'PARKED' | 'LEAVE' | 'FREE';
export function dayCellState(x: {
  trips: number;
  vehicleStatus: string;
  driverOnLeave: boolean;
}): DayCellState {
  if (x.trips > 0) return 'BUSY';
  if (x.vehicleStatus === 'MAINTENANCE') return 'REPAIR';
  if (x.vehicleStatus === 'PARKED') return 'PARKED';
  if (x.driverOnLeave) return 'LEAVE';
  return 'FREE';
}
