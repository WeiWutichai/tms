import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ISSUED_INVOICE_STATUSES, scopeAllows } from '@tms/domain';
import { encodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { DbService } from '../../db/db.service';
import {
  CANONICAL_INVOICE_INCLUDE,
  CANONICAL_SETTLEMENT_SELECT,
  canonicalInvoice,
  canonicalSettlement,
} from '../erp/canonical';
import type { ExportPage } from '../master/export';
import { SettlementsService } from '../settlements/settlements.service';
import type { AccountingExportQuery } from './accounting-export.dto';
import {
  ACCOUNTING_DATASETS,
  type AccountingDataset,
  type AccountingReceiptRow,
  type AccountingSalesRow,
  type AccountingSettlementRow,
  FileExportAdapterRegistry,
} from './file-export-adapter';

const money = (d: Prisma.Decimal | null | undefined) => new Prisma.Decimal(d ?? 0).toFixed(2);
const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

/** ช่วงยาวสุดต่อไฟล์ (1 ปี) — ไตรมาส/เดือนของต้นแบบอยู่ในช่วงนี้ */
export const ACCOUNTING_EXPORT_MAX_DAYS = 366;

/** สิทธิ์อ่านของแต่ละชุด (ชุดเดียวกับหน้ารายการ — `GET /v1/invoices`, `/v1/payments`, `/v1/settlements`) */
export const ACCOUNTING_DATASET_SCOPE: Record<AccountingDataset, string> = {
  sales: 'invoices:read',
  receipts: 'invoices:read',
  settlements: 'settlements:read',
};

export interface AccountingRange {
  from: Date;
  to: Date;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function parseDay(v: string | undefined): Date | null {
  if (!v || !DAY_RE.test(v)) return null;
  const d = new Date(`${v}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : d;
}

/**
 * อ่านข้อมูลของ "ส่งออกให้นักบัญชี" (ST7-T23) — ทีละหน้าเรียงตาม (วันที่เอกสาร, เลขที่, id) ไฟล์เดิม = ข้อมูลเดิม (deterministic)
 * อ่านภายใต้ RLS ของ tenant ใน transaction ของคำขอ/งาน (`db.tx`) · แต่ละเอกสาร = แถวเอกสาร 1 แถว + แถวรายการ
 */
@Injectable()
export class AccountingExportService {
  constructor(
    private readonly db: DbService,
    private readonly settlements: SettlementsService,
    private readonly adapters: FileExportAdapterRegistry,
  ) {}

  /** ตรวจช่วงวันที่ + รูปแบบไฟล์ (422 ตอนสั่ง — ไม่ใช่ตอนงานล้ม) */
  check(q: AccountingExportQuery, dataset?: AccountingDataset): AccountingRange {
    const from = parseDay(q.dateFrom);
    const to = parseDay(q.dateTo);
    const errors = [];
    if (!from)
      errors.push({ field: 'dateFrom', code: 'isDate', message: 'dateFrom must be YYYY-MM-DD' });
    if (!to) errors.push({ field: 'dateTo', code: 'isDate', message: 'dateTo must be YYYY-MM-DD' });
    if (from && to && from > to)
      errors.push({ field: 'dateTo', code: 'range', message: 'dateTo must be ≥ dateFrom' });
    if (from && to && (to.getTime() - from.getTime()) / 86_400_000 + 1 > ACCOUNTING_EXPORT_MAX_DAYS)
      errors.push({
        field: 'dateTo',
        code: 'range',
        message: `range must be ≤ ${ACCOUNTING_EXPORT_MAX_DAYS} days`,
      });
    if (dataset && !this.adapters.resolve(q.template, dataset))
      errors.push({
        field: 'template',
        code: 'isIn',
        message: `unknown template ${q.template ?? '(default)'} for ${dataset}`,
      });
    if (errors.length) throw new ProblemException('validation_failed', undefined, errors);
    return { from: from!, to: to! };
  }

  /** ชุด "รายการขาย": ใบแจ้งหนี้ที่ออกแล้วและไม่ถูกยกเลิก วันที่ออกอยู่ในช่วง */
  async salesRows(q: AccountingExportQuery, page: ExportPage): Promise<AccountingSalesRow[]> {
    const { from, to } = this.check(q, 'sales');
    const tx = this.db.tx;
    const last = page.after
      ? await tx.invoice.findUnique({
          where: { id: page.after },
          select: { issueDate: true, invoiceNo: true },
        })
      : null;
    const rows = await tx.invoice.findMany({
      where: {
        status: { in: [...ISSUED_INVOICE_STATUSES] },
        issueDate: { gte: from, lte: to },
        ...(last && page.after
          ? {
              OR: [
                { issueDate: { gt: last.issueDate! } },
                { issueDate: last.issueDate, invoiceNo: { gt: last.invoiceNo! } },
                { issueDate: last.issueDate, invoiceNo: last.invoiceNo, id: { gt: page.after } },
              ],
            }
          : {}),
      },
      orderBy: [{ issueDate: 'asc' }, { invoiceNo: 'asc' }, { id: 'asc' }],
      take: page.take,
      include: {
        ...CANONICAL_INVOICE_INCLUDE,
        replaces: { select: { invoiceNo: true } },
      },
    });
    return rows.flatMap((inv) => {
      // ไฟล์ให้นักบัญชีไม่ผูก connector ใด → ไม่มีรหัสลูกค้าฝั่ง ERP
      const doc = canonicalInvoice(inv, null);
      const base = {
        id: encodeId('invoice', inv.id),
        doc,
        status: inv.status,
        issuerName: inv.issuingCompany?.legalName ?? null,
        replacesNumber: inv.replaces?.invoiceNo ?? null,
      };
      return [
        { ...base, level: 'document' as const, line: null },
        ...doc.lines.map((line) => ({ ...base, level: 'line' as const, line })),
      ];
    });
  }

  /** ชุด "รับชำระ": การรับชำระที่ยังไม่กลับรายการ วันที่รับอยู่ในช่วง */
  async receiptRows(q: AccountingExportQuery, page: ExportPage): Promise<AccountingReceiptRow[]> {
    const { from, to } = this.check(q, 'receipts');
    const tx = this.db.tx;
    const last = page.after
      ? await tx.payment.findUnique({
          where: { id: page.after },
          select: { receivedDate: true, paymentNo: true },
        })
      : null;
    const rows = await tx.payment.findMany({
      where: {
        status: 'RECORDED',
        receivedDate: { gte: from, lte: to },
        ...(last && page.after
          ? {
              OR: [
                { receivedDate: { gt: last.receivedDate } },
                { receivedDate: last.receivedDate, paymentNo: { gt: last.paymentNo } },
                {
                  receivedDate: last.receivedDate,
                  paymentNo: last.paymentNo,
                  id: { gt: page.after },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ receivedDate: 'asc' }, { paymentNo: 'asc' }, { id: 'asc' }],
      take: page.take,
      include: {
        customer: { select: { code: true, legalName: true } },
        allocations: {
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          include: { invoice: { select: { invoiceNo: true } } },
        },
      },
    });
    return rows.flatMap((p) => {
      const allocated = p.allocations.reduce((a, x) => a.plus(x.amount), new Prisma.Decimal(0));
      const payment = {
        id: p.id,
        number: p.paymentNo,
        receivedDate: ymd(p.receivedDate)!,
        customer: { code: p.customer.code, legalName: p.customer.legalName },
        method: p.method,
        reference: p.reference,
        cheque: {
          number: p.chequeNo,
          bank: p.chequeBank,
          date: ymd(p.chequeDate),
          status: p.chequeStatus,
        },
        whtCertificateNo: p.whtCertificateNo,
        amountReceived: money(p.amountReceived),
        whtAmount: money(p.whtAmount),
        feeAmount: money(p.feeAmount),
        differenceAmount: money(p.differenceAmount),
        differenceReason: p.differenceReason,
        allocatedTotal: allocated.toFixed(2),
      };
      const id = encodeId('payment', p.id);
      return [
        { id, level: 'document' as const, payment, allocation: null },
        ...p.allocations.map((a, i) => ({
          id,
          level: 'line' as const,
          payment,
          allocation: {
            lineNo: i + 1,
            invoiceNumber: a.invoice.invoiceNo,
            amount: money(a.amount),
            whtAmount: money(a.whtAmount),
          },
        })),
      ];
    });
  }

  /** ชุด "จ่ายรถร่วม": ใบสำคัญจ่ายที่บันทึกจ่ายแล้ว วันที่จ่ายอยู่ในช่วง */
  async settlementRows(
    q: AccountingExportQuery,
    page: ExportPage,
  ): Promise<AccountingSettlementRow[]> {
    const { from, to } = this.check(q, 'settlements');
    const tx = this.db.tx;
    const last = page.after
      ? await tx.carrierSettlement.findUnique({
          where: { id: page.after },
          select: { paidDate: true, settlementNo: true },
        })
      : null;
    const rows = await tx.carrierSettlement.findMany({
      where: {
        status: 'PAID',
        paidDate: { gte: from, lte: to },
        ...(last && page.after
          ? {
              OR: [
                { paidDate: { gt: last.paidDate! } },
                { paidDate: last.paidDate, settlementNo: { gt: last.settlementNo! } },
                {
                  paidDate: last.paidDate,
                  settlementNo: last.settlementNo,
                  id: { gt: page.after },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ paidDate: 'asc' }, { settlementNo: 'asc' }, { id: 'asc' }],
      take: page.take,
      select: { ...CANONICAL_SETTLEMENT_SELECT, payingCompany: { select: { legalName: true } } },
    });
    const out: AccountingSettlementRow[] = [];
    for (const row of rows) {
      // DTO ตัวเดียวกับ `GET /v1/settlements/{id}` (ผลประมาณการ WHT + บรรทัด) → canonical ชุดเดียวกับที่ส่ง ERP
      const doc = canonicalSettlement(await this.settlements.get(row.id), row);
      const base = {
        id: encodeId('settlement', row.id),
        doc,
        payerName: row.payingCompany?.legalName ?? null,
      };
      out.push({ ...base, level: 'document', line: null });
      for (const line of doc.lines) out.push({ ...base, level: 'line', line });
    }
    return out;
  }

  /** จำนวนเอกสาร/แถวต่อชุดที่ผู้เรียกมีสิทธิ์ (dialog "ส่งออกให้นักบัญชี" — ไฟล์ที่จะได้) */
  async summary(
    q: AccountingExportQuery,
    scopes: readonly string[],
  ): Promise<{ dataset: AccountingDataset; documents: number; rows: number }[]> {
    const { from, to } = this.check(q);
    const tx = this.db.tx;
    const out: { dataset: AccountingDataset; documents: number; rows: number }[] = [];
    for (const dataset of ACCOUNTING_DATASETS) {
      if (!scopeAllows(scopes, ACCOUNTING_DATASET_SCOPE[dataset])) continue;
      if (!this.adapters.resolve(q.template, dataset)) continue;
      let documents = 0;
      let lines = 0;
      if (dataset === 'sales') {
        const where = {
          status: { in: [...ISSUED_INVOICE_STATUSES] },
          issueDate: { gte: from, lte: to },
        };
        documents = await tx.invoice.count({ where });
        lines = await tx.invoiceLine.count({ where: { active: true, invoice: where } });
      } else if (dataset === 'receipts') {
        const where = { status: 'RECORDED' as const, receivedDate: { gte: from, lte: to } };
        documents = await tx.payment.count({ where });
        lines = await tx.paymentAllocation.count({ where: { payment: where } });
      } else {
        const where = { status: 'PAID', paidDate: { gte: from, lte: to } };
        documents = await tx.carrierSettlement.count({ where });
        lines = await tx.settlementLine.count({ where: { voidedAt: null, settlement: where } });
      }
      out.push({ dataset, documents, rows: documents + lines });
    }
    return out;
  }
}
