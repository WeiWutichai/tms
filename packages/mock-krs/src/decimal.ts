/**
 * ยอดเงินแบบทศนิยมแม่นยำ (ไม่ใช้ float) — mock คำนวณยอดต่อรายการให้เหมือน "KRS คำนวณเอง" (docs/01 A.3)
 * เพื่อให้ reconcile ระดับ TOTAL (ST8-T11) มีตัวเลขให้เทียบ · ปัดครึ่งขึ้น (ห่างจากศูนย์) ที่ 2 ตำแหน่ง
 */

export interface Scaled {
  int: bigint;
  scale: number;
}

/**
 * number → ทศนิยมตรงตัว จากข้อความสั้นสุดของ JS (`String(n)`) รวมรูป exponent เช่น `1e+21`, `1.5e-25`
 * (ไม่ใช้ toFixed — ค่าเล็กกว่า 1e-20 จะไม่กลายเป็นศูนย์เงียบ ๆ และค่าใหญ่ไม่ทำ BigInt ล้ม)
 */
export function toScaled(n: number): Scaled {
  if (!Number.isFinite(n)) throw new RangeError('not a finite number');
  const m = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(n));
  if (!m) throw new RangeError(`cannot convert ${n}`);
  const [, sign = '', whole = '0', frac = '', exp = '0'] = m;
  let int = BigInt(whole + frac);
  let scale = frac.length - Number(exp);
  if (scale < 0) {
    int *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { int: sign ? -int : int, scale };
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

/** ขนาดสูงสุดที่ mock รับสำหรับ mainQuantity / unitPrice / ยอดต่อรายการ (ให้ยอดเป็น number ของ JSON ได้ตรงตัว) */
export const MAX_ABS_AMOUNT = 1e13;

/** ตรวจว่าคำนวณยอดได้ตรงตัว — คืนข้อความผิดหรือ null */
export function amountProblem(qty: number, unitPrice: number): string | null {
  for (const [name, v] of [
    ['mainQuantity', qty],
    ['unitPrice', unitPrice],
  ] as const) {
    if (!Number.isFinite(v)) return `${name} must be a finite number`;
    if (Math.abs(v) > MAX_ABS_AMOUNT) return `${name} out of range (|x| <= ${MAX_ABS_AMOUNT})`;
  }
  const sat = roundToSatang(lineAmountExact(qty, unitPrice));
  const abs = sat < 0n ? -sat : sat;
  if (abs > BigInt(MAX_ABS_AMOUNT) * 100n)
    return `line amount out of range (|x| <= ${MAX_ABS_AMOUNT})`;
  return null;
}
