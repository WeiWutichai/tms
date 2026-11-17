import { bangkokDay } from './assignment-rules';
import { displayResolution, type StopSeqResolution } from './stop-event';

/**
 * Undelivered-retain + auto-reschedule (ST4-T12; docs/04 E2, docs/01 §4.3 `FAILED → redeliver`, spec/04 DRV-171,
 * spec/03 ORD-087) — ฟังก์ชันล้วน ใช้ทั้ง API และเว็บ
 *
 * ปิดจุดไม่สำเร็จ (FAILED / UNDELIVERED_RETAIN) ด้วยเหตุผลที่ติ๊ก "นัดส่งใหม่อัตโนมัติ" → DO เดิม CANCELLED (event `redeliver`)
 * + DO ใหม่ DRAFT อ้าง `redelivery_of` วันส่ง = วันถัดไป (เวลาไทย) ลงกล่อง "SO รอจัด" ของกระดาน — **ไม่จัดรถให้เอง**
 * นับครั้ง (`reschedule_count` ของ DO ใบใหม่ = ใบเดิม + 1) เกินค่าตั้ง `dispatch.maxAutoReschedules` → ใบสั่งค้าง
 * `RESCHEDULES_EXHAUSTED` (DO ใบใหม่ยังสร้าง — เคลียร์เมื่อจัดรถใหม่ที่กระดาน ตาม ST3-T07)
 */

/** ค่าเริ่มต้นจำนวนครั้งที่นัดส่งใหม่อัตโนมัติได้ต่อสายงาน (ค่าตั้งองค์กร `dispatch.maxAutoReschedules`) */
export const DEFAULT_MAX_AUTO_RESCHEDULES = 2;
export const MAX_AUTO_RESCHEDULES_LIMIT = 10;

export interface AutoRescheduleInput {
  /** ธง autoReschedule ของเหตุผล **snapshot ใน event ที่ปิดจุด** (แก้ master ภายหลังไม่ย้อนผล) */
  autoReschedule: boolean;
  /** จำนวนครั้งที่ DO ใบที่ไม่สำเร็จถูกนัดส่งใหม่มาแล้ว (`reschedule_count`) */
  previousCount: number;
  /** ค่าตั้งองค์กร (0 = ไม่นัดอัตโนมัติ — ขึ้นใบค้างทันที) */
  max: number;
  /** เวลาที่ปิดจุดไม่สำเร็จ (ISO — occurredAt ของ event) */
  failedAt: string;
  /** วันนี้ (เวลาไทย YYYY-MM-DD) — event ที่มาช้าไม่สร้างงานย้อนหลัง */
  today: string;
}

export interface AutoReschedulePlan {
  /** วันส่งของ DO ใบใหม่ (YYYY-MM-DD) */
  doDate: string;
  /** ครั้งที่ (= reschedule_count ของ DO ใบใหม่) */
  attempt: number;
  /** เกินจำนวนครั้ง → ใบสั่งค้าง RESCHEDULES_EXHAUSTED */
  exhausted: boolean;
}

/** YYYY-MM-DD + n วัน */
export function addCalendarDays(day: string, n = 1): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * วันถัดไป (เวลาไทย) ของวันที่ปิดจุด — ไม่ก่อนวันนี้ (บันทึกย้อนหลังหลายวัน = วันนี้) · วันหยุดไม่ข้าม (docs ไม่กำหนด)
 * ธงไม่ติ๊ก → null (ผู้จัดรถตัดสินเอง: ส่งใหม่/คืน — ST4-T11)
 */
export function planAutoReschedule(i: AutoRescheduleInput): AutoReschedulePlan | null {
  if (!i.autoReschedule) return null;
  const next = addCalendarDays(bangkokDay(i.failedAt));
  const attempt = Math.max(0, i.previousCount) + 1;
  return {
    doDate: next < i.today ? i.today : next,
    attempt,
    exhausted: attempt > Math.max(0, i.max),
  };
}

/**
 * ช่วงเวลาที่ลูกค้าขอของ DO ที่นัดส่งใหม่ — เลื่อนวันของช่วงเดิม (sales_order_stop) ให้ตรงวันส่งของ DO โดยคงเวลาในวันไว้
 * (เช่น ร้านรับของ 08:00–17:00) · ช่วงข้ามวัน = เลื่อนทั้งช่วงเท่ากัน · ไม่มีช่วง = null
 */
export function shiftWindowToDay(
  window: { start: string | null; end: string | null },
  day: string,
): { start: string | null; end: string | null } {
  const anchor = window.start ?? window.end;
  if (!anchor) return window;
  const from = bangkokDay(anchor);
  const delta = Date.parse(`${day}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  if (!delta) return window;
  const move = (v: string | null) => (v ? new Date(Date.parse(v) + delta).toISOString() : null);
  return { start: move(window.start), end: move(window.end) };
}

/**
 * ผลไม่สำเร็จของจุด "นิ่งแล้ว" ไหม (review H1): ไม่มี event ของจุดที่ยังมีธงค้างรอผู้จัดรถตัดสิน
 * (ขัดลำดับ/ปิดแข่งกัน/มาหลังปิด/เวลาเพี้ยน/รับของยังไม่เสร็จ/ผลขัดกับ DO) — ยังค้าง = ยังไม่นัดส่งใหม่
 * (ผู้จัดรถตัดสินแล้ว projection คำนวณใหม่และนัดตอนนั้น)
 */
export function hasUnresolvedStopFlags(
  events: readonly { flags: readonly string[]; resolutions: readonly StopSeqResolution[] }[],
): boolean {
  return events.some((e) => e.flags.length > 0 && !displayResolution(e.resolutions, e.flags));
}

/** ข้อความเหตุค้าง/หมายเหตุเมื่อนัดส่งใหม่เกินค่าตั้ง (ค่าตั้ง 0 = ไม่นัดอัตโนมัติ) */
export function rescheduleExhaustedNoteTh(max: number, label: string): string {
  return max <= 0
    ? `ไม่นัดส่งใหม่อัตโนมัติ (ตั้งไว้ 0 ครั้ง) — ${label}`
    : `นัดส่งใหม่อัตโนมัติครบ ${max} ครั้งแล้ว — ${label}`;
}
