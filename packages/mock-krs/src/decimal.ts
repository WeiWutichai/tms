/**
 * ยอดเงินแบบทศนิยมแม่นยำ (ไม่ใช้ float) — mock คำนวณยอดต่อรายการให้เหมือน "KRS คำนวณเอง" (docs/01 A.3)
 * เพื่อให้ reconcile ระดับ TOTAL (ST8-T11) มีตัวเลขให้เทียบ · ปัดครึ่งขึ้น (ห่างจากศูนย์) ที่ 2 ตำแหน่ง
 */

interface Scaled {
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

/** qty × price ปัดเป็นสตางค์ (bigint) */
export function lineAmountSatang(qty: number, unitPrice: number): bigint {
  const a = toScaled(qty);
  const b = toScaled(unitPrice);
  const prod = a.int * b.int;
  const scale = a.scale + b.scale;
  if (scale <= 2) return prod * 10n ** BigInt(2 - scale);
  const div = 10n ** BigInt(scale - 2);
  const neg = prod < 0n;
  const abs = neg ? -prod : prod;
  let q = abs / div;
  if ((abs % div) * 2n >= div) q += 1n;
  return neg ? -q : q;
}

/** สตางค์ → number ของ JSON (ค่าที่ได้คือทศนิยม 2 ตำแหน่งตรงตัว เช่น 1234.5) */
export function satangToNumber(v: bigint): number {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const s = `${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
  return Number(neg ? `-${s}` : s);
}
