import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ISSUED_INVOICE_STATUSES, scopeAllows } from '@tms/domain';
import { encodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService } from '../../db/db.service';
import { CarriersService, mask } from '../carriers/carriers.service';
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
  type AccountingWhtRow,
  FileExportAdapterRegistry,
} from './file-export-adapter';

const money = (d: Prisma.Decimal | null | undefined) => new Prisma.Decimal(d ?? 0).toFixed(2);
const ymd = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
/** วันที่ไทยของเวลา (timestamptz) — วันที่ยกเลิก/กลับรายการ */
const bkkDay = (d: Date | null | undefined) =>
  d ? new Date(d.getTime() + 7 * 3600_000).toISOString().slice(0, 10) : null;

/** D-73 สถานะใบแจ้งหนี้ที่ "ออกแล้วยกเลิก" (มีเลข) — แสดงเป็นแถวเอกสารแยกยอด ไม่นับในยอดรวม */
export const CANCELLED_INVOICE_STATUSES = ['CANCELLED', 'VOIDED'] as const;

/** ใบในชุดรายการขาย: ออกแล้วยังใช้ + ออกแล้วยกเลิก (มีเลข — ร่างที่ยกเลิกไม่มีเลข ไม่อยู่ในไฟล์) */
const SALES_WHERE = {
  OR: [
    { status: { in: [...ISSUED_INVOICE_STATUSES] } },
    { status: { in: [...CANCELLED_INVOICE_STATUSES] }, invoiceNo: { not: null } },
  ],
} satisfies Prisma.InvoiceWhereInput;

/** ประเภทรถร่วมจาก snapshot — ค่าอื่น/ไม่มี = null (ไม่เดาว่าเป็นบุคคลธรรมดา — D-73 review L3) */
export function carrierEntityType(v: string | null | undefined): 'INDIVIDUAL' | 'JURISTIC' | null {
  return v === 'INDIVIDUAL' || v === 'JURISTIC' ? v : null;
}

/**
 * D-73 ฐานที่หักของใบสำคัญจ่าย 1 ใบ = Σ ฐานของอัตรา > 0 จากผลประมาณการ ST6-T08 (คำนวณจากข้อมูลที่ตรึงไว้ — ไม่ใช่คอลัมน์ที่เก็บ)
 * ใช้ได้เฉพาะเมื่อ Σ WHT ของผลประมาณการ = `wht_amount` ที่ตรึง (ข้อมูลชุดเดียวกัน) · ไม่ตรง / ไม่มีผลประมาณการ = null (ไม่เดา — review M1)
 */
export function settlementWhtBase(
  est: {
    byRate: { whtRate: string; buyBaseAmount?: string | null; buyWhtAmount?: string | null }[];
  } | null,
  frozenWht: Prisma.Decimal.Value,
): Prisma.Decimal | null {
  if (!est) return null;
  const wht = est.byRate.reduce((a, b) => a.plus(b.buyWhtAmount ?? 0), new Prisma.Decimal(0));
  if (!wht.eq(frozenWht)) return null;
  return est.byRate
    .filter((b) => new Prisma.Decimal(b.whtRate).gt(0))
    .reduce((a, b) => a.plus(b.buyBaseAmount ?? 0), new Prisma.Decimal(0));
}

/** สิทธิ์เห็นเลขบัตรประชาชนเต็มของรถร่วมบุคคลธรรมดาในไฟล์ส่งออกให้นักบัญชี (D-73) */
export const NATIONAL_ID_SCOPE = 'pii.national_id:read';

/**
 * D-73: ผู้สั่งได้เลขบัตรประชาชนเต็มไหม — ต้องมี `pii.national_id:read` และเป็นคนที่ login (`user`; `dev` = token พัฒนาในเครื่อง)
 * · API key / OAuth client (`client`) **ไม่ได้เสมอ** (สอดคล้อง D-79) · ทีม Innovera เข้าใช้งานแทน (`imp`) ไม่ได้ (PDPA — ทางระมัดระวัง)
 */
