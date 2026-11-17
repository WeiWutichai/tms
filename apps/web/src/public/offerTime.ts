/**
 * ตัวช่วยหน้าลิงก์ข้อเสนองาน (ST3-T23) — สูตรเดียวกับ `offerTimeLeft` ของ @tms/domain
 * ≥ 1 ชม. = ชั่วโมง (ปัดลง) · < 1 ชม. = นาที (ปัดขึ้น อย่างน้อย 1) · หมดแล้ว = null
 */
export function timeLeft(
  expiresAt: string,
  now: number = Date.now(),
): { unit: 'h' | 'm'; n: number } | null {
  const ms = Date.parse(expiresAt) - now;
  if (!(ms > 0)) return null;
  if (ms >= 3600_000) return { unit: 'h', n: Math.floor(ms / 3600_000) };
  return { unit: 'm', n: Math.max(1, Math.ceil(ms / 60_000)) };
}

/** เบอร์โทรไทย (มือถือ 10 หลัก / บ้าน 9 หลัก) — +66 ได้ · สูตรเดียวกับ API `phoneNorm` + `isThaiPhone` */
export function isThaiPhone(v: string): boolean {
  let d = v.replace(/\D/g, '');
  if (d.startsWith('66') && d.length >= 10)
    d = d.slice(2).startsWith('0') ? d.slice(2) : `0${d.slice(2)}`;
  return /^0[689]\d{8}$/.test(d) || /^0[2-7]\d{7}$/.test(d);
}

/** ตัวย่อบนกล่องโลโก้ (ต้นแบบ "ศท") — 2 ตัวหลักแรก ข้ามสระบน/ล่าง วรรณยุกต์ ช่องว่าง จุด */
const MARK = new RegExp('[\\u0E31\\u0E34-\\u0E3A\\u0E47-\\u0E4E\\s.]');
export const initials = (name: string) =>
  [...name]
    .filter((ch) => !MARK.test(ch))
    .slice(0, 2)
    .join('');
