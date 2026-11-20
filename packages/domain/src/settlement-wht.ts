import { decimalFromSatang, mulRateHalfUp, type Satang } from './money';
import { computeDocumentTax, taxOptionsFromSettings, toCalcWhtRate, type TaxableLine } from './tax';

/**
 * ST6-T08 — หัก ณ ที่จ่าย **ประมาณการ** บนใบสำคัญจ่ายรถร่วม (D-54/D-58 บัญชีเบา, PO 20 พ.ย. 2569; docs/04 F6 "คำนวณ WHT")
 *
 * ไม่ใช่เครื่องคำนวณภาษีตัวที่สอง — แปลงบรรทัดใบสำคัญจ่ายแล้วเรียก `computeDocumentTax` (ST5-T02) ตัวเดียวกับฝั่งขาย
 * (ปัด half-up 2 ตำแหน่ง · WHT ครั้งเดียวต่อกลุ่มอัตราจากฐานก่อน VAT · ขั้นต่ำจาก `tax.whtMinimumAmount` ค่าเริ่ม 0)
 *
 * - ฐาน = ยอด "ก่อนหัก" ของบรรทัดเที่ยว (FREIGHT/SURCHARGE) — บรรทัดหัก (DEDUCTION: เงินเบิก/น้ำมันที่เราจ่าย/ค่าปรับ/ค่าเสียหาย)
 *   ไม่ใช่ฐาน หักหลัง WHT (ตาม computeDocumentTax `DEDUCTION`; [OPEN — นักบัญชี #62 ข้อ ข])
 * - อัตรา = `wht_rate` ของบรรทัด (คัดลอกจาก rate card ตอนจ้าง — ค่าบริการ 3%) · ว่าง = ค่าตั้งต้นของรถร่วม `wht_rate_default` (ค่าเริ่ม 1%)
 *   [OPEN — PROGRESS #58 ข้อ ก: บรรทัดราคากรอกเองใช้ค่าตั้งต้นของรถร่วม ถูกไหม]
 * - **ไม่คิด VAT ขาซื้อ** (PROGRESS #58 ข้อ ๐/ข — รถร่วมจด VAT หรือไม่ยังไม่มีข้อมูล) → ส่งทุกบรรทัดเป็น EXEMPT;
 *   WHT คิดจากฐานก่อน VAT อยู่แล้ว ผลจึงไม่ขึ้นกับธง VAT
 * - แบบยื่น: รถร่วมบุคคลธรรมดา → ภ.ง.ด.3 · นิติบุคคล → ภ.ง.ด.53 (research §3.3) — เป็นข้อมูลส่งไปกับ AP ร่าง (ยื่นแบบที่ AccountSystem)
 * - ทุกผลลัพธ์ **ร่าง — ยังไม่ผ่านนักบัญชี** (golden `golden/settlement-wht.golden.json`)
 */
export type WhtForm = 'PND3' | 'PND53';
export type SettlementLineKind = 'FREIGHT' | 'SURCHARGE' | 'DEDUCTION';
export type WhtRateSource = 'LINE' | 'CARRIER_DEFAULT';

/** ผลการตรวจของนักบัญชี — คงที่ "ยังไม่ผ่าน" จนกว่านักบัญชีตรวจ golden (เกณฑ์ ST6-T08) */
export const SETTLEMENT_WHT_REVIEW = 'NOT_REVIEWED_BY_ACCOUNTANT' as const;

/** ประเภทผู้รับเหมา → แบบยื่นหัก ณ ที่จ่าย (ม.3 เตรส: บุคคลธรรมดา ภ.ง.ด.3 · นิติบุคคล ภ.ง.ด.53) */
export function whtFormOf(entityType: string): WhtForm {
  if (entityType === 'INDIVIDUAL') return 'PND3';
  if (entityType === 'JURISTIC') return 'PND53';
  throw new RangeError(`unknown carrier entity type: ${entityType}`);
}

