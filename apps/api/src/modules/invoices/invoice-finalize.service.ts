import { Injectable, Logger } from '@nestjs/common';
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
import { PdfRenderer } from '../../pdf/pdf-renderer';
import { DeliveryOrderService } from '../delivery-orders/delivery-order.service';
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
import { invoiceDocument } from './invoice.template';
import type { InvoiceDto } from './invoice.dto';
import { InvoicesService, type InvoicePartySnapshot } from './invoices.service';

const ENTITY = 'invoice';
const ymd = (d: Date) => d.toISOString().slice(0, 10);
/** วันที่ (เวลาไทย Asia/Bangkok UTC+7) ของเวลา `at` */
const bangkokDay = (at: Date) => new Date(at.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export type InvoiceCopy = 'ORIGINAL' | 'COPY';

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
 * ขั้น 1 (transaction เดียว): ล็อกใบ + If-Match → ตรวจ (sandbox, แบ่งหน้าที่, BIL-037/038, บรรทัด provisional) → คำนวณยอดใหม่ →
 * ออกเลข INV ต่อสาขาผู้ออก (`issueNumber` — แถวตัวนับล็อกจน commit: พร้อมกันได้เลขเรียงไม่ข้าม, rollback = ไม่กินเลข) →
 * snapshot ลูกค้า/ผู้ออก/ค่าพิมพ์ + วันที่ออก/ครบกำหนด → ISSUED → DO INVOICED (+ UNBILLED → BILLED) → ล็อกบรรทัดรายได้ →
 * audit `invoice.finalized` + event `invoice.finalized` (outbox — ส่ง webhook หลัง commit)
 * ขั้น 2 (หลัง commit): render PDF ต้นฉบับจาก snapshot แล้วเก็บแบบเขียนครั้งเดียว (`pdf_document_id`) — ไม่ถือล็อกเลขระหว่าง render
 * (render ใน transaction = ใบอื่นของสาขาเดียวกันรอทั้งหมด) · render ล้ม = ใบยังออกแล้ว, `GET /v1/invoices/{id}/pdf` สร้างให้ภายหลัง
 * (เนื้อเหมือนเดิมเพราะมาจาก snapshot + บรรทัดที่แก้ไม่ได้) [DECISION spec/12 §3 แถว ST5-T09]
 *
 * D-55: TMS ออกเลข**ใบแจ้งหนี้**ของตัวเองเสมอ ไม่ว่า connector จะตั้ง `taxDocumentOwner` เป็นใคร — ไม่มีทางออกเลขเอกสารภาษีในเฟส 0
 * (`SystemOfRecordPolicy.assertCanIssueTaxDocumentNumber` ใช้เมื่อเปิดเอกสารภาษีใน TMS ภายหลัง — D-56)
 */
@Injectable()
export class InvoiceFinalizeService {
  private readonly log = new Logger(InvoiceFinalizeService.name);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly guard: InvoiceBillingGuard,
    private readonly dos: DeliveryOrderService,
    private readonly invoices: InvoicesService,
    private readonly pdf: InvoicePdfService,
    private readonly renderer: PdfRenderer,
    private readonly clock: Clock,
  ) {}

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
      // ใบออกแล้ว (commit) — PDF สร้างภายหลังได้จาก snapshot (GET /pdf) ไม่ย้อนการออกเลข
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
    // [OPEN — spec/12 §3 "Sandbox: เอกสารภาษีใน sandbox" ห้ามตัดสินเอง] → ปิดไว้ก่อน (ย้อนได้)
    if (tenant?.mode === 'test') throw new ProblemException('sandbox_finalize_disabled');

    const actor = ctx.actorId;
    const settings = await readSettings(tx, ctx.tenantId!, [
      'billing.allowSelfFinalize',
      'tax.whtMinimumAmount',
    ]);
    const selfAllowed = settings['billing.allowSelfFinalize'] === true;
    // A3: ผู้สร้างใบแจ้งหนี้ finalize ใบตัวเองไม่ได้ — นับผู้แก้ร่างล่าสุดด้วย (แบบ ST6-T07) · key = ผู้ออก key · ระบุตัวไม่ได้ = ปฏิเสธ
    const [me, ...preparers] = await resolveActors(tx, [
      actor,
      inv.createdBy,
      ...(inv.updatedBy ? [inv.updatedBy] : []),
    ]);
    const isPreparer = me === null || preparers.some((p) => p === null || p === me);
    if (isPreparer && !selfAllowed) throw new ProblemException('invoice_self_finalize');

    await this.invoices.refreshTotals(tx, id);
    await this.assertFinalizable(tx, id, inv);

    const now = this.clock.now();
    const issueDate = bangkokDay(now);
    const dueDate = addDays(issueDate, inv.creditTermDays);
    const invoiceNo = await issueNumber(tx, ctx.tenantId!, {
      docType: 'INV',
      branchId: inv.issuingBranchId,
      at: now,
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
  async ensurePdf(id: string, copy: InvoiceCopy): Promise<{ doc: StoredDocument; data: Buffer }> {
    const found = await this.inTx(async (tx) => {
      const inv = await tx.invoice.findUnique({ where: { id } });
      if (!inv) throw new ProblemException('not_found');
      if (!inv.invoiceNo || !inv.issueDate || !inv.dueDate)
        throw new ProblemException('invalid_state_transition', undefined, undefined, {
          currentStatus: inv.status,
        });
      const doc = await this.storedPdf(tx, inv.id, inv.pdfDocumentId, copy);
      if (doc) return { doc, model: null, invoiceNo: inv.invoiceNo };
      const { model } = await this.pdf.loadModel(tx, id, {
        issueDate: ymd(inv.issueDate),
        dueDate: ymd(inv.dueDate),
        copy,
      });
      return { doc: null, model, invoiceNo: inv.invoiceNo };
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
          filename: `${found.invoiceNo}${copy === 'COPY' ? '-copy' : ''}.pdf`,
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

  private async storedPdf(
    tx: Tx,
    invoiceId: string,
    pdfDocumentId: string | null,
    copy: InvoiceCopy,
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
              metadata: { path: ['copy'], equals: 'COPY' },
            },
            orderBy: { createdAt: 'asc' },
          });
    if (doc && (doc.status !== 'READY' || !doc.fileKey)) throw new ProblemException('not_found');
    return doc;
  }
}

/**
 * `data.object` ของ webhook `invoice.finalized` (ทะเบียน event) = InvoiceDto เดียวกับ `GET /v1/invoices/{id}`
 * − ยอดเงิน (`sell*` — webhook ระดับ tenant ไม่ผ่านสิทธิ์ราคา) − `omit` ของทะเบียน
 */
function invoiceEventObject(dto: InvoiceDto): Record<string, unknown> {
  const o = JSON.parse(JSON.stringify(redact(dto))) as Record<string, unknown>;
  for (const k of eventDefinition('invoice.finalized')!.object!.omit) delete o[k];
  return o;
}

const redact = (dto: InvoiceDto) => redactPrices(dto, []);
