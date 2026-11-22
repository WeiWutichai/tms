import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { scopeAllows } from '@tms/domain';
import { AuditService } from '../../audit/audit.service';
import { encodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { problemBody } from '../../common/problem-body';
import { PriceField } from '../../common/price-fields';
import { requestContext, type RequestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { requestActor, resolveJobActor, type JobActor } from '../../jobs/job-actor';
import { JobOutcome, JobQueue } from '../../jobs/job-queue.service';
import { BillingNotesService } from '../billing-notes/billing-notes.service';
import { INVOICE_RUN_SUMMARY_RESOURCE } from '../exports/exports.controller';
import { ExportsService } from '../exports/exports.service';
import { dropUnpricedColumns, type ExportColumn } from '../master/export';
import { MAX_DOS_PER_INVOICE, MAX_INVOICES_PER_BILLING_NOTE } from './billing-limits';
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
  InvoiceRunSummaryDto,
} from './invoice-run.dto';
import type { InvoiceDto } from './invoice.dto';
import { InvoicesService } from './invoices.service';

export const INVOICE_RUN_JOB = 'invoices.run';
/** advisory lock ต่อ (tenant, ลูกค้า) ระหว่างรอบวางบิล — รอบที่ซ้อนกันของลูกค้าเดียวทำทีละรอบ (รอบหลังเห็น DO ที่ถูกดึงแล้ว) */
const RUN_LOCK_NS = 0x1a12;
/**
 * ผู้สร้างร่างของรอบที่**ระบบตั้งเวลาเอง** (ยังไม่มี — [OPEN] scheduler) · รอบที่ผู้ใช้/API สั่ง createdBy = ผู้สั่ง (review M1:
 * ผู้สั่งนับเป็นผู้เตรียมในกฎแบ่งหน้าที่ของ finalize — ใช้ค่านี้กับรอบที่คนสั่งไม่ได้ เพราะจะข้ามกฎแบ่งหน้าที่)
 */
export const SCHEDULED_RUN_ACTOR = 'system:invoice-run';
/** ชื่อไฟล์สรุปรอบ (ผู้ใช้เห็นในแจ้งเตือน "ไฟล์ส่งออกพร้อมแล้ว") */
const SUMMARY_LABEL = 'สรุปรอบวางบิล';
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
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
 * - **แยกความล้มต่อร่าง:** ร่างหนึ่งกลุ่ม (≤ `MAX_DOS_PER_INVOICE` DO / 1 DO สำหรับ PER_DO / ใบวางบิลต่อผู้ออก) = transaction เดียว รวมการส่งบัญชีของ DO
 *   ในกลุ่ม — กลุ่มที่ล้มย้อนทั้งกลุ่ม (ไม่มี DO ส่งบัญชีค้าง ไม่มีร่าง) กลุ่มอื่น/ลูกค้าอื่นไม่กระทบ → ผลต่อลูกค้า SUCCEEDED / PARTIAL
 *   (บางกลุ่มล้ม) / FAILED (ทุกกลุ่มที่ทำล้ม) / NOTHING_TO_BILL · มี PARTIAL/FAILED = job `succeeded_with_errors`
 *   · DO ที่ไม่ผ่านตอนดึง/ส่งบัญชี (ระบุตัวได้ เช่น หลักฐานไม่ครบ, อยู่ในร่างอื่นแล้ว) ถูกตัดออกแล้วลองใหม่ — รายงานใน `skippedDeliveryOrders`
 * - ร่าง **ไม่มีเลข ไม่ใช่เอกสารภาษี** (D-54) — ผู้ใช้ตรวจแล้วออกเอกสารเอง
 *
 * ST5-T12b (PO ตัดสิน 22 พ.ย. 2569):
 * - **ลูกค้าหนึ่งราย = ใบแจ้งหนี้ใบเดียวต่อรอบ** (MONTHLY/WEEKLY) — เพดาน `MAX_DOS_PER_INVOICE` (1,000) ต่อร่าง; เกิน = แบ่งหลายร่าง + `splitByCap`
 * - **ลูกค้าปิดใช้ (INACTIVE) ไม่เข้ารอบ** (ทั้งร่างใบแจ้งหนี้และร่างใบวางบิล) — สร้างร่างมือไม่เปลี่ยน
 * - **ร่างใบวางบิลอัตโนมัติเฉพาะงวดของรอบ:** ใบแจ้งหนี้ที่ออกแล้วค้างซึ่ง **งวดของใบ** (`periodFrom`–`periodTo`) อยู่ในงวดของรอบทั้งช่วง
 *   (`periodFrom ≥ รอบ.periodFrom` และ `periodTo ≤ รอบ.periodTo`) · ใบที่ไม่มีงวด (ไม่มี DO) ใช้ **วันที่ออก** (`issueDate`) อยู่ในงวดของรอบ
 *   — ใช้งวดของใบเป็นหลักเพราะรอบของงวดเดือน ต.ค. สั่งต้นเดือน พ.ย. ใบจึงออกเลขนอกงวดเสมอ (ดู `noteCandidates`)
 * - **ไฟล์สรุปรอบ .xlsx** (ไม่มี PDF): แถวต่อร่าง/ลูกค้า — ยอดเงินเฉพาะผู้สั่งที่มี `prices.sell:read` · เก็บ/ดาวน์โหลด/แจ้งเตือนด้วยกรอบงานส่งออก
 *   ST9-T10 (`GET /v1/exports/{jobId}` เฉพาะผู้สั่ง, 7 วัน) · ผู้สั่งต้องมี `export:run` (ไม่มี = ไม่สร้างไฟล์ `summary: null`)
 * - ไม่มีรอบอัตโนมัติตามเวลาในเฟส 0 (สั่งเองเท่านั้น)
 */
@Injectable()
export class InvoiceRunService implements OnModuleInit {
  private readonly log = new Logger(InvoiceRunService.name);

  constructor(
    private readonly db: DbService,
    private readonly queue: JobQueue,
    private readonly billingQueue: BillingQueueService,
    private readonly invoices: InvoicesService,
    private readonly notes: BillingNotesService,
    private readonly release: BillingReleaseService,
    private readonly audit: AuditService,
    private readonly exports: ExportsService,
  ) {}

  onModuleInit() {
    // ไฟล์สรุปรอบ: ดาวน์โหลดผ่าน `GET /v1/exports/{jobId}` (เฉพาะผู้สั่ง — กติกาเดียวกับไฟล์ส่งออกอื่น)
    this.exports.registerFileJob(INVOICE_RUN_JOB, {
      describe: (job) => {
        const p = job.payload as unknown as RunPayload | null;
        const r = job.result as unknown as InvoiceRunResultDto | null;
        // จบแล้วไม่มีไฟล์ = 404 · ยังไม่จบ (result ว่าง) = ให้ ExportsService หาไฟล์จากเอกสารของงาน
        if (!p || (r && !r.summary)) return null;
        return {
          actorId: p.actor?.actorId ?? null,
          resource: INVOICE_RUN_SUMMARY_RESOURCE,
          format: 'xlsx',
          filter: {
            billingCycle: p.billingCycle,
            periodFrom: p.periodFrom,
            periodTo: p.periodTo,
          },
          result: r?.summary ?? null,
        };
      },
    });
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
        const out = await requestContext.run(ctx, () => this.run(p, withTx, progress, job.id));
        return new JobOutcome(out, out.failed ? 'SUCCEEDED_WITH_ERRORS' : 'SUCCEEDED');
      },
      // ร่างละ transaction (เปิดเอง ≤ 120 วิ — กลุ่ม ≤ MAX_DOS_PER_INVOICE DO) · progress ต่อกลุ่ม (ต่อ lease) · ล้มแล้วไม่ลองใหม่ · จบ = webhook `job.completed`
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
    jobId: string,
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
        for (const [cid, groups] of this.byIssuer(await this.noteCandidates(tx, p)))
          notes.set(cid, groups);
      const customers = await tx.customer.findMany({
        // ลูกค้าปิดใช้ไม่เข้ารอบ (PO 22 พ.ย. 2569) — ตัวเลือก DO/ใบแจ้งหนี้กรองแล้ว; กรองซ้ำที่นี่เป็นด่านเดียวกันของทั้งรอบ
        where: { id: { in: [...new Set([...dos.keys(), ...notes.keys()])] }, status: 'ACTIVE' },
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
          // เกินเพดาน DO ต่อใบ → แบ่งหลายร่าง (รายงานต่อลูกค้า — ไม่เงียบ)
          splitByCap: p.billingCycle !== 'PER_DO' && ids.length > this.groupSize,
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
    const accs: { acc: CustomerAcc; dto: InvoiceRunCustomerResultDto }[] = [];
    for (const { c, invoiceGroups, noteGroups, splitByCap } of plan) {
      const acc = new CustomerAcc(c.id, splitByCap);
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
          await inTx((tx) => this.noteGroup(tx, c.id, g, p, acc));
        } catch (e) {
          acc.fail(e);
        }
        await tick();
      }
      const dto = acc.toDto(c.code, c.legalName);
      results.push(dto);
      accs.push({ acc, dto });
    }
    // ไฟล์สรุปรอบ (.xlsx) — ล้ม/ไม่มีสิทธิ์ส่งออก ไม่ทำให้รอบล้ม (ร่าง commit แล้ว): `summary: null`
    let summary: InvoiceRunSummaryDto | null = null;
    if (accs.length && scopeAllows(ctx.scopes ?? [], 'export:run'))
      try {
        summary = await inTx((tx) => this.writeSummary(tx, p, jobId, accs));
      } catch (e) {
        this.log.warn(`invoice run summary file failed: ${String(e)}`);
      }
    return {
      billingCycle: p.billingCycle,
      periodFrom: p.periodFrom,
      periodTo: p.periodTo,
      customers: results.length,
      invoicesCreated: results.reduce((a, r) => a + r.invoiceCount, 0),
      billingNotesCreated: results.reduce((a, r) => a + r.billingNotes.length, 0),
      failed: results.filter((r) => r.outcome === 'FAILED' || r.outcome === 'PARTIAL').length,
      maxDeliveryOrdersPerInvoice: this.groupSize,
      summary,
      results,
    };
  }

  /** เพดาน DO ต่อร่าง (= เพดาน `POST /invoices` — `MAX_DOS_PER_INVOICE`) — test ลดได้ */
  groupSize = MAX_DOS_PER_INVOICE;

  /**
   * ไฟล์สรุปรอบ: 1 แถวต่อร่าง (ใบแจ้งหนี้/ใบวางบิล) — ลูกค้าที่ไม่มีร่าง (ไม่สำเร็จ/ไม่มีรายการ) 1 แถว · ไม่ตัดที่ 50 รายการเหมือน `result`
   * คอลัมน์ยอดเงิน (ประมาณการของร่าง — D-54) เฉพาะผู้สั่งที่มี `prices.sell:read` (ตัดคอลัมน์ + `redactPrices` ของกรอบงานส่งออก)
   */
  private async writeSummary(
    tx: Tx,
    p: RunPayload,
    jobId: string,
    accs: { acc: CustomerAcc; dto: InvoiceRunCustomerResultDto }[],
  ): Promise<InvoiceRunSummaryDto> {
    const ctx = requestContext.require();
    const scopes = ctx.scopes ?? [];
    const rows = accs.flatMap(({ acc, dto }) => acc.summaryRows(dto));
    const file = await this.exports.storeJobFile(tx, {
      tenantId: ctx.tenantId!,
      jobId,
      actorId: ctx.actorId ?? null,
      scopes,
      principalType: ctx.principalType ?? 'user',
      columns: dropUnpricedColumns(SUMMARY_COLUMNS, {
        sell: scopeAllows(scopes, 'prices.sell:read'),
        buy: false,
      }),
      rows,
      sheet: 'invoice-run',
      fileName: `${SUMMARY_LABEL}_${p.periodFrom}_${p.periodTo}`,
      label: SUMMARY_LABEL,
    });
    return { ...file, url: `/v1/exports/${encodeId('job', jobId)}` };
  }

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
        acc.addInvoice(out.ok);
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
    p: RunPayload,
    acc: CustomerAcc,
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${RUN_LOCK_NS}::int, hashtext(${customerId}))`;
    const now = new Set((await this.noteCandidates(tx, p, customerId)).map((i) => i.id));
    const ids = group.filter((id) => now.has(id));
    if (!ids.length) return;
    const bn = await this.notes.create({
      customerId: encodeId('customer', customerId),
      invoiceIds: ids.map((id) => encodeId('invoice', id)),
    });
    acc.addBillingNote(bn.id, bn.invoices.length, bn.sellTotal);
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
        [...byKey.values()].flatMap((ids) => chunk(ids, MAX_INVOICES_PER_BILLING_NOTE)),
      ]),
    );
  }

  /**
   * ใบแจ้งหนี้ที่เข้าร่างใบวางบิลของรอบนี้ = เงื่อนไขของ `GET /billing-notes/candidates` (ออกแล้ว ค้างชำระ ไม่อยู่ในใบวางบิลที่ active)
   * **+ อยู่ในงวดของรอบ** (PO 22 พ.ย. 2569 — ไม่ใช่ทุกใบที่ค้าง):
   * - ใบที่มีงวด (`periodFrom`/`periodTo` — ใบที่มี DO มีเสมอ): งวดของใบอยู่ในงวดของรอบ**ทั้งช่วง**
   *   (`periodFrom ≥ รอบ.periodFrom` และ `periodTo ≤ รอบ.periodTo`) — ใบที่งวดคร่อมออกนอกรอบไม่เข้า
   * - ใบที่ไม่มีงวด: `issueDate` (วันที่ออก เวลาไทย) อยู่ใน [รอบ.periodFrom, รอบ.periodTo]
   * ลูกค้าปิดใช้ (INACTIVE) / ลบแล้ว / `billing_cycle` ไม่ตรง ไม่เข้า
   */
  private async noteCandidates(tx: Tx, p: RunPayload, customerId?: string) {
    const from = day(p.periodFrom);
    const to = day(p.periodTo);
    const rows = await tx.invoice.findMany({
      where: {
        ...(customerId ? { customerId } : {}),
        customer: { billingCycle: p.billingCycle, deletedAt: null, status: 'ACTIVE' },
        OR: [
          { periodFrom: { gte: from }, periodTo: { lte: to } },
          {
            OR: [{ periodFrom: null }, { periodTo: null }],
            issueDate: { gte: from, lte: to },
          },
        ],
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

/** แถวของไฟล์สรุปรอบ — field ยอดเงินลงทะเบียน `@PriceField('sell')` (ตัดเมื่อผู้สั่งไม่มี `prices.sell:read`) */
export class InvoiceRunSummaryRow {
  customerCode!: string;
  customerName!: string;
  outcome!: string;
  docType!: 'INVOICE' | 'BILLING_NOTE' | null;
  docId!: string | null;
  url!: string | null;
  deliveryOrderCount!: number | null;
  invoiceCount!: number | null;
  skippedCount!: number;
  failedGroups!: number;
  splitByCap!: boolean;
  problem!: string | null;
  @PriceField('sell') sellSubtotal?: string;
  @PriceField('sell') sellVatAmount?: string;
  @PriceField('sell') sellTotal?: string;
}

const OUTCOME_TH: Record<string, string> = {
  SUCCEEDED: 'สำเร็จ',
  PARTIAL: 'สำเร็จบางส่วน',
  FAILED: 'ไม่สำเร็จ',
  NOTHING_TO_BILL: 'ไม่มีรายการให้สร้าง',
};
const DOC_TH = { INVOICE: 'ร่างใบแจ้งหนี้', BILLING_NOTE: 'ร่างใบวางบิล' } as const;

/** คอลัมน์ไฟล์สรุปรอบ (ยอดเงิน = ประมาณการของร่าง ยังไม่ใช่เอกสารภาษี — D-54) */
const SUMMARY_COLUMNS: ExportColumn<InvoiceRunSummaryRow>[] = [
  { header: 'รหัสลูกค้า', value: (r) => r.customerCode },
  { header: 'ชื่อลูกค้า', value: (r) => r.customerName },
  { header: 'ผลของลูกค้า', value: (r) => OUTCOME_TH[r.outcome] ?? r.outcome },
  { header: 'ประเภทเอกสาร', value: (r) => (r.docType ? DOC_TH[r.docType] : null) },
  { header: 'รหัสร่าง', value: (r) => r.docId },
  { header: 'ลิงก์ร่าง (API)', value: (r) => r.url },
  { header: 'จำนวนใบส่งของ', value: (r) => r.deliveryOrderCount },
  { header: 'จำนวนใบแจ้งหนี้ในใบวางบิล', value: (r) => r.invoiceCount },
  { header: 'ยอดก่อน VAT (ประมาณการ)', value: (r) => r.sellSubtotal, price: 'sell' },
  { header: 'VAT (ประมาณการ)', value: (r) => r.sellVatAmount, price: 'sell' },
  { header: 'ยอดรวม (ประมาณการ)', value: (r) => r.sellTotal, price: 'sell' },
  { header: 'ใบส่งของที่ข้าม (ของลูกค้า)', value: (r) => r.skippedCount },
  { header: 'กลุ่มที่ไม่สำเร็จ (ของลูกค้า)', value: (r) => r.failedGroups },
  { header: 'แบ่งร่างเพราะเกินเพดาน', value: (r) => (r.splitByCap ? 'ใช่' : 'ไม่') },
  { header: 'สาเหตุที่ไม่สำเร็จ', value: (r) => r.problem },
];

/** ร่างที่สร้าง (ครบทุกใบ — สำหรับไฟล์สรุป; `result` ของ job ตัดที่ `RESULT_LIST_CAP` และไม่มียอดเงิน) */
interface CreatedDoc {
  docType: 'INVOICE' | 'BILLING_NOTE';
  id: string;
  url: string;
  deliveryOrderCount: number | null;
  invoiceCount: number | null;
  sellSubtotal: string | null;
  sellVatAmount: string | null;
  sellTotal: string | null;
}

const dec = (v: string | undefined) => new Prisma.Decimal(v ?? 0);

/** สะสมผลต่อลูกค้า */
class CustomerAcc {
  invoices: InvoiceRunDocRefDto[] = [];
  invoiceCount = 0;
  billingNotes: InvoiceRunDocRefDto[] = [];
  skipped: InvoiceRunSkippedDoDto[] = [];
  failedGroups = 0;
  problem: Record<string, unknown> | null = null;
  /** ทุกร่างที่สร้าง + ยอดเงิน — ใช้กับไฟล์สรุปเท่านั้น (ไม่ลง `result` ของ job) */
  private readonly docs: CreatedDoc[] = [];
  constructor(
    readonly customerId: string,
    readonly splitByCap = false,
  ) {}

  addInvoice(inv: InvoiceDto) {
    const url = `/v1/invoices/${inv.id}`;
    const deliveryOrderCount = inv.deliveryOrders.length;
    this.invoiceCount++;
    if (this.invoices.length < RESULT_LIST_CAP)
      this.invoices.push({ id: inv.id, url, deliveryOrderCount });
    this.docs.push({
      docType: 'INVOICE',
      id: inv.id,
      url,
      deliveryOrderCount,
      invoiceCount: null,
      sellSubtotal: dec(inv.sellSubtotalExempt)
        .add(dec(inv.sellSubtotalVatable))
        .add(dec(inv.sellSubtotalZeroRated))
        .toFixed(2),
      sellVatAmount: dec(inv.sellVatAmount).toFixed(2),
      sellTotal: dec(inv.sellTotal).toFixed(2),
    });
  }

  addBillingNote(id: string, invoiceCount: number, sellTotal: string | undefined) {
    const url = `/v1/billing-notes/${id}`;
    this.billingNotes.push({ id, url, invoiceCount });
    this.docs.push({
      docType: 'BILLING_NOTE',
      id,
      url,
      deliveryOrderCount: null,
      invoiceCount,
      sellSubtotal: null,
      sellVatAmount: null,
      sellTotal: sellTotal === undefined ? null : dec(sellTotal).toFixed(2),
    });
  }

  fail(e: unknown) {
    this.failedGroups++;
    this.problem ??= problemBody(e);
  }

  /** แถวของไฟล์สรุป: 1 แถวต่อร่าง · ไม่มีร่าง = 1 แถวของลูกค้า */
  summaryRows(dto: InvoiceRunCustomerResultDto): InvoiceRunSummaryRow[] {
    const base = {
      customerCode: dto.customerCode,
      customerName: dto.customerName,
      outcome: dto.outcome,
      skippedCount: dto.skippedCount,
      failedGroups: dto.failedGroups,
      splitByCap: dto.splitByCap,
      problem: this.problem
        ? [this.problem.code, this.problem.title].filter(Boolean).join(' — ') || null
        : null,
    };
    if (!this.docs.length)
      return [
        {
          ...base,
          docType: null,
          docId: null,
          url: null,
          deliveryOrderCount: null,
          invoiceCount: null,
        },
      ];
    return this.docs.map((d) => ({
      ...base,
      docType: d.docType,
      docId: d.id,
      url: d.url,
      deliveryOrderCount: d.deliveryOrderCount,
      invoiceCount: d.invoiceCount,
      ...(d.sellSubtotal === null ? {} : { sellSubtotal: d.sellSubtotal }),
      ...(d.sellVatAmount === null ? {} : { sellVatAmount: d.sellVatAmount }),
      ...(d.sellTotal === null ? {} : { sellTotal: d.sellTotal }),
    }));
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
      splitByCap: this.splitByCap,
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