export function nationalIdAllowed(
  scopes: readonly string[],
  principalType: string | undefined,
): boolean {
  const pt = principalType ?? 'user';
  return (pt === 'user' || pt === 'dev') && scopeAllows(scopes, NATIONAL_ID_SCOPE);
}

/** ช่วงยาวสุดต่อไฟล์ (1 ปี) — ไตรมาส/เดือนของต้นแบบอยู่ในช่วงนี้ */
export const ACCOUNTING_EXPORT_MAX_DAYS = 366;

/**
 * สิทธิ์อ่านของแต่ละชุด (any-of — ชุดเดียวกับหน้ารายการ `GET /v1/invoices`, `/v1/payments`, `/v1/settlements`)
 * `wht` = อ่านได้ฝั่งใดฝั่งหนึ่ง — ฝั่งผู้รับเหมาต้อง `settlements:read` · ฝั่งลูกค้าต้อง `invoices:read` (ไฟล์มีเฉพาะฝั่งที่อ่านได้)
 */
export const ACCOUNTING_DATASET_SCOPE: Record<AccountingDataset, string[]> = {
  sales: ['invoices:read'],
  receipts: ['invoices:read'],
  settlements: ['settlements:read'],
  wht: ['settlements:read', 'invoices:read'],
};
const canRead = (scopes: readonly string[], d: AccountingDataset) =>
  ACCOUNTING_DATASET_SCOPE[d].some((x) => scopeAllows(scopes, x));

