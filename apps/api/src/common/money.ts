import { decimalFromSatang, satangFromDecimal } from '@tms/domain';

/** รูปแบบเงินใน API: { amount: "1250.00", currency: "THB" } (docs/01 §5.1) */
export interface MoneyDto {
  amount: string;
  currency: 'THB';
}

export function money(value: { toString(): string } | string): MoneyDto {
  return { amount: decimalFromSatang(satangFromDecimal(String(value))), currency: 'THB' };
}
