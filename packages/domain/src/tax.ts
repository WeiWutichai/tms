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

// ---------------------------------------------------------------------------
// ค่าตั้งต้นภาษีของรายการใน catalog (service_item — ST2-T11) — ที่เดียวของกฎคู่ VAT × หัก ณ ที่จ่าย
// ชื่อ enum ตาม DB/API (docs/01 §3.2) ซึ่งต่างจาก VatType ด้านบน (ใช้คำนวณ) — แปลงด้วย toCalcVatType
// ---------------------------------------------------------------------------

export const SERVICE_ITEM_VAT_TYPES = ['EXEMPT_TRANSPORT', 'VAT_7', 'ZERO_RATED'] as const;
export type ServiceItemVatType = (typeof SERVICE_ITEM_VAT_TYPES)[number];
/** อัตราหัก ณ ที่จ่าย (%) เป็นสตริง numeric(5,2): ไม่หัก / 1% ค่าขนส่ง (ท.ป.4/2528 ข้อ 12/4) / 3% ค่าบริการ (ข้อ 12/1) */
export const SERVICE_ITEM_WHT_RATES = ['0.00', '1.00', '3.00'] as const;
export type ServiceItemWhtRate = (typeof SERVICE_ITEM_WHT_RATES)[number];

/**
 * คู่ VAT × หัก ณ ที่จ่ายที่ขัดกันเอง → คืนรหัสปัญหา (ไม่มีปัญหา = null)
 * - `EXEMPT_TRANSPORT` + 3% → `transport_wht_3`: รายการ "ค่าขนส่ง" ยกเว้น VAT ตาม ม.81(1)(ณ) และหัก 1% ตามข้อ 12/4
 *   [FACT research/thai-tax-docs-research.md §1.8, §3.1] ถ้าเป็นค่าบริการ (3%) ต้องไม่ใช่รายการยกเว้นแบบค่าขนส่ง
 * - `VAT_7` + 1% → `service_wht_1`: อัตรา 1% คือค่าขนส่ง ซึ่งยกเว้น VAT; การคิด VAT บนค่าขนส่งยังไม่เปิด
 *   (ACC-2 ยังไม่ได้คำตอบ — plan/06 "ไม่เปิดให้คิด VAT บนค่าขนส่ง")
 * - ไม่หัก (0) ใช้ได้กับทุกแบบ (ผู้จ่ายไม่มีหน้าที่หัก/เงินทดรองจ่าย — ACC-3 ยังเปิด) · `ZERO_RATED` ไม่จำกัด (ไม่พบข้อมูล)
 * [OPEN — รอนักบัญชีข้อ 2 / ACC-3] เปลี่ยนกฎที่นี่ที่เดียว (DB ไม่มี CHECK คู่นี้)
 */
export function serviceItemTaxProblem(
  vatType: ServiceItemVatType,
  whtRate: ServiceItemWhtRate,
): 'transport_wht_3' | 'service_wht_1' | null {
  if (vatType === 'EXEMPT_TRANSPORT' && whtRate === '3.00') return 'transport_wht_3';
  if (vatType === 'VAT_7' && whtRate === '1.00') return 'service_wht_1';
  return null;
}

/** แปลง vat_type ของบรรทัด (DB/API) → ชนิดที่ computeDocumentTax ใช้ */
export function toCalcVatType(v: ServiceItemVatType): VatType {
  return v === 'VAT_7' ? 'VAT7' : v === 'ZERO_RATED' ? 'ZERO' : 'EXEMPT';
}
