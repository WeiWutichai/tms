import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, type StoredDocument } from '@prisma/client';
import { scopeAllows } from '@tms/domain';
import { AuditService } from '../../audit/audit.service';
import { Clock } from '../../common/clock';
import { EXT_PREFIX, EXTERNAL_ID_RE } from '../../common/external-id';
import { encodeId, tryDecodeId } from '../../common/ids';
import { keysetArgs, toPage } from '../../common/pagination';
import { ProblemException, type FieldError } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { InvoiceStatusService } from '../invoices/invoice-status.service';
import { JobQueue } from '../../jobs/job-queue.service';
import { PdfRenderer } from '../../pdf/pdf-renderer';
import { putFileLocked, store } from '../documents/documents.controller';
import { customerParty, issuerParty } from '../invoices/invoice-pdf.service';
import type { InvoicePartySnapshot } from '../invoices/invoices.service';
import { issueNumber } from '../sequences/sequences.service';
import {
  BILLING_NOTE_TEMPLATE_VERSION,
  billingNoteDocument,
  type BillingNotePrintModel,
} from './billing-note.template';
import type {
  AcknowledgeBillingNoteDto,
  BillingNoteCandidatesDto,
  BillingNoteDto,
  BillingNoteListQuery,
  BillingNotePageDto,
  BillingNoteSummaryCountsDto,
  BillingNoteSummaryDto,
  CollectBillingNoteDto,
  CreateBillingNoteDto,
  UpdateBillingNoteDto,
} from './billing-note.dto';

const ENTITY = 'billing_note';
const NONE = '00000000-0000-0000-0000-000000000000';
/** งานเบื้องหลัง render + เก็บ PDF ต้นฉบับ/สำเนา (enqueue ใน transaction ของการออกเลข — แบบใบแจ้งหนี้ ST5-T09) */
export const BILLING_NOTE_PDF_JOB = 'billing_note.render_pdf';
const PDF_RETRY_MS = [10_000, 60_000, 300_000, 900_000, 3_600_000, 10_800_000, 21_600_000];
/** advisory lock ของการออกเลข BN ต่อ tenant — อ่านเวลาหลังได้ล็อก (วันที่เรียงตามเลข) */
const BN_NO_LOCK_NS = 0x1a11;
/** สถานะใบแจ้งหนี้ที่ใส่ในใบวางบิลได้ (ออกแล้ว ค้างชำระ — ST5-T13: รวมชำระบางส่วน · ชำระครบ/ยกเลิก ไม่ได้) */
const BILLABLE_INVOICE = ['ISSUED', 'PARTIALLY_PAID'] as const;

