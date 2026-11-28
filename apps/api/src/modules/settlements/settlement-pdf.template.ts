import { bahtText, decimalFromSatang, satangFromDecimal } from '@tms/domain';
import { escapeHtml } from '../../pdf/pdf-renderer';
import {
  bahtFormat,
  dateRangeShort,
  financeDocument,
  SANDBOX_WATERMARK,
  type FinanceParty,
  type FinanceTotal,
} from '../../pdf/finance-document';
import { docDateShort } from '../../common/thai-date';
import type { DeductionType, SettlementPaymentMethod } from './settlement.dto';

/**
 * แม่แบบ PDF "ใบสำคัญจ่าย / PAYMENT VOUCHER" ของรถร่วม (ST6-T04; docs/04 F6 "ติ๊กเที่ยว → ใบสำคัญจ่าย", D-54/D-58 บัญชีเบา)
 * ตามต้นแบบ `design/prototype/TMS Print.dc.html` #pv — ใช้แม่แบบการเงินร่วม (`financeDocument`, layout `stacked`) + PdfRenderer ตัวเดียว
 * - **ไม่ใช่เอกสารภาษี** (ใบประกอบการจ่าย) — หัก ณ ที่จ่ายเป็น**ยอดประมาณการ** (ST6-T08) ติด * + หมายเหตุ · 50 ทวิ ออกที่ระบบบัญชี (D-58)
 * - ทุกตัวเลขมาจาก `SettlementDto` ชุดเดียวกับ `GET /v1/settlements/{id}` (ใบที่อนุมัติแล้ว = ยอด WHT ที่ตรึง) — แม่แบบไม่คำนวณภาษีเอง
 * - ร่าง (ยังไม่อนุมัติ) = ลายน้ำ "ร่าง" ไม่มีเลข · เลขเอกสาร = เลขใบ (ไม่ออกเลข PV แยก — spec/12 §3 ST6-T09 ข้อ 4)
 * - ใบที่อนุมัติใน sandbox = ลายน้ำ "ตัวอย่าง — ใช้ไม่ได้จริง" ทุกหน้า (ตามแนว D-61 — spec/12 §3 แถว Sandbox STL)
 */
export interface SettlementPrintTrip {
  tripNo: string;
  /** YYYY-MM-DD — วันที่เที่ยวจบ (เวลาไทย) หรือวันที่เที่ยว · null = บรรทัดไม่ผูกเที่ยว */
  date: string | null;
  /** "ต้นทาง – ปลายทาง" (ขีด en dash — Sarabun ไม่มี "→" ของต้นแบบ, spec/12 §3) (ชื่อจุดแรก/สุดท้าย) — null = ไม่มีจุด */
  route: string | null;
  /** Σ บรรทัด FREIGHT ของเที่ยว (ค่าจ้างรถร่วม) */
  tripFee: string;
  /** Σ บรรทัด SURCHARGE ของเที่ยว (ค่าใช้จ่ายหน้างานฝั่งซื้อ) */
  siteExpenses: string;
}

export interface SettlementPrintModel {
  yearStyle: 'BE' | 'CE';
  /** P1-ST6-T04 โลโก้องค์กร (`data:` URI) — null/ไม่มี = กล่องตัวย่อชื่อตามต้นแบบ */
  logo?: string | null;
  /** null = ยังไม่อนุมัติ (ร่าง — ลายน้ำ) */
  settlementNo: string | null;
  /** YYYY-MM-DD — จ่ายแล้ว = วันที่จ่าย · อนุมัติแล้ว = วันอนุมัติ · ร่าง = วันพิมพ์ (เวลาไทย) */
  docDate: string;
  /** นิติบุคคลที่จ่าย ("จ้างในนาม") */
  payer: FinanceParty;
  /** รถร่วม (snapshot ตอนสร้างใบ) — ต้นแบบไม่แสดงสาขา/ที่อยู่ของผู้รับเงิน */
  payee: { name: string; taxId: string | null };
  /** คนขับ (เมื่อทุกเที่ยวในใบเป็นคนขับคนเดียวกัน) */
  driver: string | null;
  periodFrom: string;
  periodTo: string;
  paymentMethod: SettlementPaymentMethod | null;
  paymentReference: string | null;
  trips: SettlementPrintTrip[];
  /** ยอดซื้อรวม (`buyGrossAmount`) */
  gross: string;
  /** หัก ณ ที่จ่ายแยกอัตรา (`whtEstimate.byRate` ที่ยอด ≠ 0) — ยอดบวก */
  whtByRate: { rate: string; amount: string }[];
  /** หัก ณ ที่จ่ายรวม (`buyWhtAmount`) */
  whtTotal: string;
  /** บรรทัดหักรวมต่อชนิด — ยอดบวก */
  deductions: { type: DeductionType; amount: string }[];
  /** จ่ายสุทธิ (`buyNetAfterWht`) */
  net: string;
  /** ตามแนว D-61: ใบของ tenant sandbox (`mode='test'`) → ลายน้ำ "ตัวอย่าง — ใช้ไม่ได้จริง" ทุกหน้า (ร่างยังเป็น "ร่าง") · ไม่มี = live */
  sandbox?: boolean;
}

/** ป้ายวิธีจ่ายตามต้นแบบ (dialog บันทึกจ่าย `vSp`: โอนเงิน / เช็ค / เงินสด) */
export const PAYMENT_METHOD_LABEL: Record<SettlementPaymentMethod, string> = {
  TRANSFER: 'โอนเงิน',
  CHEQUE: 'เช็ค',
  CASH: 'เงินสด',
};

