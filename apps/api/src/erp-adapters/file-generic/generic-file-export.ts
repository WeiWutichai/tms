import type {
  AccountingDataset,
  AccountingReceiptRow,
  AccountingRowOf,
  AccountingSalesRow,
  AccountingSettlementRow,
  FileExportAdapter,
  FileExportMoneyAccess,
} from '../../modules/accounting-export/file-export-adapter';
import type { ExportColumn } from '../../modules/master/export';

/**
 * รูปแบบ "ทั่วไป" (ST7-T23; docs/04 G4 "CSV generic — export ทุกเอกสาร layout กลาง ให้โปรแกรมอื่น", ต้นแบบ TMS v4 `vXp`
 * "Excel อ่านง่าย หัวคอลัมน์ภาษาไทย") — layout กลาง = canonical payload แตกเป็นแถว
 * - คอลัมน์แรก "ระดับ": `เอกสาร` (หัวเอกสาร + ยอดรวม) / `รายการ` (บรรทัด — ยอดรวมของหัวเว้นว่าง) → ผลรวมคอลัมน์ = ผลรวมเอกสาร
 * - วันที่ `YYYY-MM-DD` (ค.ศ. — โปรแกรมอื่นอ่านได้ตรง) · เงินเป็นตัวเลขทศนิยม 2 ตำแหน่ง · อัตราเป็น %
 * - ภาษี (VAT/WHT) เป็นยอดประมาณการของ TMS (D-54: เอกสารภาษีออกที่ระบบบัญชี) — ตามที่อยู่ใน canonical (`taxEstimated`)
 * - เงินเฉพาะผู้มีสิทธิ์: ขาย/รับชำระ = `money.sell` · จ่ายรถร่วม = `money.buy` — ทุกคอลัมน์เงินติด `price`
 *   (core ตัดซ้ำด้วย `dropUnpricedColumns` แม้ adapter กรองพลาด)
 */

const num = (s: string | null | undefined) =>
  s === null || s === undefined || s === '' ? null : Number(s);
const LEVEL = { document: 'เอกสาร', line: 'รายการ' } as const;

const INVOICE_STATUS: Record<string, string> = {
  ISSUED: 'ออกแล้ว',
  PARTIALLY_PAID: 'ชำระบางส่วน',
  PAID: 'ชำระแล้ว',
  ADJUSTED: 'ปรับยอดแล้ว',
};
const VAT_TYPE: Record<string, string> = {
  VAT_7: 'VAT 7%',
  EXEMPT_TRANSPORT: 'ยกเว้น VAT',
  ZERO_RATED: 'VAT 0%',
};
const PAY_METHOD: Record<string, string> = {
  TRANSFER: 'โอนเงิน',
  CHEQUE: 'เช็ค',
  CASH: 'เงินสด',
  OFFSET: 'หักกลบลบหนี้',
};
const CHEQUE_STATUS: Record<string, string> = {
  PENDING: 'รอเคลียร์',
  CLEARED: 'ผ่านแล้ว',
  BOUNCED: 'เช็คคืน',
};
const STL_LINE: Record<string, string> = {
  FREIGHT: 'ค่าขนส่ง',
  SURCHARGE: 'ค่าใช้จ่ายเพิ่ม',
  DEDUCTION: 'รายการหัก',
};
const ENTITY: Record<string, string> = { INDIVIDUAL: 'บุคคลธรรมดา', JURISTIC: 'นิติบุคคล' };
const PND: Record<string, string> = { PND3: 'ภ.ง.ด.3', PND53: 'ภ.ง.ด.53' };
const label = (map: Record<string, string>, v: string | null | undefined) =>
  v ? (map[v] ?? v) : null;

/** ค่าเฉพาะแถวเอกสาร (แถวรายการเว้นว่าง — ไม่ให้ยอดหัวซ้ำต่อบรรทัด) */
const head =
  <R extends { level: string }>(f: (r: R) => string | number | null | undefined) =>
  (r: R) =>
    r.level === 'document' ? f(r) : null;

