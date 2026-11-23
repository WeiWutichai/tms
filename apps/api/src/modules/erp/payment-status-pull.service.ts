import { randomUUID } from 'node:crypto';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { type Connector, Prisma, type ReconcileSource } from '@prisma/client';
import { PAYABLE_INVOICE_STATUSES } from '@tms/domain';
import { AuditService } from '../../audit/audit.service';
import { Clock } from '../../common/clock';
import { tryDecodeId } from '../../common/ids';
import { type RequestContext, requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { PrismaService } from '../../db/prisma.service';
import { JobQueue } from '../../jobs/job-queue.service';
import { EntitlementService } from '../entitlements/entitlement.service';
import { NotificationEvents } from '../notifications/notification-events';
import { PaymentsService } from '../payments/payments.service';
import { bangkokToday } from '../vehicle-documents/expiry';
import { ConnectorResolver } from './connector-resolver';
import { ConnectorsService, redactSecrets } from './connectors.service';
import {
  type ErpAdapter,
  type ErpContext,
  type PaymentStatus,
  readyCapabilities,
} from './erp-adapter';
import { ErpAdapterRegistry } from './erp-adapter.registry';
import { MAP_ENTITY } from './erp-sync.service';
import {
  type PaymentMismatchCode,
  pullPaymentKeyPrefix,
  RECONCILE_CHECK_PAYMENT_STATUS,
  ReconcileResultsService,
} from './reconcile-results.service';

export const PAYMENT_STATUS_PULL_JOB = 'connector.payment_status';
const CAPABILITY = 'fetchPaymentStatus';
/** docs/01 §6.1 `fetchPaymentStatus` "scheduler รายวัน" — เริ่มตั้งแต่ 06:00 เวลาไทย (ก่อนสรุปรายวัน 08:00) [DECISION spec/12 §3 ST7-T21] */
export const PAYMENT_PULL_FROM_HOUR_BKK = 6;
/** worker ตรวจว่าถึงรอบหรือยังทุก 10 นาที (แบบเดียวกับ job รายวันตัวอื่น) */
export const PAYMENT_PULL_CHECK_EVERY_MS = 10 * 60_000;
const PAGE = 200;
/** เพดานใบต่อรอบ (ที่เหลือรอบถัดไป — ผลรอบมี `truncated`) */
const MAX_PER_RUN = 5000;
/** เรียกระบบบัญชีไม่สำเร็จ (ปลายทางล่ม/credential ผิด) ติดกันเท่านี้ = หยุดรอบ → job ลองใหม่ · คำตอบผิดรูปรายใบไม่นับ */
const MAX_CONSECUTIVE_ERRORS = 3;
const MONEY_RE = /^\d{1,12}\.\d{2}$/;
const STATUSES = ['UNPAID', 'PARTIALLY_PAID', 'PAID'] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** heartbeat ของ job (ต่อ lease) ทุกกี่ใบ */
const PROGRESS_EVERY = 1; // review รอบสอง: heartbeat ทุกใบ (ERP ช้า > 12 วิ/ใบ ไม่ให้ lease หลุด)
export const pullPaymentKey = (invoiceId: string, cumulative: string) =>
  `${pullPaymentKeyPrefix(invoiceId)}${cumulative}`;

const ZERO = new Prisma.Decimal(0);
const money = (d: Prisma.Decimal) => d.toFixed(2);

export type PaymentPullSkip =
  | 'feature_off'
  | 'sandbox'
  | 'connector_not_active'
  | 'adapter_unavailable'
  | 'capability_not_enabled';

export interface PaymentPullCounts {
  /** ใบที่ถามระบบบัญชี */
  checked: number;
  /** ยอดตรงกัน (ไม่มีอะไรเปลี่ยน) */
  matched: number;
  /** สร้าง payment (source CONNECTOR) */
  created: number;
  /** ส่วนต่าง → MISMATCH (รวมที่เคยแจ้งแล้ว) */
  mismatched: number;
  /** MISMATCH ที่เพิ่งพบรอบนี้ */
  newMismatches: number;
  /** ระบบบัญชีไม่มีเอกสารนี้ */
  notFound: number;
  /** ใบเปลี่ยนสถานะระหว่างรอบ (ยกเลิกไปแล้ว) */
  skipped: number;
  /** ระบบบัญชีตอบผิดรูป/ขัดกันเองของใบนั้น (ไม่แตะเงิน ทำใบถัดไปต่อ) */
  invalid: number;
  /** เรียกระบบบัญชีไม่สำเร็จ / กระทบยอดล้ม */
  errors: number;
}

export interface PaymentPullResult {
  connector: string;
  connectorId: string;
  source: ReconcileSource;
  skipped?: PaymentPullSkip;
  counts: PaymentPullCounts;
  /** เกินเพดานต่อรอบ — ที่เหลือรอบถัดไป (เริ่มจากใบที่ถามนานสุด) */
  truncated: boolean;
  /** หยุดรอบเพราะเรียกระบบบัญชีไม่สำเร็จติดกัน (ข้อความตัด credential แล้ว) */
  sourceError?: string;
}

interface Candidate {
  mapping_id: string;
  invoice_id: string;
  invoice_no: string | null;
  external_id: string;
  external_doc_no: string | null;
}

type Outcome = 'matched' | 'created' | 'mismatched' | 'newMismatch' | 'skipped' | 'invalid';

const emptyCounts = (): PaymentPullCounts => ({
  checked: 0,
  matched: 0,
  created: 0,
  mismatched: 0,
  newMismatches: 0,
  notFound: 0,
  skipped: 0,
  invalid: 0,
  errors: 0,
});

/** คำตอบของ adapter ผิดรูป (ไม่ใช่ปลายทางล่ม) */
class InvalidAnswer extends Error {}

/**
 * Payment status pull (ST7-T21; docs/04 G3 "Payment status pull", F5 "Payment status จาก ERP"; docs/01 §6.1 `fetchPaymentStatus`)
 * **ไม่ผูก ERP ใด** — ทำงานเฉพาะ connector ที่ adapter ประกาศและ tenant **เปิดเอง** capability `fetchPaymentStatus`
 * (opt-in: ไม่เปิดเป็นค่าเริ่มต้น เปิดต้องมีเหตุผล — ConnectorsService) · Standalone / adapter ที่ไม่มี capability นี้ / ยังไม่เปิด
 * = ไม่มีรอบดึง → รับชำระบันทึกมือใน TMS (docs/01 §6.1 ตาราง fallback)
 *
 * รอบดึง (job `connector.payment_status` ต่อ connector — รายวันตั้งแต่ 06:00 เวลาไทย หรือสั่งเอง `POST /v1/reconcile-runs`;
 * มี job ที่ยังไม่จบของ connector เดียวกันได้ครั้งละ 1 — advisory lock ต่อ connector ตอนสร้าง job → รอบรายวันกับรอบสั่งเองไม่ซ้อนกัน):
 * 1. ใบแจ้งหนี้ที่ส่งถึงระบบบัญชีแล้ว (`external_mapping` INVOICE ของ connector นี้ มี external_id, ไม่ถูกยกเลิกฝั่งบัญชี)
 *    และยังค้างชำระใน TMS (ISSUED / PARTIALLY_PAID — หรือ PAID ที่ยังมี MISMATCH ค้าง เพื่อปิดเมื่อยอดตรง)
 *    และ `issue_date` ≥ `connector.sync_from_date` (ถ้าตั้ง) — เรียงจากใบที่ถามนานสุด (`payment_checked_at`) เกินเพดานต่อรอบ = รอบถัดไปทำต่อ
 * 2. ถาม `adapter.fetchPaymentStatus` (นอก transaction) → **ยอดตัดหนี้สะสม**ของใบฝั่งระบบบัญชี
 * 3. ล็อกใบ (FOR UPDATE) แล้วกระทบยอดกับ `invoice.paid_amount`:
 *    - เท่ากัน = ตรง (รับชำระที่คนบันทึกเองแล้วยอดตรง = ไม่สร้างซ้ำ) → ปิด MISMATCH ที่ค้าง
 *    - ระบบบัญชีมากกว่า **และ** ใบไม่มีรับชำระจากช่องทางอื่น **และ** ไม่เคยมีรายการที่รอบดึงสร้างแล้วถูกกลับรายการ **และ**
 *      ระบบบัญชีบอก WHT + วันที่รับที่เป็นไปได้ → สร้าง `payment` source CONNECTOR เท่าส่วนต่าง ผ่าน
 *      `PaymentsService.recordFromConnector` (ทางเดียวกับ ST8-T16: เลข PAY, audit, event `payment.recorded`, สถานะใบ ST5-T18)
 *      + `external_mapping` PAYMENT (`paystatus:{ใบ}:{ยอดสะสม}`)
 *    - นอกนั้น = **MISMATCH** (`reconcile_result` severity MONEY) — ไม่ปรับ/ไม่กลับรายการ/ไม่เดาตัวเลขเงินใน TMS เอง
 * รันซ้ำ = ไม่มีอะไรเปลี่ยน (เทียบยอดสะสมใต้ล็อกใบ + diff_hash) · sandbox ไม่ดึง · ผู้กระทำ = `connector:{adapterKey}`
 */
@Injectable()
export class PaymentStatusPullService implements OnModuleInit {
  private readonly logger = new Logger('PaymentStatusPull');

  constructor(
    private readonly prisma: PrismaService,
    private readonly db: DbService,
    private readonly queue: JobQueue,
    private readonly adapters: ErpAdapterRegistry,
    private readonly entitlements: EntitlementService,
    private readonly connectors: ConnectorsService,
    private readonly resolver: ConnectorResolver,
    private readonly payments: PaymentsService,
    private readonly reconcile: ReconcileResultsService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly events: NotificationEvents,
  ) {}

  onModuleInit() {
    this.queue.register(
      PAYMENT_STATUS_PULL_JOB,
      async ({ tenantId, job, progress }) => {
        const p = (job.payload ?? {}) as { connectorId?: unknown; source?: unknown };
        if (typeof p.connectorId !== 'string' || !UUID_RE.test(p.connectorId))
          throw new Error('connector.payment_status: invalid connector id');
        if (!(await this.tenantLive(tenantId))) return { skipped: 'tenant_inactive' };
        const r = await this.pullConnector(tenantId, p.connectorId, {
          source: p.source === 'MANUAL' ? 'MANUAL' : 'NIGHTLY',
          requestId: `job:${job.id}`,
          // heartbeat: ต่อ lease ของ job ระหว่างรอบยาว (ไม่ให้ worker อื่นหยิบซ้ำ)
          onProgress: (pct) => progress(pct),
        });
        // ระบบบัญชีล่ม/credential ผิด → ให้ JobQueue ลองใหม่ (ใบที่ยังไม่ถูกถามอยู่หัวแถวของรอบถัดไป)
        if (r.sourceError)
          throw new Error(`connector ${r.connector}: payment status failed — ${r.sourceError}`);
        return r;
      },
      { outsideTransaction: true },
    );
  }

  // ---------- ตั้งรอบ ----------

  private pullable(row: { adapterKey: string }): boolean {
    const a = this.adapters.get(row.adapterKey);
    return (
      !!a && readyCapabilities(a).has(CAPABILITY) && typeof a.fetchPaymentStatus === 'function'
    );
  }

  /** ล็อกต่อ connector (จนจบ transaction) แล้วบอกว่ามี job ของ connector นี้ที่ยังไม่จบไหม — ใช้ทั้งรอบรายวันและรอบสั่งเอง */
  private async hasOpenJob(db: Tx, tenantId: string, connectorId: string): Promise<boolean> {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(8, hashtext(${`${PAYMENT_STATUS_PULL_JOB}:${connectorId}`}))`;
    const open = await db.job.findFirst({
      where: {
        tenantId,
        type: PAYMENT_STATUS_PULL_JOB,
        status: { in: ['PENDING', 'RUNNING'] },
        payload: { path: ['connectorId'], equals: connectorId },
      },
      select: { id: true },
    });
    return !!open;
  }

  /**
   * สร้าง job ของวันนี้ (เวลาไทย) ให้ connector ที่ ACTIVE + tenant เปิด `fetchPaymentStatus` + adapter ที่ติดตั้งรองรับ +
   * tenant TRIAL/ACTIVE โหมด live + แพ็กเกจมี `conn` — 1 job ต่อ connector ต่อวัน (เรียกซ้ำได้ · advisory lock กันสอง worker)
   * connector ที่ยังมีรอบค้าง (เช่น รอบสั่งเอง) ข้ามไปก่อน — ตรวจใหม่ในอีก 10 นาที (ไม่ซ้อนกัน)
   * ไม่มี connector แบบนี้ = ไม่สร้างอะไร (Standalone / ERP ที่ไม่มี capability นี้ / ยังไม่เปิด)
   */
  async scheduleDue(now: Date = this.clock.now()): Promise<number> {
    const bkk = new Date(now.getTime() + 7 * 3600_000);
    if (bkk.getUTCHours() < PAYMENT_PULL_FROM_HOUR_BKK) return 0;
    const today = bangkokToday(now);
    return this.prisma.platform.$transaction(async (db) => {
      await db.$executeRaw`SELECT pg_advisory_xact_lock(8, hashtext(${PAYMENT_STATUS_PULL_JOB}))`;
      const rows = (
        await db.connector.findMany({
          where: { status: 'ACTIVE', capabilitiesEnabled: { has: CAPABILITY } },
          select: { id: true, tenantId: true, adapterKey: true },
          orderBy: { createdAt: 'asc' },
        })
      ).filter((r) => this.pullable(r));
      if (!rows.length) return 0;
      const tenantIds = [...new Set(rows.map((r) => r.tenantId))];
      const live = new Set(
        (
          await db.tenant.findMany({
            where: { id: { in: tenantIds }, status: { in: ['TRIAL', 'ACTIVE'] }, mode: 'live' },
            select: { id: true },
          })
        ).map((t) => t.id),
      );
      const allowed = new Set(
        await this.entitlements.tenantsWith(
          'conn',
          tenantIds.filter((t) => live.has(t)),
        ),
      );
      const existing = await db.job.findMany({
        where: {
          tenantId: { in: [...allowed] },
          type: PAYMENT_STATUS_PULL_JOB,
          createdAt: { gte: new Date(now.getTime() - 3 * 86_400_000) },
          payload: { path: ['day'], equals: today },
        },
        select: { payload: true },
      });
      const done = new Set(
        existing
          .map((j) => (j.payload as { connectorId?: unknown } | null)?.connectorId)
          .filter((v): v is string => typeof v === 'string'),
      );
      let n = 0;
      for (const r of rows) {
        if (!allowed.has(r.tenantId) || done.has(r.id)) continue;
        if (await this.hasOpenJob(db as unknown as Tx, r.tenantId, r.id)) continue;
        await this.queue.enqueue(db as unknown as Tx, {
          tenantId: r.tenantId,
          type: PAYMENT_STATUS_PULL_JOB,
          payload: { connectorId: r.id, day: today, source: 'NIGHTLY' },
        });
        n += 1;
      }
      return n;
    });
  }

  /**
   * สั่งรอบดึงเอง (`POST /v1/reconcile-runs`) — transaction ของคำขอ · connector ต้องดึงได้จริงตอนนี้ (ไม่ได้ = 409 จากผู้เรียก)
   * มีรอบของ connector นี้รอ/กำลังทำอยู่ = ไม่สร้างซ้ำ
   */
  async enqueueManual(
    tx: Tx,
    tenantId: string,
    connectorId: string,
  ): Promise<'QUEUED' | 'ALREADY_QUEUED'> {
    if (await this.hasOpenJob(tx, tenantId, connectorId)) return 'ALREADY_QUEUED';
    await this.queue.enqueue(tx, {
      tenantId,
      type: PAYMENT_STATUS_PULL_JOB,
      payload: { connectorId, source: 'MANUAL' },
    });
    return 'QUEUED';
  }

  /** เหตุที่ connector นี้ดึงสถานะรับชำระไม่ได้ตอนนี้ (null = ดึงได้) — ใช้ทั้งรอบดึงและตอนสั่งเอง */
  async whyNot(tenantId: string, row: Connector): Promise<PaymentPullSkip | null> {
    const t = await this.prisma.platform.tenant.findUnique({
      where: { id: tenantId },
      select: { mode: true },
    });
    // ST7-T09 sandbox ไม่ติดต่อระบบบัญชี (connector สร้างใน sandbox ไม่ได้อยู่แล้ว — กันชั้นที่ 2)
    if (t?.mode !== 'live') return 'sandbox';
    if (!(await this.entitlements.enabled(tenantId, 'conn'))) return 'feature_off';
    if (row.status !== 'ACTIVE') return 'connector_not_active';
    const r = this.resolver.describe(row);
    if (!r.adapter || !this.adapters.get(row.adapterKey)) return 'adapter_unavailable';
    if (!r.capabilities.includes(CAPABILITY) || typeof r.adapter.fetchPaymentStatus !== 'function')
      return 'capability_not_enabled';
    return null;
  }

  private async tenantLive(tenantId: string): Promise<boolean> {
    const t = await this.prisma.platform.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true },
    });
    return t?.status === 'TRIAL' || t?.status === 'ACTIVE';
  }

  // ---------- รอบดึง ----------

  async pullConnector(
    tenantId: string,
    connectorId: string,
    opts: {
      source?: ReconcileSource;
      requestId?: string;
      maxInvoices?: number;
      onProgress?: (pct: number) => Promise<void>;
    } = {},
  ): Promise<PaymentPullResult> {
    const source = opts.source ?? 'NIGHTLY';
    const row = await this.db.withTenant(tenantId, (tx) =>
      tx.connector.findUnique({ where: { id: connectorId } }),
    );
    if (!row) throw new Error(`connector ${connectorId} not found`);
    const out: PaymentPullResult = {
      connector: row.adapterKey,
      connectorId,
      source,
      counts: emptyCounts(),
      truncated: false,
    };
    const skip = await this.whyNot(tenantId, row);
    if (skip) return { ...out, skipped: skip };
    const adapter = this.adapters.get(row.adapterKey)!;
    const ctx = this.connectors.contextOf(row);
    const secrets = row.credentialKeys.map((k) => ctx.config[k] ?? '');
    const requestId = opts.requestId ?? `payment-status:${row.adapterKey}:${randomUUID()}`;
    const max = Math.min(opts.maxInvoices ?? MAX_PER_RUN, MAX_PER_RUN);
    const runAt = this.clock.now();
    // เวลาเริ่มรอบตามนาฬิกาฐานข้อมูล — ใบที่ถามแล้วในรอบนี้ (`payment_checked_at` ≥ ค่านี้) ไม่ถูกหยิบซ้ำ
    const started = (await this.prisma.platform.$queryRaw<{ now: Date }[]>`SELECT now() AS now`)[0]!
      .now;
    const beat = async (pct: number) => {
      if (opts.onProgress)
        await opts.onProgress(Math.max(0, Math.min(99, Math.floor(pct)))).catch(() => undefined);
    };
    let consecutive = 0;
    /** เลขใบที่พบส่วนต่างใหม่ในรอบนี้ (ตัวอย่างในแจ้งเตือน — D68-61) */
    const newMismatchNos: string[] = [];
    paging: for (;;) {
      await beat((out.counts.checked / max) * 100);
      const page = await this.db.withTenant(tenantId, (tx) => this.candidates(tx, row, started));
      if (!page.length) break;
      for (const c of page) {
        if (out.counts.checked >= max) {
          out.truncated = true;
          break paging;
        }
        out.counts.checked += 1;
        if (out.counts.checked % PROGRESS_EVERY === 0) await beat((out.counts.checked / max) * 100);
        // ถามแล้ว (สำเร็จหรือไม่) → ไปท้ายแถว — ใบที่ยังไม่ถูกถามอยู่หัวแถวของรอบถัดไป (ท้ายแถวไม่อด)
        await this.db.withTenant(
          tenantId,
          (tx) =>
            tx.$executeRaw`UPDATE external_mapping SET payment_checked_at = now() WHERE id = ${c.mapping_id}::uuid`,
        );
        let raw: PaymentStatus | null;
        try {
          raw = await adapter.fetchPaymentStatus!(ctx, {
            entityType: 'invoice',
            localId: c.invoice_id,
            number: c.invoice_no ?? '',
            externalId: c.external_id,
          });
        } catch (e) {
          // เรียกไม่สำเร็จ (ปลายทางล่ม / credential ผิด) — ติดกันหลายใบ = หยุดรอบ
          out.counts.errors += 1;
          consecutive += 1;
          const msg = redactSecrets(e instanceof Error ? e.message : String(e), secrets).slice(
            0,
            300,
          );
          this.logger.warn(
            `tenant ${tenantId} connector ${row.adapterKey}: ${c.invoice_no}: ${msg}`,
          );
          if (consecutive >= MAX_CONSECUTIVE_ERRORS) {
            out.sourceError = msg;
            break paging;
          }
          continue;
        }
        consecutive = 0;
        if (raw === null || raw === undefined) {
          // เอกสารหายฝั่งระบบบัญชี = เรื่องของ reconcile เอกสาร (REMOTE_MISSING — ST8-T11) ไม่แตะรับชำระ
          out.counts.notFound += 1;
          continue;
        }
        try {
          const st = this.validate(raw);
          const o = await this.reconcileOne(tenantId, row, c, st, { source, runAt, requestId });
          if (o === 'newMismatch') {
            out.counts.mismatched += 1;
            out.counts.newMismatches += 1;
            if (newMismatchNos.length < 5) newMismatchNos.push(c.invoice_no ?? '-');
          } else out.counts[o] += 1;
        } catch (e) {
          if (e instanceof InvalidAnswer) {
            // คำตอบผิดรูปของใบนี้ — บันทึกแล้วทำใบถัดไป (ไม่นับเป็นปลายทางล่ม)
            out.counts.invalid += 1;
            this.logger.warn(
              `tenant ${tenantId} connector ${row.adapterKey}: ${c.invoice_no}: ${e.message}`,
            );
            continue;
          }
          out.counts.errors += 1;
          this.logger.error(
            `tenant ${tenantId} connector ${row.adapterKey}: reconcile ${c.invoice_no} failed`,
            e instanceof Error ? e.stack : String(e),
          );
        }
      }
      if (page.length < PAGE) break;
    }
    // สรุปรอบลง audit เฉพาะรอบที่มีอะไรเกิดขึ้น (ไม่ลงทุกวันเมื่อทุกใบตรง)
    const c = out.counts;
    if (c.created || c.newMismatches || c.errors || c.invalid || out.sourceError)
      await this.db
        .withTenant(tenantId, (tx) =>
          requestContext.run(this.actor(tenantId, row, requestId, tx), () =>
            this.audit.record({
              action: 'connector.payment_status_pulled',
              entityType: 'connector',
              entityId: row.id,
              after: {
                source,
                counts: c,
                truncated: out.truncated,
                ...(out.sourceError ? { sourceError: out.sourceError } : {}),
              },
            }),
          ),
        )
        .catch((e) => this.logger.error(e));
    // D-81 · D68-61 ส่วนต่างใหม่ (severity MONEY) → แจ้งหัวหน้าบัญชีทันที 1 ฉบับต่อรอบ (docs/01 §6.5) — แจ้งไม่สำเร็จไม่กระทบผลรอบ
    if (c.newMismatches)
      await this.db
        .withTenant(tenantId, (tx) =>
          this.events.reconcileMismatch(tx, {
            tenantId,
            connectorId: row.id,
            label: row.adapterKey,
            count: c.newMismatches,
            invoiceNos: newMismatchNos,
          }),
        )
        .catch((e) => this.logger.error(e));
    return out;
  }

  private actor(tenantId: string, row: Connector, requestId: string, tx: Tx): RequestContext {
    return {
      requestId,
      tenantId,
      // ผู้กระทำระบบ — audit / event `payment.recorded` ชี้ว่ามาจาก connector ไหน
      actorId: `connector:${row.adapterKey}`,
      principalType: 'connector',
      scopes: [],
      locale: 'th',
      tx,
    };
  }

  /** ใบที่ต้องถามและยังไม่ถูกถามในรอบนี้ — ใบที่ไม่เคยถาม/ถามนานสุดก่อน */
  private candidates(tx: Tx, c: Connector, started: Date): Promise<Candidate[]> {
    return tx.$queryRaw<Candidate[]>`
      SELECT m.id AS mapping_id, i.id AS invoice_id, i.invoice_no, m.external_id, m.external_doc_no
        FROM external_mapping m
        JOIN invoice i ON i.id = m.local_id
       WHERE m.connector_id = ${c.id}::uuid
         AND m.entity_type = ${MAP_ENTITY.invoice}::"ExternalEntityType"
         AND m.external_id IS NOT NULL
         AND m.status IN ('SYNCED', 'MISMATCH')
         AND coalesce(m.external_status, '') <> 'VOIDED'
         AND (i.status::text = ANY(${[...PAYABLE_INVOICE_STATUSES]}::text[])
              OR (i.status = 'PAID' AND EXISTS (
                    SELECT 1 FROM reconcile_result r
                     WHERE r.connector_id = m.connector_id AND r.entity_type = m.entity_type
                       AND r.local_id = i.id AND r.resolved_at IS NULL
                       AND r.diff->>'check' = ${RECONCILE_CHECK_PAYMENT_STATUS})))
         AND (${c.syncFromDate}::date IS NULL OR i.issue_date >= ${c.syncFromDate}::date)
         AND (m.payment_checked_at IS NULL OR m.payment_checked_at < ${started})
       ORDER BY m.payment_checked_at ASC NULLS FIRST, m.id
       LIMIT ${PAGE}`;
  }

  /** ตรวจรูปคำตอบของ adapter (ผิดรูป = InvalidAnswer — ไม่แตะเงิน) */
  private validate(st: PaymentStatus): PaymentStatus {
    const bad = (why: string) => new InvalidAnswer(`invalid payment status from adapter: ${why}`);
    if (typeof st !== 'object') throw bad('shape');
    if (!(STATUSES as readonly string[]).includes(st.status)) throw bad('status');
    if (typeof st.paidAmount !== 'string' || !MONEY_RE.test(st.paidAmount)) throw bad('paidAmount');
    if (
      st.whtAmount !== undefined &&
      (typeof st.whtAmount !== 'string' || !MONEY_RE.test(st.whtAmount))
    )
      throw bad('whtAmount');
    if (
      st.paidAt !== null &&
      (typeof st.paidAt !== 'string' || Number.isNaN(Date.parse(st.paidAt)))
    )
      throw bad('paidAt');
    const paid = new Prisma.Decimal(st.paidAmount);
    if ((st.status === 'UNPAID') !== paid.isZero()) throw bad('status does not match paidAmount');
    if (st.whtAmount !== undefined && new Prisma.Decimal(st.whtAmount).greaterThan(paid))
      throw bad('whtAmount > paidAmount');
    return st;
  }

  /** กระทบยอด 1 ใบใน transaction ของ tenant (ล็อกใบ) */
  private reconcileOne(
    tenantId: string,
    row: Connector,
    c: Candidate,
    st: PaymentStatus,
    run: { source: ReconcileSource; runAt: Date; requestId: string },
  ): Promise<Outcome> {
    return this.db.withTenant(tenantId, (tx) =>
      requestContext.run(this.actor(tenantId, row, run.requestId, tx), async () => {
        await tx.$queryRaw`SELECT id FROM invoice WHERE id = ${c.invoice_id}::uuid FOR UPDATE`;
        const inv = await tx.invoice.findUnique({
          where: { id: c.invoice_id },
          select: {
            id: true,
            invoiceNo: true,
            status: true,
            totalAmount: true,
            paidAmount: true,
            issueDate: true,
          },
        });
        // ระหว่างรอบ ใบถูกยกเลิก/ปรับยอดไปแล้ว → ไม่อยู่ในขอบเขต (docs/01 §6.1: เฉพาะใบที่ยังค้าง)
        // ใบที่ชำระครบแล้ว (PAID) ยังเทียบต่อ — เข้ามาเฉพาะเมื่อมี MISMATCH ค้าง (เพื่อปิดเมื่อยอดตรง) หรือเพิ่งครบระหว่างรอบ
        if (
          !inv ||
          !(
            inv.status === 'PAID' ||
            (PAYABLE_INVOICE_STATUSES as readonly string[]).includes(inv.status)
          )
        )
          return 'skipped';
        const remote = new Prisma.Decimal(st.paidAmount);
        const local = inv.paidAmount;
        const total = inv.totalAmount;
        // "บางส่วน" แต่ยอดตัดหนี้ = ยอดใบ → คำตอบขัดกันเอง (ไม่เดาว่าครบหรือไม่)
        if (st.status === 'PARTIALLY_PAID' && remote.equals(total))
          throw new InvalidAnswer(
            'invalid payment status from adapter: PARTIALLY_PAID with paidAmount equal to the invoice total',
          );

        // รับชำระทุกรายการที่รอบดึงของ connector นี้เคยสร้างให้ใบนี้ (รวมที่ถูกกลับรายการแล้ว)
        const pullMaps = await tx.externalMapping.findMany({
          where: {
            connectorId: row.id,
            entityType: MAP_ENTITY.payment,
            externalId: { startsWith: pullPaymentKeyPrefix(inv.id) },
          },
          select: { localId: true },
        });
        const pullIds = pullMaps.map((m) => m.localId);
        const pullPayments = pullIds.length
          ? await tx.payment.findMany({
              where: { id: { in: pullIds } },
              select: { id: true, status: true },
            })
          : [];
        const pulled = new Set(pullIds);
        // เคยมีรายการที่ระบบสร้างแล้วคนกลับรายการ = คนตัดสินแล้วว่ายอดจากระบบบัญชีของใบนี้เชื่อไม่ได้ → ไม่สร้างอัตโนมัติให้ใบนี้อีกเลย
        const anyReversed = pullPayments.some((p) => p.status !== 'RECORDED');
        // รับชำระที่ยังไม่กลับรายการของใบนี้ แยก "ที่รอบดึงสร้าง" กับ "ช่องทางอื่น" (คนบันทึกเอง / webhook / connector อื่น)
        const allocs = await tx.paymentAllocation.findMany({
          where: { invoiceId: inv.id, payment: { status: 'RECORDED' } },
          select: { paymentId: true, amount: true, whtAmount: true },
        });
        let otherPaid = ZERO;
        let pulledWht = ZERO;
        for (const a of allocs) {
          if (pulled.has(a.paymentId)) pulledWht = pulledWht.add(a.whtAmount);
          else otherPaid = otherPaid.add(a.amount);
        }

        const mismatch = async (
          code: PaymentMismatchCode,
          reason?: string | null,
        ): Promise<Outcome> => {
          const r = await this.reconcile.recordPaymentMismatch(tx, tenantId, {
            connectorId: row.id,
            adapterKey: row.adapterKey,
            invoiceId: inv.id,
            invoiceNo: inv.invoiceNo,
            source: run.source,
            runAt: run.runAt,
            code,
            localPaid: money(local),
            remotePaid: money(remote),
            reason,
            local: {
              invoiceNo: inv.invoiceNo,
              status: inv.status,
              totalAmount: money(total),
              paidAmount: money(local),
              paidByOtherChannels: money(otherPaid),
            },
            remote: {
              status: st.status,
              paidAmount: st.paidAmount,
              whtAmount: st.whtAmount ?? null,
              paidAt: st.paidAt,
              externalId: c.external_id,
              externalDocNo: c.external_doc_no,
            },
          });
          return r.created ? 'newMismatch' : 'mismatched';
        };

        if (remote.greaterThan(total)) return mismatch('remote_exceeds_total');
        // ระบบบัญชีว่า "ครบ" แต่ยอดตัดหนี้ไม่ถึงยอดใบ — ไม่เดาว่าส่วนที่ขาดคือ WHT/ส่วนลด [OPEN spec/12 §3]
        if (st.status === 'PAID' && remote.lessThan(total))
          return mismatch('remote_paid_amount_short');
        if (remote.equals(local)) {
          await this.reconcile.resolvePaymentMismatches(tx, row.id, inv.id, run.runAt);
          return 'matched';
        }
        if (remote.lessThan(local)) return mismatch('remote_less_than_tms');
        // ---- ระบบบัญชีมากกว่า TMS: สร้างรับชำระให้เฉพาะเมื่อไม่ต้องเดาอะไรเลย ----
        if (otherPaid.greaterThan(0)) return mismatch('tms_has_other_payments');
        if (anyReversed) return mismatch('connector_payment_reversed');
        // ไม่บอก WHT = ไม่รู้ว่าเงินเข้าจริงเท่าไร → ไม่ยืนยันตัวเลขเงินสดแทนระบบบัญชี [OPEN spec/12 §3]
        if (st.whtAmount === undefined) return mismatch('remote_wht_unknown');
        const delta = remote.sub(local);
        const wht = new Prisma.Decimal(st.whtAmount).sub(pulledWht);
        if (wht.lessThan(0) || wht.greaterThan(delta)) return mismatch('remote_wht_inconsistent');
        // วันที่รับ = วันที่ระบบบัญชีแจ้ง (เวลาไทย) — ไม่แจ้ง / อนาคต / ก่อนวันออกใบ = ไม่ปัดเอง
        const today = bangkokToday(run.runAt);
        const paidDay = st.paidAt ? bangkokToday(new Date(st.paidAt)) : null;
        const issued = inv.issueDate?.toISOString().slice(0, 10) ?? null;
        if (!paidDay || paidDay > today || (issued !== null && paidDay < issued))
          return mismatch('remote_paid_at_invalid');
        const ref = c.external_doc_no ?? c.external_id;
        const r = await this.payments.recordFromConnector(tx, {
          receivedDate: paidDay,
          reference: ref,
          note: `${row.adapterKey}: ${ref} (${st.status})`,
          allocations: [{ invoiceId: inv.id, amount: delta, whtAmount: wht }],
        });
        // เหตุผล = รหัสเท่านั้น (ข้อความของกฎรับชำระมียอดเงิน — ยอดอยู่ในช่องที่กันด้วยสิทธิ์ราคา)
        if (!r.ok) return mismatch('payment_rejected', r.code);
        await tx.externalMapping.create({
          data: {
            tenantId,
            connectorId: row.id,
            entityType: MAP_ENTITY.payment,
            localId: tryDecodeId('payment', r.payment.id)!,
            localNumber: r.payment.paymentNo,
            externalId: pullPaymentKey(inv.id, money(remote)),
            externalDocNo: c.external_doc_no?.slice(0, 100) ?? null,
            externalStatus: 'POSTED',
            status: 'SYNCED',
            lastSyncedAt: run.runAt,
            detail: {
              via: 'payment_status_pull',
              remoteStatus: st.status,
              remotePaidAt: st.paidAt,
            },
            createdBy: `connector:${row.adapterKey}`,
          },
        });
        await this.reconcile.resolvePaymentMismatches(tx, row.id, inv.id, run.runAt);
        return 'created';
      }),
    );
  }
}
