import { mulRateHalfUp, sumSatang, type Satang } from './money';

/**
 * กฎภาษีต่อบรรทัด (docs/01 §3, docs/04 F1, research/thai-tax-docs-research.md)
 * FACT: ค่าขนส่งในประเทศได้รับยกเว้น VAT (ม.81(1)(ณ)); บริการประกอบ (ยก/แพ็ก/รอ/ค่าผ่านทางที่เรียกเก็บเป็นบริการ) 7%
 * FACT: หัก ณ ที่จ่าย ค่าขนส่ง 1% (ท.ป.4/2528 ข้อ 12/4), ค่าบริการ 3% (ข้อ 12/1); ขั้นต่ำ ≥ 1,000 บาทต่อสัญญา (ข้อ 12/5) — research §3.1
 * ค่า vat_type และ wht_rate อยู่ที่บรรทัดเสมอ — ฟังก์ชันนี้ "คำนวณ" ไม่ "ตัดสิน" ว่าบรรทัดไหนเป็นประเภทไหน
 *
 * **D-54 (PO 20 พ.ย. 2569 — TMS บัญชีเบา):** ผลของ computeDocumentTax เป็น **ยอดแสดง/ประมาณการ** บนใบแจ้งหนี้ (ไม่ใช่ใบกำกับภาษี)
 * ใบวางบิล และใบสำคัญจ่ายรถร่วม — ยอดภาษีจริง (ใบกำกับภาษี/ใบเสร็จ/ใบลดหนี้/50 ทวิ/รายงานภาษี) ระบบ AccountSystem เป็นผู้คำนวณ
 * วิธีปัดเศษจึงตามวิธีของ AccountSystem (ST5-T02 — อ่านจาก `packages/ledger/src/sales.ts` docTotals,
 * `packages/tax-th/src/index.ts` vatOn/whtOnPayment, `apps/accounting-web/app/purchase/_lib/wht.ts` expectedWht):
 *  - ทุกการปัด = half-up 2 ตำแหน่ง (ROUND_HALF_UP ของ decimal.js — เศษ .5 ปัดออกจากศูนย์ ทั้งบวก/ลบ) = `mulRateHalfUp`
 *  - VAT = ฐานรวมของบรรทัด VAT 7% **ทั้งใบ** × 7% ปัดครั้งเดียว (ไม่ปัดรายบรรทัดแล้วบวก)
 *  - WHT = ฐาน "ก่อน VAT" รวมต่ออัตรา (กลุ่มอัตราเดียวกัน) × อัตรา ปัดครั้งเดียวต่อกลุ่ม แล้วรวมทุกกลุ่ม
 *  - ค่า VAT/WHT รายบรรทัดในผลลัพธ์เป็นค่าแสดงผล: ปัดรายบรรทัดแล้วโยนเศษให้บรรทัดสุดท้ายของกลุ่ม (ผลรวมตรงยอดใบเสมอ)
 * ทุกอย่างยัง **ร่าง — ยังไม่ผ่านนักบัญชี** (golden: `src/golden/tax-calc.golden.json`, spec/12 §3 แถว ST5-T02)
 */
export type VatType = 'EXEMPT' | 'VAT7' | 'ZERO';

export const VAT_RATE_7 = '0.07';

/**
 * ขั้นต่ำหัก ณ ที่จ่าย (บาท) ค่าตั้งต้น = **0 (หักทุกยอด — ตรงกับ AccountSystem)** — ยอดเป็นประมาณการ (D-54)
 * ท.ป.4/2528 ข้อ 12/5 วัดขั้นต่ำ 1,000 "ตามสัญญา" (research §3.1) แต่จะนับต่อเที่ยว/ต่อใบ/ต่อปียังเปิด
 * (research §6.2 ข้อ 8, docs/01 §8.2 ข้อ 7 — ถ้าต่อปี "ไม่ตรวจขั้นต่ำ") → วัดต่อใบเป็นค่าเริ่ม = เลือกคำตอบเอง จึงไม่ทำ
 * tenant/นักบัญชีตั้ง `tax.whtMinimumAmount` = 1000 ได้ (เทียบกับฐานก่อน VAT รวมทุกอัตราของใบ หรือยอดตามสัญญาที่ผู้เรียกส่ง)
 * [OPEN — นักบัญชี] ฐานนับขั้นต่ำ และการรวมฐานข้ามอัตรา 1%/3%
 */
