/** ตรวจเลขประจำตัวผู้เสียภาษี 13 หลัก (หลักสุดท้ายเป็น check digit แบบ mod 11) */
export function isValidThaiTaxId(value: string): boolean {
  if (!/^\d{13}$/.test(value)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(value[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(value[12]);
}
