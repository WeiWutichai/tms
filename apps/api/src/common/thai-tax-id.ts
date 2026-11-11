import { Validate, ValidatorConstraint, type ValidatorConstraintInterface } from 'class-validator';

/** ตรวจเลขประจำตัวผู้เสียภาษี 13 หลัก (หลักสุดท้ายเป็น check digit แบบ mod 11) */
export function isValidThaiTaxId(value: string): boolean {
  if (!/^\d{13}$/.test(value)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(value[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(value[12]);
}

@ValidatorConstraint({ name: 'thai_tax_id' })
export class ThaiTaxIdConstraint implements ValidatorConstraintInterface {
  validate(v: unknown) {
    return typeof v === 'string' && isValidThaiTaxId(v);
  }
  defaultMessage() {
    return 'taxId must be a valid 13-digit Thai tax ID';
  }
}

/** decorator ใช้ร่วมทุก DTO ที่มีเลขผู้เสียภาษี (นิติบุคคล, ลูกค้า, รถร่วม ฯลฯ) — ผิด → 422 code `thai_tax_id` */
export const IsThaiTaxId = () => Validate(ThaiTaxIdConstraint);