export const DEFAULT_WHT_MINIMUM_BAHT = 0;

export interface TaxableLine {
  /** จำนวนเงินก่อน VAT (สตางค์) หลังหักส่วนลดบรรทัดแล้ว · ติดลบได้ (ส่วนลดที่ลดฐานของอัตราเดียวกัน) */
  amount: Satang;
  vatType: VatType;
  /** อัตราหัก ณ ที่จ่ายเป็นสตริงทศนิยม เช่น "0.01", "0.03" หรือ "0" */
  whtRate: string;
  /**
   * `DEDUCTION` = บรรทัดหักจากยอดจ่าย (เงินเบิกล่วงหน้า ค่าปรับ ฯลฯ) — **ไม่ใช่ฐาน VAT/WHT** ไม่รวมใน grandTotal
   * หักหลัง WHT: netPayable = grandTotal − wht − deductions (amount ใส่เป็นบวก) · ค่าเริ่ม `CHARGE`
   * (ตรงกับ AccountSystem: ฐาน WHT มาจากบรรทัดของบิล ไม่ใช่ยอดที่ตัดจ่ายหลังหักกลบ — whtForBill)
   */
  kind?: 'CHARGE' | 'DEDUCTION';
}

/** ค่าบังคับ — ผู้เรียกส่งจาก `taxOptionsFromSettings()` หรือระบุชัด (ไม่มีค่าเริ่มซ่อนในฟังก์ชัน) */
export interface TaxCalcOptions {
  /** ขั้นต่ำ WHT (สตางค์) — ยอดที่เทียบ ≥ ค่านี้จึงหัก · `0n` = ไม่ตรวจขั้นต่ำ (หักทุกยอด) */
  whtMinimum: Satang;
  /** ยอดตามสัญญาที่ผู้เรียกรู้ (เช่น สัญญารายปี/รวมทุกงวด) — ส่งมาแล้วใช้เทียบขั้นต่ำแทนฐานก่อน VAT ของใบ (ข้อ 12/5 วัดต่อสัญญา) */
  whtContractAmount?: Satang;
}

/**
 * ค่าตั้ง tenant (`tax.whtMinimumAmount` บาท) → TaxCalcOptions — ที่เดียวของการแปลงหน่วย บาท → สตางค์
 * `contractAmount` = ยอดตามสัญญาที่ผู้เรียกรู้ (ถ้ามี)
 */
export function taxOptionsFromSettings(s: {
  whtMinimumAmount: number;
  contractAmount?: Satang;
}): TaxCalcOptions {
  if (!Number.isSafeInteger(s.whtMinimumAmount) || s.whtMinimumAmount < 0)
    throw new RangeError(
      `whtMinimumAmount must be a non-negative integer (got ${s.whtMinimumAmount})`,
    );
  return {
    whtMinimum: BigInt(s.whtMinimumAmount) * 100n,
    ...(s.contractAmount !== undefined ? { whtContractAmount: s.contractAmount } : {}),
  };
}

export interface LineTax {
  amount: Satang;
  vat: Satang;
  wht: Satang;
  total: Satang; // amount + vat (ก่อนหัก ณ ที่จ่าย) · บรรทัดหัก = amount
}

export interface WhtRateGroup {
  /** อัตราแบบสัดส่วนในรูปมาตรฐาน (ตัดศูนย์ท้าย) เช่น "0.01" */
  rate: string;
  /** ฐานก่อน VAT รวมของกลุ่ม (สตางค์) */
  base: Satang;
  /** round_half_up(max(ฐาน, 0) × อัตรา) — 0 เมื่อต่ำกว่าขั้นต่ำ */
  wht: Satang;
}

export interface DocumentTaxSummary {
  exemptBase: Satang;
  vatableBase: Satang;
  zeroRatedBase: Satang;
  vat: Satang;
  grandTotal: Satang; // ฐานรวม + VAT (ไม่รวมบรรทัดหัก)
  wht: Satang;
  /** รวมบรรทัดหัก (DEDUCTION) — บวก */
  deductions: Satang;
  netPayable: Satang; // grandTotal − wht − deductions
  /** WHT แยกตามอัตรา (เรียงตามลำดับที่พบในบรรทัด) — ไม่มีกลุ่มของอัตรา 0 */
  whtByRate: WhtRateGroup[];
  /** ยอดที่ใช้เทียบขั้นต่ำ (null = ไม่ตรวจขั้นต่ำ หรือไม่มีบรรทัดที่มีอัตราหัก) */
  whtMinimumTested: Satang | null;
  /** true = ยอดต่ำกว่าขั้นต่ำ → ไม่หัก (wht ทุกบรรทัด = 0) */
  whtBelowMinimum: boolean;
  lines: LineTax[];
}

