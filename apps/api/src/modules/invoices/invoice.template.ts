import {
  bahtText,
  computeDocumentTax,
  decimalFromSatang,
  satangFromDecimal,
  toCalcVatType,
  toCalcWhtRate,
  type Satang,
  type ServiceItemVatType,
  type TaxCalcOptions,
} from '@tms/domain';
import { escapeHtml } from '../../pdf/pdf-renderer';
import {
  bahtFormat,
  dateRangeShort,
  financeDocument,
  type FinanceParty,
  type FinanceTotal,
} from '../../pdf/finance-document';
import { docDateShort } from '../../common/thai-date';

/**
 * แม่แบบ PDF "ใบแจ้งหนี้ / INVOICE" (ST5-T08 · D-54 บัญชีเบา) — **ใบแจ้งหนี้ ไม่ใช่ใบกำกับภาษี** ไม่มีคำนั้นบนเอกสาร
 * ยอด VAT/WHT เป็น**ประมาณการ** (computeDocumentTax — ติด * + หมายเหตุ) · ใช้ทั้ง PDF ตัวอย่างของร่าง (ลายน้ำ "ร่าง" ไม่มีเลข)
 * และใบที่ออกแล้ว (ST5-T09 ส่งเลข + "ต้นฉบับ/สำเนา") · หน้าตาตามต้นแบบ TMS Print #inv (ตัดส่วนใบเสร็จ/ใบกำกับภาษี — spec/12 §3)
 */
export interface InvoicePrintLine {
  no: number;
  description: string;
  /** DO ที่อยู่ในบรรทัด + ทะเบียนรถของเที่ยว (spec/05 §16 "คำอธิบาย DO ทะเบียน") */
  deliveryOrders: { doNo: string; plate: string | null }[];
  /** null = หน่วยต่างกัน (บรรทัดรวม) */
  quantity: string | null;
  unitLabel: string | null;
  unitPrice: string | null;
  /** ส่วนลดของบรรทัด "0.00" = ไม่มี */
  discount: string;
  /** ยอดหลังหักส่วนลด (ก่อน VAT) */
  amount: string;
  vatType: ServiceItemVatType;
}

export interface InvoiceTotals {
  exempt: Satang;
  vatable: Satang;
  zeroRated: Satang;
  vat: Satang;
  grandTotal: Satang;
  /** อัตราเป็นเปอร์เซ็นต์ "1" / "3" */
  whtByRate: { percent: string; wht: Satang }[];
  wht: Satang;
  net: Satang;
}

export interface InvoicePrintModel {
  yearStyle: 'BE' | 'CE';
  /** null = ร่าง */
  invoiceNo: string | null;
  copy: 'ORIGINAL' | 'COPY' | null;
  /** YYYY-MM-DD — ร่าง = วันที่พิมพ์ */
  issueDate: string;
  /** YYYY-MM-DD — วันที่ออก + เครดิต */
  dueDate: string;
  issuer: FinanceParty & { vatRegistered: boolean };
  customer: FinanceParty;
  periodFrom: string | null;
  periodTo: string | null;
  creditTermDays: number;
  customerPoNo: string | null;
  note: string | null;
  lines: InvoicePrintLine[];
  totals: InvoiceTotals;
}

/**
 * ยอดของใบจาก**บรรทัดจริงที่ยังใช้** ด้วย computeDocumentTax (ค่าตั้ง tenant เดียวกับตอนบันทึกร่าง — ยอดตรงกับหัวใบ)
 * `whtRate` = เปอร์เซ็นต์ตาม snapshot ("1.00")
 */
export function invoiceTotals(
  lines: readonly { amount: string; vatType: ServiceItemVatType; whtRate: string }[],
  opts: TaxCalcOptions,
): InvoiceTotals {
  const t = computeDocumentTax(
    lines.map((l) => ({
      amount: satangFromDecimal(l.amount),
      vatType: toCalcVatType(l.vatType),
      whtRate: toCalcWhtRate(l.whtRate),
    })),
    opts,
  );
  return {
    exempt: t.exemptBase,
    vatable: t.vatableBase,
    zeroRated: t.zeroRatedBase,
    vat: t.vat,
    grandTotal: t.grandTotal,
    whtByRate: t.whtByRate
      .filter((g) => g.wht !== 0n)
      .map((g) => ({ percent: String(Number((Number(g.rate) * 100).toFixed(4))), wht: g.wht })),
    wht: t.wht,
    net: t.netPayable,
  };
}

/** ป้าย VAT ต่อบรรทัดตามต้นแบบ (คอลัมน์ "ภาษี / VAT") */
const VAT_LABEL: Record<ServiceItemVatType, string> = {
  EXEMPT_TRANSPORT: 'ยกเว้น',
  VAT_7: '7%',
  ZERO_RATED: '0%',
};

/** "2.500" → "2.5" · "1200" → "1,200" */
function qtyText(q: string): string {
  const [w, f = ''] = q.split('.') as [string, string?];
  const frac = f.replace(/0+$/, '');
  return `${w.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${frac ? `.${frac}` : ''}`;
}