export interface SettlementWhtLine {
  lineType: SettlementLineKind;
  /** สตางค์ — บรรทัดหักเก็บติดลบ (แบบ `settlement_line.amount`) */
  amount: Satang;
  /** เปอร์เซ็นต์แบบ DB ("1.00", "3.00", "0.00") · null = ใช้ค่าตั้งต้นของรถร่วม */
  whtRate: string | null;
}

export interface SettlementWhtInput {
  lines: readonly SettlementWhtLine[];
  /** `carrier.wht_rate_default` เปอร์เซ็นต์ เช่น "1.00" */
  carrierWhtRateDefault: string;
  entityType: string;
  /** ค่าตั้ง `tax.whtMinimumAmount` (บาท จำนวนเต็ม) */
  whtMinimumAmount: number;
}

export interface SettlementWhtLineResult {
  /** อัตราที่ใช้ (เปอร์เซ็นต์ 2 ตำแหน่ง) — null สำหรับบรรทัดหัก */
  ratePercent: string | null;
  rateSource: WhtRateSource | null;
  /** WHT รายบรรทัดแบบแสดงผล (เศษไปบรรทัดสุดท้ายของกลุ่ม — ผลรวม = ยอดใบ) */
  wht: Satang;
}

export interface SettlementWhtEstimate {
  form: WhtForm;
  review: typeof SETTLEMENT_WHT_REVIEW;
  /** ยอดรวมก่อนหัก (Σ บรรทัดเที่ยว) */
  gross: Satang;
  /** รวมรายการหัก (บวก) */
  deductions: Satang;
  /** ฐานที่มีอัตราหัก (Σ กลุ่มอัตรา > 0) */
  whtBase: Satang;
  wht: Satang;
  /** ยอดจ่ายหลังหัก ณ ที่จ่าย = gross − wht − deductions */
  netAfterWht: Satang;
  byRate: { ratePercent: string; base: Satang; wht: Satang }[];
  /** ขั้นต่ำที่ใช้ (สตางค์) */
  minimum: Satang;
  belowMinimum: boolean;
  lines: SettlementWhtLineResult[];
}

/** สัดส่วน ("0.01") → เปอร์เซ็นต์ 2 ตำแหน่ง ("1.00") ด้วยจำนวนเต็ม (ไม่ใช้ float) */
const percentOf = (fraction: string) => decimalFromSatang(mulRateHalfUp(10_000n, fraction));

export function estimateSettlementWht(input: SettlementWhtInput): SettlementWhtEstimate {
  const form = whtFormOf(input.entityType);
  const opts = taxOptionsFromSettings({ whtMinimumAmount: input.whtMinimumAmount });
  const sources: (WhtRateSource | null)[] = [];
  const percents: (string | null)[] = [];
  const taxable: TaxableLine[] = input.lines.map((l) => {
    if (l.lineType === 'DEDUCTION') {
      if (l.amount > 0n) throw new RangeError('DEDUCTION line amount must be <= 0');
      sources.push(null);
      percents.push(null);
      return { amount: -l.amount, vatType: 'EXEMPT', whtRate: '0', kind: 'DEDUCTION' };
    }
    const pct = l.whtRate ?? input.carrierWhtRateDefault;
    sources.push(l.whtRate === null ? 'CARRIER_DEFAULT' : 'LINE');
    const fraction = toCalcWhtRate(pct);
    percents.push(percentOf(fraction));
    return { amount: l.amount, vatType: 'EXEMPT', whtRate: fraction };
  });
  const r = computeDocumentTax(taxable, opts);
  return {
    form,
    review: SETTLEMENT_WHT_REVIEW,
    gross: r.grandTotal,
    deductions: r.deductions,
    whtBase: r.whtByRate.reduce((a, g) => a + g.base, 0n),
    wht: r.wht,
    netAfterWht: r.netPayable,
    byRate: r.whtByRate.map((g) => ({ ratePercent: percentOf(g.rate), base: g.base, wht: g.wht })),
    minimum: opts.whtMinimum,
    belowMinimum: r.whtBelowMinimum,
    lines: r.lines.map((l, i) => ({
      ratePercent: percents[i]!,
      rateSource: sources[i]!,
      wht: l.wht,
    })),
  };
}
