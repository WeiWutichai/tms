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
  InvoiceRunDocRefDto,
  InvoiceRunResultDto,
  InvoiceRunSkippedDoDto,
} from './invoice-run.dto';
import { InvoicesService } from './invoices.service';

export const INVOICE_RUN_JOB = 'invoices.run';
/** advisory lock ต่อ (tenant, ลูกค้า) ระหว่างรอบวางบิล — รอบที่ซ้อนกันของลูกค้าเดียวทำทีละรอบ (รอบหลังเห็น DO ที่ถูกดึงแล้ว) */
const RUN_LOCK_NS = 0x1a12;
/**
 * ผู้สร้างร่างของรอบที่**ระบบตั้งเวลาเอง** (ยังไม่มี — [OPEN] scheduler) · รอบที่ผู้ใช้/API สั่ง createdBy = ผู้สั่ง (review M1:
 * ผู้สั่งนับเป็นผู้เตรียมในกฎแบ่งหน้าที่ของ finalize — ใช้ค่านี้กับรอบที่คนสั่งไม่ได้ เพราะจะข้ามกฎแบ่งหน้าที่)
 */
export const SCHEDULED_RUN_ACTOR = 'system:invoice-run';
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
 * - **แยกความล้มต่อร่าง:** ร่างหนึ่งกลุ่ม (≤ 200 DO / 1 DO สำหรับ PER_DO / ใบวางบิลต่อผู้ออก) = transaction เดียว รวมการส่งบัญชีของ DO
 *   ในกลุ่ม — กลุ่มที่ล้มย้อนทั้งกลุ่ม (ไม่มี DO ส่งบัญชีค้าง ไม่มีร่าง) กลุ่มอื่น/ลูกค้าอื่นไม่กระทบ → ผลต่อลูกค้า SUCCEEDED / PARTIAL
 *   (บางกลุ่มล้ม) / FAILED (ทุกกลุ่มที่ทำล้ม) / NOTHING_TO_BILL · มี PARTIAL/FAILED = job `succeeded_with_errors`
 *   · DO ที่ไม่ผ่านตอนดึง/ส่งบัญชี (ระบุตัวได้ เช่น หลักฐานไม่ครบ, อยู่ในร่างอื่นแล้ว) ถูกตัดออกแล้วลองใหม่ — รายงานใน `skippedDeliveryOrders`
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
      // ร่างละ transaction (เปิดเอง ≤ 120 วิ — กลุ่ม ≤ 200 DO) · progress ต่อกลุ่ม (ต่อ lease) · ล้มแล้วไม่ลองใหม่ · จบ = webhook `job.completed`
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
    // ภาพรวมก่อนเริ่ม (อ่านอย่างเดียว) → แบ่งเป็นหน่วยงาน "ร่าง" ต่อลูกค้า — แต่ละหน่วยอ่านคิวใหม่ใน transaction ของตัวเอง
    const plan = await inTx(async (tx) => {
      const ready = await this.billingQueue.readyForRun(tx, this.filter(p));
      const dos = new Map<string, string[]>();
      for (const r of ready) dos.set(r.customer_id, [...(dos.get(r.customer_id) ?? []), r.id]);
      const notes = new Map<string, string[][]>();
      if (p.billingNotes)
        for (const [cid, groups] of this.byIssuer(await this.noteCandidates(tx, p.billingCycle)))
          notes.set(cid, groups);
      const customers = await tx.customer.findMany({
        where: { id: { in: [...new Set([...dos.keys(), ...notes.keys()])] } },
        select: { id: true, code: true, legalName: true },
        orderBy: [{ code: 'asc' }, { id: 'asc' }],
      });
      return customers.map((c) => {
        const ids = dos.get(c.id) ?? [];
        return {
          c,
          invoiceGroups:
            p.billingCycle === 'PER_DO' ? ids.map((x) => [x]) : chunk(ids, this.groupSize),
          noteGroups: notes.get(c.id) ?? [],
        };
      });
    });
    const units = Math.max(
      1,
      plan.reduce((a, x) => a + x.invoiceGroups.length + x.noteGroups.length, 0),
    );
    let done = 0;
    const tick = async () => progress((++done * 100) / units);

    const results: InvoiceRunCustomerResultDto[] = [];
    for (const { c, invoiceGroups, noteGroups } of plan) {
      const acc = new CustomerAcc(c.id);
      for (const g of invoiceGroups) {
        try {
          // ร่างหนึ่งกลุ่ม = transaction เดียว (ส่งบัญชี + สร้างร่าง) — ล้ม = ย้อนทั้งกลุ่ม ไม่มีอะไรค้าง
          await inTx((tx) => this.invoiceGroup(tx, c.id, g, p, acc));
        } catch (e) {
          acc.fail(e);
        }
        await tick();
      }
      for (const g of noteGroups) {
        try {
          await inTx((tx) => this.noteGroup(tx, c.id, g, p.billingCycle, acc));
        } catch (e) {
          acc.fail(e);
        }
        await tick();
      }
      results.push(acc.toDto(c.code, c.legalName));
    }
    return {
      billingCycle: p.billingCycle,
      periodFrom: p.periodFrom,
      periodTo: p.periodTo,
      customers: results.length,
      invoicesCreated: results.reduce((a, r) => a + r.invoiceCount, 0),
      billingNotesCreated: results.reduce((a, r) => a + r.billingNotes.length, 0),
      failed: results.filter((r) => r.outcome === 'FAILED' || r.outcome === 'PARTIAL').length,
      results,
    };
  }

  /** เพดาน DO ต่อร่าง (= เพดาน `POST /invoices`) — test ลดได้ */
  groupSize = MAX_PER_DOC;

  private filter(p: RunPayload, customerId?: string) {
    return {
      cycle: p.billingCycle,
      from: p.periodFrom,
      to: p.periodTo,
      released: !p.releaseDeliveryOrders,
      ...(customerId ? { customerId } : {}),
    };
  }

  /**
   * ร่างใบแจ้งหนี้หนึ่งกลุ่ม (transaction ของตัวเอง): ล็อกลูกค้า → อ่านคิวใหม่ (เฉพาะ DO ของกลุ่มที่ยังพร้อม) → ส่งบัญชี (ถ้าสั่ง) + สร้างร่าง
   * ใน savepoint · DO ที่ไม่ผ่าน (ระบุตัวได้) ถูกตัดออกแล้วลองใหม่จนชุดคงที่ · ล้มด้วยเหตุที่ระบุ DO ไม่ได้ = throw (ย้อนทั้งกลุ่ม)
   */
  private async invoiceGroup(
    tx: Tx,
    customerId: string,
    group: string[],
    p: RunPayload,
    acc: CustomerAcc,
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${RUN_LOCK_NS}::int, hashtext(${customerId}))`;
    const cus = encodeId('customer', customerId);
    const skipped: InvoiceRunSkippedDoDto[] = [];
    let left = await this.stillReady(tx, customerId, group, p);
    for (let i = 0; left.length && i <= group.length; i++) {
      const out = await this.savepoint(tx, async () => {
        if (p.releaseDeliveryOrders) {
          const bad = await this.releaseAll(tx, left);
          if (bad.length) throw new SkipDos(bad);
        }
        // createdBy = ผู้สั่งรอบ (ctx.actorId — review M1: นับเป็นผู้เตรียมในกฎแบ่งหน้าที่ของ finalize เหมือนสร้างมือ)
        return this.invoices.create({
          customerId: cus,
          deliveryOrderIds: left.map((id) => encodeId('deliveryOrder', id)),
          ...(p.billingCycle === 'PER_DO'
            ? {}
            : { periodFrom: p.periodFrom, periodTo: p.periodTo }),
        });
      });
      if ('ok' in out) {
        acc.skipped.push(...skipped);
        acc.addInvoice(out.ok.id, out.ok.deliveryOrders.length);
        return;
      }
      const dos = out.error instanceof SkipDos ? out.error.dos : skippableDos(out.error);
      if (dos?.length) {
        const ids = new Set(dos.map((d) => d.deliveryOrderId));
        skipped.push(...dos);
        left = left.filter((id) => !ids.has(encodeId('deliveryOrder', id)));
        continue;
      }
      // ระบุ DO ไม่ได้ (เช่น ชนกับคำขออื่นที่ระดับ DB) → อ่านคิวใหม่: ชุดเล็กลง = ลองต่อ, ไม่เปลี่ยน = ล้มทั้งกลุ่ม
      const again = await this.stillReady(tx, customerId, left, p);
      if (again.length === left.length) throw out.error;
      for (const id of left.filter((x) => !again.includes(x)))
        skipped.push({
          deliveryOrderId: encodeId('deliveryOrder', id),
          doNo: null,
          reasons: ['NO_LONGER_READY'],
        });
      left = again;
    }
    // ทุก DO ของกลุ่มถูกตัด — ไม่ใช่ความล้ม แต่รายงาน DO ที่ข้าม (ไม่เงียบ)
    acc.skipped.push(...skipped);
  }

  /** DO ของกลุ่มที่ยังพร้อม (อ่านคิวใหม่หลังได้ล็อก — รอบที่ซ้อนกันเห็น DO ที่ถูกดึงไปแล้ว) */
  private async stillReady(tx: Tx, customerId: string, ids: string[], p: RunPayload) {
    const now = new Set(
      (await this.billingQueue.readyForRun(tx, this.filter(p, customerId))).map((r) => r.id),
    );
    return ids.filter((id) => now.has(id));
  }

  /**
   * ส่งบัญชี DO ที่ยังไม่ส่ง (`releaseDeliveryOrders`) — ทีละ DO (savepoint ต่อรายการ — `BillingReleaseService.bulkRelease`)
   * คืน DO ที่ส่งไม่ผ่าน (ผู้เรียกย้อน savepoint ของรอบนั้นแล้วตัด DO ออก)
   */
  private async releaseAll(tx: Tx, ids: string[]): Promise<InvoiceRunSkippedDoDto[]> {
    const res = await this.release.bulkRelease(
      ids.map((id) => ({ id })),
      null,
      tx,
    );
    const bad = ids.filter((_, i) => !('ok' in res[i]!));
    if (!bad.length) return [];
    const nos = new Map(
      (
        await tx.deliveryOrder.findMany({
          where: { id: { in: bad } },
          select: { id: true, doNo: true },
        })
      ).map((d) => [d.id, d.doNo]),
    );
    return ids.flatMap((id, i) => {
      const x = res[i]!;
      if ('ok' in x) return [];
      return [
        {
          deliveryOrderId: encodeId('deliveryOrder', id),
          doNo: nos.get(id) ?? null,
          reasons: ((x.error.extra?.reasons as string[] | undefined) ?? [x.error.code]).map(String),
        },
      ];
    });
  }

  /** ร่างใบวางบิลหนึ่งกลุ่ม (ผู้ออก/สาขาเดียว ≤ 200 ใบ) — transaction ของตัวเอง · อ่านใบที่ยังเข้าได้ใหม่หลังได้ล็อก */
  private async noteGroup(
    tx: Tx,
    customerId: string,
    group: string[],
    cycle: InvoiceRunCycle,
    acc: CustomerAcc,
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${RUN_LOCK_NS}::int, hashtext(${customerId}))`;
    const now = new Set((await this.noteCandidates(tx, cycle, customerId)).map((i) => i.id));
    const ids = group.filter((id) => now.has(id));
    if (!ids.length) return;
    const bn = await this.notes.create({
      customerId: encodeId('customer', customerId),
      invoiceIds: ids.map((id) => encodeId('invoice', id)),
    });
    acc.billingNotes.push({
      id: bn.id,
      url: `/v1/billing-notes/${bn.id}`,
      invoiceCount: bn.invoices.length,
    });
  }

  /** กลุ่มใบวางบิลต่อลูกค้า: แยกผู้ออก/สาขาผู้ออก (ใบวางบิลต้องผู้ออกเดียว) แล้วแบ่ง ≤ 200 ใบ */
  private byIssuer(
    invs: { id: string; customerId: string; issuingCompanyId: string; issuingBranchId: string }[],
  ): Map<string, string[][]> {
    const m = new Map<string, Map<string, string[]>>();
    for (const i of invs) {
      const byKey = m.get(i.customerId) ?? new Map<string, string[]>();
      const k = `${i.issuingCompanyId}:${i.issuingBranchId}`;
      byKey.set(k, [...(byKey.get(k) ?? []), i.id]);
      m.set(i.customerId, byKey);
    }
    return new Map(
      [...m].map(([cid, byKey]) => [
        cid,
        [...byKey.values()].flatMap((ids) => chunk(ids, MAX_PER_DOC)),
      ]),
    );
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

  /** ทำใน savepoint — ล้ม = ย้อนเฉพาะส่วนนี้ (transaction ของกลุ่มยังใช้ต่อได้) */
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

/** ส่งบัญชีไม่ผ่านบาง DO — ย้อน savepoint ของรอบนั้น (ไม่ให้ DO ที่ส่งแล้วค้าง) แล้วตัด DO ออก */
class SkipDos extends Error {
  constructor(readonly dos: InvoiceRunSkippedDoDto[]) {
    super('skip');
  }
}

/** เพดานรายการต่อลูกค้าใน `result` (review L2 — payload `job.completed` ไม่โตไม่จำกัดสำหรับ PER_DO) */
export const RESULT_LIST_CAP = 50;

/** สะสมผลต่อลูกค้า */
class CustomerAcc {
  invoices: InvoiceRunDocRefDto[] = [];
  invoiceCount = 0;
  billingNotes: InvoiceRunDocRefDto[] = [];
  skipped: InvoiceRunSkippedDoDto[] = [];
  failedGroups = 0;
  problem: Record<string, unknown> | null = null;
  constructor(readonly customerId: string) {}

  addInvoice(id: string, deliveryOrderCount: number) {
    this.invoiceCount++;
    if (this.invoices.length < RESULT_LIST_CAP)
      this.invoices.push({ id, url: `/v1/invoices/${id}`, deliveryOrderCount });
  }

  fail(e: unknown) {
    this.failedGroups++;
    this.problem ??= problemBody(e);
  }

  toDto(code: string, name: string): InvoiceRunCustomerResultDto {
    const created = this.invoiceCount + this.billingNotes.length;
    const cus = encodeId('customer', this.customerId);
    return {
      customerId: cus,
      customerCode: code,
      customerName: name,
      outcome: this.failedGroups
        ? created
          ? 'PARTIAL'
          : 'FAILED'
        : created
          ? 'SUCCEEDED'
          : 'NOTHING_TO_BILL',
      invoiceCount: this.invoiceCount,
      invoices: this.invoices,
      invoicesListUrl: `/v1/invoices?customerId=${cus}&status=DRAFT`,
      billingNotes: this.billingNotes,
      skippedCount: this.skipped.length,
      skippedDeliveryOrders: this.skipped.slice(0, RESULT_LIST_CAP),
      failedGroups: this.failedGroups,
      problem: this.problem,
    };
  }
}

/**
 * DO ที่ข้ามได้จาก error ของการดึงเข้าร่าง (null = ระบุ DO ไม่ได้):
 * 409 `not_ready_to_bill` (`deliveryOrders[]` จากการตรวจซ้ำ หรือ `deliveryOrderId` เดียว เช่น NOT_DELIVERED/NO_REVENUE ของ billing-guard) ·
 * 409 `do_already_drafted` ที่ระบุ DO (อยู่ในร่าง/ใบอื่นแล้ว — แข่งกับคำขออื่น)
 */
function skippableDos(e: unknown): InvoiceRunSkippedDoDto[] | null {
  if (!(e instanceof ProblemException)) return null;
  const x = (e.extra ?? {}) as {
    deliveryOrders?: { deliveryOrderId: string; doNo: string | null; reasons: string[] }[];
    deliveryOrderId?: string;
    doNo?: string | null;
    reasons?: string[];
  };
  if (e.code === 'not_ready_to_bill') {
    if (x.deliveryOrders?.length)
      return x.deliveryOrders.map((d) => ({
        deliveryOrderId: d.deliveryOrderId,
        doNo: d.doNo,
        reasons: d.reasons,
      }));
    if (x.deliveryOrderId)
      return [
        { deliveryOrderId: x.deliveryOrderId, doNo: x.doNo ?? null, reasons: x.reasons ?? [] },
      ];
    return null;
  }
  if (e.code === 'do_already_drafted' && x.deliveryOrderId)
    return [{ deliveryOrderId: x.deliveryOrderId, doNo: x.doNo ?? null, reasons: ['IN_INVOICE'] }];
  return null;
}
