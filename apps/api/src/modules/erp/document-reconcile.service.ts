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
import { customerKey, OutboxService } from '../integration/outbox.service';
import type { OutboxDelivery, SettledCommand } from '../integration/outbox.types';
import { NotificationEvents } from '../notifications/notification-events';
import { addDays, bangkokToday } from '../vehicle-documents/expiry';
import { externalRefOf } from './erp-reissue';
import { ConnectorResolver } from './connector-resolver';
import { ConnectorsService } from './connectors.service';
import {
  type CanonicalDocument,
  type ErpAdapter,
  ErpAdapterError,
  type ErpContext,
  ExternalPartsError,
  type ExternalRef,
  readyCapabilities,
} from './erp-adapter';
import { ErpAdapterRegistry } from './erp-adapter.registry';
import { injectPersonalData } from './personal-data';
import { applyReconcileBasis, CANONICAL_VERSION, parseReconcileBasis } from './reconcile-basis';
import { compareDocuments } from './reconcile-compare';
import { type DocumentOutcome, ReconcileResultsService } from './reconcile-results.service';
import { SYNC_TENANT_STATUSES, canSync } from '../tenants/tenant-status';

/** sink ของคำสั่ง ERP (= `ERP_SINK` ของ ErpAdapterSink — ไม่ import เพื่อตัดวงจร import ระหว่าง sink กับ service นี้) */
const SINK = 'erp';
const CAP = 'fetchDocument';
const ENTITY = 'invoice';
export const RECONCILE_JOB = 'connector.reconcile';
/** worker ตรวจรอบ NIGHTLY / PRE_CLOSE ที่ถึงเวลาทุก 5 นาที */
export const RECONCILE_CHECK_EVERY_MS = 5 * 60_000;
/** PO 24 พ.ย. 2569 (#89): worker ตรวจ AFTER_PUSH ที่ถึงเวลาทุก 1 นาที — ให้ค่าหน่วงเวลาต่อ connector (นาที) ละเอียดพอ */
export const AFTER_PUSH_CHECK_EVERY_MS = 60_000;
/**
 * docs/01 §6.5 AFTER_PUSH "ทันทีหลัง push สำเร็จ และอีกครั้ง +60 นาที" — ชื่อขั้น (จดใน `result.reconcileStages`):
 * 0 = อ่านครั้งแรก (ครบ `connector.after_push_reconcile_delay_min` หลังส่งสำเร็จ) · 60 = อ่านอีกครั้ง +60 นาทีจากครั้งแรก
 */
export const AFTER_PUSH_STAGES_MIN = [0, 60] as const;
/** PO 24 พ.ย. 2569 (#89) ค่าหน่วงเวลาอ่านครั้งแรกหลังส่งสำเร็จ (นาที) ต่อ connector: 0 = ทันทีที่ worker รอบถัดไปเห็น (≤ 1 นาที) */
export const AFTER_PUSH_DELAY_DEFAULT_MIN = 0;
export const AFTER_PUSH_DELAY_MAX_MIN = 1440;
/** คำสั่งส่งที่จบนานกว่านี้แล้วไม่ตั้งรอบ AFTER_PUSH ย้อนหลัง (worker หยุดนาน = รอบ NIGHTLY เก็บต่อ) */
const AFTER_PUSH_LOOKBACK_MS = 3 * 3600_000;
/** คำสั่งส่งต่อชุด · ชุดต่อรอบตรวจ (1 นาที) */
export const AFTER_PUSH_BATCH = 500;
const AFTER_PUSH_MAX_BATCHES = 20;
/** docs/01 §6.5 NIGHTLY 02:00 · PRE_CLOSE วันทำการสุดท้ายของเดือน 17:00 (เวลาไทย) */
export const NIGHTLY_HOUR_BKK = 2;
export const NIGHTLY_UNTIL_HOUR_BKK = 6;
export const PRE_CLOSE_HOUR_BKK = 17;
/** ครั้งที่ลองอ่านต่อคำสั่ง (คำสั่งส่งใช้ 7) */
export const RECONCILE_MAX_ATTEMPTS = 3;
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
  | 'connector_unhealthy'
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
  /** เอกสารที่ส่ง (ฉบับที่ออก + ฐานของการส่ง) — hint จับคู่รายการตอนอ่าน · null = ไม่มีคำสั่งส่ง */
  hint: CanonicalDocument | null;
  number: string | null;
  /** ส่วนที่ ERP เก็บได้ (`comparableDocument`) — null = เทียบไม่ได้ (`problem`) */
  comparable: CanonicalDocument | null;
  problem: string | null;
  /** canonical ที่ส่งเป็นรุ่นเก่ากว่าปัจจุบัน → ไม่เทียบช่องที่ฉบับนั้นไม่มี */
  olderCanonical: boolean;
}

