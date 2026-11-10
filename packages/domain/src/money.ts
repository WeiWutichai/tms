/**
 * เงินในระบบเก็บเป็น numeric(14,2) ในฐานข้อมูล (CLAUDE.md) — ในโค้ดใช้ "สตางค์" เป็น bigint
 * เพื่อไม่ให้เกิดความคลาดเคลื่อนของ float · แปลงเข้า/ออกด้วยฟังก์ชันในไฟล์นี้เท่านั้น
 */
export type Satang = bigint;

const DECIMAL_RE = /^-?\d+(\.\d{1,2})?$/;

/** "1234.5" → 123450n · รับทศนิยมได้ไม่เกิน 2 ตำแหน่ง (ตรงกับ numeric(14,2)) */
export function satangFromDecimal(value: string): Satang {
  if (!DECIMAL_RE.test(value)) {
    throw new RangeError(`invalid money literal: ${value}`);
  }
  const negative = value.startsWith('-');
  const [whole, frac = ''] = value.replace('-', '').split('.') as [string, string?];
  const satang = BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));
  return negative ? -satang : satang;
}

/** 123450n → "1234.50" (รูปแบบที่ API และ DB ใช้) */
export function decimalFromSatang(value: Satang): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

/**
 * คูณจำนวนเงินด้วยอัตรา (เช่น 0.07) แล้วปัดเป็นสตางค์แบบ half-up
 * rate รับเป็น string ทศนิยม เพื่อไม่ให้ 0.07 กลายเป็น 0.0700000001
 */
export function mulRateHalfUp(amount: Satang, rate: string): Satang {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(rate);
  if (!m) throw new RangeError(`invalid rate: ${rate}`);
  const frac = m[2] ?? '';
  const scale = 10n ** BigInt(frac.length);
  const rateInt = BigInt(m[1]!) * scale + BigInt(frac || '0');
  const numerator = amount * rateInt;
  const negative = numerator < 0n;
  const absNum = negative ? -numerator : numerator;
  const q = absNum / scale;
  const r = absNum % scale;
  const rounded = r * 2n >= scale ? q + 1n : q;
  return negative ? -rounded : rounded;
}

export function sumSatang(values: Iterable<Satang>): Satang {
  let total = 0n;
  for (const v of values) total += v;
  return total;
}