const RATE_FRACTION_RE = /^(0(\.\d+)?|1(\.0+)?)$/;

/** "0.0100" → "0.01", "0.0000" → "0", "1.00" → "1" */
function normalizeRate(rate: string): string {
  if (!rate.includes('.')) return rate;
  const t = rate.replace(/0+$/, '');
  return t.endsWith('.') ? t.slice(0, -1) : t;
}

/** ปัดรายบรรทัด แล้วโยนเศษ (ยอดรวม − Σ รายบรรทัด) ให้ index สุดท้ายในกลุ่ม — ค่าแสดงผลเท่านั้น */
function spreadToLast(target: Satang, perLine: Satang[], indexes: readonly number[]): void {
  if (indexes.length === 0) return;
  const drift = target - sumSatang(indexes.map((i) => perLine[i]!));
  if (drift !== 0n) {
    const last = indexes[indexes.length - 1]!;
    perLine[last] = perLine[last]! + drift;
  }
}

/**
 * คำนวณยอดภาษีแสดงของเอกสาร 1 ใบ (ใบแจ้งหนี้/ใบวางบิล/ใบสำคัญจ่าย) — **ประมาณการ** (D-54) วิธีปัดตาม AccountSystem (ดูหัวไฟล์)
 * ขั้นต่ำ WHT: ยอดที่เทียบ < ขั้นต่ำ → ไม่หักทั้งใบ (ข้อ 12/5) · ฐานกลุ่มอัตราติดลบ (ส่วนลดเกินยอด) → WHT ของกลุ่ม = 0
 */
