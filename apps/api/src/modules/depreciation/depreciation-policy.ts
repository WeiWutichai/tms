/**
 * กติกาค่าเสื่อมเส้นตรงรายเดือน (ST2-T22) — ฟังก์ชันบริสุทธิ์ คำนวณเป็นสตางค์ (bigint) ไม่มี float
 *
 * [DECISION — ย้อนได้, spec/12 §3 #43]
 * - ฐาน = ราคาซื้อ − มูลค่าซาก (ไม่กรอกซาก = 0 → ค่าเสื่อม/เดือน = ราคาซื้อ ÷ (N × 12) ตามเกณฑ์ตรวจรับ backlog;
 *   มีซาก = (ราคาซื้อ − ซาก) ÷ เดือน ตาม spec/06 FLT-004)
 * - ค่าเสื่อม/เดือน = ฐาน ÷ (N × 12) ปัดครึ่งขึ้นเป็นสตางค์ · **เดือนสุดท้ายของอายุ = ฐาน − ที่ลงไปแล้ว** (เศษรวมที่เดือนสุดท้าย
 *   → รวมทุกเดือน = ฐานพอดี) · ทุกเดือนไม่เกินยอดคงเหลือ (ยอดรวมไม่เกินฐานแม้แก้ราคา/อายุภายหลัง)
 * - เริ่มเดือนที่ซื้อ (เต็มเดือน ไม่เฉลี่ยตามวัน) · จบเดือนที่ N × 12 · รถปลดระวาง: คิดถึงเดือนที่ปลด (รวมเดือนนั้น) แล้วหยุด
 * - คิดเฉพาะเดือนที่ปิดแล้ว (≤ `through`) · เดือนที่ขาด (job รันช้า/กรอกวันซื้อย้อนหลัง) ลงย้อนให้ครบ — จำกัดโดยอายุ (≤ 360 เดือน)
 */

/** เดือนแบบ YYYY-MM */
export type Month = string;

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function monthOf(day: string): Month {
  return day.slice(0, 7);
}

export function addMonths(m: Month, n: number): Month {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  const i = y * 12 + (mo - 1) + n;
  return `${String(Math.floor(i / 12)).padStart(4, '0')}-${String((i % 12) + 1).padStart(2, '0')}`;
}

/** จำนวนเดือนจาก a ถึง b (b − a) */
export function monthsBetween(a: Month, b: Month): number {
  const [ya, ma] = a.split('-').map(Number) as [number, number];
  const [yb, mb] = b.split('-').map(Number) as [number, number];
  return yb * 12 + mb - (ya * 12 + ma);
}

/** วันสุดท้ายของเดือน (YYYY-MM-DD) */
export function lastDayOf(m: Month): string {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, mo, 0));
  return d.toISOString().slice(0, 10);
}

/** เดือน (เวลาไทย) ของเวลา `at` */
export function bangkokMonth(at: Date): Month {
  return new Date(at.getTime() + 7 * 3600_000).toISOString().slice(0, 7);
}

/** "1234.50" → 123450n (สตางค์) — รับเฉพาะรูปแบบเงินที่ฐานคืน (numeric(14,2)) */
export function toSatang(v: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(v.trim());
  if (!m) throw new Error(`bad money '${v}'`);
  const s = BigInt(m[2]!) * 100n + BigInt((m[3] ?? '0').padEnd(2, '0'));
  return m[1] ? -s : s;
}

export function fromSatang(s: bigint): string {
  const neg = s < 0n;
  const a = neg ? -s : s;
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
}

/** n ÷ d ปัดครึ่งขึ้น (n, d > 0) */
function divHalfUp(n: bigint, d: bigint): bigint {
  return (n * 2n + d) / (2n * d);
}

export interface DepreciationInput {
  purchaseCost: string;
  salvageValue: string | null;
  years: number;
  /** วันที่ซื้อ YYYY-MM-DD */
  purchasedOn: string;
  /** เดือนที่ปลดระวาง (เวลาไทย) — null = ยังใช้งาน */
  retiredMonth: Month | null;
}

export interface DepreciationLine {
  month: Month;
  /** เดือนที่เท่าไรของอายุ (1 … total) */
  index: number;
  total: number;
  amount: string;
}

/** ค่าเสื่อม/เดือน (ก่อนเดือนสุดท้าย) — null ถ้าไม่มีฐานให้คิด */
export function monthlyAmount(
  i: Pick<DepreciationInput, 'purchaseCost' | 'salvageValue' | 'years'>,
) {
  const base = toSatang(i.purchaseCost) - (i.salvageValue ? toSatang(i.salvageValue) : 0n);
  const n = BigInt(i.years * 12);
  if (base <= 0n || n <= 0n) return null;
  return fromSatang(divHalfUp(base, n));
}

/**
 * แถวที่ต้องลงเพิ่มถึงเดือน `through` (รวม) — `posted` = เดือน → ยอดของแถว DEPRECIATION ที่มีแล้วของรถคันนี้
 * เดือนที่มีแล้วไม่ลงซ้ำ; ยอดคงเหลือ = ฐาน − ผลรวมที่ลงแล้วทุกเดือน
 */
export function dueLines(
  i: DepreciationInput,
  through: Month,
  posted: ReadonlyMap<Month, string>,
): DepreciationLine[] {
  const base = toSatang(i.purchaseCost) - (i.salvageValue ? toSatang(i.salvageValue) : 0n);
  const total = i.years * 12;
  if (base <= 0n || total <= 0) return [];
  const monthly = divHalfUp(base, BigInt(total));
  const start = monthOf(i.purchasedOn);
  const end = addMonths(start, total - 1);
  let last = end;
  if (i.retiredMonth && i.retiredMonth < last) last = i.retiredMonth;
  if (through < last) last = through;
  let remaining = base;
  for (const a of posted.values()) remaining -= toSatang(a);
  const out: DepreciationLine[] = [];
  for (let m = start; m <= last && remaining > 0n; m = addMonths(m, 1)) {
    if (posted.has(m)) continue;
    const amount = m === end ? remaining : monthly < remaining ? monthly : remaining;
    remaining -= amount;
    out.push({ month: m, index: monthsBetween(start, m) + 1, total, amount: fromSatang(amount) });
  }
  return out;
}