/** ป้ายบรรทัดหักบนเส้นรวม — CASH_ADVANCE ตามต้นแบบ #pv · ชนิดอื่นแบบเดียวกัน (spec/12 §3 ST6-T04) */
export const DEDUCTION_LABEL: Record<DeductionType, string> = {
  CASH_ADVANCE: 'หักเงินเบิกล่วงหน้า / Less advance',
  FUEL_PROVIDED: 'หักค่าน้ำมัน / Less fuel',
  FINE: 'หักค่าปรับ / Less fines',
  DAMAGE: 'หักค่าเสียหาย / Less damages',
};

export const WHT_ESTIMATE_NOTE =
  '* ยอดภาษีหัก ณ ที่จ่ายเป็นยอดประมาณการ / Estimated withholding tax';

/** "1.00" → "1" · "1.50" → "1.5" */
const pct = (r: string) => String(Number(r));

const NUM = 'font-variant-numeric:tabular-nums;font-size:15px';

/** เส้นรวมตามต้นแบบ #pv: ยอดซื้อรวม → หัก ณ ที่จ่าย (แยกอัตรา · ประมาณการ *) → บรรทัดหัก → จ่ายสุทธิ */
export function settlementTotalRows(m: SettlementPrintModel): FinanceTotal[] {
  const rows: FinanceTotal[] = [{ label: 'ยอดซื้อรวม / Subtotal', value: bahtFormat(m.gross) }];
  const byRate = m.whtByRate.reduce((a, g) => a + satangFromDecimal(g.amount), 0n);
  if (satangFromDecimal(m.whtTotal) !== 0n) {
    // ยอดแยกอัตรารวมไม่เท่ายอดที่ตรึง (ไม่ควรเกิด) → แสดงยอดรวมบรรทัดเดียว — ตัวเลขบนใบต้องเท่ากับ API เสมอ
    if (byRate === satangFromDecimal(m.whtTotal))
      for (const g of m.whtByRate)
        rows.push({
          label: `หัก ณ ที่จ่าย ${pct(g.rate)}%* / WHT ${pct(g.rate)}%*`,
          value: bahtFormat(`-${g.amount}`),
        });
    else rows.push({ label: 'หัก ณ ที่จ่าย* / WHT*', value: bahtFormat(`-${m.whtTotal}`) });
  }
  for (const d of m.deductions)
    rows.push({ label: DEDUCTION_LABEL[d.type], value: bahtFormat(`-${d.amount}`) });
  rows.push({ label: 'จ่ายสุทธิ / Net paid', value: bahtFormat(m.net), grand: true });
  return rows;
}

function tripCells(t: SettlementPrintTrip, yearStyle: 'BE' | 'CE'): string[] {
  const e = escapeHtml;
  return [
    `<span style="${NUM}">${e(t.tripNo)}</span>`,
    t.date ? e(docDateShort(t.date, yearStyle)) : '—',
    e(t.route ?? '—'),
    `<span style="${NUM}">${e(bahtFormat(t.tripFee))}</span>`,
    `<span style="${NUM}">${e(bahtFormat(t.siteExpenses))}</span>`,
  ];
}

/** HTML ของใบสำคัญจ่ายสำหรับ PdfRenderer */
export function settlementVoucherDocument(m: SettlementPrintModel) {
  const totals = settlementTotalRows(m);
  return financeDocument({
    yearStyle: m.yearStyle,
    title: 'ใบสำคัญจ่าย',
    logo: m.logo ?? null,
    titleEn: 'PAYMENT VOUCHER',
    docNo: m.settlementNo,
    copyLabel: null,
    // live: watermark null = ไม่มีลายน้ำ (ผลพิมพ์เดิมทุกจุด) · ร่าง (docNo null) ใช้ "ร่าง" เสมอ
    watermark: m.sandbox ? SANDBOX_WATERMARK : null,
    watermarkKind: 'sample',
    docDate: m.docDate,
    issuer: m.payer,
    customer: { name: m.payee.name, taxId: m.payee.taxId, branchCode: null, address: '' },
    partyLabel: 'จ่ายให้ / Pay to',
    partyExtra: m.driver ? [`คนขับ ${m.driver}`] : [],
    info: [
      ['Settlement', m.settlementNo ?? '—', true],
      ['งวด', dateRangeShort(m.periodFrom, m.periodTo, m.yearStyle)],
      ['จ่ายโดย', m.paymentMethod ? PAYMENT_METHOD_LABEL[m.paymentMethod] : '—'],
      ['เลขอ้างอิง', m.paymentReference ?? '—', true],
    ],
    columns: [
      { th: 'เที่ยว', en: 'Trip', width: 142 },
      { th: 'วันที่', en: 'Date', width: 112 },
      { th: 'เส้นทาง', en: 'Route' },
      { th: 'ค่าเที่ยว', en: 'Trip fee', align: 'right', width: 110 },
      { th: 'ค่าใช้จ่ายหน้างาน', en: 'Site expenses', align: 'right', width: 146 },
    ],
    rows: m.trips.map((t) => tripCells(t, m.yearStyle)),
    amountInWords: bahtText(satangFromDecimal(m.net)),
    notes: totals.some((t) => t.label.includes('*')) ? [WHT_ESTIMATE_NOTE] : [],
    totals,
    remarks: [],
    signatures: [
      { label: 'ผู้จัดทำ / Prepared by', dated: false },
      { label: 'ผู้อนุมัติ / Approved by', dated: false },
      { label: 'ผู้รับเงิน / Collector', dated: false },
    ],
    layout: 'stacked',
  });
}

/** Σ ยอดทศนิยม (สตางค์ — ไม่ใช้ float) */
export function sumDecimal(values: readonly string[]): string {
  return decimalFromSatang(values.reduce((a, v) => a + satangFromDecimal(v), 0n));
}