export function computeDocumentTax(
  lines: readonly TaxableLine[],
  opts: TaxCalcOptions,
): DocumentTaxSummary {
  // whtRate เป็นสัดส่วน (0.01) ไม่ใช่เปอร์เซ็นต์ (1.00) — กันพลาด 100 เท่า (ใช้ toCalcWhtRate แปลงจาก snapshot)
  for (const l of lines)
    if (!RATE_FRACTION_RE.test(l.whtRate))
      throw new RangeError(
        `whtRate must be a fraction 0..1 (got ${l.whtRate}) — use toCalcWhtRate()`,
      );
  for (const l of lines)
    if (l.kind === 'DEDUCTION' && l.amount < 0n)
      throw new RangeError('DEDUCTION amount must be >= 0 (it is subtracted from netPayable)');
  const minimum = opts.whtMinimum;
  if (minimum < 0n) throw new RangeError('whtMinimum must be >= 0');

  const isCharge = (l: TaxableLine) => l.kind !== 'DEDUCTION';
  const idx = lines.map((_, i) => i);
  const chargeIdx = idx.filter((i) => isCharge(lines[i]!));
  const baseOf = (t: VatType) =>
    sumSatang(chargeIdx.filter((i) => lines[i]!.vatType === t).map((i) => lines[i]!.amount));
  const exemptBase = baseOf('EXEMPT');
  const vatableBase = baseOf('VAT7');
  const zeroRatedBase = baseOf('ZERO');
  const vat = mulRateHalfUp(vatableBase, VAT_RATE_7);
  const grandTotal = exemptBase + vatableBase + zeroRatedBase + vat;
  const deductions = sumSatang(
    idx.filter((i) => !isCharge(lines[i]!)).map((i) => lines[i]!.amount),
  );

  // VAT รายบรรทัดแบบแสดงผล
  const perLineVat = lines.map((l) =>
    isCharge(l) && l.vatType === 'VAT7' ? mulRateHalfUp(l.amount, VAT_RATE_7) : 0n,
  );
  spreadToLast(
    vat,
    perLineVat,
    chargeIdx.filter((i) => lines[i]!.vatType === 'VAT7'),
  );

  // WHT ต่อกลุ่มอัตรา (ฐานก่อน VAT) — แบบ AccountSystem expectedWht/whtForBill
  const groups = new Map<string, number[]>();
  for (const i of chargeIdx) {
    const r = normalizeRate(lines[i]!.whtRate);
    if (r === '0') continue;
    groups.set(r, [...(groups.get(r) ?? []), i]);
  }
  const whtBaseTotal = sumSatang([...groups.values()].flat().map((i) => lines[i]!.amount));
  // ฐานเทียบขั้นต่ำ = ยอดตามสัญญา (ถ้าส่ง) หรือ Σ ฐานก่อน VAT ทุกอัตราของใบ [OPEN — นักบัญชี: รวมข้ามอัตราได้ไหม]
  const whtMinimumTested =
    minimum === 0n || groups.size === 0 ? null : (opts.whtContractAmount ?? whtBaseTotal);
  const whtBelowMinimum = whtMinimumTested !== null && whtMinimumTested < minimum;

  const perLineWht: Satang[] = lines.map(() => 0n);
  const whtByRate: WhtRateGroup[] = [];
  for (const [rate, members] of groups) {
    const base = sumSatang(members.map((i) => lines[i]!.amount));
    const wht = whtBelowMinimum || base <= 0n ? 0n : mulRateHalfUp(base, rate);
    whtByRate.push({ rate, base, wht });
    if (wht === 0n) continue;
    for (const i of members) perLineWht[i] = mulRateHalfUp(lines[i]!.amount, rate);
    spreadToLast(wht, perLineWht, members);
  }
  const wht = sumSatang(whtByRate.map((g) => g.wht));

  const outLines: LineTax[] = lines.map((l, i) => ({
    amount: l.amount,
    vat: perLineVat[i]!,
    wht: perLineWht[i]!,
    total: l.amount + perLineVat[i]!,
  }));

  return {
    exemptBase,
    vatableBase,
    zeroRatedBase,
    vat,
    grandTotal,
    wht,
    deductions,
    netPayable: grandTotal - wht - deductions,
    whtByRate,
    whtMinimumTested,
    whtBelowMinimum,
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
 * **คำเตือนเท่านั้น (ไม่บล็อก)** — คู่ VAT × หัก ณ ที่จ่ายของ "ค่าตั้งต้นใน catalog" ที่ไม่ตรงแบบที่พบบ่อย → รหัสคำเตือน (ปกติ = null)
 * - `EXEMPT_TRANSPORT` + 3%: ค่าขนส่งยกเว้น VAT (ม.81(1)(ณ)) ปกติหัก 1% (ท.ป.4/2528 ข้อ 12/4) [research §1.8, §3.1]
 * - `VAT_7` + 1%: ค่าบริการปกติหัก 3% (ข้อ 12/1) — แต่ **ถูกต้องได้** เมื่อจ่ายผ่าน e-Withholding Tax
 *   (กฎกระทรวง 389 ลดเป็น 1% ถึง 31 ธ.ค. 2570 — research §3.3) จึงห้ามตีเป็นข้อผิดพลาด
 * ไม่มีกฎภาษีข้อใดห้ามคู่เหล่านี้ → ใช้แสดง `warnings` ให้ผู้ใช้ทบทวนเท่านั้น
 * **ห้ามนำไปใช้ตรวจ/บล็อกบรรทัดเอกสาร** (invoice/settlement — อัตราจริงขึ้นกับผู้จ่ายและช่องทาง e-WHT) [OPEN — รอนักบัญชีข้อ 2 / ACC-3]
 */
export function serviceItemTaxNote(
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

/**
 * แปลงอัตราหัก ณ ที่จ่ายแบบเปอร์เซ็นต์ของบรรทัด/snapshot ("1.00", "3.00") → สัดส่วนที่ computeDocumentTax ใช้ ("0.01", "0.03")
 * ต้องผ่านฟังก์ชันนี้เสมอ — computeDocumentTax ปฏิเสธอัตรา > 1 (เช่น "3.00") แต่ "1.00" ตรง ๆ ผ่านได้ (= หัก 100%) จึงห้ามข้ามขั้นนี้
 */
export function toCalcWhtRate(percent: string): string {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(percent);
  if (!m) throw new RangeError(`invalid WHT percent: ${percent}`);
  const hundredths = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  if (hundredths > 10_000) throw new RangeError(`WHT percent > 100: ${percent}`);
  // hundredths ของเปอร์เซ็นต์ = หมื่นส่วน → สัดส่วนทศนิยม 4 ตำแหน่ง
  return `${Math.floor(hundredths / 10_000)}.${String(hundredths % 10_000).padStart(4, '0')}`;
}
