import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { type Connector, Prisma, type ReconcileSource } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { Clock } from '../../common/clock';
import { encodeId } from '../../common/ids';
import { type RequestContext, requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { PrismaService } from '../../db/prisma.service';
import { JobQueue } from '../../jobs/job-queue.service';
import { EntitlementService } from '../entitlements/entitlement.service';
import { OutboxService } from '../integration/outbox.service';
import type { OutboxDelivery, SettledCommand } from '../integration/outbox.types';
import { NotificationEvents } from '../notifications/notification-events';
import { addDays, bangkokToday } from '../vehicle-documents/expiry';
import { CANONICAL_INVOICE_INCLUDE, canonicalInvoice } from './canonical';
import { ConnectorResolver } from './connector-resolver';
import { ConnectorsService } from './connectors.service';
import {
  type CanonicalDocument,
  type ErpAdapter,
  ErpAdapterError,
  type ErpContext,
  type ExternalRef,
  readyCapabilities,
} from './erp-adapter';
import { ErpAdapterRegistry } from './erp-adapter.registry';
import { ErpMasterCodesService } from './erp-master-codes.service';
import { ExternalMappingService } from './external-mapping.service';
import { injectPersonalData } from './personal-data';
import { compareDocuments } from './reconcile-compare';
import { type DocumentOutcome, ReconcileResultsService } from './reconcile-results.service';

/** sink ของคำสั่ง ERP (= `ERP_SINK` ของ ErpAdapterSink — ไม่ import เพื่อตัดวงจร import ระหว่าง sink กับ service นี้) */
const SINK = 'erp';
const CAP = 'fetchDocument';
const ENTITY = 'invoice';
export const RECONCILE_JOB = 'connector.reconcile';
/** worker ตรวจรอบที่ถึงเวลา (AFTER_PUSH / NIGHTLY / PRE_CLOSE) ทุก 5 นาที */
export const RECONCILE_CHECK_EVERY_MS = 5 * 60_000;
/** docs/01 §6.5 AFTER_PUSH "ทันทีหลัง push สำเร็จ และอีกครั้ง +60 นาที" */
export const AFTER_PUSH_STAGES_MIN = [0, 60] as const;
/** คำสั่งส่งที่จบนานกว่านี้แล้วไม่ตั้งรอบ AFTER_PUSH ย้อนหลัง (worker หยุดนาน = รอบ NIGHTLY เก็บต่อ) */
const AFTER_PUSH_LOOKBACK_MS = 3 * 3600_000;
/** docs/01 §6.5 NIGHTLY 02:00 · PRE_CLOSE วันทำการสุดท้ายของเดือน 17:00 (เวลาไทย) */
export const NIGHTLY_HOUR_BKK = 2;
export const PRE_CLOSE_HOUR_BKK = 17;
/** docs/01 §6.5 NIGHTLY: mapping SYNCED/MISMATCH ที่ issue_date ภายใน 90 วัน */
export const NIGHTLY_WINDOW_DAYS = 90;
/** เพดานใบต่อรอบต่อ connector (docs/01 §6.5 ≈ 900 ใบ/รอบ) */
const MAX_PER_RUN = 5000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCES: readonly ReconcileSource[] = ['AFTER_PUSH', 'NIGHTLY', 'PRE_CLOSE', 'MANUAL'];

export type ReconcileSkip =
  | 'sandbox'
  | 'feature_off'
  | 'connector_not_active'
  | 'adapter_unavailable'
  | 'capability_not_enabled';

/** payload ของคำสั่ง FETCH_DOCUMENT ที่ reconcile สร้าง */
export interface ReconcileCommand {
  source: ReconcileSource;
  /** รหัสรอบ — ส่วนหนึ่งของ idempotency key (รอบเดิม = คำสั่งเดิม) */
  run: string;
}

export function reconcileOf(payload: unknown): ReconcileCommand | null {
  const r = (payload as { reconcile?: { source?: unknown; run?: unknown } } | null)?.reconcile;
  if (!r || typeof r.run !== 'string') return null;
  if (!SOURCES.includes(r.source as ReconcileSource)) return null;
  return { source: r.source as ReconcileSource, run: r.run };
}

/** วันทำการสุดท้ายของเดือนของ `day` (YYYY-MM-DD) = จันทร์–ศุกร์วันสุดท้าย · วันหยุดนักขัตฤกษ์ไม่นับ [OPEN — PO] (ระบบยังไม่มีปฏิทินวันหยุด) */
export function lastBusinessDay(day: string): string {
  const [y, m] = day.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m, 0)); // วันสุดท้ายของเดือน
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** วันสุดท้ายของเดือนของ `day` */
function monthEnd(day: string): string {
  const [y, m] = day.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** ชั่วโมงตามเวลาไทย (UTC+7 ไม่มี DST) */
const bkkHour = (now: Date) => new Date(now.getTime() + 7 * 3600_000).getUTCHours();

interface Expected {
  /** เอกสารที่ส่ง (ฉบับที่ออก + รหัสฝั่ง ERP ณ ตอนนี้) — ใช้เป็น hint จับคู่รายการตอนอ่าน */
  sent: CanonicalDocument;
  /** ส่วนที่ ERP เก็บได้ (`comparableDocument`) — null = เทียบไม่ได้ */
  comparable: CanonicalDocument | null;
  problem: string | null;
}

/**
 * Reconcile engine (ST8-T11; docs/01 §6.5, §4.4; docs/04 G3 — K12 ห้าม sync ทางเดียวโดยไม่ reconcile) — **ไม่ผูก ERP ใด**
 *
 * รอบ (ทุกรอบสร้างคำสั่ง `FETCH_DOCUMENT` ใน outbox ของ connector — ไม่เรียก ERP ตรง: คิวเคารพ concurrency ต่อ connector, ลำดับต่อลูกค้า
 * (serialize_key เดียวกับการส่ง — ไม่อ่านก่อนการแทนที่ที่ค้าง), การพักคิวเมื่อ health ล้ม/connector หยุด และ retry ตาม ErrorClass):
 * - `AFTER_PUSH` — คำสั่งส่งใบแจ้งหนี้ (PUSH_INVOICE / REPLACE_DOCUMENT) ที่ DONE พร้อม `externalId` → อ่านทันที + อีกครั้ง +60 นาที
 *   (worker ตรวจทุก 5 นาที — ไม่ตั้งคำสั่งล่วงหน้าเพราะคำสั่งที่ยังไม่ถึงเวลาจะกั้นคิวของลูกค้ารายนั้น)
 * - `NIGHTLY` — 02:00 เวลาไทย: ทุกใบที่ mapping SYNCED/MISMATCH และ issue_date ภายใน 90 วัน (1 job ต่อ connector ต่อวัน)
 * - `PRE_CLOSE` — วันทำการสุดท้ายของเดือน 17:00: ทุกใบของเดือนนั้น (TMS ไม่มีการปิดงวด — งวดปิดในระบบบัญชี D-54 จึงใช้เวลาตาม docs)
 * - `MANUAL` — `POST /v1/reconcile-runs` `check: DOCUMENT` (คน + `settings:write` + เหตุผล + audit) เฉพาะใบที่เลือก
 * เฉพาะ connector ACTIVE ที่ adapter ทำ `fetchDocument` ได้และ tenant เปิด capability นี้ · tenant TRIAL/ACTIVE · แพ็กเกจมี `conn` ·
 * sandbox เฉพาะ DemoProvider · ไม่มี = ไม่มีรอบ (ใบคง `SENT` — docs/01 §6.1 ตาราง fallback)
 *
 * ตอนอ่าน (`deliver` — ErpAdapterSink เรียกเมื่อคำสั่ง FETCH_DOCUMENT เป็นของ reconcile):
 * 1. เอกสารฉบับที่ออก = payload ของคำสั่ง PUSH_INVOICE แรกของใบนี้ต่อ connector (ไม่มี — เช่น คนกรอกเลขฝั่ง ERP เอง = สร้างจากใบที่ออกแล้ว)
 *    + รหัสฝั่ง ERP ณ ตอนนี้ (ทางเดียวกับตอนส่ง) → `comparableDocument` ของ adapter
 * 2. `fetchDocument` → ไม่พบ (NOT_FOUND / null) = REMOTE_MISSING · พบ = `compareDocuments` (HEADER / LINE_COUNT / TOTAL / LINE_FIELD / EXTRA_LINE)
 * 3. `ReconcileResultsService.recordDocumentOutcome` → reconcile_result + diff_hash (ส่วนต่างเดิมไม่แจ้งซ้ำ) + external_mapping
 *    `reconcile_state` ACCEPTED / MISMATCH · ส่วนต่างใหม่ → แจ้งผู้ดูแลรับชำระ (MONEY ทันที + อีเมล / FIELD ในระบบ)
 * อ่านไม่สำเร็จ (TRANSIENT/AUTH) = คำสั่งลองใหม่/พักตามกติกาเดิมของคิว · ลองครบแล้วยังล่ม = ERP_UNREACHABLE (INFO) [ไม่แจ้งเตือน — ดู spec/12]
 */
@Injectable()
export class DocumentReconcileService implements OnModuleInit {
  private readonly logger = new Logger('DocumentReconcile');

  constructor(
    private readonly prisma: PrismaService,
    private readonly db: DbService,
    private readonly queue: JobQueue,
    private readonly outbox: OutboxService,
    private readonly adapters: ErpAdapterRegistry,
    private readonly resolver: ConnectorResolver,
    private readonly connectors: ConnectorsService,
    private readonly entitlements: EntitlementService,
    private readonly masterCodes: ErpMasterCodesService,
    private readonly mappings: ExternalMappingService,
    private readonly results: ReconcileResultsService,
    private readonly events: NotificationEvents,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  onModuleInit() {
    this.queue.register(
      RECONCILE_JOB,
      async ({ tenantId, job, withTx }) => {
        const p = (job.payload ?? {}) as { connectorId?: unknown; source?: unknown; day?: unknown };
        if (typeof p.connectorId !== 'string' || !UUID_RE.test(p.connectorId))
          throw new Error('connector.reconcile: invalid connector id');
        const source = p.source === 'PRE_CLOSE' ? 'PRE_CLOSE' : 'NIGHTLY';
        const day =
          typeof p.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.day)
            ? p.day
            : bangkokToday(this.clock.now());
        return this.runRound(tenantId, p.connectorId as string, source, day, withTx);
      },
      { outsideTransaction: true },
    );
  }

  // ---------- เงื่อนไข ----------

  /** เหตุที่ connector นี้เทียบเอกสารไม่ได้ตอนนี้ (null = ได้) */
  async whyNot(tenantId: string, row: Connector): Promise<ReconcileSkip | null> {
    const t = await this.prisma.platform.tenant.findUnique({
      where: { id: tenantId },
      select: { mode: true },
    });
    const sandbox = t?.mode === 'test';
    if (!t || (sandbox && !this.resolver.isSandboxAdapter(row.adapterKey))) return 'sandbox';
    if (!(await this.entitlements.enabled(tenantId, 'conn'))) return 'feature_off';
    if (row.status !== 'ACTIVE') return 'connector_not_active';
    const r = this.resolver.describe(row, null, undefined, sandbox);
    if (!r.adapter || !this.adapters.get(row.adapterKey)) return 'adapter_unavailable';
    if (
      !r.capabilities.includes(CAP) ||
      !readyCapabilities(r.adapter).has(CAP) ||
      typeof r.adapter.fetchDocument !== 'function'
    )
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

  // ---------- สร้างคำสั่งอ่าน ----------

  /** คำสั่ง FETCH_DOCUMENT 1 ใบ (idempotent ต่อรอบ — `run` อยู่ใน payload) · คืน true เมื่อสร้างใหม่ */
  async enqueueFetch(
    tx: Tx,
    x: {
      tenantId: string;
      connectorId: string;
      invoiceId: string;
      number: string;
      externalId: string;
      customerId: string | null;
      source: ReconcileSource;
      run: string;
    },
  ): Promise<boolean> {
    const ref: ExternalRef = {
      entityType: ENTITY,
      localId: x.invoiceId,
      number: x.number,
      externalId: x.externalId,
    };
    const r = await this.outbox.enqueueCommand(tx, {
      tenantId: x.tenantId,
      kind: 'ADAPTER',
      sink: SINK,
      targetId: x.connectorId,
      operation: 'FETCH_DOCUMENT',
      entityType: ENTITY,
      localId: x.invoiceId,
      // ลำดับเดียวกับคำสั่งส่งของลูกค้ารายนี้ — ไม่อ่านแซงการส่ง/แทนที่ที่ค้าง
      customerId: x.customerId,
      payload: { ref, reconcile: { source: x.source, run: x.run } },
    });
    return r.created;
  }

  /** ใบของ connector ที่อยู่ใน ERP (mapping มีเลขฝั่ง ERP · ไม่ถูกยกเลิก) ในช่วง issue_date — หรือเฉพาะ id ที่ให้ */
  private candidates(
    tx: Tx,
    connectorId: string,
    filter: { from: string; to: string } | { ids: string[] },
  ) {
    const cond =
      'from' in filter
        ? Prisma.sql`i.issue_date >= ${filter.from}::date AND i.issue_date <= ${filter.to}::date`
        : Prisma.sql`m.local_id IN (${Prisma.join(filter.ids.map((id) => Prisma.sql`${id}::uuid`))})`;
    if (!('from' in filter) && !filter.ids.length) return Promise.resolve([]);
    return tx.$queryRaw<
      {
        local_id: string;
        external_id: string;
        number: string | null;
        customer_id: string | null;
      }[]
    >`
      SELECT m.local_id, m.external_id, COALESCE(i.invoice_no, m.local_number) AS number, i.customer_id
        FROM external_mapping m
        JOIN invoice i ON i.id = m.local_id
       WHERE m.connector_id = ${connectorId}::uuid
         AND m.entity_type = 'INVOICE'::"ExternalEntityType"
         AND m.external_id IS NOT NULL
         AND m.status IN ('SYNCED', 'MISMATCH')
         AND (m.external_status IS NULL OR m.external_status <> 'VOIDED')
         AND i.status <> 'CANCELLED'
         AND ${cond}
       ORDER BY i.issue_date, m.local_id
       LIMIT ${MAX_PER_RUN}`;
  }

  /** รอบ NIGHTLY / PRE_CLOSE ของ connector 1 ตัว (handler ของ job) */
  async runRound(
    tenantId: string,
    connectorId: string,
    source: 'NIGHTLY' | 'PRE_CLOSE',
    day: string,
    withTx: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T> = (fn) =>
      this.db.withTenant(tenantId, fn, 60_000),
  ): Promise<{ source: string; day: string; queued: number; skipped?: ReconcileSkip | string }> {
    if (!(await this.tenantLive(tenantId)))
      return { source, day, queued: 0, skipped: 'tenant_inactive' };
    const row = await withTx((tx) => tx.connector.findUnique({ where: { id: connectorId } }));
    if (!row) return { source, day, queued: 0, skipped: 'connector_not_found' };
    const why = await this.whyNot(tenantId, row);
    if (why) return { source, day, queued: 0, skipped: why };
    const range =
      source === 'NIGHTLY'
        ? { from: addDays(day, -NIGHTLY_WINDOW_DAYS), to: day }
        : { from: `${day.slice(0, 8)}01`, to: monthEnd(day) };
    const run = source === 'NIGHTLY' ? `nightly:${day}` : `pre_close:${day.slice(0, 7)}`;
    const queued = await withTx(async (tx) => {
      let n = 0;
      for (const c of await this.candidates(tx, connectorId, range))
        if (
          await this.enqueueFetch(tx, {
            tenantId,
            connectorId,
            invoiceId: c.local_id,
            number: c.number ?? '',
            externalId: c.external_id,
            customerId: c.customer_id,
            source,
            run,
          })
        )
          n += 1;
      return n;
    });
    if (queued)
      this.logger.log(`tenant ${tenantId} connector ${connectorId}: ${source} ${queued} queued`);
    return { source, day, queued };
  }

  /**
   * `POST /v1/reconcile-runs` `check: DOCUMENT` — transaction ของคำขอ (RLS) · ผู้เรียกตรวจ `whyNot` แล้ว
   * ใบที่ไม่อยู่ใน ERP ของ connector นี้ (ไม่พบ / ไม่มีเลขฝั่ง ERP / ยกเลิก) คืนใน `notInErp` · audit `reconcile.run_requested` + เหตุผล
   */
  async enqueueManual(
    tx: Tx,
    tenantId: string,
    connector: Connector,
    invoiceIds: string[],
    reason: string,
  ): Promise<{ queued: number; notInErp: string[] }> {
    const ids = [...new Set(invoiceIds)];
    const found = await this.candidates(tx, connector.id, { ids });
    const run = `manual:${this.clock.now().toISOString()}:${requestContext.get()?.requestId ?? ''}`;
    let queued = 0;
    for (const c of found)
      if (
        await this.enqueueFetch(tx, {
          tenantId,
          connectorId: connector.id,
          invoiceId: c.local_id,
          number: c.number ?? '',
          externalId: c.external_id,
          customerId: c.customer_id,
          source: 'MANUAL',
          run,
        })
      )
        queued += 1;
    const have = new Set(found.map((c) => c.local_id));
    const notInErp = ids.filter((id) => !have.has(id));
    await this.audit.record({
      action: 'reconcile.run_requested',
      entityType: 'connector',
      entityId: connector.id,
      after: {
        check: 'DOCUMENT',
        source: 'MANUAL',
        connector: connector.adapterKey,
        invoiceIds: [...have].map((id) => encodeId('invoice', id)),
        queued,
        notInErp: notInErp.length,
      },
      reason,
    });
    return { queued, notInErp };
  }

  // ---------- ตั้งรอบ (worker) ----------

  /** เรียกทุก 5 นาทีจาก worker — AFTER_PUSH ที่ถึงเวลา + job ของ NIGHTLY / PRE_CLOSE ที่ถึงเวลา */
  async scheduleDue(now: Date = this.clock.now()): Promise<{ afterPush: number; rounds: number }> {
    const afterPush = await this.scheduleAfterPush(now);
    const rounds = await this.scheduleRounds(now);
    return { afterPush, rounds };
  }

  /** ใบที่เพิ่งส่งสำเร็จ (DONE + externalId) → อ่านทันที และอีกครั้งเมื่อครบ 60 นาที */
  async scheduleAfterPush(now: Date = this.clock.now()): Promise<number> {
    const since = new Date(now.getTime() - AFTER_PUSH_LOOKBACK_MS - 60 * 60_000);
    const done = await this.prisma.platform.$queryRaw<
      { id: string; tenant_id: string; target_id: string; local_id: string; done_at: Date }[]
    >`
      SELECT o.id, o.tenant_id, o.target_id, o.local_id, o.done_at
        FROM integration_outbox o
       WHERE o.status = 'DONE' AND o.sink = ${SINK} AND o.entity_type = ${ENTITY}
         AND o.operation IN ('PUSH_INVOICE', 'REPLACE_DOCUMENT')
         AND o.next_run_at >= ${new Date(since.getTime() - 86_400_000)}
         AND o.done_at >= ${since} AND o.done_at <= ${now}
         AND o.target_id IS NOT NULL
         AND COALESCE(o.result->>'externalId', '') <> ''
       ORDER BY o.done_at
       LIMIT ${MAX_PER_RUN}`;
    if (!done.length) return 0;
    let n = 0;
    const ok = new Map<string, boolean>();
    for (const o of done) {
      const stages = AFTER_PUSH_STAGES_MIN.filter((m) => {
        const due = o.done_at.getTime() + m * 60_000;
        // ขั้นที่ถึงเวลาแล้ว และยังไม่เลยหน้าต่างย้อนหลัง (worker หยุดนาน = ไม่ตามย้อน — รอบ NIGHTLY เก็บ)
        return due <= now.getTime() && due >= now.getTime() - AFTER_PUSH_LOOKBACK_MS;
      });
      if (!stages.length) continue;
      const key = `${o.tenant_id}:${o.target_id}`;
      if (!ok.has(key)) {
        const row = await this.prisma.platform.connector.findUnique({ where: { id: o.target_id } });
        ok.set(
          key,
          !!row &&
            row.tenantId === o.tenant_id &&
            (await this.tenantLive(o.tenant_id)) &&
            !(await this.whyNot(o.tenant_id, row)),
        );
      }
      if (!ok.get(key)) continue;
      try {
        n += await this.db.withTenant(o.tenant_id, async (tx) => {
          const [c] = await this.candidates(tx, o.target_id, { ids: [o.local_id] });
          if (!c) return 0;
          let k = 0;
          for (const m of stages)
            if (
              await this.enqueueFetch(tx, {
                tenantId: o.tenant_id,
                connectorId: o.target_id,
                invoiceId: c.local_id,
                number: c.number ?? '',
                externalId: c.external_id,
                customerId: c.customer_id,
                source: 'AFTER_PUSH',
                run: `after_push:${o.id}:${m}`,
              })
            )
              k += 1;
          return k;
        });
      } catch (e) {
        this.logger.warn(
          `after-push reconcile ${o.id}: ${String((e as Error)?.message ?? e).slice(0, 200)}`,
        );
      }
    }
    return n;
  }

  /** job NIGHTLY (ตั้งแต่ 02:00) / PRE_CLOSE (วันทำการสุดท้ายของเดือน ตั้งแต่ 17:00) — 1 job ต่อ connector ต่อรอบ */
  async scheduleRounds(now: Date = this.clock.now()): Promise<number> {
    const today = bangkokToday(now);
    const hour = bkkHour(now);
    const due: { source: 'NIGHTLY' | 'PRE_CLOSE' }[] = [];
    if (hour >= NIGHTLY_HOUR_BKK) due.push({ source: 'NIGHTLY' });
    if (today === lastBusinessDay(today) && hour >= PRE_CLOSE_HOUR_BKK)
      due.push({ source: 'PRE_CLOSE' });
    if (!due.length) return 0;
    return this.prisma.platform.$transaction(async (db) => {
      await db.$executeRaw`SELECT pg_advisory_xact_lock(8, hashtext(${RECONCILE_JOB}))`;
      const rows = await db.connector.findMany({
        where: { status: 'ACTIVE', capabilitiesEnabled: { has: CAP } },
        select: { id: true, tenantId: true, adapterKey: true },
        orderBy: { createdAt: 'asc' },
      });
      const live = rows.filter((r) => {
        const a = this.adapters.get(r.adapterKey);
        return !!a && readyCapabilities(a).has(CAP) && typeof a.fetchDocument === 'function';
      });
      if (!live.length) return 0;
      const tenantIds = [...new Set(live.map((r) => r.tenantId))];
      const modes = new Map(
        (
          await db.tenant.findMany({
            where: { id: { in: tenantIds }, status: { in: ['TRIAL', 'ACTIVE'] } },
            select: { id: true, mode: true },
          })
        ).map((t) => [t.id, t.mode === 'test']),
      );
      const usable = (r: { tenantId: string; adapterKey: string }) =>
        modes.has(r.tenantId) && !!this.adapters.usableIn(r.adapterKey, modes.get(r.tenantId)!);
      const allowed = new Set(
        await this.entitlements.tenantsWith(
          'conn',
          tenantIds.filter((t) => live.some((r) => r.tenantId === t && usable(r))),
        ),
      );
      const existing = await db.job.findMany({
        where: {
          tenantId: { in: [...allowed] },
          type: RECONCILE_JOB,
          // ช่วงค้น (index) — อิงเวลาที่เก่ากว่าระหว่างรอบที่ตรวจกับนาฬิกาจริง (test ส่งเวลาล่วงหน้าได้)
          createdAt: {
            gte: new Date(Math.min(now.getTime(), this.clock.now().getTime()) - 3 * 86_400_000),
          },
          payload: { path: ['day'], equals: today },
        },
        select: { payload: true },
      });
      const have = new Set(
        existing.map((j) => {
          const p = (j.payload ?? {}) as { connectorId?: unknown; source?: unknown };
          return `${String(p.connectorId)}:${String(p.source)}`;
        }),
      );
      let n = 0;
      for (const r of live) {
        if (!allowed.has(r.tenantId) || !usable(r)) continue;
        for (const d of due) {
          if (have.has(`${r.id}:${d.source}`)) continue;
          await this.queue.enqueue(db as unknown as Tx, {
            tenantId: r.tenantId,
            type: RECONCILE_JOB,
            payload: { connectorId: r.id, source: d.source, day: today },
          });
          n += 1;
        }
      }
      return n;
    });
  }

  // ---------- อ่าน + เทียบ (ErpAdapterSink เรียก) ----------

  /**
   * คำสั่ง FETCH_DOCUMENT ของ reconcile — ErpAdapterSink ตรวจประตูทั้งหมดแล้ว (connector ACTIVE, health, capability, sandbox)
   * error ของการอ่านที่ไม่ใช่ "ไม่พบ" โยนต่อ (sink แปลงเป็นผลของคำสั่งตาม ErrorClass)
   */
  async deliver(
    d: OutboxDelivery,
    x: { connector: Connector; adapter: ErpAdapter; ctx: ErpContext; ref: ExternalRef },
  ): Promise<{ result: Record<string, unknown> }> {
    const rc = reconcileOf(d.payload)!;
    const { connector, adapter, ctx, ref } = x;
    const exp = await d.withTx((tx) => this.expected(tx, d, connector, adapter, ctx));
    let got: CanonicalDocument | null;
    try {
      got = await adapter.fetchDocument!(ctx, ref, exp?.sent);
    } catch (e) {
      if (!(e instanceof ErpAdapterError && e.errorClass === 'NOT_FOUND')) throw e;
      got = null;
    }
    const runAt = this.clock.now();
    const number = exp?.sent.number ?? ref.number;
    let outcome: DocumentOutcome;
    let totalSkipped: string | null = null;
    if (!got) outcome = { kind: 'REMOTE_MISSING', externalId: ref.externalId ?? '' };
    else if (!exp?.comparable)
      // เทียบไม่ได้ (ผังรหัสไม่ครบ ฯลฯ) — ไม่ตัดสินแทน ไม่เปลี่ยนผลกระทบยอด
      return {
        result: {
          reconcile: {
            source: rc.source,
            outcome: 'NOT_COMPARABLE',
            code: exp?.problem ?? 'document_unavailable',
          },
        },
      };
    else {
      const cmp = compareDocuments(exp.comparable, got);
      totalSkipped = cmp.totalSkipped;
      outcome = cmp.matched ? { kind: 'MATCH' } : { kind: 'MISMATCH', compare: cmp };
    }
    const lines = (doc: CanonicalDocument | null | undefined) =>
      Array.isArray(doc?.lines) ? doc.lines.length : null;
    const r = await d.withTx((tx) =>
      requestContext.run(this.actor(d.tenantId, connector, `outbox:${d.id}`, tx), async () => {
        const res = await this.results.recordDocumentOutcome(tx, d.tenantId, {
          connectorId: connector.id,
          adapterKey: connector.adapterKey,
          entityType: 'INVOICE',
          localId: d.localId,
          localNumber: number,
          source: rc.source,
          runAt,
          outcome,
          outboxId: d.id,
          local: { number, lines: lines(exp?.comparable ?? exp?.sent) },
          remote: {
            externalId: (got?.externalId as string | undefined) ?? ref.externalId,
            externalDocNo: (got?.externalDocNo as string | undefined) ?? null,
            found: !!got,
            lines: lines(got),
            ...(ref.documents?.length ? { documents: ref.documents.length } : {}),
          },
        });
        if (res.created && (res.severity === 'MONEY' || res.severity === 'FIELD'))
          await this.events.documentMismatch(tx, {
            tenantId: d.tenantId,
            connectorId: connector.id,
            label: this.connectors.adapterLabel(connector.adapterKey),
            invoiceId: d.localId,
            invoiceNo: number,
            severity: res.severity,
          });
        return res;
      }),
    );
    const cmp = outcome.kind === 'MISMATCH' ? outcome.compare : null;
    return {
      result: {
        reconcile: {
          source: rc.source,
          outcome: outcome.kind,
          state: r.state,
          newMismatch: r.created,
          ...(r.id ? { reconcileResultId: encodeId('reconcileResult', r.id) } : {}),
          ...(cmp ? { levels: cmp.levels, severity: cmp.severity } : {}),
          ...(totalSkipped ? { totalSkipped } : {}),
        },
      },
    };
  }

  /**
   * คำสั่งอ่านของ reconcile จบแบบไม่สำเร็จ (FAILED_FINAL — ลองครบแล้วปลายทางยังล่ม) → ERP_UNREACHABLE (INFO)
   * ไม่เปลี่ยนผลกระทบยอดของใบ · SKIPPED (capability/sandbox/connector ยกเลิก) = ไม่บันทึก
   */
  async onSettled(c: SettledCommand): Promise<void> {
    const rc = reconcileOf(c.payload);
    if (!rc || c.status !== 'FAILED_FINAL' || !c.targetId) return;
    if (c.errorClass !== 'TRANSIENT' && c.errorClass !== 'AMBIGUOUS') return;
    const connectorId = c.targetId;
    const ref = (c.payload as { ref?: { number?: unknown } }).ref;
    await this.db.withTenant(c.tenantId, async (tx) => {
      const row = await tx.connector.findUnique({ where: { id: connectorId } });
      if (!row) return;
      await requestContext.run(this.actor(c.tenantId, row, `outbox:${c.id}`, tx), () =>
        this.results.recordDocumentOutcome(tx, c.tenantId, {
          connectorId,
          adapterKey: row.adapterKey,
          entityType: 'INVOICE',
          localId: c.localId,
          localNumber: typeof ref?.number === 'string' ? ref.number : null,
          source: rc.source,
          runAt: this.clock.now(),
          outcome: { kind: 'ERP_UNREACHABLE', errorClass: c.errorClass },
          outboxId: c.id,
          local: { number: typeof ref?.number === 'string' ? ref.number : null },
          remote: { found: null, errorClass: c.errorClass, code: c.code },
        }),
      );
    });
  }

  /**
   * เอกสารฉบับที่ออกที่ใช้เทียบ: payload ของคำสั่ง PUSH_INVOICE แรก (canonical ณ ตอนออก — ST7-T16 `resend` ใช้ฉบับเดียวกัน)
   * ไม่มี (mapping ที่คนกรอกเอง) = canonical จากใบที่ออกแล้ว · ใส่รหัสฝั่ง ERP ณ ตอนนี้ทางเดียวกับตอนส่ง (party codes → ผังรหัส →
   * ข้อมูลส่วนบุคคลที่ adapter ประกาศ) แล้วให้ adapter ตัดเหลือส่วนที่ ERP เก็บ (`comparableDocument`)
   */
  private async expected(
    tx: Tx,
    d: OutboxDelivery,
    connector: Connector,
    adapter: ErpAdapter,
    ctx: ErpContext,
  ): Promise<Expected | null> {
    const first = await tx.integrationOutbox.findFirst({
      where: {
        sink: SINK,
        targetId: connector.id,
        operation: 'PUSH_INVOICE',
        entityType: ENTITY,
        localId: d.localId,
      },
      orderBy: { seq: 'asc' },
      select: { payload: true },
    });
    let doc = (first?.payload as { document?: CanonicalDocument } | null)?.document ?? null;
    if (!doc) {
      const inv = await tx.invoice.findUnique({
        where: { id: d.localId },
        include: CANONICAL_INVOICE_INCLUDE,
      });
      if (!inv || !inv.invoiceNo) return null;
      const code = await this.mappings.customerErpCode(tx, connector.id, inv.customerId);
      doc = canonicalInvoice(inv, code, adapter.personalDataNeeds ?? []) as CanonicalDocument;
    }
    const prep = await this.masterCodes.prepareForPush(
      tx,
      connector.id,
      adapter,
      ctx,
      'PUSH_INVOICE',
      await this.mappings.withPartyCodes(tx, connector.id, doc),
    );
    if (!prep.ok) return { sent: doc, comparable: null, problem: prep.problem.code };
    const pii = await injectPersonalData(tx, prep.document, adapter.personalDataNeeds ?? []);
    ctx.masterCodes = prep.masterCodes;
    const sent = pii.document;
    let comparable: CanonicalDocument | null;
    try {
      comparable = adapter.comparableDocument ? adapter.comparableDocument(ctx, sent) : sent;
    } catch {
      comparable = null;
    }
    return { sent, comparable, problem: comparable ? null : 'not_comparable' };
  }

  private actor(tenantId: string, row: Connector, requestId: string, tx: Tx): RequestContext {
    return {
      requestId,
      tenantId,
      actorId: `connector:${row.adapterKey}`,
      principalType: 'connector',
      scopes: [],
      locale: 'th',
      tx,
    };
  }
}