const money = (s: Satang) => bahtFormat(decimalFromSatang(s));
const MINOR = 'font-size:13px;color:#3B424C;line-height:1.45';
const NUM = 'font-variant-numeric:tabular-nums;font-size:15px';

function lineCells(l: InvoicePrintLine): string[] {
  const e = escapeHtml;
  const dos = l.deliveryOrders.length
    ? `<div style="${MINOR}">${l.deliveryOrders
        .map((d) => e(d.plate ? `${d.doNo} · ${d.plate}` : d.doNo))
        .join(', ')}</div>`
    : '';
  const disc =
    l.discount !== '0.00' ? `<div style="${MINOR}">ส่วนลด ${e(bahtFormat(l.discount))}</div>` : '';
  return [
    String(l.no),
    `${e(l.description)}${dos}${disc}`,
    l.quantity !== null ? e(`${qtyText(l.quantity)} ${l.unitLabel ?? ''}`.trim()) : '',
    l.unitPrice !== null ? `<span style="${NUM}">${e(bahtFormat(l.unitPrice))}</span>` : '',
    VAT_LABEL[l.vatType],
    `<span style="${NUM}">${e(bahtFormat(l.amount))}</span>`,
  ];
}

/** เส้นรวม (spec/05 BIL-190 แสดงตามที่มี) + WHT ที่คาดว่าจะถูกหักต่ออัตรา + ยอดชำระสุทธิ — ยอดภาษีติด * (ประมาณการ D-54) */
export function invoiceTotalRows(m: InvoicePrintModel): FinanceTotal[] {
  const t = m.totals;
  const rows: FinanceTotal[] = [];
  if (m.issuer.vatRegistered) {
    if (t.exempt !== 0n)
      rows.push({
        label: 'รวมค่าขนส่ง (ยกเว้น VAT) / Freight (VAT exempt)',
        value: money(t.exempt),
      });
    if (t.zeroRated !== 0n)
      rows.push({ label: 'ฐาน VAT 0% / Zero-rated', value: money(t.zeroRated) });
    if (t.vatable !== 0n) {
      rows.push({ label: 'ฐาน VAT 7% / Taxable amount', value: money(t.vatable) });
      rows.push({ label: 'ภาษีมูลค่าเพิ่ม 7%* / VAT 7%*', value: money(t.vat) });
    }
  }
  rows.push({ label: 'รวมทั้งสิ้น / Grand total', value: money(t.grandTotal), grand: true });
  if (t.wht !== 0n) {
    for (const g of t.whtByRate)
      rows.push({ label: `หัก ณ ที่จ่าย ${g.percent}%*`, value: money(g.wht), muted: true });
    rows.push({ label: 'ยอดชำระสุทธิ*', value: money(t.net), muted: true });
  }
  return rows;
}

/** HTML ของใบแจ้งหนี้สำหรับ PdfRenderer */
export function invoiceDocument(m: InvoicePrintModel) {
  const period =
    m.periodFrom && m.periodTo ? dateRangeShort(m.periodFrom, m.periodTo, m.yearStyle) : '—';
  const totals = invoiceTotalRows(m);
  const estimated = totals.some((t) => t.label.includes('*'));
  return financeDocument({
    yearStyle: m.yearStyle,
    title: 'ใบแจ้งหนี้',
    titleEn: 'INVOICE',
    docNo: m.invoiceNo,
    copyLabel:
      m.invoiceNo === null || m.copy === null
        ? null
        : m.copy === 'ORIGINAL'
          ? 'ต้นฉบับ / Original'
          : 'สำเนา / Copy',
    docDate: m.issueDate,
    issuer: m.issuer,
    customer: m.customer,
    info: [
      ['เลขที่ PO', m.customerPoNo ?? '—', true],
      ['งวด', period],
      ['เครดิต', `${m.creditTermDays} วัน`],
      ['ครบกำหนด', docDateShort(m.dueDate, m.yearStyle)],
    ],
    columns: [
      { th: 'ลำดับ', en: 'No.', width: 60 },
      { th: 'รายการ', en: 'Description' },
      { th: 'จำนวน', en: 'Qty', align: 'right', width: 88 },
      { th: 'ราคา/หน่วย', en: 'Unit price', align: 'right', width: 108 },
      { th: 'ภาษี', en: 'VAT', width: 60 },
      { th: 'จำนวนเงิน', en: 'Amount', align: 'right', width: 116 },
    ],
    rows: m.lines.map(lineCells),
    amountInWords: bahtText(m.totals.grandTotal),
    notes: estimated
      ? ['* ยอดภาษีมูลค่าเพิ่มและภาษีหัก ณ ที่จ่ายเป็นยอดประมาณการ / Estimated tax amounts']
      : [],
    totals,
    remarks: m.note ? [m.note] : [],
    signatures: [
      { label: 'ผู้รับใบแจ้งหนี้ / Received by', dated: true },
      { label: 'ผู้มีอำนาจลงนาม / Authorized signatory', dated: false },
    ],
  });
}