const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const isRealDay = (s: string) => !Number.isNaN(day(s).getTime()) && ymd(day(s)) === s;
const bangkokDay = (at: Date) => new Date(at.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
const money = (d: Prisma.Decimal | string) => new Prisma.Decimal(d).toFixed(2);

const LOAD = {
  customer: { select: { id: true, code: true, legalName: true, taxId: true, branchCode: true } },
  invoices: { orderBy: { lineNo: 'asc' } },
  pdfDocument: { select: { id: true, filename: true, sha256: true, sizeBytes: true } },
} as const satisfies Prisma.BillingNoteInclude;
type Row = Prisma.BillingNoteGetPayload<{ include: typeof LOAD }>;

type InvoiceForNote = {
  id: string;
  invoiceNo: string | null;
  status: string;
  customerId: string;
  issuingCompanyId: string;
  issuingBranchId: string;
  issueDate: Date | null;
  dueDate: Date | null;
  totalAmount: Prisma.Decimal;
  paidAmount: Prisma.Decimal;
  whtExpectedAmount: Prisma.Decimal;
};

/** ยอดค้างของใบแจ้งหนี้ ณ ตอนนี้ = ยอดรวม − รับชำระแล้ว (`paid_amount` — ST5-T13 ไม่นับที่กลับรายการ) */
function outstandingOf(inv: Pick<InvoiceForNote, 'totalAmount' | 'paidAmount'>): Prisma.Decimal {
  return inv.totalAmount.sub(inv.paidAmount);
}

/** WHT ประมาณการที่ยังเหลือ = ประมาณการของใบ − WHT ที่ลูกค้าหักไปแล้วในการรับชำระที่ยังไม่กลับรายการ (ไม่ติดลบ) */
async function whtRemaining(
  tx: Tx,
  invoices: InvoiceForNote[],
): Promise<Map<string, Prisma.Decimal>> {
  const ids = invoices.map((x) => x.id);
  const rows = ids.length
    ? await tx.$queryRaw<{ invoice_id: string; wht: Prisma.Decimal }[]>`
        SELECT a.invoice_id, COALESCE(SUM(a.wht_amount), 0) AS wht
          FROM payment_allocation a JOIN payment p ON p.id = a.payment_id
         WHERE a.invoice_id = ANY(${ids}::uuid[]) AND p.status = 'RECORDED'
         GROUP BY a.invoice_id`
    : [];
  const done = new Map(rows.map((r) => [r.invoice_id, new Prisma.Decimal(r.wht)]));
  return new Map(
    invoices.map((x) => {
      const left = x.whtExpectedAmount.sub(done.get(x.id) ?? 0);
      return [x.id, left.isNegative() ? new Prisma.Decimal(0) : left];
    }),
  );
}

function invalid(errors: FieldError[]): ProblemException {
  return new ProblemException('validation_failed', undefined, errors);
}

/**
 * ใบวางบิล (ST5-T11; docs/01 §3.4 `billing_note`, docs/04 F2 "ใบวางบิล", docs/01 §5.2 #9 `billing-notes`, spec/05 §3 BIL-039)
 * สรุปใบแจ้งหนี้ที่ออกแล้วและยังค้างของลูกค้าหนึ่งราย + ยอดรวม + วันนัดรับเช็ค/โอน + ผู้รับวางบิล · **ไม่กระทบ VAT/WHT** (D-54 — ไม่ใช่เอกสารภาษี)
 *
 * - DRAFT (ไม่มีเลข แก้ได้) → ISSUED (`/finalize`: ออกเลขชุด BN + snapshot ลูกค้า/ผู้ออก + PDF ต้นฉบับเก็บ ณ วันออก) → COLLECTED (`/collect`)
 * - DRAFT/ISSUED → CANCELLED (เหตุผล ≥ 10 + audit; เลขคงอยู่ — ยกเลิกใบวางบิลไม่กระทบใบแจ้งหนี้ BIL-039)
 * - ใบแจ้งหนี้หนึ่งใบอยู่ในใบวางบิลที่ active (DRAFT/ISSUED/COLLECTED — ปล่อยเฉพาะเมื่อยกเลิก, review M1) ได้ใบเดียว — unique partial ระดับ DB (migration 0142) → 409 `invoice_already_billed`
 * - ไม่แตะตาราง/สถานะใบแจ้งหนี้ (สถานะใบจากการรับชำระ = ST5-T13/T18)
 */
@Injectable()
export class BillingNotesService implements OnModuleInit {
  private readonly log = new Logger(BillingNotesService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly renderer: PdfRenderer,
    private readonly clock: Clock,
    private readonly queue: JobQueue,
    private readonly status: InvoiceStatusService,
  ) {}

  onModuleInit() {
    this.queue.register(
      BILLING_NOTE_PDF_JOB,
      async ({ job, tenantId }) => {
        const id = (job.payload as { billingNoteId?: unknown } | null)?.billingNoteId;
        if (typeof id !== 'string') return { skipped: 'bad_payload' };
        const out = await requestContext.run(
          { requestId: randomUUID(), tenantId, actorId: 'system:billing-note-pdf', locale: 'th' },
          async () => ({
            original: (await this.ensurePdf(id, 'ORIGINAL')).doc,
            copy: (await this.ensurePdf(id, 'COPY')).doc,
          }),
        );
        return {
          original: {
            documentId: encodeId('document', out.original.id),
            sha256: out.original.sha256,
          },
          copy: { documentId: encodeId('document', out.copy.id), sha256: out.copy.sha256 },
        };
      },
      { outsideTransaction: true, retryDelaysMs: PDF_RETRY_MS },
    );
  }

  /** transaction ของ tenant ปัจจุบัน (route @NoTransaction) + ให้ AuditService ใช้ transaction นี้ */
  private inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const ctx = requestContext.require();
    return this.db.withTenant(ctx.tenantId!, async (tx) => {
      ctx.tx = tx as never;
      try {
        return await fn(tx);
      } finally {
        ctx.tx = undefined;
      }
    });
  }

  // ---------- อ่าน ----------

  async list(q: BillingNoteListQuery): Promise<BillingNotePageDto> {
    const tx = this.db.tx;
    const k = keysetArgs(q);
    const and: Prisma.BillingNoteWhereInput[] = [k.where as Prisma.BillingNoteWhereInput];
    if (q.status) and.push({ status: q.status });
    if (q.customerId !== undefined)
      and.push({ customerId: (await this.customerRef(tx, q.customerId)) ?? NONE });
    const rows = await tx.billingNote.findMany({
      where: { AND: and },
      orderBy: k.orderBy as unknown as Prisma.BillingNoteOrderByWithRelationInput[],
      take: k.take,
      include: { customer: LOAD.customer },
    });
    const counts = new Map(
      (
        await tx.billingNoteInvoice.groupBy({
          by: ['billingNoteId'],
          where: { billingNoteId: { in: rows.map((r) => r.id) }, removedAt: null },
          _count: { _all: true },
        })
      ).map((g) => [g.billingNoteId, g._count._all]),
    );
    return toPage(
      rows,
      k,
      (r) => summary(r, counts.get(r.id) ?? 0),
      q.fields,
    ) as BillingNotePageDto;
  }

  async get(id: string, tx: Tx = this.db.tx): Promise<BillingNoteDto> {
    const r = await tx.billingNote.findUnique({ where: { id }, include: LOAD });
    if (!r) throw new ProblemException('not_found');
    return toDto(r);
  }

  async summary(): Promise<BillingNoteSummaryCountsDto> {
    const rows = await this.db.tx.billingNote.groupBy({ by: ['status'], _count: { _all: true } });
    const n = (s: string) => rows.find((r) => r.status === s)?._count._all ?? 0;
    return {
      total: rows.reduce((a, r) => a + r._count._all, 0),
      draft: n('DRAFT'),
      issued: n('ISSUED'),
      collected: n('COLLECTED'),
      cancelled: n('CANCELLED'),
    };
  }

  /** ใบแจ้งหนี้ของลูกค้าที่ใส่ในใบวางบิลได้: ออกแล้ว ค้างชำระ ไม่อยู่ในใบวางบิลอื่นที่ active */
  async candidates(customerRef: string): Promise<BillingNoteCandidatesDto> {
    const tx = this.db.tx;
    const customerId = (await this.customerRef(tx, customerRef)) ?? NONE;
    const rows = await tx.invoice.findMany({
      where: {
        customerId,
        status: { in: [...BILLABLE_INVOICE] },
        invoiceNo: { not: null },
        billingNoteLinks: { none: { active: true } },
      },
      orderBy: [{ issueDate: 'asc' }, { invoiceNo: 'asc' }],
      take: 500,
    });
    const whtLeft = await whtRemaining(tx, rows);
    return {
      data: rows.map((i) => ({
        invoiceId: encodeId('invoice', i.id),
        invoiceNo: i.invoiceNo!,
        issueDate: i.issueDate ? ymd(i.issueDate) : '',
        dueDate: i.dueDate ? ymd(i.dueDate) : '',
        status: i.status,
        issuingCompanyId: encodeId('company', i.issuingCompanyId),
        issuingBranchId: encodeId('branch', i.issuingBranchId),
        sellTotal: money(i.totalAmount),
        sellWhtExpected: money(whtLeft.get(i.id)!),
        sellOutstanding: money(outstandingOf(i)),
      })),
    };
  }

  // ---------- เขียน ----------

  async create(body: CreateBillingNoteDto): Promise<BillingNoteDto> {
    const tx = this.db.tx;
    const ctx = requestContext.require();
    const customerId = await this.customerRef(tx, body.customerId);
    const customer = customerId
      ? await tx.customer.findFirst({ where: { id: customerId, deletedAt: null } })
      : null;
    if (!customer)
      throw invalid([
        { field: 'customerId', code: 'invalid_reference', message: 'customer not found' },
      ]);
    if (body.collectionDate !== undefined) this.checkDate('collectionDate', body.collectionDate);
    const invoices = await this.loadInvoices(tx, body.invoiceIds, customer.id);
    const first = invoices[0]!;
    const bn = await tx.billingNote.create({
      data: {
        tenantId: ctx.tenantId!,
        customerId: customer.id,
        issuingCompanyId: first.issuingCompanyId,
        issuingBranchId: first.issuingBranchId,
        collectionDate: body.collectionDate ? day(body.collectionDate) : null,
        note: body.note || null,
        createdBy: ctx.actorId ?? null,
      },
    });
    await this.attach(tx, bn, invoices);
    const out = await this.get(bn.id);
    await this.audit.record({
      action: 'billing_note.draft_created',
      entityType: ENTITY,
      entityId: bn.id,
      after: {
        customerId: out.customer.id,
        invoices: out.invoices.map((i) => i.invoiceNo),
        collectionDate: out.collectionDate,
        total: out.sellTotal,
      },
    });
    return out;
  }

  async update(id: string, body: UpdateBillingNoteDto, expected?: number): Promise<BillingNoteDto> {
    const tx = this.db.tx;
    const bn = await this.lock(tx, id, expected, ['DRAFT']);
    if (body.collectionDate) this.checkDate('collectionDate', body.collectionDate);
    const before = await this.get(id);
    if (body.invoiceIds) {
      const invoices = await this.loadInvoices(tx, body.invoiceIds, bn.customerId);
      await this.attach(tx, bn, invoices);
    }
    const data: Prisma.BillingNoteUpdateInput = {
      updatedBy: requestContext.require().actorId ?? null,
      version: { increment: 1 },
    };
    if (body.collectionDate !== undefined)
      data.collectionDate = body.collectionDate ? day(body.collectionDate) : null;
    if (body.note !== undefined) data.note = body.note || null;
    await tx.billingNote.update({ where: { id }, data });
    const out = await this.get(id);
    await this.audit.changed(
      'billing_note.draft_updated',
      ENTITY,
      id,
      headerOf(before),
      headerOf(out),
    );
    return out;
  }

  /** ออกเอกสาร: DRAFT → ISSUED — ออกเลขชุด BN + snapshot + PDF ต้นฉบับ (หลัง commit) */
  async finalize(id: string, expected: number | undefined): Promise<BillingNoteDto> {
    await this.inTx((tx) => this.issue(tx, id, expected));
    try {
      await this.ensurePdf(id, 'ORIGINAL');
    } catch (e) {
      // ออกแล้ว (commit) — งาน `billing_note.render_pdf` ลองใหม่จนเก็บได้ · ไม่ย้อนการออกเลข
      this.log.warn(`billing note ${id}: issued PDF not stored yet — ${(e as Error).message}`);
    }
    return this.inTx((tx) => this.get(id, tx));
  }

  private async issue(tx: Tx, id: string, expected: number | undefined): Promise<void> {
    const ctx = requestContext.require();
    await tx.$queryRaw`SELECT id FROM billing_note WHERE id = ${id}::uuid FOR UPDATE`;
    const bn = await tx.billingNote.findUnique({
      where: { id },
      include: { customer: true, issuingCompany: true, issuingBranch: true },
    });
    if (!bn) throw new ProblemException('not_found');
    // ออกเอกสาร = ล็อกถาวร ต้องอ้าง version ที่ผู้ออกเห็น (แบบใบแจ้งหนี้ ST5-T09)
    if (expected === undefined)
      throw invalid([
        {
          field: 'If-Match',
          code: 'if_match_required',
          message: 'send If-Match (ETag of the billing note)',
        },
      ]);
    if (expected !== bn.version) throw new ProblemException('precondition_failed');
    if (bn.status !== 'DRAFT')
      throw new ProblemException('invalid_state_transition', undefined, undefined, {
        currentStatus: bn.status,
      });
    // ตรวจใบแจ้งหนี้ซ้ำตอนออก (สถานะอาจเปลี่ยนหลังสร้างร่าง) + ยอด ณ วันออก
    const links = await tx.billingNoteInvoice.findMany({
      where: { billingNoteId: id, active: true },
      select: { invoiceId: true },
    });
    if (!links.length)
      throw invalid([
        { field: 'invoiceIds', code: 'required', message: 'add at least one invoice' },
      ]);
    const invoices = await this.lockInvoices(
      tx,
      links.map((l) => l.invoiceId),
    );
    this.assertBillable(invoices);
    await this.attach(tx, bn, invoices);

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BN_NO_LOCK_NS}::int, hashtext(${ctx.tenantId!}))`;
    const now = this.clock.now();
    const billingDate = bangkokDay(now);
    if (!bn.collectionDate)
      throw invalid([
        {
          field: 'collectionDate',
          code: 'required',
          message: 'set the cheque/transfer collection date first',
        },
      ]);
    if (ymd(bn.collectionDate) < billingDate)
      throw invalid([
        {
          field: 'collectionDate',
          code: 'before_billing_date',
          message: 'collectionDate must be on or after the billing date (today)',
        },
      ]);
    const billingNoteNo = await issueNumber(tx, ctx.tenantId!, {
      docType: 'BN',
      branchId: bn.issuingBranchId,
      at: now,
    });
    const tenant = await tx.tenant.findFirst({ select: { yearStyle: true } });
    const customer: InvoicePartySnapshot = { code: bn.customer.code, ...customerParty(bn) };
    const issuer: InvoicePartySnapshot = issuerParty(bn);
    await tx.billingNote.update({
      where: { id },
      data: {
        status: 'ISSUED',
        billingNoteNo,
        billingDate: day(billingDate),
        issuedAt: now,
        issuedBy: ctx.actorId ?? 'system',
        customerSnapshot: customer as unknown as Prisma.InputJsonValue,
        issuerSnapshot: issuer as unknown as Prisma.InputJsonValue,
        printOptions: {
          yearStyle: tenant?.yearStyle === 'CE' ? 'CE' : 'BE',
          templateVersion: BILLING_NOTE_TEMPLATE_VERSION,
        },
        updatedBy: ctx.actorId ?? null,
        version: { increment: 1 },
      },
    });
    // ST5-T18 ออกใบวางบิล = ส่งลูกค้าแล้ว (ช่องทาง BILLING_NOTE) — ใบที่ยังไม่มีธง
    await this.status.markSentByBillingNote(
      tx,
      invoices.map((i) => i.id),
      { id, billingNoteNo },
      now,
    );
    const out = await this.get(id, tx);
    await this.audit.record({
      action: 'billing_note.issued',
      entityType: ENTITY,
      entityId: id,
      before: { status: 'DRAFT', billingNoteNo: null },
      after: {
        status: 'ISSUED',
        billingNoteNo,
        billingDate,
        collectionDate: out.collectionDate,
        invoices: out.invoices.filter((i) => !i.removed).map((i) => i.invoiceNo),
        total: out.sellTotal,
      },
    });
    await this.queue.enqueue(tx, {
      tenantId: ctx.tenantId!,
      type: BILLING_NOTE_PDF_JOB,
      payload: { billingNoteId: id },
      maxAttempts: PDF_RETRY_MS.length + 1,
    });
  }

  /** ผู้รับวางบิล (ชื่อฝั่งลูกค้า + วันที่รับ) — ใบที่ออกแล้ว (ISSUED/COLLECTED) · บันทึกซ้ำ = แก้ (audit ค่าเดิม/ใหม่) */
  async acknowledge(
    id: string,
    body: AcknowledgeBillingNoteDto,
    expected?: number,
  ): Promise<BillingNoteDto> {
    const tx = this.db.tx;
    const bn = await this.lock(tx, id, expected, ['ISSUED', 'COLLECTED']);
    this.checkDate('receivedOn', body.receivedOn);
    const today = bangkokDay(this.clock.now());
    if (bn.billingDate && body.receivedOn < ymd(bn.billingDate))
      throw invalid([
        {
          field: 'receivedOn',
          code: 'before_billing_date',
          message: 'receivedOn must be ≥ billing date',
        },
      ]);
    if (body.receivedOn > today)
      throw invalid([
        { field: 'receivedOn', code: 'future_date', message: 'receivedOn cannot be in the future' },
      ]);
    const actor = requestContext.require().actorId ?? null;
    const before = {
      acknowledgedBy: bn.acknowledgedByName,
      acknowledgedOn: bn.acknowledgedOn ? ymd(bn.acknowledgedOn) : null,
    };
    await tx.billingNote.update({
      where: { id },
      data: {
        acknowledgedByName: body.receivedBy,
        acknowledgedOn: day(body.receivedOn),
        acknowledgedAt: this.clock.now(),
        acknowledgedBy: actor,
        updatedBy: actor,
        version: { increment: 1 },
      },
    });
    await this.audit.changed('billing_note.acknowledged', ENTITY, id, before, {
      acknowledgedBy: body.receivedBy,
      acknowledgedOn: body.receivedOn,
    });
    return this.get(id);
  }

  /** รับเช็ค/โอนแล้ว: ISSUED → COLLECTED — ผูกใบแจ้งหนี้คงไว้ (กันวางบิลซ้ำ จน ST5-T13/T18 กำหนดกติกาเช็คคืน/รับบางส่วน — review M1) · COLLECTED = สถานะสิ้นสุด */
  async collect(
    id: string,
    body: CollectBillingNoteDto,
    expected?: number,
  ): Promise<BillingNoteDto> {
    const tx = this.db.tx;
    await this.lock(tx, id, expected, ['ISSUED']);
    const actor = requestContext.require().actorId ?? null;
    await tx.billingNote.update({
      where: { id },
      data: {
        status: 'COLLECTED',
        collectedAt: this.clock.now(),
        collectedBy: actor,
        collectNote: body.note || null,
        updatedBy: actor,
        version: { increment: 1 },
      },
    });
    await this.audit.record({
      action: 'billing_note.collected',
      entityType: ENTITY,
      entityId: id,
      before: { status: 'ISSUED' },
      after: { status: 'COLLECTED', note: body.note || null },
    });
    return this.get(id);
  }

  /** ยกเลิก: DRAFT (`invoices:draft`) / ISSUED (`invoices:finalize`) → CANCELLED — เหตุผล + audit · เลขคงอยู่ · ไม่กระทบใบแจ้งหนี้ */
  async cancel(id: string, reason: string, expected?: number): Promise<BillingNoteDto> {
    const tx = this.db.tx;
    const ctx = requestContext.require();
    const bn = await this.lock(tx, id, expected, ['DRAFT', 'ISSUED']);
    if (bn.status === 'ISSUED' && !scopeAllows(ctx.scopes ?? [], 'invoices:finalize'))
      throw new ProblemException('permission_denied', undefined, undefined, {
        requiredScope: 'invoices:finalize',
      });
    // ST5-T18 ใบวางบิลที่ออกแล้ว → ล้างธง "ส่งลูกค้าแล้ว" ที่ตั้งตอนออกใบวางบิลนี้ (ก่อนปิดลิงก์)
    const linked =
      bn.status === 'ISSUED'
        ? (
            await tx.billingNoteInvoice.findMany({
              where: { billingNoteId: id, active: true },
              select: { invoiceId: true },
            })
          ).map((l) => l.invoiceId)
        : [];
    await tx.billingNote.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        cancelledAt: this.clock.now(),
        cancelledBy: ctx.actorId ?? null,
        cancelReason: reason,
        updatedBy: ctx.actorId ?? null,
        version: { increment: 1 },
      },
    });
    await this.audit.record({
      action: 'billing_note.cancelled',
      entityType: ENTITY,
      entityId: id,
      before: { status: bn.status, billingNoteNo: bn.billingNoteNo },
      after: { status: 'CANCELLED', billingNoteNo: bn.billingNoteNo },
      reason,
    });
    if (linked.length)
      await this.status.clearSentByBillingNote(
        tx,
        linked,
        { id, billingNoteNo: bn.billingNoteNo },
        `ยกเลิกใบวางบิล ${bn.billingNoteNo ?? ''}: ${reason}`.trim(),
      );
    return this.get(id);
  }

  // ---------- PDF ----------

  /** PDF ตัวอย่างของร่าง (ลายน้ำ "ร่าง" ไม่มีเลข) — render ใหม่ทุกครั้ง ไม่เก็บ */
  async proforma(id: string): Promise<Buffer> {
    const model = await this.inTx(async (tx) => {
      const bn = await tx.billingNote.findUnique({
        where: { id },
        include: {
          customer: true,
          issuingCompany: true,
          issuingBranch: true,
          invoices: { orderBy: { lineNo: 'asc' } },
        },
      });
      if (!bn) throw new ProblemException('not_found');
      if (bn.status !== 'DRAFT')
        throw new ProblemException('invalid_state_transition', undefined, undefined, {
          currentStatus: bn.status,
        });
      const tenant = await tx.tenant.findFirst({ select: { yearStyle: true } });
      return printModel(bn, {
        yearStyle: tenant?.yearStyle === 'CE' ? 'CE' : 'BE',
        no: null,
        copy: null,
        billingDate: bangkokDay(this.clock.now()),
        issuer: issuerParty(bn),
        customer: customerParty(bn),
      });
    });
    return this.renderer.pdf(billingNoteDocument(model));
  }

  /**
   * PDF ใบที่ออกแล้ว: ต้นฉบับ = ไฟล์ที่เก็บตอนออก (`pdf_document_id`) · สำเนา = render จาก snapshot ครั้งแรกแล้วเก็บ
   * render ได้เฉพาะแม่แบบรุ่นเดียวกับวันออก (ไม่ render ใบเก่าด้วยแม่แบบใหม่เงียบ ๆ) · ร่าง → 409
   */
  async ensurePdf(
    id: string,
    copy: 'ORIGINAL' | 'COPY',
  ): Promise<{ doc: StoredDocument; data: Buffer }> {
    const found = await this.inTx(async (tx) => {
      const bn = await tx.billingNote.findUnique({
        where: { id },
        include: { invoices: { orderBy: { lineNo: 'asc' } } },
      });
      if (!bn) throw new ProblemException('not_found');
      if (!bn.billingNoteNo || !bn.billingDate)
        throw new ProblemException('invalid_state_transition', undefined, undefined, {
          currentStatus: bn.status,
        });
      const doc = await storedPdf(tx, bn.id, bn.pdfDocumentId, copy);
      if (doc) return { doc, model: null, no: bn.billingNoteNo };
      const print = bn.printOptions as { yearStyle?: string; templateVersion?: number } | null;
      if (print?.templateVersion !== BILLING_NOTE_TEMPLATE_VERSION)
        throw new ProblemException('invoice_pdf_template_changed', undefined, undefined, {
          issuedTemplateVersion: print?.templateVersion ?? null,
          currentTemplateVersion: BILLING_NOTE_TEMPLATE_VERSION,
        });
      const cs = bn.customerSnapshot as unknown as InvoicePartySnapshot;
      const is = bn.issuerSnapshot as unknown as InvoicePartySnapshot;
      const model = printModel(bn, {
        yearStyle: print.yearStyle === 'CE' ? 'CE' : 'BE',
        no: bn.billingNoteNo,
        copy,
        billingDate: ymd(bn.billingDate),
        issuer: { name: is.name, taxId: is.taxId, branchCode: is.branchCode, address: is.address },
        customer: {
          name: cs.name,
          taxId: cs.taxId,
          branchCode: cs.taxId ? cs.branchCode : null,
          address: cs.address,
        },
      });
      return { doc: null, model, no: bn.billingNoteNo };
    });
    if (found.doc) return { doc: found.doc, data: await store().get(found.doc.fileKey!) };
    const data = await this.renderer.pdf(billingNoteDocument(found.model!));
    const ctx = requestContext.require();
    const doc = await this.inTx(async (tx) => {
      const rows = await tx.$queryRaw<{ pdf_document_id: string | null }[]>`
        SELECT pdf_document_id FROM billing_note WHERE id = ${id}::uuid FOR UPDATE`;
      const existing = await storedPdf(tx, id, rows[0]?.pdf_document_id ?? null, copy);
      if (existing) return existing;
      const f = await putFileLocked(tx, ctx.tenantId!, data, 'pdf');
      const created = await tx.storedDocument.create({
        data: {
          tenantId: ctx.tenantId!,
          status: 'READY',
          kind: 'PDF',
          mimeType: 'application/pdf',
          fileKey: f.key,
          sha256: f.sha256,
          sizeBytes: f.size,
          filename: `${found.no}${copy === 'COPY' ? '-copy' : ''}.pdf`,
          entityType: ENTITY,
          entityId: id,
          createdBy: ctx.actorId ?? null,
          metadata: { document: 'BILLING_NOTE', copy, billingNoteNo: found.no },
        },
      });
      // ผูกไฟล์ไม่ใช่การแก้ใบ — raw SQL ไม่เปลี่ยน version/updated_at
      if (copy === 'ORIGINAL')
        await tx.$executeRaw`UPDATE billing_note SET pdf_document_id = ${created.id}::uuid WHERE id = ${id}::uuid`;
      await this.audit.record({
        action: 'billing_note.pdf_stored',
        entityType: ENTITY,
        entityId: id,
        after: {
          documentId: encodeId('document', created.id),
          copy,
          billingNoteNo: found.no,
          sha256: f.sha256,
        },
      });
      return created;
    });
    return { doc, data };
  }

  // ---------- ภายใน ----------

  /** ล็อกใบ (FOR UPDATE) + If-Match (412) + สถานะที่ยอม (409) */
  private async lock(tx: Tx, id: string, expected: number | undefined, allowed: string[]) {
    await tx.$queryRaw`SELECT id FROM billing_note WHERE id = ${id}::uuid FOR UPDATE`;
    const bn = await tx.billingNote.findUnique({ where: { id } });
    if (!bn) throw new ProblemException('not_found');
    if (expected !== undefined && expected !== bn.version)
      throw new ProblemException('precondition_failed');
    if (!allowed.includes(bn.status))
      throw new ProblemException('invalid_state_transition', undefined, undefined, {
        currentStatus: bn.status,
      });
    return bn;
  }

  private async lockInvoices(tx: Tx, ids: string[]): Promise<InvoiceForNote[]> {
    const sorted = [...new Set(ids)].sort();
    // FOR SHARE เรียง id — ยกเลิก/ออกใบพร้อมกันรอกัน (ไม่ใส่ใบที่กำลังถูกยกเลิก)
    await tx.$queryRaw`SELECT id FROM invoice WHERE id = ANY(${sorted}::uuid[]) ORDER BY id FOR SHARE`;
    return tx.invoice.findMany({
      where: { id: { in: sorted } },
      orderBy: [{ issueDate: 'asc' }, { invoiceNo: 'asc' }],
    });
  }

  /** decode + ตรวจ: มีอยู่ · ลูกค้าเดียวกัน · ผู้ออก/สาขาผู้ออกเดียวกัน · ออกแล้วค้างชำระ */
  private async loadInvoices(
    tx: Tx,
    refs: string[],
    customerId: string,
  ): Promise<InvoiceForNote[]> {
    const ids: string[] = [];
    const bad: FieldError[] = [];
    refs.forEach((r, i) => {
      const id = tryDecodeId('invoice', r);
      if (!id)
        bad.push({
          field: `invoiceIds[${i}]`,
          code: 'invalid_reference',
          message: 'invoice not found',
        });
      else ids.push(id);
    });
    if (bad.length) throw invalid(bad);
    const invoices = await this.lockInvoices(tx, ids);
    const found = new Set(invoices.map((x) => x.id));
    refs.forEach((r, i) => {
      if (!found.has(tryDecodeId('invoice', r)!))
        bad.push({
          field: `invoiceIds[${i}]`,
          code: 'invalid_reference',
          message: 'invoice not found',
        });
    });
    if (bad.length) throw invalid(bad);
    const other = invoices.filter((x) => x.customerId !== customerId);
    if (other.length)
      throw invalid(
        other.map((x) => ({
          field: 'invoiceIds',
          code: 'customer_mismatch',
          message: `invoice ${x.invoiceNo ?? encodeId('invoice', x.id)} belongs to another customer`,
        })),
      );
    const [first] = invoices;
    const mixed = invoices.filter(
      (x) =>
        x.issuingCompanyId !== first!.issuingCompanyId ||
        x.issuingBranchId !== first!.issuingBranchId,
    );
    if (mixed.length)
      throw invalid([
        {
          field: 'invoiceIds',
          code: 'issuer_mismatch',
          message: 'all invoices must have the same issuing company and branch',
        },
      ]);
    this.assertBillable(invoices);
    return invoices;
  }

  private assertBillable(invoices: InvoiceForNote[]) {
    const bad = invoices.filter(
      (x) =>
        !(BILLABLE_INVOICE as readonly string[]).includes(x.status) ||
        !x.invoiceNo ||
        !x.issueDate ||
        !x.dueDate ||
        !outstandingOf(x).greaterThan(0),
    );
    if (bad.length)
      throw new ProblemException('invoice_not_billable', undefined, undefined, {
        invoices: bad.map((x) => ({
          invoiceId: encodeId('invoice', x.id),
          invoiceNo: x.invoiceNo,
          status: x.status,
        })),
      });
  }

  /**
   * ตั้งชุดใบแจ้งหนี้ของร่าง: ถอดใบที่ไม่อยู่ในชุด (active=false + removed_at) · ใส่ใบใหม่ (ยอด ณ ตอนนี้) · ใบเดิมอัปเดตยอด
   * ใบอยู่ในใบวางบิลอื่นที่ active → 409 `invoice_already_billed` (ตรวจก่อน + unique partial ระดับ DB กันแข่งกัน)
   */
  private async attach(
    tx: Tx,
    bn: { id: string; tenantId: string; issuingCompanyId: string; issuingBranchId: string },
    invoices: InvoiceForNote[],
  ): Promise<void> {
    const first = invoices[0]!;
    if (
      first.issuingCompanyId !== bn.issuingCompanyId ||
      first.issuingBranchId !== bn.issuingBranchId
    )
      throw invalid([
        {
          field: 'invoiceIds',
          code: 'issuer_mismatch',
          message: 'all invoices must have the same issuing company and branch as the billing note',
        },
      ]);
    const ids = invoices.map((x) => x.id);
    const taken = await tx.billingNoteInvoice.findMany({
      where: { invoiceId: { in: ids }, active: true, billingNoteId: { not: bn.id } },
      include: { billingNote: { select: { id: true, billingNoteNo: true } } },
    });
    if (taken.length) throw alreadyBilled(taken, invoices);
    const current = await tx.billingNoteInvoice.findMany({ where: { billingNoteId: bn.id } });
    const now = this.clock.now();
    const drop = current.filter((l) => l.active && !ids.includes(l.invoiceId)).map((l) => l.id);
    if (drop.length)
      await tx.billingNoteInvoice.updateMany({
        where: { id: { in: drop } },
        data: { active: false, removedAt: now },
      });
    let lineNo = current.reduce((a, l) => Math.max(a, l.lineNo), 0);
    const whtLeft = await whtRemaining(tx, invoices);
    for (const inv of invoices) {
      const snap = {
        invoiceNo: inv.invoiceNo!,
        issueDate: inv.issueDate!,
        dueDate: inv.dueDate!,
        totalAmount: inv.totalAmount,
        // ST5-T13: ชำระบางส่วนแล้ว → WHT ที่ยังคาดว่าจะถูกหัก = ส่วนที่เหลือ (สุทธิคาดรับ = คงค้าง − WHT ที่เหลือ)
        whtExpectedAmount: whtLeft.get(inv.id)!,
        outstandingAmount: outstandingOf(inv),
      };
      const have = current.find((l) => l.active && l.invoiceId === inv.id);
      if (have) {
        await tx.billingNoteInvoice.update({ where: { id: have.id }, data: snap });
        continue;
      }
      try {
        await tx.billingNoteInvoice.create({
          data: {
            tenantId: bn.tenantId,
            billingNoteId: bn.id,
            invoiceId: inv.id,
            lineNo: ++lineNo,
            ...snap,
          },
        });
      } catch (e) {
        // แข่งกับคำขออื่น: unique partial (tenant_id, invoice_id) WHERE active
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
          throw new ProblemException('invoice_already_billed', undefined, undefined, {
            invoices: [{ invoiceId: encodeId('invoice', inv.id), invoiceNo: inv.invoiceNo }],
          });
        throw e;
      }
    }
    // ยอดรวมจากใบที่อยู่ในร่าง
    const t = await tx.billingNoteInvoice.aggregate({
      where: { billingNoteId: bn.id, active: true },
      _sum: { outstandingAmount: true, whtExpectedAmount: true },
    });
    const total = t._sum.outstandingAmount ?? new Prisma.Decimal(0);
    const wht = t._sum.whtExpectedAmount ?? new Prisma.Decimal(0);
    await tx.billingNote.update({
      where: { id: bn.id },
      data: { totalAmount: total, totalWhtExpected: wht, netExpected: total.minus(wht) },
    });
  }

  private checkDate(field: string, v: string) {
    if (!isRealDay(v))
      throw invalid([{ field, code: 'invalid_date', message: 'must be a real date (YYYY-MM-DD)' }]);
  }

  private async customerRef(tx: Tx, ref: string): Promise<string | null> {
    if (ref.startsWith(EXT_PREFIX)) {
      const ext = ref.slice(EXT_PREFIX.length);
      if (!EXTERNAL_ID_RE.test(ext)) return null;
      const c = await tx.customer.findFirst({
        where: { externalId: ext, deletedAt: null },
        select: { id: true },
      });
      return c?.id ?? null;
    }
    return tryDecodeId('customer', ref);
  }
}

function alreadyBilled(
  taken: { invoiceId: string; billingNote: { id: string; billingNoteNo: string | null } }[],
  invoices: InvoiceForNote[],
): ProblemException {
  return new ProblemException('invoice_already_billed', undefined, undefined, {
    invoices: taken.map((t) => ({
      invoiceId: encodeId('invoice', t.invoiceId),
      invoiceNo: invoices.find((x) => x.id === t.invoiceId)?.invoiceNo ?? null,
      billingNoteId: encodeId('billingNote', t.billingNote.id),
      billingNoteNo: t.billingNote.billingNoteNo,
    })),
  });
}

async function storedPdf(
  tx: Tx,
  id: string,
  pdfDocumentId: string | null,
  copy: 'ORIGINAL' | 'COPY',
): Promise<StoredDocument | null> {
  const doc =
    copy === 'ORIGINAL'
      ? pdfDocumentId
        ? await tx.storedDocument.findUnique({ where: { id: pdfDocumentId } })
        : null
      : await tx.storedDocument.findFirst({
          where: {
            entityType: ENTITY,
            entityId: id,
            kind: 'PDF',
            metadata: { path: ['copy'], equals: 'COPY' },
          },
          orderBy: { createdAt: 'asc' },
        });
  if (doc && (doc.status !== 'READY' || !doc.fileKey)) throw new ProblemException('not_found');
  return doc;
}

/** ใบแจ้งหนี้ "ในใบ" = ยังไม่ถูกถอดออกจากร่าง (removed_at ว่าง) — `active` เป็นตัวกันซ้ำ (หยุดนับเมื่อใบวางบิลปิด) */
const inNote = <L extends { removedAt: Date | null }>(ls: L[]) =>
  ls.filter((l) => l.removedAt === null);

function printModel(
  bn: {
    collectionDate: Date | null;
    totalAmount: Prisma.Decimal;
    totalWhtExpected: Prisma.Decimal;
    netExpected: Prisma.Decimal;
    note: string | null;
    invoices: {
      removedAt: Date | null;
      invoiceNo: string;
      issueDate: Date;
      dueDate: Date;
      totalAmount: Prisma.Decimal;
      outstandingAmount: Prisma.Decimal;
    }[];
  },
  o: Pick<BillingNotePrintModel, 'yearStyle' | 'copy' | 'billingDate' | 'issuer' | 'customer'> & {
    no: string | null;
  },
): BillingNotePrintModel {
  return {
    yearStyle: o.yearStyle,
    billingNoteNo: o.no,
    copy: o.copy,
    billingDate: o.billingDate,
    collectionDate: bn.collectionDate ? ymd(bn.collectionDate) : null,
    issuer: o.issuer,
    customer: o.customer,
    invoices: inNote(bn.invoices).map((l) => ({
      invoiceNo: l.invoiceNo,
      issueDate: ymd(l.issueDate),
      dueDate: ymd(l.dueDate),
      total: money(l.totalAmount),
      outstanding: money(l.outstandingAmount),
    })),
    total: money(bn.totalAmount),
    whtExpected: money(bn.totalWhtExpected),
    netExpected: money(bn.netExpected),
    note: bn.note,
  };
}

function summary(
  r: Prisma.BillingNoteGetPayload<{ include: { customer: (typeof LOAD)['customer'] } }>,
  invoiceCount: number,
): BillingNoteSummaryDto {
  return {
    id: encodeId('billingNote', r.id),
    billingNoteNo: r.billingNoteNo,
    status: r.status,
    customer: {
      id: encodeId('customer', r.customer.id),
      code: r.customer.code,
      legalName: r.customer.legalName,
      taxId: r.customer.taxId,
      branchCode: r.customer.branchCode,
    },
    invoiceCount,
    billingDate: r.billingDate ? ymd(r.billingDate) : null,
    collectionDate: r.collectionDate ? ymd(r.collectionDate) : null,
    sellTotal: money(r.totalAmount),
    sellNetExpected: money(r.netExpected),
    version: r.version,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function toDto(r: Row): BillingNoteDto {
  return {
    ...summary(r, inNote(r.invoices).length),
    issuingCompanyId: encodeId('company', r.issuingCompanyId),
    issuingBranchId: encodeId('branch', r.issuingBranchId),
    sellWhtExpected: money(r.totalWhtExpected),
    note: r.note,
    invoices: r.invoices.map((l) => ({
      invoiceId: encodeId('invoice', l.invoiceId),
      invoiceNo: l.invoiceNo,
      issueDate: ymd(l.issueDate),
      dueDate: ymd(l.dueDate),
      active: l.active,
      removed: l.removedAt !== null,
      sellTotal: money(l.totalAmount),
      sellWhtExpected: money(l.whtExpectedAmount),
      sellOutstanding: money(l.outstandingAmount),
    })),
    acknowledgement:
      r.acknowledgedByName && r.acknowledgedOn && r.acknowledgedAt
        ? {
            name: r.acknowledgedByName,
            receivedOn: ymd(r.acknowledgedOn),
            recordedAt: r.acknowledgedAt.toISOString(),
            recordedBy: r.acknowledgedBy,
          }
        : null,
    collectedAt: r.collectedAt?.toISOString() ?? null,
    collectedBy: r.collectedBy,
    collectNote: r.collectNote,
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
    cancelReason: r.cancelReason,
    createdBy: r.createdBy,
    issuedAt: r.issuedAt?.toISOString() ?? null,
    issuedBy: r.issuedBy,
    pdf:
      r.pdfDocument && r.pdfDocument.sha256
        ? {
            documentId: encodeId('document', r.pdfDocument.id),
            filename: r.pdfDocument.filename ?? `${r.billingNoteNo}.pdf`,
            sha256: r.pdfDocument.sha256,
            sizeBytes: r.pdfDocument.sizeBytes ?? 0,
          }
        : null,
  };
}

/** ช่องที่ audit ของการแก้ร่างเทียบ */
function headerOf(d: BillingNoteDto): Record<string, unknown> {
  return {
    collectionDate: d.collectionDate,
    note: d.note,
    invoices: d.invoices.filter((i) => !i.removed).map((i) => i.invoiceNo),
    total: d.sellTotal,
  };
}