/**
 * Reconcile engine (ST8-T11; docs/01 §6.5, §4.4; docs/04 G3 — K12 ห้าม sync ทางเดียวโดยไม่ reconcile) — **ไม่ผูก ERP ใด**
 *
 * รอบ (ทุกรอบสร้างคำสั่ง `FETCH_DOCUMENT` ใน outbox ของ connector — ไม่เรียก ERP ตรง: คิวเคารพ concurrency ต่อ connector, ลำดับต่อลูกค้า
 * (serialize_key เดียวกับการส่ง — ไม่อ่านก่อนการแทนที่ที่ค้าง), การพักคิวเมื่อ health ล้ม/connector หยุด และ retry ตาม ErrorClass):
 * - `AFTER_PUSH` — คำสั่งส่งใบแจ้งหนี้ (PUSH_INVOICE / REPLACE_DOCUMENT) ที่ DONE พร้อม `externalId` → อ่านเมื่อครบค่าหน่วงของ connector
 *   (`afterPushReconcileDelayMinutes` ค่าเริ่ม 0 = ทันที — PO 24 พ.ย. 2569 #89) + อีกครั้ง +60 นาทีจากครั้งแรก
 *   (worker ตรวจทุก 1 นาที — ไม่ตั้งคำสั่งล่วงหน้าเพราะคำสั่งที่ยังไม่ถึงเวลาจะกั้นคิวของลูกค้ารายนั้น)
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
    // review 2: health กำลังล้ม (คิวพักอยู่) = ไม่ตั้งรอบ — คำสั่งจะค้างคิวเปล่า ๆ
    if (row.healthFailingSince) return 'connector_unhealthy';
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
    return canSync(t?.status);
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
    // review 2: ใบนี้มีคำสั่งอ่านค้างอยู่แล้ว (รอ/กำลังอ่าน/รอลองใหม่) = ไม่สร้างซ้อน (ผลของคำสั่งนั้นพอ)
    const open = await tx.integrationOutbox.findFirst({
      where: {
        sink: SINK,
        targetId: x.connectorId,
        operation: 'FETCH_DOCUMENT',
        entityType: ENTITY,
        localId: x.invoiceId,
        status: { in: ['PENDING', 'IN_FLIGHT', 'FAILED_RETRYABLE'] },
      },
      select: { id: true },
    });
    if (open) return false;
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
      customerId: x.customerId,
      // review 2: ช่องลำดับแยกของการอ่าน (`erp:{connector}:recon:{ลูกค้า}`) — อ่านค้าง/ลองใหม่ไม่กั้นการส่งเอกสารของลูกค้า
      serializeKey: `${SINK}:${x.connectorId}:recon:${customerKey(x.customerId) ?? `${ENTITY}:${x.invoiceId}`}`,
      // อ่านอย่างเดียว — ลองไม่กี่ครั้ง (ไม่ได้ = ERP_UNREACHABLE; รอบถัดไปอ่านใหม่)
      maxAttempt: RECONCILE_MAX_ATTEMPTS,
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
    if (!('from' in filter) && !filter.ids.length) return Promise.resolve([]);
    const cond =
      'from' in filter
        ? Prisma.sql`i.issue_date >= ${filter.from}::date AND i.issue_date <= ${filter.to}::date`
        : Prisma.sql`m.local_id IN (${Prisma.join(filter.ids.map((id) => Prisma.sql`${id}::uuid`))})`;

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
    // review 10: วัน PRE_CLOSE — ใบของเดือนนี้รอรอบ 17:00 (NIGHTLY ไม่อ่านซ้ำ)
    const monthStart = `${day.slice(0, 8)}01`;
    const range =
      source === 'NIGHTLY'
        ? {
            from: addDays(day, -NIGHTLY_WINDOW_DAYS),
            to: day === lastBusinessDay(day) ? addDays(monthStart, -1) : day,
          }
        : { from: monthStart, to: monthEnd(day) };
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

  /** AFTER_PUSH ที่ถึงเวลา + job ของ NIGHTLY / PRE_CLOSE ที่ถึงเวลา (worker เรียกสองส่วนแยกกัน: AFTER_PUSH ทุก 1 นาที · รอบทุก 5 นาที) */
  async scheduleDue(now: Date = this.clock.now()): Promise<{ afterPush: number; rounds: number }> {
    const afterPush = await this.scheduleAfterPush(now);
    const rounds = await this.scheduleRounds(now);
    return { afterPush, rounds };
  }

  /**
   * ใบที่เพิ่งส่งสำเร็จ (DONE + externalId) → อ่านเมื่อครบค่าหน่วงของ connector (PO 24 พ.ย. 2569 #89 — ค่าเริ่ม 0 = ทันที)
   * และอีกครั้งเมื่อครบ 60 นาทีจากครั้งแรก · worker เรียกทุก 1 นาที (`AFTER_PUSH_CHECK_EVERY_MS`)
   * review (crowd-out): เลือกใน SQL เฉพาะขั้นที่ **ถึงเวลาและยังอยู่ในหน้าต่างย้อนหลัง** ของ connector ที่ ACTIVE + ปกติ + เปิด `fetchDocument`
   * เรียงตามเวลาถึงกำหนด (เก่าก่อน) · แถวที่ถึงเวลาแต่ตั้งไม่ได้ (tenant ไม่ live / sandbox / แพ็กเกจไม่มี / adapter ไม่พร้อม) = จดว่าข้ามแล้ว
   * (`reconcileStages` เดิม — ไม่วนกลับมากินที่) · ทำทีละชุด ≤ `AFTER_PUSH_BATCH` จนหมดหรือครบ `AFTER_PUSH_MAX_BATCHES` ต่อรอบ
   */
  async scheduleAfterPush(now: Date = this.clock.now()): Promise<number> {
    // หน้าต่างย้อนหลังกว้างตามค่าหน่วงสูงสุดของ connector ที่ใช้งานได้จริง (ค่าเริ่ม 0 → หน้าต่างเท่าเดิม ≈ 4 ชม.)
    const [mx] = await this.prisma.platform.$queryRaw<{ m: number | null }[]>`
      SELECT max(after_push_reconcile_delay_min)::int AS m FROM connector
       WHERE status = 'ACTIVE' AND ${CAP} = ANY(capabilities_enabled)`;
    const maxDelay = Math.min(Math.max(mx?.m ?? 0, 0), AFTER_PUSH_DELAY_MAX_MIN);
    const since = new Date(now.getTime() - AFTER_PUSH_LOOKBACK_MS - (maxDelay + 60) * 60_000);
    const oldest = new Date(now.getTime() - AFTER_PUSH_LOOKBACK_MS);
    let n = 0;
    const ok = new Map<string, boolean>();
    for (let b = 0; b < AFTER_PUSH_MAX_BATCHES; b++) {
      // review 5: ขั้นที่ตั้งแล้ว/ข้ามแล้วจดใน `result.reconcileStages` ของคำสั่งส่ง → ไม่ดึงแถวเดิมซ้ำทุกรอบ
      const done = await this.prisma.platform.$queryRaw<
        {
          id: string;
          tenant_id: string;
          target_id: string;
          local_id: string;
          done_at: Date;
          delay_min: number;
          stages: number[] | null;
        }[]
      >`
        SELECT x.* FROM (
          SELECT o.id, o.tenant_id, o.target_id, o.local_id, o.done_at, c.after_push_reconcile_delay_min AS delay_min,
                 ARRAY(SELECT jsonb_array_elements_text(COALESCE(o.result->'reconcileStages', '[]'::jsonb))::int) AS stages,
                 o.done_at + make_interval(mins => c.after_push_reconcile_delay_min) AS due0,
                 o.done_at + make_interval(mins => c.after_push_reconcile_delay_min + 60) AS due60,
                 COALESCE(o.result->'reconcileStages', '[]'::jsonb) AS marked
            FROM integration_outbox o
            JOIN connector c ON c.id::text = o.target_id AND c.tenant_id = o.tenant_id
           WHERE o.status = 'DONE' AND o.sink = ${SINK} AND o.entity_type = ${ENTITY}
             AND o.operation IN ('PUSH_INVOICE', 'REPLACE_DOCUMENT')
             AND o.next_run_at >= ${new Date(since.getTime() - 86_400_000)}
             AND o.done_at >= ${since} AND o.done_at <= ${now}
             AND o.target_id IS NOT NULL
             AND COALESCE(o.result->>'externalId', '') <> ''
             AND c.status = 'ACTIVE' AND c.health_failing_since IS NULL
             AND ${CAP} = ANY(c.capabilities_enabled)
        ) x
         WHERE (x.due0 <= ${now} AND x.due0 >= ${oldest} AND NOT x.marked @> '[0]'::jsonb)
            OR (x.due60 <= ${now} AND x.due60 >= ${oldest} AND NOT x.marked @> '[60]'::jsonb)
         ORDER BY CASE WHEN NOT x.marked @> '[0]'::jsonb AND x.due0 >= ${oldest} THEN x.due0 ELSE x.due60 END ASC, x.id
         LIMIT ${AFTER_PUSH_BATCH}`;
      for (const o of done) n += await this.afterPushOne(o, now, ok);
      if (done.length < AFTER_PUSH_BATCH) break;
    }
    return n;
  }

  /** ตั้งคำสั่งอ่านของขั้นที่ถึงเวลาของคำสั่งส่ง 1 แถว แล้วจดขั้น (ตั้งได้หรือข้าม) · คืนจำนวนคำสั่งอ่านที่สร้าง */
  private async afterPushOne(
    o: {
      id: string;
      tenant_id: string;
      target_id: string;
      local_id: string;
      done_at: Date;
      delay_min: number;
      stages: number[] | null;
    },
    now: Date,
    ok: Map<string, boolean>,
  ): Promise<number> {
    const marked = new Set(o.stages ?? []);
    const stages = AFTER_PUSH_STAGES_MIN.filter((m) => {
      if (marked.has(m)) return false;
      const due = o.done_at.getTime() + (o.delay_min + m) * 60_000;
      // ขั้นที่ถึงเวลาแล้ว และยังไม่เลยหน้าต่างย้อนหลัง (worker หยุดนาน = ไม่ตามย้อน — รอบ NIGHTLY เก็บ)
      return due <= now.getTime() && due >= now.getTime() - AFTER_PUSH_LOOKBACK_MS;
    });
    if (!stages.length) return 0;
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
    let k = 0;
    try {
      // review (crowd-out): ตั้งไม่ได้ (ถึงเวลาแล้ว) = จดว่าข้าม ไม่สร้างคำสั่ง — ไม่วนกลับมาทุกรอบ (รอบ NIGHTLY เก็บต่อ)
      if (ok.get(key))
        k = await this.db.withTenant(o.tenant_id, async (tx) => {
          const [c] = await this.candidates(tx, o.target_id, { ids: [o.local_id] });
          let made = 0;
          if (c)
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
                made += 1;
          return made;
        });
      // จดว่าตั้งแล้ว (รวมกรณีใบไม่อยู่ใน ERP แล้ว / มีคำสั่งอ่านค้างอยู่ / connector ใช้ไม่ได้ — ไม่ต้องตั้งซ้ำ)
      const all = [...new Set([...marked, ...stages])].sort((x, y) => x - y);
      await this.prisma.platform.$executeRaw`
        UPDATE integration_outbox
           SET result = jsonb_set(COALESCE(result, '{}'::jsonb), '{reconcileStages}', ${JSON.stringify(all)}::jsonb)
         WHERE id = ${o.id}::uuid`;
    } catch (e) {
      this.logger.warn(
        `after-push reconcile ${o.id}: ${String((e as Error)?.message ?? e).slice(0, 200)}`,
      );
    }
    return k;
  }

  /** job NIGHTLY (ตั้งแต่ 02:00) / PRE_CLOSE (วันทำการสุดท้ายของเดือน ตั้งแต่ 17:00) — 1 job ต่อ connector ต่อรอบ */
  async scheduleRounds(now: Date = this.clock.now()): Promise<number> {
    const today = bangkokToday(now);
    const hour = bkkHour(now);
    const due: { source: 'NIGHTLY' | 'PRE_CLOSE' }[] = [];
    // review 6: NIGHTLY เฉพาะช่วง 02:00–06:00 (worker หยุดทั้งคืน = ไม่ไล่อ่านกลางวัน — รอคืนถัดไป)
    if (hour >= NIGHTLY_HOUR_BKK && hour < NIGHTLY_UNTIL_HOUR_BKK) due.push({ source: 'NIGHTLY' });
    if (today === lastBusinessDay(today) && hour >= PRE_CLOSE_HOUR_BKK)
      due.push({ source: 'PRE_CLOSE' });
    if (!due.length) return 0;
    return this.prisma.platform.$transaction(async (db) => {
      await db.$executeRaw`SELECT pg_advisory_xact_lock(8, hashtext(${RECONCILE_JOB}))`;
      const rows = await db.connector.findMany({
        where: { status: 'ACTIVE', healthFailingSince: null, capabilitiesEnabled: { has: CAP } },
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
            where: { id: { in: tenantIds }, status: { in: [...SYNC_TENANT_STATUSES] } },
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
   * - ไม่พบ (NOT_FOUND / null) = REMOTE_MISSING · เลขฝั่ง ERP ชี้ไปเอกสารที่ไม่ใช่ของใบนี้ (error ที่มี `mismatched`) = MISMATCH MONEY
   *   `remote_ref_mismatch` · error อื่นโยนต่อ (sink แปลงเป็นผลของคำสั่งตาม ErrorClass)
   * - เทียบได้เฉพาะเมื่อ adapter ประกาศ `comparableDocument` และมีฐานของการส่ง (`result.reconcileBasis`) — ไม่งั้น NOT_COMPARABLE (INFO ครั้งเดียว)
   */
  async deliver(
    d: OutboxDelivery,
    x: { connector: Connector; adapter: ErpAdapter; ctx: ErpContext; ref: ExternalRef },
  ): Promise<{ result: Record<string, unknown> }> {
    const rc = reconcileOf(d.payload)!;
    const { connector, adapter, ctx, ref } = x;
    const exp = await d.withTx((tx) => this.expected(tx, d, connector, adapter, ctx));
    let got: CanonicalDocument | null = null;
    let refMismatch: { externalId: string; expectedRef: string; actualRef: string | null }[] = [];
    try {
      got = await adapter.fetchDocument!(ctx, ref, exp.hint ?? undefined);
    } catch (e) {
      // ST8-T09 `ExternalPartsError`: เอกสารที่อ่านได้มีเลขอ้างอิงของเราไม่ตรง (ไม่ใช่ของใบนี้) → remote_ref_mismatch
      // (ไม่พบอย่างเดียว = NOT_FOUND → REMOTE_MISSING)
      if (e instanceof ExternalPartsError && e.mismatched.length)
        refMismatch = e.mismatched.map((m) => ({
          externalId: m.externalId,
          expectedRef: m.expectedRef,
          actualRef: m.actualRef ?? null,
        }));
      else if (!(e instanceof ErpAdapterError && e.errorClass === 'NOT_FOUND')) throw e;
    }
    const runAt = this.clock.now();
    const number = exp.number ?? ref.number;
    let outcome: DocumentOutcome;
    let totalSkipped: string | null = null;
    if (refMismatch.length) outcome = { kind: 'REF_MISMATCH', mismatched: refMismatch };
    else if (!got) outcome = { kind: 'REMOTE_MISSING', externalId: ref.externalId ?? '' };
    else if (!exp.comparable)
      outcome = { kind: 'NOT_COMPARABLE', reason: exp.problem ?? 'not_comparable' };
    else {
      const cmp = compareDocuments(exp.comparable, got, { onlyLocalPaths: exp.olderCanonical });
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
          local: { number, lines: lines(exp.comparable ?? exp.hint) },
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
          ...(outcome.kind === 'NOT_COMPARABLE' ? { code: outcome.reason } : {}),
          ...(totalSkipped ? { totalSkipped } : {}),
        },
      },
    };
  }

  /**
   * คำสั่งอ่านของ reconcile จบแบบไม่สำเร็จ (FAILED_FINAL — ลองครบแล้วปลายทางยังล่ม) → ERP_UNREACHABLE (INFO)
   * ไม่เปลี่ยนผลกระทบยอดของใบ · SKIPPED (capability/sandbox/connector ยกเลิก) = ไม่บันทึก
   * review b: รอบที่ 2 ติดกัน (แถวเดิมยังเปิด) → แจ้งผู้ดูแลการเชื่อมต่อฝั่ง TMS ครั้งเดียวต่อแถว (audit `reconcile.unreachable_notified`)
   */
  async onSettled(c: SettledCommand): Promise<void> {
    const rc = reconcileOf(c.payload);
    if (!rc || c.status !== 'FAILED_FINAL' || !c.targetId) return;
    if (c.errorClass !== 'TRANSIENT' && c.errorClass !== 'AMBIGUOUS') return;
    const connectorId = c.targetId;
    const ref = (c.payload as { ref?: { number?: unknown } }).ref;
    const number = typeof ref?.number === 'string' ? ref.number : null;
    await this.db.withTenant(c.tenantId, async (tx) => {
      const row = await tx.connector.findUnique({ where: { id: connectorId } });
      if (!row) return;
      await requestContext.run(this.actor(c.tenantId, row, `outbox:${c.id}`, tx), async () => {
        const res = await this.results.recordDocumentOutcome(tx, c.tenantId, {
          connectorId,
          adapterKey: row.adapterKey,
          entityType: 'INVOICE',
          localId: c.localId,
          localNumber: number,
          source: rc.source,
          runAt: this.clock.now(),
          outcome: { kind: 'ERP_UNREACHABLE', errorClass: c.errorClass },
          outboxId: c.id,
          local: { number },
          remote: { found: null, errorClass: c.errorClass, code: c.code },
        });
        if (!res.repeated || !res.id) return;
        const told = await tx.auditLog.findFirst({
          where: { action: 'reconcile.unreachable_notified', entityId: res.id },
          select: { id: true },
        });
        if (told) return;
        await this.audit.record({
          action: 'reconcile.unreachable_notified',
          entityType: 'reconcile_result',
          entityId: res.id,
          after: { connector: row.adapterKey, invoiceNo: number },
        });
        await this.events.reconcileUnreachable(tx, {
          tenantId: c.tenantId,
          connectorId,
          label: this.connectors.adapterLabel(row.adapterKey),
          invoiceNo: number,
        });
      });
    });
  }

  /**
   * เอกสารที่คาด (review 3): payload ฉบับที่ออก ของคำสั่งส่งล่าสุดที่สำเร็จ + **ฐานของการส่ง** (`result.reconcileBasis` — รหัส/ค่าตั้งที่ใส่
   * ณ ตอนส่งจริง) → `comparableDocument` ของ adapter · ไม่ resolve รหัส/ค่าตั้งปัจจุบันใหม่ (แก้ mapping หลังส่ง ≠ ERP ต่าง)
   * เทียบไม่ได้ (`problem`): adapter ไม่ประกาศ `comparableDocument` · ไม่มีคำสั่งส่งที่มีฐาน (เช่น คนกรอกเลขฝั่ง ERP เอง / ส่งก่อน deploy) ·
   * adapter สร้างส่วนที่เทียบได้ไม่ได้ · canonical ฉบับเก่ากว่า `CANONICAL_VERSION` = ไม่เทียบช่องที่ฉบับนั้นไม่มี
   */
  private async expected(
    tx: Tx,
    d: OutboxDelivery,
    connector: Connector,
    adapter: ErpAdapter,
    ctx: ErpContext,
  ): Promise<Expected> {
    const pushes = await tx.integrationOutbox.findMany({
      where: {
        sink: SINK,
        targetId: connector.id,
        operation: { in: ['PUSH_INVOICE', 'REPLACE_DOCUMENT'] },
        entityType: ENTITY,
        localId: d.localId,
        status: 'DONE',
      },
      orderBy: { seq: 'desc' },
      take: 20,
      select: { payload: true, result: true },
    });
    const last = pushes.find((p) =>
      parseReconcileBasis((p.result as { reconcileBasis?: unknown } | null)?.reconcileBasis),
    );
    const doc =
      (last?.payload as { document?: CanonicalDocument } | null)?.document ??
      (pushes[0]?.payload as { document?: CanonicalDocument } | null)?.document ??
      null;
    const base = {
      hint: doc,
      number: typeof doc?.number === 'string' ? doc.number : null,
      olderCanonical: false,
    };
    if (!adapter.comparableDocument)
      return { ...base, comparable: null, problem: 'adapter_not_comparable' };
    const basis = parseReconcileBasis(
      (last?.result as { reconcileBasis?: unknown } | null)?.reconcileBasis,
    );
    if (!doc || !basis) return { ...base, comparable: null, problem: 'no_push_basis' };
    // ST8-T13 ใบออกใหม่ที่แทนที่เอกสารของใบเดิม: ระบบบัญชีเห็นเลขอ้างอิงของใบเดิม (`detail.externalRef`) — เทียบด้วยเลขนั้น
    const m = await tx.externalMapping.findUnique({
      where: {
        connectorId_entityType_localId: {
          connectorId: connector.id,
          entityType: 'INVOICE',
          localId: d.localId,
        },
      },
      select: { detail: true },
    });
    const seenRef = externalRefOf(m?.detail);
    const applied = applyReconcileBasis(seenRef ? { ...doc, number: seenRef } : doc, basis, ctx);
    const pii = await injectPersonalData(tx, applied.doc, adapter.personalDataNeeds ?? []);
    let comparable: CanonicalDocument | null;
    try {
      comparable = adapter.comparableDocument(applied.ctx, pii.document);
    } catch {
      comparable = null;
    }
    return {
      hint: pii.document,
      number: base.number,
      comparable,
      problem: comparable ? null : 'comparable_unavailable',
      olderCanonical: basis.canonicalVersion < CANONICAL_VERSION,
    };
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
