import { mulRateHalfUp, sumSatang, type Satang } from './money';

/**
 * กฎภาษีต่อบรรทัด (docs/01 §3, research/thai-tax-docs-research.md)
 * FACT: ค่าขนส่งในประเทศได้รับยกเว้น VAT (ม.81(1)(ณ)); บริการประกอบ (ยก/แพ็ก/รอ/ค่าผ่านทางที่เรียกเก็บเป็นบริการ) 7%
 * FACT: หัก ณ ที่จ่าย ค่าขนส่ง 1%, ค่าบริการ 3% (ผู้จ่ายเป็นนิติบุคคล)
 * ค่า vat_type และ wht_rate อยู่ที่บรรทัดเสมอ — ฟังก์ชันนี้ "คำนวณ" ไม่ "ตัดสิน" ว่าบรรทัดไหนเป็นประเภทไหน
 */
export type VatType = 'EXEMPT' | 'VAT7' | 'ZERO';

export const VAT_RATE_7 = '0.07';

export interface TaxableLine {
  /** จำนวนเงินก่อน VAT (สตางค์) หลังหักส่วนลดบรรทัดแล้ว */
  amount: Satang;
  vatType: VatType;
  /** อัตราหัก ณ ที่จ่ายเป็นสตริงทศนิยม เช่น "0.01", "0.03" หรือ "0" */
  whtRate: string;
}

export interface LineTax {
  amount: Satang;
  vat: Satang;
  wht: Satang;
  total: Satang; // amount + vat (ก่อนหัก ณ ที่จ่าย)
}

export interface DocumentTaxSummary {
  exemptBase: Satang;
  vatableBase: Satang;
  zeroRatedBase: Satang;
  vat: Satang;
  grandTotal: Satang; // ฐานรวม + VAT
  wht: Satang;
  netPayable: Satang; // grandTotal − wht
  lines: LineTax[];
}

/**
 * นโยบายปัดเศษ [PROPOSED — รอนักบัญชียืนยัน, plan/03 §4 golden case]:
 * VAT คำนวณจาก "ฐานรวมของบรรทัดที่เสีย VAT ทั้งใบ" แล้วปัดครั้งเดียว (ไม่ใช่ปัดรายบรรทัดแล้วบวก)
 * ค่า VAT รายบรรทัดในผลลัพธ์เป็นค่าแสดงผล โดยกระจายเศษให้บรรทัดสุดท้ายเพื่อให้ผลรวมตรงใบ
 */
export function computeDocumentTax(lines: readonly TaxableLine[]): DocumentTaxSummary {
  const exemptBase = sumSatang(lines.filter((l) => l.vatType === 'EXEMPT').map((l) => l.amount));
  const vatableBase = sumSatang(lines.filter((l) => l.vatType === 'VAT7').map((l) => l.amount));
  const zeroRatedBase = sumSatang(lines.filter((l) => l.vatType === 'ZERO').map((l) => l.amount));
  const vat = mulRateHalfUp(vatableBase, VAT_RATE_7);

  // VAT รายบรรทัดแบบแสดงผล: ปัดรายบรรทัด แล้วโยนส่วนต่างให้บรรทัด VAT7 สุดท้าย
  const perLineVat = lines.map((l) =>
    l.vatType === 'VAT7' ? mulRateHalfUp(l.amount, VAT_RATE_7) : 0n,
  );
  const drift = vat - sumSatang(perLineVat);
  if (drift !== 0n) {
    const lastVatable = lines.map((l) => l.vatType).lastIndexOf('VAT7');
    if (lastVatable >= 0) perLineVat[lastVatable] = perLineVat[lastVatable]! + drift;
  }

  const outLines: LineTax[] = lines.map((l, i) => {
    const lineVat = perLineVat[i]!;
    const wht = mulRateHalfUp(l.amount, l.whtRate);
    return { amount: l.amount, vat: lineVat, wht, total: l.amount + lineVat };
  });

  const wht = sumSatang(outLines.map((l) => l.wht));
  const grandTotal = exemptBase + vatableBase + zeroRatedBase + vat;
  return {
    exemptBase,
    vatableBase,
    zeroRatedBase,
    vat,
    grandTotal,
    wht,
    netPayable: grandTotal - wht,
    lines: outLines,
  };
}