export interface AccountingDatasetCount {
  dataset: AccountingDataset;
  /** เอกสารที่ยังใช้ (นับในยอดรวม) */
  documents: number;
  /** D-73 เอกสารที่ยกเลิก/กลับรายการในงวด (แถวแยก ไม่นับรวม) */
  cancelledDocuments: number;
  rows: number;
}

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
    private readonly carriers: CarriersService,
  ) {}

  /** เลขบัตรประชาชนเต็มของรถร่วม (เฉพาะผู้สั่งที่ได้สิทธิ์ — `nationalIdAllowed`) · ไม่ได้สิทธิ์ = map ว่าง */
  private async nationalIds(carrierIds: string[]): Promise<Map<string, string>> {
    const ctx = requestContext.require();
    if (!nationalIdAllowed(ctx.scopes ?? [], ctx.principalType)) return new Map();
    return this.carriers.nationalIds(carrierIds);
  }

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

  /**
   * ชุด "รายการขาย": ใบแจ้งหนี้ที่ออกแล้ว วันที่ออกอยู่ในช่วง — ใบที่ยังใช้ (แถวเอกสาร + แถวรายการ) และ (D-73) ใบที่ออกในช่วงแล้ว
   * ยกเลิก (มีเลข — แถวเอกสารอย่างเดียว ยอดตามที่ออกอยู่ในคอลัมน์ยกเลิก)
   */
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
        ...SALES_WHERE,
        issueDate: { gte: from, lte: to },
        ...(last && page.after
          ? {
              AND: {
                OR: [
                  { issueDate: { gt: last.issueDate! } },
                  { issueDate: last.issueDate, invoiceNo: { gt: last.invoiceNo! } },
                  { issueDate: last.issueDate, invoiceNo: last.invoiceNo, id: { gt: page.after } },
                ],
              },
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
      const cancelled = (CANCELLED_INVOICE_STATUSES as readonly string[]).includes(inv.status)
        ? { date: bkkDay(inv.cancelledAt), reason: inv.cancelReason }
        : null;
      const base = {
        id: encodeId('invoice', inv.id),
        doc,
        status: inv.status,
        cancelled,
        issuerName: inv.issuingCompany?.legalName ?? null,
        replacesNumber: inv.replaces?.invoiceNo ?? null,
      };
      // ใบที่ยกเลิก: บรรทัดหยุดนับแล้ว (trigger) — แถวเอกสารอย่างเดียว
      if (cancelled) return [{ ...base, level: 'document' as const, line: null }];
      return [
        { ...base, level: 'document' as const, line: null },
        ...doc.lines.map((line) => ({ ...base, level: 'line' as const, line })),
      ];
    });
  }

  /**
   * ชุด "รับชำระ": การรับชำระ วันที่รับอยู่ในช่วง — ที่ยังไม่กลับรายการ (แถวเอกสาร + แถวตัดหนี้) และ (D-73) ที่กลับรายการ/เช็คคืนแล้ว
   * (แถวเอกสารอย่างเดียว ยอดอยู่ในคอลัมน์กลับรายการ)
   */
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
        status: { in: ['RECORDED', 'REVERSED'] },
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
      const reversed =
        p.status === 'REVERSED' ? { date: bkkDay(p.reversedAt), reason: p.reverseReason } : null;
      const head = { id, payment, status: p.status, reversed };
      if (reversed) return [{ ...head, level: 'document' as const, allocation: null }];
      return [
        { ...head, level: 'document' as const, allocation: null },
        ...p.allocations.map((a, i) => ({
          ...head,
          level: 'line' as const,
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
    const nid = await this.nationalIds(rows.map((r) => r.carrierId));
    for (const row of rows) {
      // DTO ตัวเดียวกับ `GET /v1/settlements/{id}` (ผลประมาณการ WHT + บรรทัด) → canonical ชุดเดียวกับที่ส่ง ERP
      const dto = await this.settlements.get(row.id);
      const doc = canonicalSettlement(dto, row);
      // เลขเต็มเฉพาะที่ snapshot ระบุ INDIVIDUAL ชัด (canonical ตีประเภทไม่รู้เป็นบุคคล — ไม่ใช้ตัดสิน PII)
      const full =
        carrierEntityType(dto.carrier.entityType) === 'INDIVIDUAL'
          ? nid.get(row.carrierId)
          : undefined;
      const base = {
        id: encodeId('settlement', row.id),
        doc,
        payerName: row.payingCompany?.legalName ?? null,
        // canonical ไม่มีเลขบัตรของบุคคล (PDPA) — ไฟล์นักบัญชีใส่เต็มเฉพาะผู้มีสิทธิ์ (D-73) ไม่งั้นเลขท้าย 4 หลัก
        carrierTaxId:
          doc.carrier.entityType === 'JURISTIC'
            ? doc.carrier.taxId
            : (full ?? mask(dto.carrier.taxIdLast4)),
        piiIncluded: !!full,
      };
      out.push({ ...base, level: 'document', line: null });
      for (const line of doc.lines) out.push({ ...base, level: 'line', line });
    }
    return out;
  }

  /**
   * ชุด "สรุปหัก ณ ที่จ่าย (ประมาณการ)" (D-73) — 1 แถวต่อ (ฝั่ง, คู่ค้า) รวม**ค่าที่บันทึกไว้**เท่านั้น (ไม่คำนวณภาษีใหม่):
   * ผู้รับเหมา = ใบสำคัญจ่าย PAID (วันที่จ่ายในช่วง, `wht_amount` ตรึง > 0) · ลูกค้า = รับชำระ RECORDED (วันที่รับในช่วง, `wht_amount` > 0)
   * แสดงเฉพาะฝั่งที่ผู้สั่งอ่านได้ · อ่านครั้งเดียวทั้งชุด (spec `single`) — ไม่ใช่แบบ ภ.ง.ด. / 50 ทวิ (ออกที่ระบบบัญชี D-54/D-58)
   */
  async whtRows(q: AccountingExportQuery, page: ExportPage): Promise<AccountingWhtRow[]> {
    const { from, to } = this.check(q, 'wht');
    const tx = this.db.tx;
    const scopes = requestContext.require().scopes ?? [];
    const out: AccountingWhtRow[] = [];
    const byCode = (a: AccountingWhtRow, b: AccountingWhtRow) =>
      (a.code ?? '').localeCompare(b.code ?? '') || a.name.localeCompare(b.name, 'th');

    if (scopeAllows(scopes, 'settlements:read')) {
      const rows = await tx.carrierSettlement.findMany({
        where: { status: 'PAID', paidDate: { gte: from, lte: to }, whtAmount: { gt: 0 } },
        orderBy: [{ paidDate: 'asc' }, { settlementNo: 'asc' }, { id: 'asc' }],
        select: { id: true, carrierId: true, whtAmount: true },
      });
      const nid = await this.nationalIds(rows.map((r) => r.carrierId));
      const groups = new Map<string, AccountingWhtRow & { base: Prisma.Decimal | null }>();
      for (const r of rows) {
        // ผลประมาณการ ST6-T08 ตัวเดียวกับหน้าใบสำคัญจ่าย/canonical (แบบยื่น + ฐานต่ออัตรา) — ไม่คำนวณใหม่
        const s = await this.settlements.get(r.id);
        const est = s.whtEstimate;
        const base = settlementWhtBase(est, r.whtAmount!);
        const entityType = carrierEntityType(s.carrier.entityType);
        const full = entityType === 'INDIVIDUAL' ? nid.get(r.carrierId) : undefined;
        // ข้อมูลรถร่วม = snapshot ของใบล่าสุดในงวด (ใบเรียงตามวันที่จ่าย)
        const g = groups.get(r.carrierId) ?? {
          id: `carrier:${r.carrierId}`,
          side: 'carrier' as const,
          code: null,
          name: '',
          entityType: null,
          taxId: null,
          branchCode: null,
          forms: [],
          documents: 0,
          baseAmount: null,
          whtAmount: '0.00',
          piiIncluded: false,
          base: new Prisma.Decimal(0),
        };
        g.code = s.carrier.code;
        g.name = s.carrier.legalName;
        // ประเภทไม่รู้ (snapshot เก่า) = ว่าง — ไม่เดาว่าเป็นบุคคล · เลขยังแสดงแบบปิดไว้ (เลขเต็มเฉพาะ INDIVIDUAL ที่มีสิทธิ์)
        g.entityType = entityType;
        g.taxId =
          entityType === 'JURISTIC' ? s.carrier.taxId : (full ?? mask(s.carrier.taxIdLast4));
        g.piiIncluded = !!full;
        g.branchCode = s.carrier.branchCode;
        if (est?.form && !g.forms.includes(est.form)) g.forms = [...g.forms, est.form].sort();
        g.documents += 1;
        g.whtAmount = new Prisma.Decimal(g.whtAmount).plus(r.whtAmount!).toFixed(2);
        // ใบใดไม่มีผลประมาณการ หรือ WHT ของผลประมาณการไม่ตรงยอดที่ตรึง → ฐานของคู่ค้านี้ไม่ครบ = ว่าง (ไม่เดา)
        g.base = g.base && base ? g.base.plus(base) : null;
        groups.set(r.carrierId, g);
      }
      out.push(
        ...[...groups.values()]
          .map(({ base, ...g }) => ({ ...g, baseAmount: base ? base.toFixed(2) : null }))
          .sort(byCode),
      );
    }

    if (scopeAllows(scopes, 'invoices:read')) {
      const pays = await tx.payment.findMany({
        where: { status: 'RECORDED', receivedDate: { gte: from, lte: to }, whtAmount: { gt: 0 } },
        orderBy: [{ receivedDate: 'asc' }, { paymentNo: 'asc' }, { id: 'asc' }],
        select: {
          customerId: true,
          whtAmount: true,
          customer: { select: { code: true, legalName: true, taxId: true, branchCode: true } },
        },
      });
      const groups = new Map<string, AccountingWhtRow>();
      for (const p of pays) {
        const g = groups.get(p.customerId) ?? {
          id: `customer:${p.customerId}`,
          side: 'customer' as const,
          code: p.customer.code,
          name: p.customer.legalName,
          entityType: null,
          taxId: p.customer.taxId,
          branchCode: p.customer.branchCode,
          // แบบยื่น/ฐานของฝั่งลูกค้าไม่ได้เก็บในระบบ — [OPEN] spec/12 §3 แถว ST7-T23 (ไม่คำนวณเอง)
          forms: [],
          documents: 0,
          baseAmount: null,
          whtAmount: '0.00',
          piiIncluded: false,
        };
        g.documents += 1;
        g.whtAmount = new Prisma.Decimal(g.whtAmount).plus(p.whtAmount).toFixed(2);
        groups.set(p.customerId, g);
      }
      out.push(...[...groups.values()].sort(byCode));
    }
    return out.slice(0, page.take);
  }

  /** จำนวนเอกสาร/แถวต่อชุดที่ผู้เรียกมีสิทธิ์ (dialog "ส่งออกให้นักบัญชี" — ไฟล์ที่จะได้) */
  async summary(
    q: AccountingExportQuery,
    scopes: readonly string[],
  ): Promise<AccountingDatasetCount[]> {
    const { from, to } = this.check(q);
    const tx = this.db.tx;
    const out: AccountingDatasetCount[] = [];
    for (const dataset of ACCOUNTING_DATASETS) {
      if (!canRead(scopes, dataset)) continue;
      if (!this.adapters.resolve(q.template, dataset)) continue;
      let documents = 0;
      let cancelledDocuments = 0;
      let rows = 0;
      if (dataset === 'sales') {
        const range = { issueDate: { gte: from, lte: to } };
        const where = { status: { in: [...ISSUED_INVOICE_STATUSES] }, ...range };
        documents = await tx.invoice.count({ where });
        cancelledDocuments = await tx.invoice.count({
          where: {
            status: { in: [...CANCELLED_INVOICE_STATUSES] },
            invoiceNo: { not: null },
            ...range,
          },
        });
        const lines = await tx.invoiceLine.count({ where: { active: true, invoice: where } });
        rows = documents + lines + cancelledDocuments;
      } else if (dataset === 'receipts') {
        const range = { receivedDate: { gte: from, lte: to } };
        const where = { status: 'RECORDED' as const, ...range };
        documents = await tx.payment.count({ where });
        cancelledDocuments = await tx.payment.count({
          where: { status: 'REVERSED', ...range },
        });
        const lines = await tx.paymentAllocation.count({ where: { payment: where } });
        rows = documents + lines + cancelledDocuments;
      } else if (dataset === 'settlements') {
        const where = { status: 'PAID', paidDate: { gte: from, lte: to } };
        documents = await tx.carrierSettlement.count({ where });
        const lines = await tx.settlementLine.count({
          where: { voidedAt: null, settlement: where },
        });
        rows = documents + lines;
      } else {
        // สรุป WHT: เอกสาร = ใบที่มี WHT · แถว = จำนวนคู่ค้า (ฝั่งที่อ่านได้)
        if (scopeAllows(scopes, 'settlements:read')) {
          const where = {
            status: 'PAID',
            paidDate: { gte: from, lte: to },
            whtAmount: { gt: 0 },
          };
          documents += await tx.carrierSettlement.count({ where });
          rows += (await tx.carrierSettlement.groupBy({ by: ['carrierId'], where })).length;
        }
        if (scopeAllows(scopes, 'invoices:read')) {
          const where = {
            status: 'RECORDED' as const,
            receivedDate: { gte: from, lte: to },
            whtAmount: { gt: 0 },
          };
          documents += await tx.payment.count({ where });
          rows += (await tx.payment.groupBy({ by: ['customerId'], where })).length;
        }
      }
      out.push({ dataset, documents, cancelledDocuments, rows });
    }
    return out;
  }
}
