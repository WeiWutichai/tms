import { Injectable, type OnModuleInit } from '@nestjs/common';
import { scopeAllows } from '@tms/domain';
import { AuditService } from '../../audit/audit.service';
import { encodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { problemBody } from '../../common/problem-body';
import { requestContext, type RequestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { requestActor, resolveJobActor, type JobActor } from '../../jobs/job-actor';
import { JobOutcome, JobQueue } from '../../jobs/job-queue.service';
import { BillingNotesService } from '../billing-notes/billing-notes.service';
import { BillingQueueService } from './billing-queue.service';
import { BillingReleaseService } from './billing-release.service';
import type {
  CreateInvoiceRunDto,
  InvoiceRunAcceptedDto,
  InvoiceRunCustomerResultDto,
  InvoiceRunCycle,
  InvoiceRunResultDto,
  InvoiceRunSkippedDoDto,
} from './invoice-run.dto';
import { InvoicesService } from './invoices.service';

export const INVOICE_RUN_JOB = 'invoices.run';
/** advisory lock ต่อ (tenant, ลูกค้า) ระหว่างรอบวางบิล — รอบที่ซ้อนกันของลูกค้าเดียวทำทีละรอบ (รอบหลังเห็น DO ที่ถูกดึงแล้ว) */
const RUN_LOCK_NS = 0x1a12;
/** ผู้สร้างร่างของรอบวางบิล (`invoice.created_by`) */
export const RUN_ACTOR = 'system:invoice-run';
/** เพดาน DO ต่อร่าง / ใบแจ้งหนี้ต่อใบวางบิล — เท่ากับเพดานของ `POST /invoices` / `POST /billing-notes` */
const MAX_PER_DOC = 200;
/** สถานะใบแจ้งหนี้ที่ใส่ใบวางบิลได้ (ชุดเดียวกับ BillingNotesService — ออกแล้วค้างชำระ) */
const BILLABLE_INVOICE = ['ISSUED', 'PARTIALLY_PAID'] as const;

interface RunPayload {
  billingCycle: InvoiceRunCycle;
  periodFrom: string;
  periodTo: string;
  releaseDeliveryOrders: boolean;
  billingNotes: boolean;
  actor: JobActor;
  locale: 'th' | 'en';
}

type WithTx = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

const chunk = <T>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

/**
 * รอบวางบิล (ST5-T12; docs/04 F3 "Invoice run (async)" + F2 "ใบวางบิล สร้างอัตโนมัติตาม billing_cycle", docs/01 §5.2 #8 `POST /invoice-runs`)
 *
 * - `POST /v1/invoice-runs` → 202 `{jobId, statusUrl}` → job `invoices.run` (รันในชื่อผู้สั่ง: scope ตอนสั่ง ∩ สิทธิ์ปัจจุบัน) →
 *   จบ = webhook `job.completed` + แจ้งผู้สั่ง · `result` = ผลต่อลูกค้า + ลิงก์ร่างที่สร้าง (ไม่มียอดเงิน — ผู้อ่าน job อาจไม่มีสิทธิ์ราคา)
 * - ลูกค้าที่ `billing_cycle` ตรงรอบ (ไม่รวม MANUAL / ลูกค้าที่ลบ) ที่มี DO พร้อมดึงในงวด (`do_date`) — กฎคิวเดียวกับ `GET /invoices/queue`
 *   + เวลาจุดส่งครบ · ร่างสร้างผ่าน `InvoicesService.create` (ทางเดียวกับสร้างมือ: ตรวจซ้ำตอนดึง + กันวางบิลซ้ำระดับ DB + audit)
 * - **ไม่สร้างซ้ำ (idempotent):** DO ที่อยู่ในร่าง/ใบที่ active ไม่ขึ้นคิวแล้ว และใบแจ้งหนี้ที่อยู่ในใบวางบิลที่ active ไม่ถูกเลือกอีก →
 *   สั่งรอบเดิมซ้ำ = ลูกค้าไม่มีอะไรต้องสร้าง · ลูกค้าเดียวกันในรอบที่ซ้อนกันทำทีละรอบ (advisory lock)
 * - **แยกความล้มต่อลูกค้า:** ลูกค้าละ transaction + savepoint ต่อร่าง — ลูกค้าที่ล้มไม่ทำให้ลูกค้าอื่นล้ม (job = `succeeded_with_errors`)
 *   · DO ที่ตรวจซ้ำตอนดึงไม่ผ่าน (เช่น หลักฐานไม่ครบตาม checklist ปัจจุบัน) ถูกตัดออกจากร่างและรายงานใน `skippedDeliveryOrders`
 * - ร่าง **ไม่มีเลข ไม่ใช่เอกสารภาษี** (D-54) — ผู้ใช้ตรวจแล้วออกเอกสารเอง
 */
@Injectable()
export class InvoiceRunService implements OnModuleInit {
  constructor(
    private readonly db: DbService,
    private readonly queue: JobQueue,
    private readonly billingQueue: BillingQueueService,
    private readonly invoices: InvoicesService,
    private readonly notes: BillingNotesService,
    private readonly release: BillingReleaseService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    this.queue.register(
      INVOICE_RUN_JOB,
      async ({ tenantId, job, withTx, progress }) => {
        // ล้มกลางรอบ = บางลูกค้า commit แล้ว — ไม่ลองซ้ำอัตโนมัติ (สั่งรอบใหม่ได้: ส่วนที่สร้างแล้วไม่ถูกสร้างซ้ำ)
        if (job.attempts > 1)
          throw new Error('invoice run interrupted — not re-run; start a new run');
        const p = job.payload as unknown as RunPayload;
        const actor = await withTx((tx) => resolveJobActor(tx, p.actor ?? {}));
        const ctx: RequestContext = {
          requestId: `job:${encodeId('job', job.id)}`,
          tenantId,
          locale: p.locale === 'en' ? 'en' : 'th',
          ...(actor.actorId ? { actorId: actor.actorId } : {}),
          scopes: actor.scopes,
          principalType: actor.principalType ?? 'user',
          ...(actor.actAs ? { actAs: actor.actAs } : {}),
          ...(actor.ip ? { ip: actor.ip } : {}),
        };
        const out = await requestContext.run(ctx, () => this.run(p, withTx, progress));
        return new JobOutcome(out, out.failed ? 'SUCCEEDED_WITH_ERRORS' : 'SUCCEEDED');
      },
      // ลูกค้าละ transaction (เปิดเอง) · ล้มแล้วไม่ลองใหม่ · จบ = webhook `job.completed`
      { outsideTransaction: true, publicEvent: true, timeoutMs: 120_000 },
    );
  }

  /** สั่งรอบ (ใน transaction ของคำขอ — งานไม่หลุดถ้าคำขอ rollback) */
  async enqueue(body: CreateInvoiceRunDto): Promise<InvoiceRunAcceptedDto> {
    const ctx = requestContext.require();
    const payload: RunPayload = {
      billingCycle: body.billingCycle,
      periodFrom: body.periodFrom,
      periodTo: body.periodTo,
      releaseDeliveryOrders: body.releaseDeliveryOrders === true,
      billingNotes: body.billingNotes !== false,
      actor: { ...requestActor(), actorId: ctx.actorId ?? null },
      locale: ctx.locale,
    };
    const user = requestActor().actorId;
    const job = await this.queue.enqueue(this.db.tx, {
      tenantId: ctx.tenantId!,
      type: INVOICE_RUN_JOB,
      payload,
      maxAttempts: 1,
      ...(user && (ctx.principalType ?? 'user') === 'user'
        ? {
            notify: {
              userId: user,
              label: `สร้างร่างใบแจ้งหนี้ตามรอบวางบิล (${body.periodFrom} – ${body.periodTo})`,
              link: '/bill',
            },
          }
        : {}),
    });
    const jobId = encodeId('job', job.id);
    await this.audit.record({
      action: 'invoice_run.requested',
      entityType: 'job',
      entityId: job.id,
      after: {
        billingCycle: payload.billingCycle,
        periodFrom: payload.periodFrom,
        periodTo: payload.periodTo,
        releaseDeliveryOrders: payload.releaseDeliveryOrders,
        billingNotes: payload.billingNotes,
      },
    });
    return { jobId, statusUrl: `/v1/jobs/${jobId}` };
  }

  private async run(
    p: RunPayload,
    withTx: WithTx,
    progress: (pct: number) => Promise<void>,
  ): Promise<InvoiceRunResultDto> {
    const ctx = requestContext.require();
    // สิทธิ์เดียวกับ POST /v1/invoices (ผู้สั่งอาจถูกถอดสิทธิ์ระหว่างรอ) — ไม่มี = งานล้มทั้งงาน
    if (!scopeAllows(ctx.scopes ?? [], 'invoices:draft'))
      throw new ProblemException('permission_denied', undefined, undefined, {
        module: 'invoices',
        action: 'draft',
        required: ['invoices:draft'],
      });
    const inTx: WithTx = (fn) => withTx((tx) => requestContext.run({ ...ctx, tx }, () => fn(tx)));
    const customers = await inTx(async (tx) => {
      const ready = await this.billingQueue.readyForRun(tx, {
        cycle: p.billingCycle,
        from: p.periodFrom,
        to: p.periodTo,
        released: !p.releaseDeliveryOrders,
      });
      const ids = new Set(ready.map((r) => r.customer_id));
      if (p.billingNotes)
        for (const i of await this.noteCandidates(tx, p.billingCycle)) ids.add(i.customerId);
      return tx.customer.findMany({
        where: { id: { in: [...ids] } },
        select: { id: true, code: true, legalName: true },
        orderBy: [{ code: 'asc' }, { id: 'asc' }],
      });
    });
    const results: InvoiceRunCustomerResultDto[] = [];
    for (const c of customers) {
      const r: InvoiceRunCustomerResultDto = {
        customerId: encodeId('customer', c.id),
        customerCode: c.code,
        customerName: c.legalName,
        outcome: 'NOTHING_TO_BILL',
        invoices: [],
        billingNotes: [],
        skippedDeliveryOrders: [],
        problem: null,
      };
      try {
        await inTx((tx) => this.customer(tx, c.id, p, r));
      } catch (e) {
        // ทั้ง transaction ของลูกค้านี้ย้อน — ร่างที่บันทึกในรายการถูกย้อนด้วย
        r.invoices = [];
        r.billingNotes = [];
        r.problem = problemBody(e);
      }
      r.outcome = r.problem
        ? 'FAILED'
        : r.invoices.length || r.billingNotes.length
          ? 'CREATED'
          : 'NOTHING_TO_BILL';
      results.push(r);
      await progress(((results.length * 100) / customers.length) | 0);
    }
    return {
      billingCycle: p.billingCycle,
      periodFrom: p.periodFrom,
      periodTo: p.periodTo,
      customers: results.length,
      invoicesCreated: results.reduce((a, r) => a + r.invoices.length, 0),
      billingNotesCreated: results.reduce((a, r) => a + r.billingNotes.length, 0),
      failed: results.filter((r) => r.outcome === 'FAILED').length,
      results,
    };
  }

  /** ลูกค้าหนึ่งราย (transaction เดียว) — ร่างละ savepoint: ร่างที่ล้มย้อนเฉพาะร่างนั้น */
  private async customer(
    tx: Tx,
    customerId: string,
    p: RunPayload,
    r: InvoiceRunCustomerResultDto,
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${RUN_LOCK_NS}::int, hashtext(${customerId}))`;
    // อ่านใหม่หลังได้ล็อก — รอบที่ซ้อนกันเห็น DO ที่รอบก่อนดึงไปแล้ว (ไม่ขึ้นคิว)
    const ready = await this.billingQueue.readyForRun(tx, {
      cycle: p.billingCycle,
      from: p.periodFrom,
      to: p.periodTo,
      released: !p.releaseDeliveryOrders,
      customerId,
    });
    let ids = ready.map((d) => d.id);
    if (p.releaseDeliveryOrders) ids = await this.releaseAll(tx, ids, r);
    const groups = p.billingCycle === 'PER_DO' ? ids.map((id) => [id]) : chunk(ids, MAX_PER_DOC);
    const cus = encodeId('customer', customerId);
    for (const g of groups) {
      let left = g;
      // ตรวจซ้ำตอนดึงไม่ผ่านบาง DO → ตัด DO นั้นออกแล้วลองใหม่ครั้งเดียว (DO ที่เหลือยังพร้อม)
      for (let attempt = 0; attempt < 2 && left.length; attempt++) {
        const out = await this.savepoint(tx, () =>
          this.invoices.create(
            {
              customerId: cus,
              deliveryOrderIds: left.map((id) => encodeId('deliveryOrder', id)),
              ...(p.billingCycle === 'PER_DO'
                ? {}
                : { periodFrom: p.periodFrom, periodTo: p.periodTo }),
            },
            // ร่างของระบบ (ST5-T09 L3 hand-off) — ผู้สั่งรอบไม่นับเป็นผู้เตรียม; audit ยังลงชื่อผู้สั่ง
            { createdBy: RUN_ACTOR },
          ),
        );
        if ('ok' in out) {
          r.invoices.push({
            id: out.ok.id,
            url: `/v1/invoices/${out.ok.id}`,
            deliveryOrderCount: out.ok.deliveryOrders.length,
          });
          break;
        }
        const failed = notReadyDos(out.error);
        if (!failed) {
          r.problem ??= problemBody(out.error);
          break;
        }
        const bad = new Set(failed.map((f) => f.deliveryOrderId));
        r.skippedDeliveryOrders.push(...failed);
        left = left.filter((id) => !bad.has(encodeId('deliveryOrder', id)));
      }
    }
    if (p.billingNotes) await this.billingNotes(tx, customerId, p.billingCycle, r);
  }

  /**
   * ส่งบัญชี DO ที่ยังไม่ส่ง (`releaseDeliveryOrders`) — ทีละ DO (savepoint ต่อรายการ — `BillingReleaseService.bulkRelease`)
   * ไม่ผ่าน = ตัดออกและรายงานใน `skippedDeliveryOrders` · คืน DO ที่ส่งบัญชีแล้ว (ลำดับเดิม)
   */
  private async releaseAll(
    tx: Tx,
    ids: string[],
    r: InvoiceRunCustomerResultDto,
  ): Promise<string[]> {
    const res = await this.release.bulkRelease(
      ids.map((id) => ({ id })),
      null,
      tx,
    );
    const bad = ids.filter((_, i) => !('ok' in res[i]!));
    const nos = new Map(
      (
        await tx.deliveryOrder.findMany({
          where: { id: { in: bad } },
          select: { id: true, doNo: true },
        })
      ).map((d) => [d.id, d.doNo]),
    );
    const ok: string[] = [];
    res.forEach((x, i) => {
      if ('ok' in x) ok.push(ids[i]!);
      else
        r.skippedDeliveryOrders.push({
          deliveryOrderId: encodeId('deliveryOrder', ids[i]!),
          doNo: nos.get(ids[i]!) ?? null,
          reasons: ((x.error.extra?.reasons as string[] | undefined) ?? [x.error.code]).map(String),
        });
    });
    return ok;
  }

  /** ร่างใบวางบิล: ใบแจ้งหนี้ที่ออกแล้วยังค้าง ไม่อยู่ในใบวางบิลที่ active — 1 ร่างต่อผู้ออก/สาขาผู้ออก (ใบวางบิลต้องผู้ออกเดียว) */
  private async billingNotes(
    tx: Tx,
    customerId: string,
    cycle: InvoiceRunCycle,
    r: InvoiceRunCustomerResultDto,
  ): Promise<void> {
    const invs = await this.noteCandidates(tx, cycle, customerId);
    const byIssuer = new Map<string, string[]>();
    for (const i of invs) {
      const k = `${i.issuingCompanyId}:${i.issuingBranchId}`;
      byIssuer.set(k, [...(byIssuer.get(k) ?? []), i.id]);
    }
    for (const ids of byIssuer.values())
      for (const g of chunk(ids, MAX_PER_DOC)) {
        const out = await this.savepoint(tx, () =>
          this.notes.create({
            customerId: encodeId('customer', customerId),
            invoiceIds: g.map((id) => encodeId('invoice', id)),
          }),
        );
        if ('ok' in out)
          r.billingNotes.push({
            id: out.ok.id,
            url: `/v1/billing-notes/${out.ok.id}`,
            invoiceCount: out.ok.invoices.length,
          });
        else r.problem ??= problemBody(out.error);
      }
  }

  /** ใบแจ้งหนี้ที่เข้าใบวางบิลได้ของลูกค้าในรอบนี้ (เงื่อนไขเดียวกับ `GET /billing-notes/candidates`) */
  private async noteCandidates(tx: Tx, cycle: InvoiceRunCycle, customerId?: string) {
    const rows = await tx.invoice.findMany({
      where: {
        ...(customerId ? { customerId } : {}),
        customer: { billingCycle: cycle, deletedAt: null },
        status: { in: [...BILLABLE_INVOICE] },
        invoiceNo: { not: null },
        issueDate: { not: null },
        dueDate: { not: null },
        billingNoteLinks: { none: { active: true } },
      },
      orderBy: [{ issueDate: 'asc' }, { invoiceNo: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        customerId: true,
        issuingCompanyId: true,
        issuingBranchId: true,
        totalAmount: true,
        paidAmount: true,
      },
    });
    return rows.filter((i) => i.totalAmount.greaterThan(i.paidAmount));
  }

  /** ทำใน savepoint — ล้ม = ย้อนเฉพาะส่วนนี้ (transaction ของลูกค้ายังใช้ต่อได้) */
  private async savepoint<T>(
    tx: Tx,
    fn: () => Promise<T>,
  ): Promise<{ ok: T } | { error: unknown }> {
    await tx.$executeRawUnsafe('SAVEPOINT tms_invoice_run');
    try {
      const ok = await fn();
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT tms_invoice_run');
      return { ok };
    } catch (error) {
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT tms_invoice_run');
      await tx.$executeRawUnsafe('RELEASE SAVEPOINT tms_invoice_run');
      return { error };
    }
  }
}

/** DO ที่ไม่ผ่านจาก 409 `not_ready_to_bill` ของการดึงเข้าร่าง (null = ล้มด้วยเหตุอื่น) */
function notReadyDos(e: unknown): InvoiceRunSkippedDoDto[] | null {
  if (!(e instanceof ProblemException) || e.code !== 'not_ready_to_bill') return null;
  const list = (e.extra?.deliveryOrders ?? []) as {
    deliveryOrderId: string;
    doNo: string | null;
    reasons: string[];
  }[];
  if (!list.length) return null;
  return list.map((d) => ({
    deliveryOrderId: d.deliveryOrderId,
    doNo: d.doNo,
    reasons: d.reasons,
  }));
}
