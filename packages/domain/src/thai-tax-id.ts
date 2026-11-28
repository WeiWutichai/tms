/**
 * เลขประจำตัวผู้เสียภาษี 13 หลัก (PLT-020; research/company-verification §6)
 * ผลรวม(หลักที่ i × (14 − i)), i = 1..12 → `(11 − sum mod 11) mod 10` = หลักที่ 13
 * ใช้ร่วมกันทั้ง API (DTO) และเว็บ (ตรวจทันทีก่อนส่งคำขอ — checksum ผิด = ไม่เรียก API)
 */
export function isValidThaiTaxId(value: string): boolean {
  if (!/^\d{13}$/.test(value)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(value[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(value[12]);
}

/**
 * ประเภทผู้เสียภาษีจากหลักแรก — '0' = นิติบุคคล (DBD ออกเลข) · '1'–'8' = บุคคลธรรมดา (เลขบัตรประชาชน)
 * (research §6 [OPINION จากโครงสร้างเลข]; spec/01 PLT-022 "หลักแรก ≠ 0 (บุคคลธรรมดา)")
 */
export function thaiTaxIdKind(value: string): 'juristic' | 'individual' {
  return value.startsWith('0') ? 'juristic' : 'individual';
}
