import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { InvoiceSentChannel } from '@tms/domain';
import { AuditService } from '../../audit/audit.service';
import { Clock } from '../../common/clock';
import { encodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { PrismaService } from '../../db/prisma.service';
import { JobQueue } from '../../jobs/job-queue.service';
import { bangkokToday } from '../vehicle-documents/expiry';
import { applyInvoicePayments, type InvoicePaymentChange } from './invoice-payments';
import { invoiceEventObject } from './invoice-finalize.service';
import type { InvoiceDto } from './invoice.dto';
import { InvoicesService } from './invoices.service';
import { canRunInternalJobs, INTERNAL_JOB_TENANT_STATUSES } from '../tenants/tenant-status';

const ENTITY = 'invoice';
export const INVOICE_OVERDUE_JOB = 'invoice.overdue';
/** job รายวันเริ่มตั้งแต่ 00:05 เวลาไทย (spec/05 BIL-040) */
export const OVERDUE_RUN_FROM_MIN_BKK = 5;
/** ใบต่อ transaction ของ job (ล็อกสั้น ๆ) */
const BATCH = 200;
const ACTOR = 'system:invoice-overdue';
/** สถานะที่มีเลขและยังไม่ถูกยกเลิก — ทำเครื่องหมาย "ส่งลูกค้าแล้ว" ได้ */
export const SENDABLE = ['ISSUED', 'PARTIALLY_PAID', 'PAID', 'ADJUSTED'] as const;

type WithTx = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

export interface InvoiceOverdueRunResult {
  day: string;
  /** ใบที่ตั้งธงเกินกำหนดรอบนี้ */
  marked: number;
  /** ใบที่ล้างธง (ไม่เข้าเงื่อนไขแล้ว) */
  cleared: number;
}

/**
 * สถานะใบแจ้งหนี้จากการรับชำระ + เกินกำหนด + ส่งลูกค้าแล้ว (ST5-T18; docs/04 F5 "สถานะ invoice", F3 "ยกเลิกใบ"; docs/01 §4.4, §5.3;
 * spec/05 BIL-040; plan/11 #5) [DECISION spec/12 §3 แถว ST5-T18]
 *
 * - **`apply(tx, invoiceIds, now)` = ทางเดียวที่เปลี่ยนสถานะจากการรับชำระ** (ห่อ `applyInvoicePayments`) + ยิง webhook `invoice.paid`
 *   เมื่อใบเพิ่งชำระครบ (docs/01 §5.3) — ใช้โดยรับชำระ/กลับรายการ (ST5-T13), job เกินกำหนด และ**สถานะชำระจากระบบบัญชี (D-57 —
 *   ST8-T16 / ST7-T21 สร้าง `payment` แล้วเรียก `apply`)** · ผู้เรียกต้องล็อกใบ FOR UPDATE เรียง id ก่อน
 * - เกินกำหนด = ธง `overdue_at` (ไม่ใช่สถานะ) — job `invoice.overdue` รายวันตั้งแต่ 00:05 เวลาไทย ต่อ tenant (idempotent: รันซ้ำไม่เปลี่ยน)
 * - "ส่งลูกค้าแล้ว" = `sent_to_customer_at` — ทำเครื่องหมายเอง (`invoices:finalize`) / ออกใบวางบิล / อีเมล (ST5-T21) ·
 *   ล้างธงต้องมีเหตุผล (`invoices:void`) · ทุกครั้งลง audit · ส่งแล้วยกเลิกใบไม่ได้ (ST5-T10 + trigger 0147)
 */
@Injectable()
export class InvoiceStatusService implements OnModuleInit {
  private readonly logger = new Logger('InvoiceStatusService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly db: DbService,
    private readonly queue: JobQueue,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly invoices: InvoicesService,
  ) {}

  onModuleInit() {
    this.queue.register(
      INVOICE_OVERDUE_JOB,
      async ({ tenantId, job, withTx }) => {
        if (!(await this.tenantActive(tenantId))) return { skipped: 'tenant_inactive' };
        return this.runOverdue(tenantId, this.clock.now(), withTx, `job:${job.id}`);
      },
      { outsideTransaction: true },
    );
  }

  // ---------- สถานะจากการรับชำระ ----------

  /** คำนวณสถานะ/ยอดตัด/เกินกำหนดใหม่ + webhook `invoice.paid` (ใบที่เพิ่งเป็น PAID) — transaction ของผู้เรียก */
  async apply(tx: Tx, invoiceIds: readonly string[], now: Date): Promise<InvoicePaymentChange[]> {
    const changes = await applyInvoicePayments(tx, invoiceIds, now);
    const ctx = requestContext.require();
    for (const c of changes) {
      if (c.after.status !== 'PAID' || c.before.status === 'PAID') continue;
      const dto = await this.invoices.get(c.id, tx);
      await tx.domainEvent.create({
        data: {
          tenantId: ctx.tenantId!,
          type: 'invoice.paid',
          entityType: ENTITY,
          localId: c.id,
          snapshot: invoiceEventObject(dto, 'invoice.paid') as Prisma.InputJsonValue,
          previousAttributes: { status: c.before.status, version: c.beforeVersion },
          requestId: ctx.requestId ?? null,
          actorId: ctx.actorId ?? null,
        },
      });
    }
    return changes;
  }

  // ---------- job เกินกำหนดรายวัน ----------

  /**
   * สร้าง job ของวันนี้ให้ทุก tenant ที่ยังไม่มี (เรียกซ้ำได้ — ก่อน 00:05 เวลาไทยไม่ทำอะไร) · advisory lock กันสอง worker สร้างซ้ำ
   */
  async scheduleDue(now: Date = this.clock.now()): Promise<number> {
    const bkk = new Date(now.getTime() + 7 * 3600_000);
    if (bkk.getUTCHours() === 0 && bkk.getUTCMinutes() < OVERDUE_RUN_FROM_MIN_BKK) return 0;
    const today = bangkokToday(now);
    return this.prisma.platform.$transaction(async (db) => {
      await db.$executeRaw`SELECT pg_advisory_xact_lock(8, hashtext(${INVOICE_OVERDUE_JOB}))`;
      const tenants = await db.tenant.findMany({
        where: { status: { in: [...INTERNAL_JOB_TENANT_STATUSES] }, mode: 'live' },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });
      if (!tenants.length) return 0;
      const existing = await db.job.findMany({
        where: {
          tenantId: { in: tenants.map((t) => t.id) },
          type: INVOICE_OVERDUE_JOB,
          createdAt: { gte: new Date(now.getTime() - 3 * 86_400_000) }, // review L2: นาฬิกาที่ฉีด
          payload: { path: ['day'], equals: today },
        },
        select: { tenantId: true },
      });
      const done = new Set(existing.map((j) => j.tenantId));
      const todo = tenants.filter((t) => !done.has(t.id));
      for (const t of todo)
        await this.queue.enqueue(db as unknown as Tx, {
          tenantId: t.id,
          type: INVOICE_OVERDUE_JOB,
          payload: { day: today },
        });
      return todo.length;
    });
  }

  private async tenantActive(tenantId: string): Promise<boolean> {
    const t = await this.prisma.platform.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true },
    });
    return canRunInternalJobs(t?.status);
  }

  /**
   * ตั้ง/ล้างธงเกินกำหนดของ tenant ณ `now` (วันเวลาไทย) — ทีละชุด (transaction สั้น + ล็อกใบเรียง id) ผ่าน `apply` ตัวเดียวกับการรับชำระ
   * ใบที่เปลี่ยน → audit `invoice.overdue` / `invoice.overdue_cleared` (ผู้กระทำ = ระบบ) · รันซ้ำ = ไม่มีอะไรเปลี่ยน
   */
  async runOverdue(
    tenantId: string,
    now: Date,
    withTx: WithTx = (fn) => this.db.withTenant(tenantId, fn),
    requestId = `invoice-overdue:${now.toISOString()}`,
  ): Promise<InvoiceOverdueRunResult> {
    const today = bangkokToday(now);
    const todayDate = new Date(`${today}T00:00:00.000Z`);
    const out: InvoiceOverdueRunResult = { day: today, marked: 0, cleared: 0 };
    for (;;) {
      const n = await withTx((tx) =>
        requestContext.run(
          {
            requestId,
            tenantId,
            actorId: ACTOR,
            principalType: 'system',
            scopes: [],
            locale: 'th',
            tx,
          },
          async () => {
            const due = await tx.invoice.findMany({
              where: {
                OR: [
                  {
                    status: { in: ['ISSUED', 'PARTIALLY_PAID'] },
                    overdueAt: null,
                    dueDate: { lt: todayDate },
                    // review L1: ยอดรวม 0 / ตัดครบแล้วไม่เข้าเงื่อนไข — กันชุด 200 ใบที่ apply ไม่เปลี่ยนค้างลูป
                    paidAmount: { lt: tx.invoice.fields.totalAmount },
                  },
                  { overdueAt: { not: null }, dueDate: { gte: todayDate } },
                ],
              },
              select: { id: true },
              orderBy: { id: 'asc' },
              take: BATCH,
            });
            if (!due.length) return 0;
            const ids = due.map((d) => d.id);
            await tx.$queryRaw`SELECT id FROM invoice WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
            const changes = await this.apply(tx, ids, now);
            for (const c of changes) {
              if (c.before.overdue === c.after.overdue) continue;
              if (c.after.overdue) out.marked++;
              else out.cleared++;
              await this.audit.record({
                action: c.after.overdue ? 'invoice.overdue' : 'invoice.overdue_cleared',
                entityType: ENTITY,
                entityId: c.id,
                before: { overdue: c.before.overdue, status: c.before.status },
                after: { overdue: c.after.overdue, status: c.after.status, day: today },
              });
            }
            return changes.length;
          },
        ),
      );
      // ชุดที่ไม่เปลี่ยนอะไรเลย (ไม่ควรเกิด — เงื่อนไข query = เงื่อนไขของ apply) → หยุด กันวนไม่รู้จบ
      if (n === 0) break;
    }
    if (out.marked || out.cleared)
      this.logger.log(`tenant ${tenantId} overdue ${JSON.stringify(out)}`);
    return out;
  }

  // ---------- ส่งลูกค้าแล้ว ----------

  /** ทำเครื่องหมาย "ส่งลูกค้าแล้ว" เอง — ส่งแล้วอยู่แล้ว = คืนค่าเดิม (ไม่เปลี่ยน ไม่ลง audit) */
  async markSent(id: string, expected: number | undefined): Promise<InvoiceDto> {
    const tx = this.db.tx;
    const ctx = requestContext.require();
    const inv = await this.lockOne(tx, id, expected);
    if (!(SENDABLE as readonly string[]).includes(inv.status) || !inv.invoiceNo)
      throw new ProblemException('invalid_state_transition', undefined, undefined, {
        currentStatus: inv.status,
      });
    if (inv.sentToCustomerAt) return this.invoices.get(id, tx);
    const now = this.clock.now();
    await this.setSent(tx, id, now, ctx.actorId ?? 'system', 'MANUAL');
    await this.audit.record({
      action: 'invoice.sent_to_customer',
      entityType: ENTITY,
      entityId: id,
      before: { sentToCustomerAt: null },
      after: { sentToCustomerAt: now.toISOString(), channel: 'MANUAL', invoiceNo: inv.invoiceNo },
    });
    return this.invoices.get(id, tx);
  }

  /** ล้างธง "ส่งลูกค้าแล้ว" (ทำเครื่องหมายผิด) — เหตุผล + audit · ยังไม่ส่ง = คืนค่าเดิม */
  async unmarkSent(id: string, reason: string, expected: number | undefined): Promise<InvoiceDto> {
    const tx = this.db.tx;
    const inv = await this.lockOne(tx, id, expected);
    if (!inv.sentToCustomerAt) return this.invoices.get(id, tx);
    await tx.invoice.update({
      where: { id },
      data: {
        sentToCustomerAt: null,
        sentToCustomerBy: null,
        sentToCustomerChannel: null,
        version: { increment: 1 },
      },
    });
    await this.audit.record({
      action: 'invoice.sent_to_customer_cleared',
      entityType: ENTITY,
      entityId: id,
      reason,
      before: {
        sentToCustomerAt: inv.sentToCustomerAt.toISOString(),
        channel: inv.sentToCustomerChannel,
        by: inv.sentToCustomerBy,
      },
      after: { sentToCustomerAt: null },
    });
    return this.invoices.get(id, tx);
  }

  /**
   * ออกใบวางบิล = ส่งลูกค้าแล้ว (ช่องทาง BILLING_NOTE) — ใบที่ยังไม่มีธง · transaction ของผู้ออก (ใบถูกล็อกโดยผู้เรียกแล้ว)
   * คืนจำนวนใบที่ตั้ง
   */
  async markSentByBillingNote(
    tx: Tx,
    invoiceIds: readonly string[],
    billingNote: { id: string; billingNoteNo: string },
    now: Date,
  ): Promise<number> {
    const ctx = requestContext.require();
    const rows = await tx.invoice.findMany({
      where: { id: { in: [...invoiceIds] }, sentToCustomerAt: null, invoiceNo: { not: null } },
      select: { id: true, invoiceNo: true },
      orderBy: { id: 'asc' },
    });
    for (const r of rows) {
      await this.setSent(tx, r.id, now, ctx.actorId ?? 'system', 'BILLING_NOTE');
      await this.audit.record({
        action: 'invoice.sent_to_customer',
        entityType: ENTITY,
        entityId: r.id,
        before: { sentToCustomerAt: null },
        after: {
          sentToCustomerAt: now.toISOString(),
          channel: 'BILLING_NOTE',
          invoiceNo: r.invoiceNo,
          billingNoteId: encodeId('billingNote', billingNote.id),
          billingNoteNo: billingNote.billingNoteNo,
        },
      });
    }
    return rows.length;
  }

  /**
   * ส่งอีเมลถึงลูกค้า = ส่งลูกค้าแล้ว (ช่องทาง EMAIL — ST5-T21) — ใบที่ยังไม่มีธง · transaction ของผู้ส่ง (ผู้เรียกล็อกเอกสารแล้ว)
   * ใบที่มีธงอยู่แล้ว (ทำเครื่องหมายเอง / ออกใบวางบิล) ไม่เปลี่ยนช่องทาง · คืน id ใบที่ตั้ง (เก็บใน document_email — ส่งไม่สำเร็จ
   * worker ล้างคืนเฉพาะใบเหล่านี้: review M1)
   */
  async markSentByEmail(
    tx: Tx,
    invoiceIds: readonly string[],
    via: { entityType: 'invoice' | 'billing_note'; documentNo: string },
    now: Date,
  ): Promise<string[]> {
    if (!invoiceIds.length) return [];
    const ctx = requestContext.require();
    const by = ctx.actorId ?? 'system';
    // review L2: ล็อกใบตามลำดับ id ก่อนอ่าน + ตั้งแบบมีเงื่อนไข (คำขออื่นตั้ง/ล้างพร้อมกันไม่ทับ)
    await tx.$queryRaw`SELECT id FROM invoice WHERE id = ANY(${[...invoiceIds]}::uuid[]) ORDER BY id FOR UPDATE`;
    const rows = await tx.invoice.findMany({
      where: {
        id: { in: [...invoiceIds] },
        sentToCustomerAt: null,
        invoiceNo: { not: null },
        status: { in: [...SENDABLE] },
      },
      select: { id: true, invoiceNo: true },
      orderBy: { id: 'asc' },
    });
    const flagged: string[] = [];
    for (const r of rows) {
      const n = await tx.invoice.updateMany({
        where: { id: r.id, sentToCustomerAt: null },
        data: {
          sentToCustomerAt: now,
          sentToCustomerBy: by,
          sentToCustomerChannel: 'EMAIL',
          version: { increment: 1 },
        },
      });
      if (!n.count) continue;
      flagged.push(r.id);
      await this.audit.record({
        action: 'invoice.sent_to_customer',
        entityType: ENTITY,
        entityId: r.id,
        before: { sentToCustomerAt: null },
        after: {
          sentToCustomerAt: now.toISOString(),
          channel: 'EMAIL',
          invoiceNo: r.invoiceNo,
          ...(via.entityType === 'billing_note' ? { billingNoteNo: via.documentNo } : {}),
        },
      });
    }
    return flagged;
  }

  /**
   * ยกเลิกใบวางบิลที่ออกแล้ว → ล้างธง "ส่งลูกค้าแล้ว" ที่มาจากการออกใบวางบิล (ช่องทาง BILLING_NOTE) ของใบในใบวางบิลนั้น —
   * พฤติกรรมยกเลิกใบแจ้งหนี้หลังยกเลิกใบวางบิลคงเดิมแบบ ST5-T10 · ธงที่ตั้งเอง/อีเมล ไม่แตะ · audit พร้อมเหตุผล
   */
  async clearSentByBillingNote(
    tx: Tx,
    invoiceIds: readonly string[],
    billingNote: { id: string; billingNoteNo: string | null },
    reason: string,
  ): Promise<number> {
    const rows = await tx.invoice.findMany({
      where: { id: { in: [...invoiceIds] }, sentToCustomerChannel: 'BILLING_NOTE' },
      select: { id: true, sentToCustomerAt: true, sentToCustomerBy: true },
      orderBy: { id: 'asc' },
    });
    for (const r of rows) {
      await tx.invoice.update({
        where: { id: r.id },
        data: {
          sentToCustomerAt: null,
          sentToCustomerBy: null,
          sentToCustomerChannel: null,
          version: { increment: 1 },
        },
      });
      await this.audit.record({
        action: 'invoice.sent_to_customer_cleared',
        entityType: ENTITY,
        entityId: r.id,
        reason,
        before: {
          sentToCustomerAt: r.sentToCustomerAt?.toISOString() ?? null,
          channel: 'BILLING_NOTE',
          by: r.sentToCustomerBy,
        },
        after: {
          sentToCustomerAt: null,
          billingNoteId: encodeId('billingNote', billingNote.id),
          billingNoteNo: billingNote.billingNoteNo,
        },
      });
    }
    return rows.length;
  }

  private async setSent(tx: Tx, id: string, at: Date, by: string, channel: InvoiceSentChannel) {
    await tx.invoice.update({
      where: { id },
      data: {
        sentToCustomerAt: at,
        sentToCustomerBy: by,
        sentToCustomerChannel: channel,
        version: { increment: 1 },
      },
    });
  }

  private async lockOne(tx: Tx, id: string, expected: number | undefined) {
    await tx.$queryRaw`SELECT id FROM invoice WHERE id = ${id}::uuid FOR UPDATE`;
    const inv = await tx.invoice.findUnique({ where: { id } });
    if (!inv) throw new ProblemException('not_found');
    if (expected !== undefined && expected !== inv.version)
      throw new ProblemException('precondition_failed');
    return inv;
  }
}