function sales(money: FileExportMoneyAccess): ExportColumn<AccountingSalesRow>[] {
  const L = (r: AccountingSalesRow) => r.line;
  const cols: ExportColumn<AccountingSalesRow>[] = [
    { header: 'ระดับ', value: (r) => LEVEL[r.level] },
    { header: 'เลขที่ใบแจ้งหนี้', value: (r) => r.doc.number },
    { header: 'วันที่', value: (r) => r.doc.issueDate },
    { header: 'ครบกำหนด', value: (r) => r.doc.dueDate },
    { header: 'สถานะ', value: (r) => label(INVOICE_STATUS, r.status) },
    { header: 'นิติบุคคลผู้ออก', value: (r) => r.issuerName },
    { header: 'สาขาผู้ออก', value: (r) => r.doc.issuer.branchCode },
    { header: 'รหัสลูกค้า', value: (r) => r.doc.customer.code },
    { header: 'ลูกค้า', value: (r) => r.doc.customer.legalName },
    { header: 'เลขผู้เสียภาษีลูกค้า', value: (r) => r.doc.customer.taxId },
    { header: 'สาขาลูกค้า', value: (r) => r.doc.customer.branchCode },
    { header: 'เลขที่ PO ลูกค้า', value: (r) => r.doc.customerPoNo },
    { header: 'ออกแทนใบเลขที่', value: (r) => r.replacesNumber },
    { header: 'ลำดับ', value: (r) => L(r)?.lineNo },
    { header: 'เลขที่ DO', value: (r) => L(r)?.deliveryOrder?.number },
    { header: 'รายการ', value: (r) => L(r)?.description },
    { header: 'จำนวน', value: (r) => num(L(r)?.quantity) },
    { header: 'หน่วย', value: (r) => L(r)?.unitLabel },
  ];
  if (money.sell)
    cols.push(
      { price: 'sell', header: 'ราคาต่อหน่วย', value: (r) => num(L(r)?.unitPrice) },
      { price: 'sell', header: 'ส่วนลด', value: (r) => num(L(r)?.discount) },
      { price: 'sell', header: 'มูลค่ารายการ (ก่อน VAT)', value: (r) => num(L(r)?.amount) },
    );
  cols.push({ header: 'ประเภท VAT', value: (r) => label(VAT_TYPE, L(r)?.vatType) });
  if (money.sell)
    cols.push({ price: 'sell', header: 'VAT ของรายการ', value: (r) => num(L(r)?.vatAmount) });
  cols.push({ header: 'อัตราหัก ณ ที่จ่าย (%)', value: (r) => num(L(r)?.whtRate) });
  if (money.sell)
    cols.push(
      {
        price: 'sell',
        header: 'มูลค่ายกเว้น VAT',
        value: head((r) => num(r.doc.totals.subtotalExempt)),
      },
      {
        price: 'sell',
        header: 'มูลค่า VAT 7%',
        value: head((r) => num(r.doc.totals.subtotalVatable)),
      },
      {
        price: 'sell',
        header: 'มูลค่า VAT 0%',
        value: head((r) => num(r.doc.totals.subtotalZeroRated)),
      },
      { price: 'sell', header: 'VAT', value: head((r) => num(r.doc.totals.vatAmount)) },
      { price: 'sell', header: 'รวมทั้งสิ้น', value: head((r) => num(r.doc.totals.total)) },
      {
        price: 'sell',
        header: 'หัก ณ ที่จ่ายที่คาดว่าจะถูกหัก',
        value: head((r) => num(r.doc.totals.whtExpected)),
      },
    );
  return cols;
}

function receipts(money: FileExportMoneyAccess): ExportColumn<AccountingReceiptRow>[] {
  const P = (r: AccountingReceiptRow) => r.payment;
  const cols: ExportColumn<AccountingReceiptRow>[] = [
    { header: 'ระดับ', value: (r) => LEVEL[r.level] },
    { header: 'เลขที่รับชำระ', value: (r) => P(r).number },
    { header: 'วันที่รับ', value: (r) => P(r).receivedDate },
    { header: 'รหัสลูกค้า', value: (r) => P(r).customer.code },
    { header: 'ลูกค้า', value: (r) => P(r).customer.legalName },
    { header: 'วิธีรับ', value: (r) => label(PAY_METHOD, P(r).method) },
    { header: 'เลขอ้างอิง', value: (r) => P(r).reference },
    { header: 'เลขที่เช็ค', value: (r) => P(r).cheque.number },
    { header: 'ธนาคาร', value: (r) => P(r).cheque.bank },
    { header: 'วันที่เช็ค', value: (r) => P(r).cheque.date },
    { header: 'สถานะเช็ค', value: (r) => label(CHEQUE_STATUS, P(r).cheque.status) },
    { header: 'เลขที่หนังสือรับรอง 50 ทวิ', value: (r) => P(r).whtCertificateNo },
  ];
  if (money.sell)
    cols.push(
      { price: 'sell', header: 'เงินรับ', value: head((r) => num(P(r).amountReceived)) },
      { price: 'sell', header: 'หัก ณ ที่จ่ายที่ถูกหัก', value: head((r) => num(P(r).whtAmount)) },
      { price: 'sell', header: 'ค่าธรรมเนียม', value: head((r) => num(P(r).feeAmount)) },
      { price: 'sell', header: 'ส่วนต่าง', value: head((r) => num(P(r).differenceAmount)) },
    );
  cols.push({ header: 'เหตุผลส่วนต่าง', value: head((r) => P(r).differenceReason) });
  if (money.sell)
    cols.push({
      price: 'sell',
      header: 'ยอดตัดหนี้รวม',
      value: head((r) => num(P(r).allocatedTotal)),
    });
  cols.push(
    { header: 'ลำดับ', value: (r) => r.allocation?.lineNo },
    { header: 'ใบแจ้งหนี้ที่ตัด', value: (r) => r.allocation?.invoiceNumber },
  );
  if (money.sell)
    cols.push(
      { price: 'sell', header: 'ยอดตัดหนี้ของใบ', value: (r) => num(r.allocation?.amount) },
      { price: 'sell', header: 'หัก ณ ที่จ่ายของใบ', value: (r) => num(r.allocation?.whtAmount) },
    );
  return cols;
}

