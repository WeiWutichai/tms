import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, type StoredDocument } from '@prisma/client';
import { eventDefinition } from '@tms/domain';
import { AuditService } from '../../audit/audit.service';
import { resolveActors } from '../../common/actors';
import { Clock } from '../../common/clock';
import { encodeId } from '../../common/ids';
import { redactPrices } from '../../common/price-fields';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { JobQueue } from '../../jobs/job-queue.service';
import { PdfRenderer } from '../../pdf/pdf-renderer';
import { DeliveryOrderService } from '../delivery-orders/delivery-order.service';
import { ErpSyncService } from '../erp/erp-sync.service';
import { putFileLocked, store } from '../documents/documents.controller';
import { issueNumber } from '../sequences/sequences.service';
import { readSettings } from '../settings/settings.service';
import { InvoiceBillingGuard } from './billing-guard.service';
import {
  InvoicePdfService,
  customerParty,
  issuerParty,
  type InvoicePrintOptions,
} from './invoice-pdf.service';
import { INVOICE_TEMPLATE_VERSION, invoiceDocument } from './invoice.template';
import type { InvoiceDto } from './invoice.dto';
import { InvoicesService, type InvoicePartySnapshot } from './invoices.service';

const ENTITY = 'invoice';
/** งานเบื้องหลัง render + เก็บ PDF ต้นฉบับ (enqueue ใน transaction เดียวกับการออกเลข — review M1) */
export const INVOICE_PDF_JOB = 'invoice.render_pdf';
/** ลองใหม่: 10 วิ · 1 นาที · 5 นาที · 15 นาที · 1 ชม. · 3 ชม. · 6 ชม. (รวม 8 ครั้ง) */
const PDF_RETRY_MS = [10_000, 60_000, 300_000, 900_000, 3_600_000, 10_800_000, 21_600_000];
/** advisory lock ต่อ (tenant, สาขาผู้ออก) ของการออกเลข INV — อ่านเวลาหลังได้ล็อก (review L1) */
const INVOICE_NO_LOCK_NS = 0x1a09;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
/** วันที่ (เวลาไทย Asia/Bangkok UTC+7) ของเวลา `at` */
const bangkokDay = (at: Date) => new Date(at.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export type InvoiceCopy = 'ORIGINAL' | 'COPY';
/**
 * ไฟล์ PDF ที่เก็บของใบ (`stored_document.metadata.copy`): ต้นฉบับ/สำเนา ณ วันออก · **ST5-T10** ฉบับลายน้ำ "ยกเลิก" (render ตอนยกเลิก
 * ด้วยแม่แบบรุ่นเดียวกับวันออก แล้วเก็บ — review L4)
 */
export type InvoicePdfVariant = InvoiceCopy | 'CANCELLED_ORIGINAL' | 'CANCELLED_COPY';
/** งานเบื้องหลัง render + เก็บ PDF ลายน้ำ "ยกเลิก" (enqueue ใน transaction ของการยกเลิก — ST5-T10) */
export const INVOICE_CANCELLED_PDF_JOB = 'invoice.render_cancelled_pdf';
const cancelledVariant = (copy: InvoiceCopy): InvoicePdfVariant =>
  copy === 'COPY' ? 'CANCELLED_COPY' : 'CANCELLED_ORIGINAL';

/** เหตุที่ออกเอกสารไม่ได้ (extension `reasons[]` ของ 409 `invoice_not_finalizable`) */
export type FinalizeBlocker =
  | 'no_lines'
  | 'total_not_positive'
  | 'customer_tax_id_missing'
  | 'customer_branch_missing'
  | 'line_vat_type_missing'
  | 'revenue_line_provisional'
  | 'issuer_not_vat_registered';

/**
 * ออกเอกสารใบแจ้งหนี้ (ST5-T09; **D-54 บัญชีเบา — ใบแจ้งหนี้ ไม่ใช่ใบกำกับภาษี: ไม่มี `tax_invoice_no`**; docs/04 F3 "Finalize (immutable)",
 * F1 เลขเรียงลำดับ + สาขาผู้ออก/ผู้ซื้อ, A3 แบ่งหน้าที่; docs/01 §4.4 DRAFT → ISSUED; spec/05 BIL-031/037/038/196)
 *
 * ขั้น 1 (transaction เดียว): ล็อกใบ + If-Match → ตรวจ (แบ่งหน้าที่, BIL-037/038, บรรทัด provisional) → คำนวณยอดใหม่ →
 * ออกเลข INV ต่อสาขาผู้ออก (`issueNumber` — แถวตัวนับล็อกจน commit: พร้อมกันได้เลขเรียงไม่ข้าม, rollback = ไม่กินเลข) →
 * snapshot ลูกค้า/ผู้ออก/ค่าพิมพ์ + วันที่ออก/ครบกำหนด → ISSUED → DO INVOICED (+ UNBILLED → BILLED) → ล็อกบรรทัดรายได้ →
 * audit `invoice.finalized` + event `invoice.finalized` (outbox — ส่ง webhook หลัง commit)
 * ขั้น 2 (หลัง commit): render PDF ต้นฉบับจาก snapshot แล้วเก็บแบบเขียนครั้งเดียว (`pdf_document_id`) — ไม่ถือล็อกเลขระหว่าง render
 * (render ใน transaction = ใบอื่นของสาขาเดียวกันรอทั้งหมด) · render ล้ม/process ตาย = ใบยังออกแล้ว และงาน `invoice.render_pdf`
 * (enqueue ใน transaction ของการออกเลข — review M1) ลองใหม่จนเก็บได้ · render ได้เฉพาะแม่แบบรุ่นเดียวกับวันออก
 * (`print_options.templateVersion`) — แม่แบบเปลี่ยนแล้ว → 409 `invoice_pdf_template_changed` [DECISION spec/12 §3 แถว ST5-T09]
 *
 * D-55: TMS ออกเลข**ใบแจ้งหนี้**ของตัวเองเสมอ ไม่ว่า connector จะตั้ง `taxDocumentOwner` เป็นใคร — ไม่มีทางออกเลขเอกสารภาษีในเฟส 0
 * (`SystemOfRecordPolicy.assertCanIssueTaxDocumentNumber` ใช้เมื่อเปิดเอกสารภาษีใน TMS ภายหลัง — D-56)
 */
@Injectable()
export class InvoiceFinalizeService implements OnModuleInit {
  private readonly log = new Logger(InvoiceFinalizeService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly guard: InvoiceBillingGuard,
    private readonly dos: DeliveryOrderService,
    private readonly invoices: InvoicesService,
    private readonly pdf: InvoicePdfService,
    private readonly renderer: PdfRenderer,
    private readonly erpSync: ErpSyncService,
    private readonly clock: Clock,
    private readonly queue: JobQueue,
  ) {}

  /** งาน render PDF ต้นฉบับ + สำเนา (idempotent — มีไฟล์แล้ว = ข้าม) · นอก transaction (render ไม่ถือ connection) · ลองใหม่จนเก็บได้ */
  onModuleInit() {
    this.queue.register(
      INVOICE_PDF_JOB,
      async ({ job, tenantId }) => {
        const invoiceId = (job.payload as { invoiceId?: unknown } | null)?.invoiceId;
        if (typeof invoiceId !== 'string') return { skipped: 'bad_payload' };
        // ต้นฉบับ + สำเนา ณ วันออก (แม่แบบรุ่นเดียวกัน) — สำเนาไม่ต้อง render ภายหลัง (แม่แบบเปลี่ยนแล้วจะพิมพ์ไม่ได้)
        const out = await requestContext.run(
          { requestId: randomUUID(), tenantId, actorId: 'system:invoice-pdf', locale: 'th' },
          async () => ({
            original: (await this.ensurePdf(invoiceId, 'ORIGINAL')).doc,
            copy: (await this.ensurePdf(invoiceId, 'COPY')).doc,
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
    // ST5-T10 (review L4): ใบที่ยกเลิก — เก็บ PDF ลายน้ำ "ยกเลิก" ตอนยกเลิก (แม่แบบเปลี่ยนภายหลังก็ยังดาวน์โหลดได้)
    this.queue.register(
      INVOICE_CANCELLED_PDF_JOB,
      async ({ job, tenantId }) => {
        const invoiceId = (job.payload as { invoiceId?: unknown } | null)?.invoiceId;
        if (typeof invoiceId !== 'string') return { skipped: 'bad_payload' };
        const out = await requestContext.run(
          { requestId: randomUUID(), tenantId, actorId: 'system:invoice-pdf', locale: 'th' },
          async () => ({
            original: (await this.ensurePdf(invoiceId, 'CANCELLED_ORIGINAL')).doc,
            copy: (await this.ensurePdf(invoiceId, 'CANCELLED_COPY')).doc,
          }),
        );
        return {
          original: { documentId: encodeId('document', out.original.id) },
          copy: { documentId: encodeId('document', out.copy.id) },
        };
      },
      { outsideTransaction: true, retryDelaysMs: PDF_RETRY_MS },
    );
  }

  /** ST5-T10 enqueue งาน render PDF ลายน้ำ "ยกเลิก" ใน transaction ของการยกเลิก */
  async enqueueCancelledPdf(tx: Tx, tenantId: string, invoiceId: string): Promise<void> {
    await this.queue.enqueue(tx, {
      tenantId,
      type: INVOICE_CANCELLED_PDF_JOB,
      payload: { invoiceId },
      maxAttempts: PDF_RETRY_MS.length + 1,
    });
  }

  /** transaction ของ tenant ปัจจุบัน + ให้ AuditService/โค้ดที่ใช้ `db.tx` ทำงานในนั้น (route เป็น @NoTransaction) */
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

  async finalize(id: string, expected: number | undefined): Promise<InvoiceDto> {
    await this.inTx((tx) => this.issue(tx, id, expected));
    try {
      await this.ensurePdf(id, 'ORIGINAL');
    } catch (e) {
      // ใบออกแล้ว (commit) — งาน `invoice.render_pdf` (enqueue ในการออกเลข) ลองใหม่จนเก็บได้ · ไม่ย้อนการออกเลข
      this.log.warn(`invoice ${id}: issued PDF not stored yet — ${(e as Error).message}`);
    }
    return this.inTx((tx) => this.invoices.get(id, tx));
  }

  private async issue(tx: Tx, id: string, expected: number | undefined): Promise<void> {
    const ctx = requestContext.require();
    await tx.$queryRaw`SELECT id FROM invoice WHERE id = ${id}::uuid FOR UPDATE`;
    const inv = await tx.invoice.findUnique({
      where: { id },
      include: { customer: true, issuingCompany: true, issuingBranch: true },
    });
    if (!inv) throw new ProblemException('not_found');
    // ออกเอกสาร = ล็อกถาวร ต้องอ้าง version ที่ผู้ออกเห็น (แบบอนุมัติใบสำคัญจ่าย ST6-T07) — ตรวจหลังหาใบเจอ (ข้าม tenant = 404 ก่อน)
    if (expected === undefined)
      throw new ProblemException('validation_failed', undefined, [
        {
          field: 'If-Match',
          code: 'if_match_required',
          message: 'send If-Match (ETag of the invoice)',
        },
      ]);
    if (expected !== inv.version) throw new ProblemException('precondition_failed');
    if (inv.status !== 'DRAFT')
      throw new ProblemException('invalid_state_transition', undefined, undefined, {
        currentStatus: inv.status,
      });
    const tenant = await tx.tenant.findFirst({ select: { mode: true, yearStyle: true } });
    // D-61 (PO 21 พ.ย. 2569 "ออกเลขชุดแยก"): sandbox ออกใบได้ — เลขจากชุดเลขของแถว sandbox เอง + `TEST-` นำหน้า (issueNumber
    // markSandbox) · PDF ลายน้ำ "ตัวอย่าง — ใช้ไม่ได้จริง" (print_options.sandbox) · ไม่ถึง connector/ERP (sink `erp` ข้าม sandbox — ST7-T09)
    // `sandbox_finalize_disabled` ไม่ถูกส่งแล้ว (คงไว้ในแคตตาล็อกปัญหาเพื่อไม่ให้สัญญา API เปลี่ยนแบบ breaking)
    const sandbox = tenant?.mode === 'test';

    const actor = ctx.actorId;
    const settings = await readSettings(tx, ctx.tenantId!, [
      'billing.allowSelfFinalize',
      'tax.whtMinimumAmount',
    ]);
    const selfAllowed = settings['billing.allowSelfFinalize'] === true;
    // A3: ผู้สร้างใบแจ้งหนี้ finalize ใบตัวเองไม่ได้ — นับผู้แก้ร่างล่าสุดด้วย (แบบ ST6-T07) · key = ผู้ออก key · ระบุตัวไม่ได้ = ปฏิเสธ
    // review L2: ร่างที่ระบบสร้าง (createdBy ว่าง — รอบวางบิล ST5-T12) = ไม่มีผู้สร้างที่เป็นคน → นับเฉพาะผู้แก้ร่าง
    // (ผู้เตรียมที่ระบุไม่ได้หลังแปลง key → ผู้ออก key ยังปฏิเสธ — fail closed) · hand-off ST5-T12: ใส่ createdBy = `system:invoice-run`
    const [me, ...preparers] = await resolveActors(tx, [
      actor,
      ...[inv.createdBy, inv.updatedBy].filter((x): x is string => !!x && !x.startsWith('system:')),
    ]);
    const isPreparer = me === null || preparers.some((p) => p === null || p === me);
    if (isPreparer && !selfAllowed) throw new ProblemException('invoice_self_finalize');

    await this.invoices.refreshTotals(tx, id);
    await this.assertFinalizable(tx, id, inv);

    // review L1: ล็อกการออกเลขของสาขาก่อนอ่านเวลา — ข้ามเที่ยงคืน ลำดับวันที่ออกตรงลำดับเลข (ใบเลขมากกว่าไม่ลงวันก่อนหน้า)
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${INVOICE_NO_LOCK_NS}::int, hashtext(${`${ctx.tenantId}:${inv.issuingBranchId}`}))`;
    const now = this.clock.now();
    const issueDate = bangkokDay(now);
    const dueDate = addDays(issueDate, inv.creditTermDays);
    const invoiceNo = await issueNumber(tx, ctx.tenantId!, {
      docType: 'INV',
      branchId: inv.issuingBranchId,
      at: now,
      markSandbox: true,
    });
    const customer: InvoicePartySnapshot = {
      code: inv.customer.code,
      ...customerParty({ customer: inv.customer }),
      // ไม่มีเลขผู้เสียภาษี = ไม่พิมพ์สาขา (ตรวจแล้วข้างบนว่ามีทั้งคู่)
      branchCode: inv.customer.branchCode,
    };
    const issuer: InvoicePartySnapshot = issuerParty({
      issuingCompany: inv.issuingCompany,
      issuingBranch: inv.issuingBranch,
    });
    const print: InvoicePrintOptions = {
      yearStyle: tenant?.yearStyle === 'CE' ? 'CE' : 'BE',
      whtMinimumAmount: settings['tax.whtMinimumAmount'] as number,
      templateVersion: INVOICE_TEMPLATE_VERSION,
      ...(sandbox ? { sandbox: true } : {}),
    };
    const before = await this.invoices.get(id, tx);
    await tx.invoice.update({
      where: { id },
      data: {
        status: 'ISSUED',
        invoiceNo,
        issuedAt: now,
        issuedBy: actor ?? 'system',
        issueDate: new Date(`${issueDate}T00:00:00.000Z`),
        dueDate: new Date(`${dueDate}T00:00:00.000Z`),
        customerSnapshot: customer as unknown as Prisma.InputJsonValue,
        issuerSnapshot: issuer as unknown as Prisma.InputJsonValue,
        printOptions: print as unknown as Prisma.InputJsonValue,
        updatedBy: actor ?? null,
        version: { increment: 1 },
      },
    });
    // DO ในใบ: billing_status IN_DRAFT → INVOICED (+ invoiced_at) · status UNBILLED → BILLED
    const invoiced = await this.guard.syncFromInvoice(id, tx);
    const doIds = [
      ...new Set(
        (
          await tx.invoiceLine.findMany({
            where: { invoiceId: id, active: true, deliveryOrderId: { not: null } },
            select: { deliveryOrderId: true },
          })
        ).map((l) => l.deliveryOrderId!),
      ),
    ].sort();
    const billed = await this.dos.billForInvoice(tx, doIds, `invoice:${id}`);
    // ล็อกบรรทัดรายได้ที่วางบิลแล้ว (docs/04 F3 "ไม่ rebuild หลัง finalize" — trigger 0116; ปลดได้ทางเดียวตอนยกเลิกใบ ST5-T10)
    const revenueIds = (
      await tx.invoiceLine.findMany({
        where: { invoiceId: id, active: true, revenueLineId: { not: null } },
        select: { revenueLineId: true },
      })
    ).map((l) => l.revenueLineId!);
    const locked = revenueIds.length
      ? (
          await tx.revenueLine.updateMany({
            where: { id: { in: revenueIds }, lockedAt: null },
            data: { lockedAt: now, lockedDocumentId: id, version: { increment: 1 } },
          })
        ).count
      : 0;
    const out = await this.invoices.get(id, tx);
    await this.audit.record({
      action: 'invoice.finalized',
      entityType: ENTITY,
      entityId: id,
      before: { status: 'DRAFT', invoiceNo: null },
      after: {
        status: 'ISSUED',
        invoiceNo,
        issueDate,
        dueDate,
        sellTotal: out.sellTotal,
        deliveryOrdersInvoiced: invoiced,
        deliveryOrdersBilled: billed,
        revenueLinesLocked: locked,
        // ปิดกฎแบ่งหน้าที่แล้วออกใบตัวเอง — บันทึกไว้ตรวจย้อน (A3 "owner ยอมรับความเสี่ยง")
        selfFinalized: isPreparer,
      },
    });
    await tx.domainEvent.create({
      data: {
        tenantId: ctx.tenantId!,
        type: 'invoice.finalized',
        entityType: ENTITY,
        localId: id,
        snapshot: invoiceEventObject(out) as Prisma.InputJsonValue,
        // ค่าเดิมของ field ระดับบนที่เปลี่ยน (docs/01 §5.3)
        previousAttributes: {
          status: before.status,
          invoiceNo: null,
          issueDate: null,
          dueDate: null,
          issuedAt: null,
          version: before.version,
        },
        requestId: ctx.requestId ?? null,
        actorId: actor ?? null,
      },
    });
    // ST8-T16 connector ที่เปิด pushInvoice → คำสั่งส่งใบเข้า ERP (outbox — ส่งหลัง commit · Standalone = ไม่มีคำสั่ง)
    await this.erpSync.invoiceFinalized(tx, id);
    // review M1: งาน render PDF ต้นฉบับใน transaction เดียวกับการออกเลข — process ตายหลัง commit ก็ยังมีงานค้างให้ทำต่อ
    await this.queue.enqueue(tx, {
      tenantId: ctx.tenantId!,
      type: INVOICE_PDF_JOB,
      payload: { invoiceId: id },
      maxAttempts: PDF_RETRY_MS.length + 1,
    });
  }

  /** BIL-037/038 + ห้ามบรรทัด provisional (ST5-T01b review) → 409 `invoice_not_finalizable` + `reasons[]` */
  private async assertFinalizable(
    tx: Tx,
    id: string,
    inv: {
      customer: { taxId: string | null; branchCode: string | null };
      issuingCompany: { vatRegistered: boolean };
    },
  ): Promise<void> {
    const reasons: FinalizeBlocker[] = [];
    const lines = await tx.invoiceLine.findMany({
      where: { invoiceId: id, active: true },
      orderBy: { lineNo: 'asc' },
      select: {
        id: true,
        lineNo: true,
        vatType: true,
        revenueLine: { select: { id: true, provisional: true } },
        deliveryOrder: { select: { doNo: true } },
      },
    });
    const head = await tx.invoice.findUniqueOrThrow({
      where: { id },
      select: { totalAmount: true },
    });
    if (!lines.length) reasons.push('no_lines');
    else if (!head.totalAmount.greaterThan(0)) reasons.push('total_not_positive');
    if (!inv.customer.taxId) reasons.push('customer_tax_id_missing');
    if (!inv.customer.branchCode) reasons.push('customer_branch_missing');
    if (lines.some((l) => !l.vatType)) reasons.push('line_vat_type_missing');
    const provisional = lines.filter((l) => l.revenueLine?.provisional);
    if (provisional.length) reasons.push('revenue_line_provisional');
    // BIL-038: ผู้ออกไม่จด VAT แต่มีบรรทัด VAT 7% → ห้ามออก (คำถามนักบัญชี #63 ยังค้าง — บล็อกจนได้คำตอบ)
    if (!inv.issuingCompany.vatRegistered && lines.some((l) => l.vatType === 'VAT_7'))
      reasons.push('issuer_not_vat_registered');
    if (reasons.length)
      throw new ProblemException('invoice_not_finalizable', undefined, undefined, {
        reasons,
        ...(provisional.length
          ? {
              lines: provisional.map((l) => ({
                id: encodeId('invoiceLine', l.id),
                lineNo: l.lineNo,
                deliveryOrderNo: l.deliveryOrder?.doNo ?? null,
                revenueLineId: encodeId('revenueLine', l.revenueLine!.id),
              })),
            }
          : {}),
      });
  }

  /**
   * PDF ของใบที่ออกแล้ว (BIL-195/196): ต้นฉบับ = ไฟล์ที่เก็บตอนออก (`pdf_document_id`) · สำเนา = render จาก snapshot ครั้งแรกที่ขอ แล้วเก็บ
   * ยังไม่มีไฟล์ → render นอก transaction แล้วเก็บแบบเขียนครั้งเดียวใต้ล็อกใบ (ขอพร้อมกัน = ได้ไฟล์เดียว) · ร่าง/ร่างที่ยกเลิก → 409
   */
  async ensurePdf(
    id: string,
    copy: InvoicePdfVariant,
  ): Promise<{ doc: StoredDocument; data: Buffer }> {
    const cancelled = copy.startsWith('CANCELLED_');
    const found = await this.inTx(async (tx) => {
      const inv = await tx.invoice.findUnique({ where: { id } });
      if (!inv) throw new ProblemException('not_found');
      if (
        !inv.invoiceNo ||
        !inv.issueDate ||
        !inv.dueDate ||
        (cancelled && inv.status !== 'CANCELLED')
      )
        throw new ProblemException('invalid_state_transition', undefined, undefined, {
          currentStatus: inv.status,
        });
      const doc = await this.storedPdf(tx, inv.id, inv.pdfDocumentId, copy);
      if (doc) return { doc, model: null, invoiceNo: inv.invoiceNo };
      // review M1: render ได้เฉพาะแม่แบบรุ่นเดียวกับวันออก (ไม่ใช้แม่แบบใหม่กับใบเก่าเงียบ ๆ)
      const tv = (inv.printOptions as InvoicePrintOptions | null)?.templateVersion;
      if (tv !== INVOICE_TEMPLATE_VERSION)
        throw new ProblemException('invoice_pdf_template_changed', undefined, undefined, {
          issuedTemplateVersion: tv ?? null,
          currentTemplateVersion: INVOICE_TEMPLATE_VERSION,
        });
      const { model } = await this.pdf.loadModel(tx, id, {
        issueDate: ymd(inv.issueDate),
        dueDate: ymd(inv.dueDate),
        copy: copy.endsWith('COPY') ? 'COPY' : 'ORIGINAL',
      });
      // ต้นฉบับ/สำเนา = เอกสาร ณ วันออก (ไม่มีลายน้ำแม้ render หลังยกเลิก — BIL-100 เก็บ PDF เดิม) · CANCELLED_* = ลายน้ำ "ยกเลิก"
      return { doc: null, model: { ...model, cancelled }, invoiceNo: inv.invoiceNo };
    });
    if (found.doc) return { doc: found.doc, data: await store().get(found.doc.fileKey!) };
    const data = await this.renderer.pdf(invoiceDocument(found.model!));
    const ctx = requestContext.require();
    const doc = await this.inTx(async (tx) => {
      const rows = await tx.$queryRaw<{ pdf_document_id: string | null }[]>`
        SELECT pdf_document_id FROM invoice WHERE id = ${id}::uuid FOR UPDATE`;
      const existing = await this.storedPdf(tx, id, rows[0]?.pdf_document_id ?? null, copy);
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
          filename: `${found.invoiceNo}${copy.endsWith('COPY') ? '-copy' : ''}${cancelled ? '-cancelled' : ''}.pdf`,
          entityType: ENTITY,
          entityId: id,
          createdBy: ctx.actorId ?? null,
          metadata: { document: 'INVOICE', copy, invoiceNo: found.invoiceNo },
        },
      });
      // raw SQL: ผูกไฟล์ไม่ใช่การแก้ใบ — ไม่เปลี่ยน updated_at/version (event `invoice.finalized` = สภาพใบตอนออก)
      if (copy === 'ORIGINAL')
        await tx.$executeRaw`UPDATE invoice SET pdf_document_id = ${created.id}::uuid WHERE id = ${id}::uuid`;
      await this.audit.record({
        action: 'invoice.pdf_stored',
        entityType: ENTITY,
        entityId: id,
        after: {
          documentId: encodeId('document', created.id),
          copy,
          invoiceNo: found.invoiceNo,
          sha256: f.sha256,
        },
      });
      return created;
    });
    return { doc, data };
  }

  /**
   * PDF สำหรับดาวน์โหลด (`GET /invoices/{id}/pdf`): ใบปกติ = ไฟล์ที่เก็บ ณ วันออก (ensurePdf) · **ใบที่ยกเลิกแล้ว (ST5-T10)** = ไฟล์ลายน้ำ
   * "ยกเลิก" (spec/05 BIL-195) ที่เก็บตอนยกเลิก (งาน `invoice.render_cancelled_pdf` — ยังไม่มี = render แล้วเก็บ) · แม่แบบเปลี่ยนหลังวันออก
   * และยังไม่มีไฟล์ลายน้ำ → ส่งไฟล์ต้นฉบับที่เก็บไว้แทน + header `X-Invoice-Pdf-Note: cancelled-watermark-unavailable` (review L4)
   * · ไฟล์ต้นฉบับ/สำเนาที่เก็บคงเดิมเสมอ (BIL-100)
   */
  async downloadPdf(
    id: string,
    copy: InvoiceCopy,
  ): Promise<{ filename: string; sha256: string; data: Buffer; note: string | null }> {
    const status = await this.inTx(async (tx) => {
      const inv = await tx.invoice.findUnique({ where: { id }, select: { status: true } });
      if (!inv) throw new ProblemException('not_found');
      return inv.status;
    });
    let note: string | null = null;
    let got: { doc: StoredDocument; data: Buffer };
    if (status === 'CANCELLED') {
      try {
        got = await this.ensurePdf(id, cancelledVariant(copy));
      } catch (e) {
        if (!(e instanceof ProblemException) || e.code !== 'invoice_pdf_template_changed') throw e;
        got = await this.ensurePdf(id, copy);
        note = 'cancelled-watermark-unavailable';
      }
    } else got = await this.ensurePdf(id, copy);
    return {
      filename: got.doc.filename ?? 'invoice.pdf',
      sha256: got.doc.sha256 ?? '',
      data: got.data,
      note,
    };
  }

  private async storedPdf(
    tx: Tx,
    invoiceId: string,
    pdfDocumentId: string | null,
    copy: InvoicePdfVariant,
  ): Promise<StoredDocument | null> {
    const doc =
      copy === 'ORIGINAL'
        ? pdfDocumentId
          ? await tx.storedDocument.findUnique({ where: { id: pdfDocumentId } })
          : null
        : await tx.storedDocument.findFirst({
            where: {
              entityType: ENTITY,
              entityId: invoiceId,
              kind: 'PDF',
              metadata: { path: ['copy'], equals: copy },
            },
            orderBy: { createdAt: 'asc' },
          });
    if (doc && (doc.status !== 'READY' || !doc.fileKey)) throw new ProblemException('not_found');
    return doc;
  }
}

/**
 * `data.object` ของ webhook `invoice.finalized` / `invoice.voided` / `invoice.paid` (ทะเบียน event) = InvoiceDto เดียวกับ `GET /v1/invoices/{id}`
 * − ยอดเงิน (`sell*` — webhook ระดับ tenant ไม่ผ่านสิทธิ์ราคา) − `omit` ของทะเบียน
 */
export function invoiceEventObject(
  dto: InvoiceDto,
  type: 'invoice.finalized' | 'invoice.voided' | 'invoice.paid' = 'invoice.finalized',
): Record<string, unknown> {
  const o = JSON.parse(JSON.stringify(redact(dto))) as Record<string, unknown>;
  for (const k of eventDefinition(type)!.object!.omit) delete o[k];
  return o;
}

const redact = (dto: InvoiceDto) => redactPrices(dto, []);
