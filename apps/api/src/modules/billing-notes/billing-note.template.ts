import { bahtText, satangFromDecimal } from '@tms/domain';
import { docDateShort } from '../../common/thai-date';
import { escapeHtml } from '../../pdf/pdf-renderer';
import {
  bahtFormat,
  dateRangeShort,
  financeDocument,
  SANDBOX_WATERMARK,
  type FinanceParty,
  type FinanceTotal,
} from '../../pdf/finance-document';

/**
 * แม่แบบ PDF "ใบวางบิล / BILLING NOTE" (ST5-T11) — **ใช้แม่แบบกลางเดียวกับใบแจ้งหนี้** (`pdf/finance-document.ts` — ไม่มี renderer ที่สอง)
 * ตามต้นแบบ TMS Print #bill (หัวผู้ออก + กล่องตัวย่อ, "ใบวางบิล / BILLING NOTE", กล่องลูกค้า + กล่องข้อมูล, จำนวนเงินตัวอักษร,
 * เส้นรวม, ย่อหน้า "นัดรับเช็ค / โอนเงิน ภายในวันที่ …", ลายเซ็น "ผู้วางบิล / Biller" + "ผู้รับวางบิล / Received by")
 * **ตารางเป็นรายการใบแจ้งหนี้** (docs/01 §3.4 + spec/05 §16: เลข วันที่ ครบกำหนด ยอด ค้าง) แทนรายการ DO ของต้นแบบ [DECISION spec/12 §3 — ST5-T11]
 * ไม่กระทบ VAT/WHT — ไม่มีเส้น VAT · WHT ที่คาดว่าจะถูกหักเป็นประมาณการ (D-54) · ร่าง = ลายน้ำ "ร่าง" ไม่มีเลข
 */
/**
 * รุ่นแม่แบบใบวางบิล (เก็บใน `billing_note.print_options.templateVersion`) — **แก้หน้าตา/เนื้อ (รวม finance-document.ts) ต้องเพิ่มเลข**
 * (D-61 ลายน้ำ sandbox ไม่เพิ่มเลข: ก่อน D-61 sandbox ออกใบแจ้งหนี้ไม่ได้ จึงไม่มีใบวางบิลที่ออกแล้วใน sandbox — ผลพิมพ์ใบเดิมไม่เปลี่ยน)
 */
export const BILLING_NOTE_TEMPLATE_VERSION = 1;

export interface BillingNotePrintInvoice {
  invoiceNo: string;
  issueDate: string;
  dueDate: string;
  /** ยอดรวมใบแจ้งหนี้ "1234.50" */
  total: string;
  /** ยอดค้าง ณ วันวางบิล */
  outstanding: string;
}

export interface BillingNotePrintModel {
  yearStyle: 'BE' | 'CE';
  /** P1-ST6-T04 โลโก้องค์กร (`data:` URI) — null/ไม่มี = กล่องตัวย่อชื่อตามต้นแบบ */
  logo?: string | null;
  /** null = ร่าง */
  billingNoteNo: string | null;
  copy: 'ORIGINAL' | 'COPY' | null;
  /** D-61: ใบที่ออกใน sandbox (`print_options.sandbox` ณ วันออก) → ลายน้ำ "ตัวอย่าง — ใช้ไม่ได้จริง" ทุกหน้า */
  sandbox?: boolean;
  /** วันวางบิล — ร่าง = วันพิมพ์ */
  billingDate: string;
  /** วันนัดรับเช็ค/โอน — null = ยังไม่กำหนด (ร่าง) */
  collectionDate: string | null;
  issuer: FinanceParty;
  customer: FinanceParty;
  invoices: BillingNotePrintInvoice[];
  /** Σ ยอดค้าง */
  total: string;
  /** Σ WHT ที่คาดว่าจะถูกหัก (ประมาณการ) */
  whtExpected: string;
  /** total − whtExpected */
  netExpected: string;
  note: string | null;
}

const NUM = 'font-variant-numeric:tabular-nums;font-size:15px';
const e = escapeHtml;

/** เส้นรวม: รวมทั้งสิ้น (ยอดวางบิล) + WHT ที่คาดว่าจะถูกหัก/ยอดชำระสุทธิ (ประมาณการ ติด *) เมื่อมี */
export function billingNoteTotalRows(m: BillingNotePrintModel): FinanceTotal[] {
  const rows: FinanceTotal[] = [
    { label: 'รวมทั้งสิ้น / Grand total', value: bahtFormat(m.total), grand: true },
  ];
  if (satangFromDecimal(m.whtExpected) !== 0n) {
    rows.push({ label: 'หัก ณ ที่จ่าย*', value: bahtFormat(m.whtExpected), muted: true });
    rows.push({ label: 'ยอดชำระสุทธิ*', value: bahtFormat(m.netExpected), muted: true });
  }
  return rows;
}

export function billingNoteDocument(m: BillingNotePrintModel) {
  const days = m.invoices.map((i) => i.issueDate).sort();
  const period = days.length ? dateRangeShort(days[0]!, days[days.length - 1]!, m.yearStyle) : '—';
  const totals = billingNoteTotalRows(m);
  const collect = m.collectionDate ? docDateShort(m.collectionDate, m.yearStyle) : null;
  return financeDocument({
    yearStyle: m.yearStyle,
    title: 'ใบวางบิล',
    logo: m.logo ?? null,
    titleEn: 'BILLING NOTE',
    docNo: m.billingNoteNo,
    copyLabel:
      m.billingNoteNo === null || m.copy === null
        ? null
        : m.copy === 'ORIGINAL'
          ? 'ต้นฉบับ / Original'
          : 'สำเนา / Copy',
    watermark: m.sandbox ? SANDBOX_WATERMARK : null,
    watermarkKind: 'sample',
    docDate: m.billingDate,
    issuer: m.issuer,
    customer: m.customer,
    info: [
      ['ใบแจ้งหนี้', `${m.invoices.length} ใบ`],
      ['งวด', period],
      ['นัดรับเช็ค', collect ?? '—'],
    ],
    columns: [
      { th: 'ลำดับ', en: 'No.', width: 60 },
      { th: 'เลขใบแจ้งหนี้', en: 'Invoice No.' },
      { th: 'วันที่', en: 'Date', width: 112 },
      { th: 'ครบกำหนด', en: 'Due date', width: 112 },
      { th: 'จำนวนเงิน', en: 'Amount', align: 'right', width: 116 },
      { th: 'ยอดค้าง', en: 'Outstanding', align: 'right', width: 116 },
    ],
    rows: m.invoices.map((i, n) => [
      String(n + 1),
      `<span style="${NUM}">${e(i.invoiceNo)}</span>`,
      e(docDateShort(i.issueDate, m.yearStyle)),
      e(docDateShort(i.dueDate, m.yearStyle)),
      `<span style="${NUM}">${e(bahtFormat(i.total))}</span>`,
      `<span style="${NUM}">${e(bahtFormat(i.outstanding))}</span>`,
    ]),
    amountInWords: bahtText(satangFromDecimal(m.total)),
    notes: totals.some((t) => t.label.includes('*'))
      ? ['* ยอดภาษีหัก ณ ที่จ่ายเป็นยอดประมาณการ / Estimated withholding tax']
      : [],
    totals,
    remarks: [
      ...(collect ? [`นัดรับเช็ค / โอนเงิน ภายในวันที่ ${collect}`] : []),
      ...(m.note ? [m.note] : []),
    ],
    signatures: [
      { label: 'ผู้วางบิล / Biller', dated: true },
      { label: 'ผู้รับวางบิล / Received by', dated: true },
    ],
  });
}