function settlements(money: FileExportMoneyAccess): ExportColumn<AccountingSettlementRow>[] {
  const D = (r: AccountingSettlementRow) => r.doc;
  const L = (r: AccountingSettlementRow) => r.line;
  const cols: ExportColumn<AccountingSettlementRow>[] = [
    { header: 'ระดับ', value: (r) => LEVEL[r.level] },
    { header: 'เลขที่ใบสำคัญจ่าย', value: (r) => D(r).number },
    { header: 'วันที่จ่าย', value: (r) => D(r).paidDate },
    { header: 'งวดตั้งแต่', value: (r) => D(r).period.from },
    { header: 'งวดถึง', value: (r) => D(r).period.to },
    { header: 'นิติบุคคลผู้จ่าย', value: (r) => r.payerName },
    { header: 'รหัสผู้รับเหมา', value: (r) => D(r).carrier.code },
    { header: 'ผู้รับเหมา', value: (r) => D(r).carrier.legalName },
    { header: 'ประเภทผู้รับเหมา', value: (r) => label(ENTITY, D(r).carrier.entityType) },
    // บุคคลธรรมดา: ไม่มีเลขบัตรประชาชนในไฟล์ (canonical — PDPA) · 50 ทวิ ออกที่ระบบบัญชี (D-58)
    { header: 'เลขผู้เสียภาษีผู้รับเหมา', value: (r) => D(r).carrier.taxId },
    { header: 'สาขาผู้รับเหมา', value: (r) => D(r).carrier.branchCode },
    { header: 'เลขที่ใบแจ้งหนี้ของผู้รับเหมา', value: (r) => D(r).carrierInvoiceNumber },
    { header: 'วิธีจ่าย', value: (r) => label(PAY_METHOD, D(r).payment.method) },
    { header: 'เลขอ้างอิงการจ่าย', value: (r) => D(r).payment.reference },
    { header: 'ธนาคาร', value: (r) => D(r).payment.bank },
    {
      header: 'แบบยื่นหัก ณ ที่จ่าย (ประมาณการ)',
      value: head((r) => label(PND, D(r).whtEstimate.pndForm || null)),
    },
  ];
  if (money.buy)
    cols.push(
      { price: 'buy', header: 'ค่าขนส่งรวม', value: head((r) => num(D(r).totals.gross)) },
      { price: 'buy', header: 'รายการหัก', value: head((r) => num(D(r).totals.deduction)) },
      { price: 'buy', header: 'ยอดก่อนหัก ณ ที่จ่าย', value: head((r) => num(D(r).totals.net)) },
      {
        price: 'buy',
        header: 'หัก ณ ที่จ่าย (ประมาณการ)',
        value: head((r) => num(D(r).totals.wht)),
      },
      { price: 'buy', header: 'จ่ายสุทธิ', value: head((r) => num(D(r).totals.netAfterWht)) },
    );
  cols.push(
    { header: 'ลำดับ', value: (r) => L(r)?.lineNo },
    { header: 'ชนิดรายการ', value: (r) => label(STL_LINE, L(r)?.lineType) },
    { header: 'เลขที่เที่ยว', value: (r) => L(r)?.trip?.number },
    { header: 'รายการ', value: (r) => L(r)?.description },
  );
  if (money.buy) cols.push({ price: 'buy', header: 'ยอดรายการ', value: (r) => num(L(r)?.amount) });
  cols.push(
    { header: 'ประเภท VAT', value: (r) => label(VAT_TYPE, L(r)?.vatType) },
    { header: 'อัตราหัก ณ ที่จ่าย (%)', value: (r) => num(L(r)?.whtRate) },
  );
  if (money.buy)
    cols.push({
      price: 'buy',
      header: 'หัก ณ ที่จ่ายของรายการ',
      value: (r) => num(L(r)?.whtAmount),
    });
  return cols;
}

export class GenericFileExport implements FileExportAdapter {
  readonly key = 'generic';
  readonly displayName = 'ทั่วไป';
  readonly isDefault = true;
  readonly datasets: readonly AccountingDataset[] = ['sales', 'receipts', 'settlements'];

  columns<D extends AccountingDataset>(
    dataset: D,
    money: FileExportMoneyAccess,
  ): ExportColumn<AccountingRowOf[D]>[] {
    const by = { sales, receipts, settlements } as unknown as Record<
      AccountingDataset,
      (m: FileExportMoneyAccess) => ExportColumn<AccountingRowOf[D]>[]
    >;
    return by[dataset](money);
  }
}
