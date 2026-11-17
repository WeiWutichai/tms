import { satangFromDecimal, type Satang } from './money';

/**
 * จ้างรถร่วม (ST3-T22; docs/04 D3 "เลือก carrier + ราคาซื้อ" + "บันทึกเหตุผลการเลือก `selectionReason`"
 * (ถูกสุด / ลำดับ / override โดย … เพราะ …), spec/03 §8 `selectionRationale` "บังคับเมื่อไม่ได้เลือกรายที่ถูกที่สุด")
 * ฟังก์ชันล้วน — ใช้ทั้ง API (ตัดสินจริง) และเว็บ (แสดงช่องเหตุผลก่อนกดส่ง)
 *
 * - ราคาเทียบ = ราคาขาซื้อจาก rate card ของแต่ละรายสำหรับเที่ยวนี้ (เฉพาะรายที่คิดราคาได้)
 * - **ถูกสุด** = ราคาที่จ้าง ≤ ราคาต่ำสุดของตัวเลือก (เท่ากันนับว่าถูกสุด) → ระบบเขียนเหตุผลให้ (`CHEAPEST`)
 * - ไม่ถูกสุด หรือไม่มีราคาให้เทียบเลย (ไม่มี rate card ขาซื้อของเส้นทางนี้) → ต้องมีเหตุผลจากผู้จ้าง (`OVERRIDE`)
 *   [DECISION — ย้อนได้] เทียบไม่ได้ = ต้องให้เหตุผล (ตรวจสอบย้อนได้ทุกการจ้าง — PL5)
 */

export type SelectionKind = 'CHEAPEST' | 'OVERRIDE';

/** เหตุผลการเลือกที่ผู้จ้างพิมพ์: อย่างน้อย 10 ตัวอักษร (ชุดเดียวกับเหตุผลยกเว้นกฎ/ยกเลิก) */
export const SELECTION_REASON_MIN_LENGTH = 10;

export interface HireCandidate {
  carrierId: string;
  /** ราคาขาซื้อจาก rate card (ทศนิยม 2 ตำแหน่ง) — null = คิดราคาไม่ได้ (ไม่มี rate card) */
  amount: string | null;
}

export interface SelectionDecision {
  /** ราคาต่ำสุดของตัวเลือกที่คิดราคาได้ — null = ไม่มีให้เทียบ */
  cheapestAmount: string | null;
  /** รายที่ราคาต่ำสุด (เท่ากันหลายราย = ทุกราย) */
  cheapestCarrierIds: string[];
  isCheapest: boolean;
  kind: SelectionKind;
  /** ต้องให้เหตุผล (ไม่ใช่ถูกสุด) */
  reasonRequired: boolean;
}

const toSatang = (v: string): Satang => satangFromDecimal(v);

/** รายที่ราคาต่ำสุด + ราคาต่ำสุด (ตัวเลือกที่คิดราคาไม่ได้ไม่นับ) */
export function cheapestOf(candidates: readonly HireCandidate[]): {
  amount: string | null;
  carrierIds: string[];
} {
  let min: Satang | null = null;
  let minText: string | null = null;
  let ids: string[] = [];
  for (const c of candidates) {
    if (c.amount === null) continue;
    const v = toSatang(c.amount);
    if (min === null || v < min) {
      min = v;
      minText = c.amount;
      ids = [c.carrierId];
    } else if (v === min) ids.push(c.carrierId);
  }
  return { amount: minText, carrierIds: ids };
}

/** ตัดสินว่าการจ้างครั้งนี้ "ถูกสุด" หรือไม่ (ราคาที่จ้างจริง เทียบกับราคาต่ำสุดของตัวเลือก) */
export function decideSelection(
  buyAmount: string,
  candidates: readonly HireCandidate[],
): SelectionDecision {
  const c = cheapestOf(candidates);
  const isCheapest = c.amount !== null && toSatang(buyAmount) <= toSatang(c.amount);
  return {
    cheapestAmount: c.amount,
    cheapestCarrierIds: c.carrierIds,
    isCheapest,
    kind: isCheapest ? 'CHEAPEST' : 'OVERRIDE',
    reasonRequired: !isCheapest,
  };
}

/**
 * ข้อความเหตุผลที่ระบบเขียนให้เมื่อเลือกรายที่ถูกสุด (เก็บใน `selectionReason` — ไม่ว่างเสมอ)
 * ไม่มีตัวเลขราคา — `selectionReason` ไม่ใช่ field ราคา (ผู้ไม่มีสิทธิ์ดูราคาซื้อก็เห็น)
 */
export function cheapestReasonTh(candidates: number): string {
  return `ราคาถูกสุดจาก ${candidates} รายที่มี rate card ขาซื้อ`;
}

/** "6800.00" → "6,800.00" (ไม่ใช้ float) */
export function formatBaht(amount: string): string {
  const neg = amount.startsWith('-');
  const [w, f = '00'] = amount.replace('-', '').split('.') as [string, string?];
  return `${neg ? '-' : ''}${w.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${(f + '00').slice(0, 2)}`;
}

/**
 * ลิงก์ข้อเสนองาน (ST3-T23; docs/04 D3 "ปฏิเสธ + เหตุผล", spec/03 PLN-151, spec/04 §5 S3)
 * [DECISION spec/12 §3 — ย้อนได้] เหตุผลปฏิเสธ = ชุดคงที่ 4 ข้อตามต้นแบบ TMS Subcon (ยังไม่มีหมวด reason code `subcon_reject`
 * ที่ตั้งค่าได้ต่อบริษัท) · หมายเหตุไม่บังคับ (API รับได้ ≤ 500 ตัว — ต้นแบบไม่มีช่อง)
 */
export const SUBCON_REJECT_REASONS = [
  { code: 'VEHICLE_UNAVAILABLE', labelTh: 'รถไม่ว่างวันที่รับงาน' },
  { code: 'PRICE_TOO_LOW', labelTh: 'ราคาไม่คุ้มต้นทุน' },
  { code: 'NO_VEHICLE_TYPE', labelTh: 'ไม่มีรถประเภทที่ต้องการ' },
  { code: 'ROUTE_INCONVENIENT', labelTh: 'เส้นทางไม่สะดวก' },
] as const;
export type SubconRejectReason = (typeof SUBCON_REJECT_REASONS)[number]['code'];
export const SUBCON_REJECT_CODES = SUBCON_REJECT_REASONS.map((r) => r.code) as SubconRejectReason[];
export const isSubconRejectReason = (v: unknown): v is SubconRejectReason =>
  typeof v === 'string' && (SUBCON_REJECT_CODES as string[]).includes(v);
export const subconRejectLabelTh = (code: string): string =>
  SUBCON_REJECT_REASONS.find((r) => r.code === code)?.labelTh ?? code;

/**
 * เวลาที่เหลือก่อนข้อเสนอหมดอายุ (แสดง "ลิงก์หมดอายุใน 36 ชม." / "เหลือ 36 ชม.")
 * ≥ 1 ชม. = ชั่วโมง (ปัดลง) · < 1 ชม. = นาที (ปัดขึ้น อย่างน้อย 1) · หมดแล้ว = null
 */
export function offerTimeLeft(
  expiresAt: string | Date,
  now: Date = new Date(),
): { unit: 'h' | 'm'; n: number } | null {
  const ms = new Date(expiresAt).getTime() - now.getTime();
  if (!(ms > 0)) return null;
  if (ms >= 3600_000) return { unit: 'h', n: Math.floor(ms / 3600_000) };
  return { unit: 'm', n: Math.max(1, Math.ceil(ms / 60_000)) };
}
