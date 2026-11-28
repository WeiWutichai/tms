import { Validate, ValidatorConstraint, type ValidatorConstraintInterface } from 'class-validator';
import { isValidThaiTaxId } from '@tms/domain';

/** ตรวจเลขประจำตัวผู้เสียภาษี 13 หลัก — สูตรอยู่ที่ `@tms/domain` (ใช้ร่วมกับเว็บ: P1-ST2-T04) */
export { isValidThaiTaxId };

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
