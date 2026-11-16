import { money } from '../rate-cards/rateFormat';
import type { HireOptions } from './useTrips';

/**
 * ตัวช่วยของ drawer จ้างรถร่วม (ST3-T22) — เงินเป็นสตางค์ bigint (ไม่ใช้ float) · กฎ "ถูกสุด" ชุดเดียวกับ API
 * (@tms/domain decideSelection: ราคาที่จ้าง ≤ ราคาต่ำสุดของตัวเลือก = ถูกสุด; ไม่มีราคาให้เทียบ = ต้องมีเหตุผล)
 */
const MONEY_RE = /^\d{1,12}(\.\d{1,2})?$/;
export const SELECTION_REASON_MIN = 10;

/** ข้อความราคาที่ผู้ใช้พิมพ์ (มีคอมมาได้) → "4800.50" · ไม่ถูกต้อง/≤ 0 → null */
export function parseCost(v: string): string | null {
  const s = v.replace(/,/g, '').trim();
  if (!MONEY_RE.test(s)) return null;
  const sat = toSatang(s);
  return sat > 0n ? fromSatang(sat) : null;
}

export function toSatang(v: string): bigint {
  const neg = v.startsWith('-');
  const [w = '0', f = ''] = v.replace('-', '').split('.');
  const x = BigInt(w) * 100n + BigInt((f + '00').slice(0, 2));
  return neg ? -x : x;
}

export function fromSatang(x: bigint): string {
  const neg = x < 0n;
  const a = neg ? -x : x;
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
}

/** ต้นแบบ this.num(): คอมมา ไม่เติมทศนิยมศูนย์ (5,200 · 5,200.5) */
export const plainNum = (v: string) =>
  money(v)
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '');

/** รายเริ่มต้น = ตัวเลือกแรก (API เรียงถูกก่อน) */
export const defaultCarrier = (o: HireOptions) => o.options[0]?.carrier.id ?? '';

/** ต้องให้เหตุผลไหม (ราคาไม่ถูกต้อง = ยังตัดสินไม่ได้ → ไม่แสดงช่อง) */
export function reasonRequired(cost: string | null, cheapest: string | null | undefined): boolean {
  if (cost === null) return false;
  if (cheapest === null || cheapest === undefined) return true;
  return toSatang(cost) > toSatang(cheapest);
}

/** กำไร = ราคาขาย − ราคาซื้อ · % = กำไร / ราคาขาย (ทศนิยม 1 ตำแหน่ง ปัดครึ่งขึ้น) — ไม่มีราคาขาย = null */
export function margin(
  sell: string | null | undefined,
  cost: string | null,
): { profit: string; pct: string; negative: boolean } | null {
  if (!sell || cost === null) return null;
  const s = toSatang(sell);
  if (s <= 0n) return null;
  const p = s - toSatang(cost);
  // ร้อยละ × 10 (หนึ่งตำแหน่ง) ปัดครึ่งขึ้นตามค่าสัมบูรณ์
  const num = (p < 0n ? -p : p) * 1000n;
  const q = (num * 2n + s) / (2n * s);
  const pct = `${p < 0n && q > 0n ? '-' : ''}${q / 10n}.${q % 10n}`;
  return { profit: fromSatang(p), pct, negative: p < 0n };
}
