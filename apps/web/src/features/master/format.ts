/**
 * ตัวเลขมีเครื่องหมายลบแบบตัวพิมพ์ (U+2212 "−" ไม่ใช่ขีด "-") — ใช้กับอุณหภูมิทุกหน้า (review ST2-T10 #11)
 */
export function signedNum(n: number, maxFraction = 1): string {
  const s = Math.abs(n).toLocaleString('th-TH', { maximumFractionDigits: maxFraction });
  return n < 0 ? `−${s}` : s;
}

/**
 * ช่วงอุณหภูมิ: บวกทั้งคู่ = "2–8 °C" (ตามต้นแบบ) · มีค่าติดลบ = "−18.5 – −10 °C" (เว้นวรรครอบ en dash ให้อ่านไม่สับสนกับเครื่องหมายลบ)
 */
export function tempRange(min: number, max: number): string {
  const a = signedNum(min);
  const b = signedNum(max);
  return min < 0 || max < 0 ? `${a} – ${b} °C` : `${a}–${b} °C`;
}
