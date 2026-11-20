import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { Clock } from '../../common/clock';
import { encodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { DeliveryOrderService } from '../delivery-orders/delivery-order.service';
import { InvoiceBillingGuard } from './billing-guard.service';
import { InvoiceFinalizeService, invoiceEventObject } from './invoice-finalize.service';
import type { InvoiceDto } from './invoice.dto';
import { ErpSyncService } from '../erp/erp-sync.service';
import { InvoicesService } from './invoices.service';

const ENTITY = 'invoice';
/** ใบวางบิลที่ออกแล้ว — ใบแจ้งหนี้ในนั้นยกเลิกไม่ได้ (trigger `invoice_billing_note_guard` 0142) */
const LOCKING_NOTE = ['ISSUED', 'COLLECTED'] as const;

/**
 * ยกเลิกใบแจ้งหนี้ (ST5-T10; **D-54 บัญชีเบา — ใบแจ้งหนี้ ไม่ใช่ใบกำกับภาษี**; docs/04 F3 "ยกเลิกใบ", F1 เลขไม่ใช้ซ้ำ;
 * docs/01 §4.3 BILLED → UNBILLED; spec/05 §3.6 ISSUED → CANCELLED + §7 BIL-100/106/107) [DECISION spec/12 §3 แถว ST5-T10]
 *
 * - ร่าง = `POST /invoices/{id}/cancel` (ST5-T07 — `invoices:draft`) · ที่นี่ร่าง → 409
 * - **ใบที่ออกแล้ว** (`POST /invoices/{id}/void` — docs/04 G1/G2 · `invoices:finalize` + If-Match บังคับ): ได้เฉพาะ ISSUED ที่ยังไม่รับชำระ (`paid_amount` = 0 — 409 `invoice_has_payments`)
 *   และไม่อยู่ในใบวางบิล ISSUED/COLLECTED (409 `invoice_on_billing_note` + เลขใบวางบิล) — "ยังไม่ส่งลูกค้า" ในเฟสนี้ = ยังไม่อยู่ในใบวางบิลที่ออกแล้ว
 *   (ธง "ส่งลูกค้าแล้ว" ของ ST5-T18 มาเพิ่มเงื่อนไขภายหลัง)
 * - ผล (transaction เดียว): CANCELLED คงเลข (เลขไม่ถูกออกซ้ำ — ตัวนับเดินหน้าอย่างเดียว) + เหตุผล/เวลา/ผู้ยกเลิก → บรรทัดหยุดนับ
 *   (trigger — `released_with_invoice` = บรรทัดของเอกสาร ณ วันยกเลิก) → DO INVOICED → UNBILLED + BILLED → UNBILLED (วางบิลใหม่ได้) →
 *   ปลดล็อกบรรทัดรายได้ที่ล็อกตอนออกเลข (`tms_revenue_line_unlock` — audit ต่อใบสั่ง) แล้วคิดบรรทัดรายได้ของใบสั่งใหม่ →
 *   ถอดออกจากใบวางบิลที่ยังเป็นร่าง → audit `invoice.cancelled` + event `invoice.voided` (outbox → webhook / ระบบบัญชี ST8-T16)
 * - `reissue`: สร้างร่างฉบับใหม่แทน (DO ชุดเดิม + บรรทัดที่เพิ่มเอง) อ้าง `replaces_invoice_id` — ออกเลขใหม่ตามปกติ (BIL-101/107)
 */
@Injectable()
export class InvoiceCancelService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly invoices: InvoicesService,
    private readonly guard: InvoiceBillingGuard,
    private readonly dos: DeliveryOrderService,
    private readonly finalizer: InvoiceFinalizeService,
    private readonly erpSync: ErpSyncService,
  ) {}

  async void(
    id: string,
    reason: string,
    reissue: boolean,
    expected: number | undefined,
  ): Promise<InvoiceDto> {
    const tx = this.db.tx;
    const ctx = requestContext.require();
    // review M2: ลำดับล็อกเดียวกับใบวางบิล (ออก/แก้ร่าง: billing_note FOR UPDATE → invoice FOR SHARE) — ล็อกใบวางบิลที่ผูกใบนี้ก่อน
    // (เรียง id) แล้วจึงล็อกใบแจ้งหนี้ · ไม่งั้นยกเลิกพร้อมออกใบวางบิล = deadlock (40P01)
    const noteIds = [
      ...new Set(
        (
          await tx.billingNoteInvoice.findMany({
            where: { invoiceId: id, active: true },
            select: { billingNoteId: true },
          })
        ).map((l) => l.billingNoteId),
      ),
    ].sort();
    if (noteIds.length)
      await tx.$queryRaw`SELECT id FROM billing_note WHERE id = ANY(${noteIds}::uuid[]) ORDER BY id FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM invoice WHERE id = ${id}::uuid FOR UPDATE`;
    const inv = await tx.invoice.findUnique({ where: { id } });
    if (!inv) throw new ProblemException('not_found');
    // ยกเลิกใบที่ออกแล้ว = ย้อนไม่ได้ ต้องอ้าง version ที่ผู้ยกเลิกเห็น (แบบออกเอกสาร ST5-T09)
    if (expected === undefined)
      throw new ProblemException('validation_failed', undefined, [
        {
          field: 'If-Match',
          code: 'if_match_required',
          message: 'send If-Match (ETag of the invoice)',
        },
      ]);
    if (expected !== inv.version) throw new ProblemException('precondition_failed');
    if (inv.status === 'PARTIALLY_PAID' || inv.status === 'PAID' || !inv.paidAmount.isZero())
      throw await this.paid(tx, id, inv.status);
    if (inv.status !== 'ISSUED')
      throw new ProblemException('invalid_state_transition', undefined, undefined, {
        currentStatus: inv.status,
      });
    const onNote = await tx.billingNoteInvoice.findFirst({
      where: { invoiceId: id, active: true, billingNote: { status: { in: [...LOCKING_NOTE] } } },
      select: { billingNote: { select: { id: true, billingNoteNo: true, status: true } } },
    });
    if (onNote)
      throw new ProblemException('invoice_on_billing_note', undefined, undefined, {
        billingNoteId: encodeId('billingNote', onNote.billingNote.id),
        billingNoteNo: onNote.billingNote.billingNoteNo,
        billingNoteStatus: onNote.billingNote.status,
      });
    // ST5-T18 ส่งลูกค้าแล้วยกเลิกไม่ได้ (docs/04 F3 "เฉพาะยังไม่ส่งลูกค้า") — trigger `invoice_cancel_sent` (0147) กันซ้ำ
    if (inv.sentToCustomerAt)
      throw new ProblemException('invoice_sent_to_customer', undefined, undefined, {
        sentToCustomerAt: inv.sentToCustomerAt.toISOString(),
        sentToCustomerChannel: inv.sentToCustomerChannel,
      });

    const actor = ctx.actorId ?? 'system';
    const now = this.clock.now();
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
    const manual = await tx.invoiceLine.findMany({
      where: { invoiceId: id, active: true, deliveryOrderId: null },
      orderBy: { lineNo: 'asc' },
    });
    // ลำดับล็อกเดียวกับยกเลิกร่าง/rebuild: ใบ (ถือแล้ว) → ใบสั่ง (advisory) → DO ของใบสั่ง
    const orders = await this.invoices.lockOrders(tx, doIds);
    const before = await this.invoices.get(id, tx);
    await tx.invoice.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        cancelledAt: now,
        cancelledBy: actor,
        cancelReason: reason,
        updatedBy: ctx.actorId ?? null,
        version: { increment: 1 },
      },
    });
    const released = await this.guard.syncFromInvoice(id, tx);
    const unbilled = await this.dos.unbillForInvoice(tx, doIds, `invoice:${id}`);
    // ST5-T09 hand-off: ปลดล็อกบรรทัดรายได้ที่ออกเลขแล้ว (ทางเดียวที่ปลดได้ — ฟังก์ชันลง audit ต่อใบสั่งเอง) แล้วคิดใหม่ตามใบสั่ง
    const unlocked = await tx.$queryRaw<{ n: number }[]>`
      SELECT tms_revenue_line_unlock(${id}::uuid, ${actor}, ${reason}) AS n`;
    await this.invoices.rebuildOrders(tx, orders);
    const notes = await this.detachDraftNotes(tx, id, now);
    const out = await this.invoices.get(id, tx);
    await this.audit.record({
      action: 'invoice.cancelled',
      entityType: ENTITY,
      entityId: id,
      reason,
      before: { status: before.status, invoiceNo: inv.invoiceNo },
      after: {
        status: 'CANCELLED',
        invoiceNo: inv.invoiceNo,
        total: out.sellTotal,
        reissue,
        deliveryOrdersReleased: released,
        deliveryOrdersUnbilled: unbilled,
        revenueLinesUnlocked: Number(unlocked[0]?.n ?? 0),
        billingNotesDetached: notes,
      },
    });
    await tx.domainEvent.create({
      data: {
        tenantId: ctx.tenantId!,
        type: 'invoice.voided',
        entityType: ENTITY,
        localId: id,
        snapshot: invoiceEventObject(out, 'invoice.voided') as Prisma.InputJsonValue,
        previousAttributes: { status: before.status, version: before.version },
        requestId: ctx.requestId ?? null,
        actorId: ctx.actorId ?? null,
      },
    });
    // ST8-T16 ใบที่ส่งเข้า ERP แล้ว → แจ้งยกเลิกตามที่ ERP รองรับ (ไม่รองรับ = งานยกเลิกด้วยมือในบันทึกการซิงก์)
    await this.erpSync.invoiceVoided(tx, id);
    // review L4: เก็บ PDF ลายน้ำ "ยกเลิก" (แม่แบบรุ่นวันออก) หลัง commit — งานใน transaction เดียวกับการยกเลิก
    await this.finalizer.enqueueCancelledPdf(tx, ctx.tenantId!, id);
    if (reissue) await this.reissue(tx, inv, doIds, manual);
    return this.invoices.get(id, tx);
  }

  /** 409 `invoice_has_payments` + รายการรับชำระที่ยังไม่กลับรายการ (ให้ผู้ใช้กลับรายการก่อน — spec/05 BIL-103) */
  private async paid(tx: Tx, id: string, status: string): Promise<ProblemException> {
    const pays = await tx.payment.findMany({
      where: { status: 'RECORDED', allocations: { some: { invoiceId: id } } },
      select: { id: true, paymentNo: true },
      orderBy: { createdAt: 'asc' },
    });
    return new ProblemException('invoice_has_payments', undefined, undefined, {
      currentStatus: status,
      payments: pays.map((p) => ({ paymentId: encodeId('payment', p.id), paymentNo: p.paymentNo })),
    });
  }

  /** ใบแจ้งหนี้ที่ยกเลิกออกจากใบวางบิลที่ยังเป็นร่าง (ยอดรวมร่างคิดใหม่ + audit ต่อใบวางบิล) → จำนวนใบวางบิล */
  private async detachDraftNotes(tx: Tx, invoiceId: string, now: Date): Promise<number> {
    const links = await tx.billingNoteInvoice.findMany({
      where: { invoiceId, active: true, billingNote: { status: 'DRAFT' } },
      select: { id: true, billingNoteId: true },
      orderBy: { billingNoteId: 'asc' },
    });
    for (const l of links) {
      // ล็อกแล้วตั้งแต่ต้น (ก่อนล็อกใบแจ้งหนี้ — review M2) · ผูกใหม่ที่ commit ระหว่างนั้นล็อกซ้ำที่นี่ได้ (ไม่มีใครรอใบนี้อยู่แล้ว)
      await tx.$queryRaw`SELECT id FROM billing_note WHERE id = ${l.billingNoteId}::uuid FOR UPDATE`;
      await tx.billingNoteInvoice.update({
        where: { id: l.id },
        data: { active: false, removedAt: now },
      });
      const t = await tx.billingNoteInvoice.aggregate({
        where: { billingNoteId: l.billingNoteId, active: true },
        _sum: { outstandingAmount: true, whtExpectedAmount: true },
      });
      const total = t._sum.outstandingAmount ?? new Prisma.Decimal(0);
      const wht = t._sum.whtExpectedAmount ?? new Prisma.Decimal(0);
      await tx.billingNote.update({
        where: { id: l.billingNoteId },
        data: {
          totalAmount: total,
          totalWhtExpected: wht,
          netExpected: total.minus(wht),
          version: { increment: 1 },
        },
      });
      await this.audit.record({
        action: 'billing_note.invoice_removed',
        entityType: 'billing_note',
        entityId: l.billingNoteId,
        reason: 'invoice cancelled',
        after: { invoiceId: encodeId('invoice', invoiceId), cause: 'invoice.cancelled' },
      });
    }
    return links.length;
  }

  /**
   * ออกฉบับใหม่แทน: ร่างใหม่ หัวเดิม (ลูกค้า ผู้ออก เครดิต งวด PO หมายเหตุ รูปบรรทัด) + DO ชุดเดิม (ดึงตามกติกาปกติ — ตรวจพร้อมวางบิลซ้ำ;
   * ไม่ผ่าน = ยกเลิกทั้งคำขอ) + บรรทัดที่เพิ่มเอง (ส่วนลดของบรรทัด DO ไม่ตามมา — แก้ในร่าง) · `replaces_invoice_id` = ใบเดิม
   */
  private async reissue(
    tx: Tx,
    old: Prisma.InvoiceGetPayload<object>,
    doIds: string[],
    manual: Prisma.InvoiceLineGetPayload<object>[],
  ): Promise<string> {
    const ctx = requestContext.require();
    const draft = await tx.invoice.create({
      data: {
        tenantId: old.tenantId,
        customerId: old.customerId,
        issuingCompanyId: old.issuingCompanyId,
        issuingBranchId: old.issuingBranchId,
        creditTermDays: old.creditTermDays,
        customerPoNo: old.customerPoNo,
        note: old.note,
        lineMode: old.lineMode,
        periodFrom: old.periodFrom,
        periodTo: old.periodTo,
        replacesInvoiceId: old.id,
        createdBy: ctx.actorId ?? null,
      },
    });
    if (doIds.length) await this.invoices.pull(tx, draft.id, doIds);
    const top = await tx.invoiceLine.aggregate({
      where: { invoiceId: draft.id },
      _max: { lineNo: true },
    });
    let lineNo = top._max.lineNo ?? 0;
    for (const l of manual)
      await tx.invoiceLine.create({
        data: {
          tenantId: l.tenantId,
          invoiceId: draft.id,
          lineNo: ++lineNo,
          serviceItemId: l.serviceItemId,
          description: l.description,
          quantity: l.quantity,
          unitLabel: l.unitLabel,
          unitPrice: l.unitPrice,
          amount: l.amount,
          discount: l.discount,
          vatType: l.vatType,
          whtRate: l.whtRate,
          accountCode: l.accountCode,
          isUserAdded: true,
          doAnchor: false,
        },
      });
    await this.invoices.recompute(tx, draft.id, false);
    const out = await this.invoices.get(draft.id, tx);
    await this.audit.record({
      action: 'invoice.draft_created',
      entityType: ENTITY,
      entityId: draft.id,
      after: {
        customerId: out.customer.id,
        replacesInvoiceId: encodeId('invoice', old.id),
        replacesInvoiceNo: old.invoiceNo,
        deliveryOrders: out.deliveryOrders.map((d) => d.doNo ?? d.id),
        lineCount: out.lines.length,
        total: out.sellTotal,
      },
    });
    return draft.id;
  }
}
