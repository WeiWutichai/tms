/**
 * ยอดเงินแบบทศนิยมแม่นยำ (ไม่ใช้ float) — mock คำนวณยอดต่อรายการให้เหมือน "KRS คำนวณเอง" (docs/01 A.3)
 * เพื่อให้ reconcile ระดับ TOTAL (ST8-T11) มีตัวเลขให้เทียบ · ปัดครึ่งขึ้น (ห่างจากศูนย์) ที่ 2 ตำแหน่ง
 */

export interface Scaled {
  int: bigint;
  scale: number;
}

function toScaled(n: number): Scaled {
  if (!Number.isFinite(n)) throw new RangeError('not a finite number');
  let s = String(n);
  if (/e/i.test(s)) s = n.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
  const neg = s.startsWith('-');
  if (neg) s = s.slice(1);
  const [whole = '0', frac = ''] = s.split('.');
  const int = BigInt(whole + frac) * (neg ? -1n : 1n);
  return { int, scale: frac.length };
}

/** qty × price แบบเต็ม (ไม่ปัด) */
export function lineAmountExact(qty: number, unitPrice: number): Scaled {
  const a = toScaled(qty);
  const b = toScaled(unitPrice);
  return { int: a.int * b.int, scale: a.scale + b.scale };
}

/** ปัดเป็นสตางค์: half-up = ครึ่งขึ้นห่างจากศูนย์ · half-even = banker's rounding */
export function roundToSatang(v: Scaled, mode: 'half-up' | 'half-even' = 'half-up'): bigint {
  if (v.scale <= 2) return v.int * 10n ** BigInt(2 - v.scale);
  const div = 10n ** BigInt(v.scale - 2);
  const neg = v.int < 0n;
  const abs = neg ? -v.int : v.int;
  let q = abs / div;
  const twice = (abs % div) * 2n;
  if (twice > div || (twice === div && (mode === 'half-up' || q % 2n === 1n))) q += 1n;
  return neg ? -q : q;
}

/** qty × price ปัดครึ่งขึ้นเป็นสตางค์ (bigint) */
export function lineAmountSatang(qty: number, unitPrice: number): bigint {
  return roundToSatang(lineAmountExact(qty, unitPrice));
}

/** สตางค์ → number ของ JSON (ค่าที่ได้คือทศนิยม 2 ตำแหน่งตรงตัว เช่น 1234.5) */
export function satangToNumber(v: bigint): number {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const s = `${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
  return Number(neg ? `-${s}` : s);
}
