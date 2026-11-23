import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CONNECTOR_KEY_RE } from '@tms/domain';
import { AuditService } from '../../audit/audit.service';
import { Clock } from '../../common/clock';
import { iEquals } from '../../common/ilike';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { PrismaService } from '../../db/prisma.service';
import { JobQueue } from '../../jobs/job-queue.service';
import { EntitlementService } from '../entitlements/entitlement.service';
import { ConnectorResolver } from '../erp/connector-resolver';
import { ConnectorsService, redactSecrets } from '../erp/connectors.service';
import { ErpAdapterError } from '../erp/erp-adapter';
import { OrderIntakeService } from '../orders/order-intake.service';
import { OrderStateService } from '../orders/order-state.service';
import { bangkokToday } from '../vehicle-documents/expiry';
import {
  externalCodes,
  externalKey,
  fallbackInput,
  mapExternalOrder,
  minimalOrder,
  show,
  type MappedOrder,
  type MappedRefs,
} from './connector-mapping';
import { NotificationEvents } from '../notifications/notification-events';
import { OrderSourceRegistry } from './order-source-registry';
import type { ExternalOrder, PullPage, PullProblem } from './order-source.port';

export const CONNECTOR_PULL_JOB = 'connector.pull';
/** จำนวนใบต่อหน้าที่ขอจาก adapter */
export const PULL_PAGE_SIZE = 50;
/** หน้าสูงสุดต่อรอบ (ที่เหลือรอบถัดไป — ไม่ถือ lease นานเกิน) */
export const PULL_MAX_PAGES = 20;
/** lease ของรอบดึง — worker ตายกลางรอบ รอบถัดไปหยิบต่อได้หลังหมดอายุ */
export const PULL_LEASE_MS = 5 * 60_000;
/** ใบที่มีผลใน audit สรุปรอบ */
const AUDIT_ITEMS = 100;
/** ผลรายใบที่เก็บใน last_result (ไม่รวมใบที่ไม่เปลี่ยน) */
const MAX_STORED_RESULTS = 200;

/**
 * ผลต่อใบ: created/updated/unchanged = เข้าระบบแล้ว (ดู `status`/`holds`) ·
 * source_changed = ใบวางแผนแล้วและต้นทางแก้ช่องที่ล็อก → **ไม่ทับ** เก็บชุดรอคนรับ/ไม่รับ (SOURCE_CHANGED_AFTER_PLAN + diff — ST3-T10)
 *   (ส่งชุดเดิมซ้ำ / ชุดที่คนไม่รับแล้ว = unchanged + `reason`) ·
 * conflict = externalId เดียวกันเป็นของช่องทางอื่น (409 `external_id_conflict` — ไม่ทับ) ·
 * locked = ใบปิด/ยกเลิกแล้ว หรือใบสำรองที่แก้ช่องที่ล็อก (409 `order_locked_for_update` — ไม่ทับ ไม่เก็บ diff) ·
 * error = ล้มเหลวที่ไม่คาดคิด (เช่น ฐานข้อมูล) → ไม่เลื่อน cursor รอบหน้าดึงซ้ำ (ไม่ทิ้งใบ) ·
 * ST8-T05 ต้นทางยกเลิกใบ (`ExternalOrder.cancelled`): cancelled = ยกเลิกใน TMS แล้ว (ยังไม่มี DO) ·
 * cancel_alert = มี DO แล้ว ไม่ยกเลิก แจ้งเตือนผู้วางแผน · skipped = ยังไม่มีใบใน TMS (ไม่สร้าง)
 */
export type PullOutcome =
  | 'created'
  | 'updated'
  | 'unchanged'
  | 'source_changed'
  | 'conflict'
  | 'locked'
  | 'cancelled'
  | 'cancel_alert'
  | 'skipped'
  | 'error';

export interface PullItemResult {
  externalId: string;
  outcome: PullOutcome;
  orderId?: string;
  soNo?: string | null;
  status?: string;
  /** เหตุค้าง (ตัวแรก = reason code บนใบ) */
  holds?: string[];
  /** จำนวนปัญหาของข้อมูลต้นทาง (sourceIssues) */
  sourceIssues?: number;
  warnings?: string[];
  /** รับเป็นใบสำรอง (upsert ปฏิเสธรูปแบบครั้งแรก) */
  fallback?: boolean;
  /** ชุดการเปลี่ยนแปลงจากต้นทาง (ST3-T10) — source_changed / unchanged ที่เป็นชุดเดิม */
  sourceChangeId?: string;
  /** เหตุที่ unchanged: ชุดเดิมยังรอตัดสิน / ชุดนี้คนไม่รับไปแล้ว · ST8-T05 ต้นทางยกเลิกใบ (cancelled/cancel_alert/skipped/unchanged) */
  reason?: 'source_change_pending' | 'source_change_rejected' | 'source_cancelled';
  error?: { code: string; message: string };
}

export type PullCounts = Record<PullOutcome, number> & { held: number; total: number };

/**
 * ข้ามรอบ: `in_progress` = มีรอบอื่นถือ lease · (ดึงผ่าน connector — ST7-T14) `connector_not_active` = ไม่ใช่ ACTIVE ·
 * `pull_not_enabled` = adapter ไม่รองรับ/tenant ไม่เปิด `pullOrders` · `adapter_unavailable` = adapter ไม่ได้ติดตั้ง ·
 * `feature_off` = แพ็กเกจไม่มี `conn`
 */
export type PullSkip =
  | 'in_progress'
  | 'connector_not_active'
  | 'pull_not_enabled'
  | 'adapter_unavailable'
  | 'feature_off'
  /** ST8-T03 adapter ประกาศ pullOrders แต่ยังไม่ได้ทำ (`ErpAdapterError` CAPABILITY — เช่นโครง adapter `krs` ก่อน ST8-T04) */
  | 'not_implemented';

export interface PullRunResult {
  /** รหัส adapter (ป้ายที่มา `ERP:{key}`) */
  connector: string;
  /** connector id (uuid) — null = ต้นทางทดสอบตามรหัส (`mock`) */
  connectorId?: string | null;
  skipped?: PullSkip;
  pages: number;
  cursor: string | null;
  counts: PullCounts;
  results: PullItemResult[];
  /** ดึงจากต้นทางไม่สำเร็จ */
  sourceError?: string;
  /** ST8-T04 คำเตือนจากต้นทางที่ไม่หยุดรอบ (`PullPage.warnings`) */
  warnings?: string[];
}

/** Prisma: ต่อฐานไม่ได้ / pool เต็ม / transaction หมดเวลา / deadlock-serialization */
const TRANSIENT_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2028', 'P2034']);

/** ข้อผิดพลาดชั่วคราวของระบบ (ไม่ใช่ข้อมูล) — ใบนั้นได้ผล `error` ไม่เลื่อน cursor รอบหน้าลองใหม่ */
export function isTransient(e: unknown): boolean {
  if (e instanceof ProblemException) return e.code === 'concurrent_update';
  if (
    e instanceof Prisma.PrismaClientInitializationError ||
    e instanceof Prisma.PrismaClientRustPanicError
  )
    return true;
  if (e instanceof Prisma.PrismaClientKnownRequestError) return TRANSIENT_CODES.has(e.code);
  const msg = e instanceof Error ? e.message : '';
  return /ECONNREFUSED|ECONNRESET|Connection terminated|Can't reach database|deadlock detected|could not serialize/i.test(
    msg,
  );
}

/** ตรวจรูปหน้าที่ adapter คืน — null = ใช้ได้ */
export function pageShapeError(page: unknown, cursor: string | null, limit: number): string | null {
  const p = page as Partial<PullPage> | null | undefined;
  if (!p || typeof p !== 'object' || !Array.isArray(p.orders))
    return 'invalid page from source: orders must be an array';
  if (p.orders.length > limit)
    return `invalid page from source: ${p.orders.length} orders > limit ${limit}`;
  if (p.nextCursor !== null && p.nextCursor !== undefined && typeof p.nextCursor !== 'string')
    return 'invalid page from source: nextCursor must be a string or null';
  if (typeof p.hasMore !== 'boolean') return 'invalid page from source: hasMore must be a boolean';
  if (p.hasMore && (p.nextCursor ?? cursor) === cursor)
    return 'invalid page from source: hasMore without advancing cursor';
  if (p.problem !== undefined && p.problem !== null) {
    const q = p.problem as Partial<PullProblem>;
    if (
      typeof q !== 'object' ||
      (q.errorClass !== 'VALIDATION' && q.errorClass !== 'AUTH') ||
      typeof q.code !== 'string' ||
      !q.code ||
      typeof q.message !== 'string'
    )
      return 'invalid page from source: problem must be {errorClass, code, message}';
  }
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ต้นทางของรอบดึง — ต้นทางทดสอบตามรหัส (OrderSourceRegistry) หรือ connector ของ tenant (ErpAdapter — ST7-T14) */
interface PullSource {
  /** รหัส adapter — ป้ายที่มา `ERP:{key}` + ผู้กระทำ `connector:{key}` */
  key: string;
  /** null = ต้นทางทดสอบตามรหัส (cursor ต่อรหัส) */
  connectorId: string | null;
  pullOrders(since: string | null, limit: number): Promise<PullPage>;
  /** ค่า credential สำหรับตัดออกจากข้อความ error */
  secrets: string[];
}

const emptyCounts = (): PullCounts => ({
  created: 0,
  updated: 0,
  unchanged: 0,
  source_changed: 0,
  conflict: 0,
  locked: 0,
  cancelled: 0,
  cancel_alert: 0,
  skipped: 0,
  error: 0,
  held: 0,
  total: 0,
});

/**
 * ทางเข้าจาก connector (ST3-T05; docs/04 C "รับจาก ERP connector", docs/01 §6.1 `pullOrders`)
 *
 * - ดึงจาก `OrderSourcePort` ของ connector (ไม่ผูก ERP — registry หา adapter จากรหัส) ทีละหน้า **นอก transaction**
 * - ทีละใบ: transaction ของ tenant + requestContext ผู้กระทำระบบ `connector:{key}` → แปลงด้วย `mapExternalOrder`
 *   → `OrderIntakeService.upsertOrder` (ทางเดียวกับ API — ไม่มีทางลัด) · ใบหนึ่งล้มไม่ย้อนใบอื่น
 * - **ทุกใบเข้าระบบ**: ข้อมูลผิดรูป → ใบค้าง SOURCE_ERROR + sourceIssues; ลูกค้า/สถานที่ไม่รู้จัก → CUSTOMER/LOCATION_UNMAPPED;
 *   upsert ยังปฏิเสธรูปแบบ (422) → ใบสำรอง (หัวใบ + จุดเป็นข้อความ) · ข้อยกเว้นที่ไม่ทับข้อมูล: conflict / locked (บันทึกผล + log)
 * - ใบวางแผนแล้วที่ต้นทางแก้ช่องที่ล็อก → `upsertOrder` เก็บชุดรอตัดสิน (ไม่ทับ) = ผล source_changed (ST3-T10)
 *   ใบสำรองห้ามเก็บชุด (`forbidStaging`) — ข้อมูลลดรูปไม่ขึ้นเป็น diff ให้คนรับทับใบที่วางแผนแล้ว → locked
 * - idempotent: externalId เดิม + ข้อมูลเดิม = unchanged (hash ใน upsertOrder) — ดึงซ้ำไม่เกิดใบซ้ำ
 * - cursor (`connector_cursor`) ต่อ connector id (ดึงผ่าน connector — ST7-T14) หรือต่อรหัส (ต้นทางทดสอบ `mock`)
 *   เลื่อนเมื่อทุกใบในหน้าได้ผลสุดท้าย (มี error = ไม่เลื่อน, job ลองใหม่)
 * - ต้นทาง: `pullConnector` = แถว connector ของ tenant → ErpAdapterRegistry (`ErpAdapter.pullOrders`, ST7-T14) ·
 *   `pull` = ต้นทางทดสอบตามรหัสจาก OrderSourceRegistry (dev/test เท่านั้น)
 * - lease ในแถว cursor กันสองรอบดึงพร้อมกัน (รอบที่สองได้ `skipped: in_progress`)
 * - ไม่มี endpoint — สั่งผ่าน job `connector.pull` (`ConnectorPullScheduler` ทุก 5 นาที) + audit สรุปรอบ
 */
@Injectable()
export class ConnectorIntakeService implements OnModuleInit {
  private readonly logger = new Logger('ConnectorIntake');

  constructor(
    private readonly db: DbService,
    private readonly prisma: PrismaService,
    private readonly queue: JobQueue,
    private readonly intake: OrderIntakeService,
    private readonly registry: OrderSourceRegistry,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly connectors: ConnectorsService,
    private readonly resolver: ConnectorResolver,
    private readonly entitlements: EntitlementService,
    private readonly events: NotificationEvents,
    private readonly orderState: OrderStateService,
  ) {}

  onModuleInit() {
    this.queue.register(
      CONNECTOR_PULL_JOB,
      async ({ tenantId, job }) => {
        const p = (job.payload ?? {}) as { connector?: unknown; connectorId?: unknown };
        if (!(await this.tenantActive(tenantId))) return { skipped: 'tenant_inactive' };
        let r: PullRunResult;
        if (p.connectorId !== undefined) {
          // ST7-T14: ดึงผ่านแถว connector (ErpAdapter) — cursor ต่อ connector id
          if (typeof p.connectorId !== 'string' || !UUID_RE.test(p.connectorId))
            throw new Error('connector.pull: invalid connector id');
          r = await this.pullConnector(tenantId, p.connectorId);
        } else {
          if (typeof p.connector !== 'string' || !CONNECTOR_KEY_RE.test(p.connector))
            throw new Error('connector.pull: invalid connector key');
          r = await this.pull(tenantId, p.connector);
        }
        const key = r.connector;
        // ใบที่ error / ต้นทางล่ม → ให้ JobQueue ลองใหม่ (cursor ไม่เลื่อน — ดึงซ้ำได้ใบเดิม)
        if (r.sourceError) throw new Error(`connector ${key}: source failed — ${r.sourceError}`);
        if (r.counts.error) throw new Error(`connector ${key}: ${r.counts.error} order(s) failed`);
        return {
          connector: key,
          ...(r.connectorId ? { connectorId: r.connectorId } : {}),
          pages: r.pages,
          counts: r.counts,
          skipped: r.skipped ?? null,
        };
      },
      { outsideTransaction: true },
    );
  }

  /** สั่งดึงจากต้นทางทดสอบตามรหัส (`mock` — dev/test) ใน transaction ของผู้เรียก */
  enqueue(tx: Tx, tenantId: string, connector: string) {
    if (!CONNECTOR_KEY_RE.test(connector)) throw new Error('invalid connector key');
    return this.queue.enqueue(tx, {
      tenantId,
      type: CONNECTOR_PULL_JOB,
      payload: { connector },
    });
  }

  /** สั่งดึงผ่าน connector (ST7-T14 — scheduler `ConnectorPullScheduler` เรียกทุก 5 นาที) */
  enqueueConnector(tx: Tx, tenantId: string, connectorId: string) {
    if (!UUID_RE.test(connectorId)) throw new Error('invalid connector id');
    return this.queue.enqueue(tx, {
      tenantId,
      type: CONNECTOR_PULL_JOB,
      payload: { connectorId },
    });
  }

  /** ดึงหนึ่งรอบจากต้นทางทดสอบตามรหัส (OrderSourceRegistry — `mock` ใน dev/test) */
  async pull(
    tenantId: string,
    connector: string,
    opts: { pageSize?: number; maxPages?: number } = {},
  ): Promise<PullRunResult> {
    if (!CONNECTOR_KEY_RE.test(connector)) throw new Error('invalid connector key');
    const port = this.registry.get(connector);
    if (!port) throw new Error(`connector '${connector}' is not registered`);
    // ไม่มี tenant / ถูกระงับ → ไม่ดึง (ไม่สร้างแถว cursor ให้ tenant ที่ไม่มี)
    if (!(await this.tenantActive(tenantId)))
      throw new Error(`tenant ${tenantId} is not active — pull refused`);
    return this.run(
      tenantId,
      {
        key: connector,
        connectorId: null,
        pullOrders: (since, limit) => port.pullOrders({ tenantId }, since, limit),
        secrets: [],
      },
      opts,
    );
  }

  /**
   * ดึงหนึ่งรอบผ่าน connector ของ tenant (ST7-T14; docs/01 §6.1 `pullOrders` "scheduler ทุก N นาทีต่อ connector ที่เปิด")
   * ดึงเมื่อ: แพ็กเกจมี `conn` + connector ACTIVE + adapter ติดตั้ง + `pullOrders` ใช้ได้จริง (adapter ∩ tenant เปิด)
   * ไม่เข้าเงื่อนไข = `skipped` (ไม่ใช่ error — job ไม่ลองซ้ำ) · cursor ต่อ connector id · ข้อความ error ตัด credential
   */
  async pullConnector(
    tenantId: string,
    connectorId: string,
    opts: { pageSize?: number; maxPages?: number } = {},
  ): Promise<PullRunResult> {
    const mode = await this.tenantMode(tenantId);
    if (!mode) throw new Error(`tenant ${tenantId} is not active — pull refused`);
    const row = await this.db.withTenant(tenantId, (tx) =>
      tx.connector.findUnique({ where: { id: connectorId } }),
    );
    if (!row) throw new Error(`connector ${connectorId} not found`);
    const skip = (skipped: PullSkip): PullRunResult => ({
      connector: row.adapterKey,
      connectorId,
      skipped,
      pages: 0,
      cursor: null,
      counts: emptyCounts(),
      results: [],
    });
    if (!(await this.entitlements.enabled(tenantId, 'conn'))) return skip('feature_off');
    if (row.status !== 'ACTIVE') return skip('connector_not_active');
    // D68-58/96 sandbox ดึงได้เฉพาะจาก DemoProvider (ERP จำลอง) · demo ใน production = เฉพาะ sandbox
    const r = this.resolver.describe(row, null, undefined, mode === 'test');
    if (!r.adapter) return skip('adapter_unavailable');
    if (!r.capabilities.includes('pullOrders') || !r.adapter.pullOrders)
      return skip('pull_not_enabled');
    const adapter = r.adapter;
    const ctx = this.connectors.contextOf(row);
    return this.run(
      tenantId,
      {
        key: row.adapterKey,
        connectorId,
        pullOrders: (since, limit) => adapter.pullOrders!(ctx, since, limit),
        secrets: row.credentialKeys.map((k) => ctx.config[k] ?? ''),
      },
      opts,
    );
  }

  /** หนึ่งรอบ: หลายหน้าจนหมดหรือครบ maxPages */
  private async run(
    tenantId: string,
    source: PullSource,
    opts: { pageSize?: number; maxPages?: number },
  ): Promise<PullRunResult> {
    const connector = source.key;
    const pageSize = opts.pageSize ?? PULL_PAGE_SIZE;
    const maxPages = opts.maxPages ?? PULL_MAX_PAGES;
    const leaseId = randomUUID();
    const run: PullRunResult = {
      connector,
      ...(source.connectorId ? { connectorId: source.connectorId } : {}),
      pages: 0,
      cursor: null,
      counts: emptyCounts(),
      results: [],
    };

    const claimed = await this.db.withTenant(tenantId, (tx) =>
      this.claim(tx, tenantId, source, leaseId),
    );
    if (!claimed) return { ...run, skipped: 'in_progress' };
    run.cursor = claimed.cursor;

    let ownLease = true;
    try {
      for (let page = 0; page < maxPages; page++) {
        let got;
        try {
          got = await source.pullOrders(run.cursor, pageSize);
        } catch (e) {
          // ST8-T03 capability ที่ adapter ยังไม่ได้ทำ = ข้ามรอบ (ไม่ใช่ต้นทางล่ม — ไม่ลองใหม่ ไม่เลื่อน cursor)
          if (e instanceof ErpAdapterError && e.errorClass === 'CAPABILITY') {
            run.skipped = 'not_implemented';
            break;
          }
          // ข้อความจาก adapter อาจมี credential (URL/header ของ HTTP client) → ตัดก่อนเก็บ/log
          run.sourceError = redactSecrets(
            e instanceof Error ? e.message : show(e),
            source.secrets,
          ).slice(0, 500);
          this.logger.warn(
            `tenant ${tenantId} connector ${connector}: pull failed — ${run.sourceError}`,
          );
          // ST8-T04 key ผิด (AUTH) / ต้นทางผิดโครงสร้าง (VALIDATION เช่น view หาย) = ลองซ้ำไม่หาย → หยุด connector
          // (docs/01 §6.3 AUTH, A.2 "view หาย → connector ERROR") · TRANSIENT/อื่น ๆ = job ลองใหม่ตามเดิม
          if (
            e instanceof ErpAdapterError &&
            (e.errorClass === 'AUTH' || e.errorClass === 'VALIDATION')
          )
            await this.stopConnector(tenantId, source, {
              errorClass: e.errorClass,
              code: e.problem.code,
              message: run.sourceError,
            });
          // ST8-T04 ปลายทางล่มชั่วคราว (TRANSIENT) นับรวมกติกา 30 นาทีของ spec/07 §1 (เหมือนผล healthCheck ที่ระบบตรวจเอง)
          else if (e instanceof ErpAdapterError && e.errorClass === 'TRANSIENT')
            await this.noteTransient(tenantId, source, e.problem.code, run.sourceError);
          break;
        }
        // รูปหน้าที่ adapter คืนต้องถูก — ผิด = ต้นทางผิดพลาด (ไม่รับหน้า ไม่เลื่อน cursor; hasMore ที่ไม่เลื่อน = วนไม่จบ)
        const shapeError = pageShapeError(got, run.cursor, pageSize);
        if (shapeError) {
          run.sourceError = shapeError;
          this.logger.warn(`tenant ${tenantId} connector ${connector}: ${shapeError}`);
          break;
        }
        run.pages += 1;
        if (got.warnings?.length)
          run.warnings = [
            ...(run.warnings ?? []),
            ...got.warnings.map((w) => redactSecrets(String(w), source.secrets).slice(0, 300)),
          ].slice(0, 20);
        const today = bangkokToday(this.clock.now());
        let pageErrors = 0;
        // ST9-T08: ใบค้างของหน้านี้แจ้งรวมฉบับเดียว (ไม่ใช่ทีละใบ) — แจ้งไม่สำเร็จไม่กระทบใบที่รับแล้ว
        const { held } = await this.events.batchOrderHolds(async () => {
          for (const ext of got.orders) {
            const r = await this.intakeOne(tenantId, connector, leaseId, ext, today);
            run.counts[r.outcome] += 1;
            run.counts.total += 1;
            if (r.status === 'ON_HOLD') run.counts.held += 1;
            if (r.outcome === 'error') pageErrors += 1;
            run.results.push(r);
          }
        });
        if (held.length)
          await this.db
            .withTenant(tenantId, (tx) => this.events.flushOrderHolds(tx, tenantId, held))
            .catch((e) =>
              this.logger.warn(
                `tenant ${tenantId} connector ${connector}: hold notify failed — ${show(e)}`,
              ),
            );
        // ST8-T04 ต้นทางแจ้งปัญหาโครงสร้าง: รับใบแล้ว (ค้าง SOURCE_ERROR) แต่ไม่เลื่อน cursor + หยุด connector
        // (แก้ต้นทางแล้วเปิดใช้ → ดึงหน้าเดิมซ้ำได้ข้อมูลครบ ทับใบค้างเดิม)
        if (got.problem) {
          const problem = {
            errorClass: got.problem.errorClass,
            code: got.problem.code.slice(0, 60),
            message: redactSecrets(
              `${got.problem.code}: ${got.problem.message}`,
              source.secrets,
            ).slice(0, 500),
          };
          run.sourceError = problem.message;
          this.logger.warn(`tenant ${tenantId} connector ${connector}: ${problem.message}`);
          await this.stopConnector(tenantId, source, problem);
          break;
        }
        // หน้านี้มีใบที่ไม่ได้ผลสุดท้าย → ไม่เลื่อน cursor (รอบหน้าดึงหน้าเดิมซ้ำ — idempotent)
        if (pageErrors) break;
        const next = got.nextCursor ?? run.cursor;
        ownLease = await this.db.withTenant(tenantId, (tx) =>
          this.saveCursor(tx, tenantId, source, leaseId, next),
        );
        if (!ownLease) {
          this.logger.warn(`tenant ${tenantId} connector ${connector}: lease lost — stop`);
          break;
        }
        run.cursor = next;
        if (!got.hasMore) break;
      }
    } finally {
      if (ownLease) await this.finish(tenantId, source, leaseId, run);
    }
    return run;
  }

  /** ใบเดียว → upsertOrder ใน transaction ของตัวเอง (ล้มแล้วไม่ย้อนใบอื่น) */
  async intakeOne(
    tenantId: string,
    connector: string,
    runId: string,
    ext: ExternalOrder,
    today: string,
  ): Promise<PullItemResult> {
    // ST8-T05 ต้นทางยกเลิกใบ → ยกเลิก/แจ้งเตือน (ไม่ upsert ข้อมูลของใบที่ยกเลิกแล้ว)
    if (ext?.cancelled === true) return this.cancelOne(tenantId, connector, runId, ext);
    let mapped: MappedOrder | null = null;
    const label = () => mapped?.input.externalId ?? String(ext?.externalId ?? '');
    /** `recover` = ข้อผิดพลาดของรอบแรก → รับเป็นใบสำรอง (หัวใบ + จุดข้อความ + ปัญหา) */
    const attempt = (recover: { errors: string[]; cause: unknown } | null) =>
      this.db.withTenant(tenantId, (tx) =>
        requestContext.run(
          {
            requestId: `connector:${connector}:${runId}`,
            tenantId,
            // ผู้กระทำระบบ — audit/ประวัติสถานะ/domain event ชี้ว่าใบมาจาก connector ไหน
            actorId: `connector:${connector}`,
            principalType: 'connector',
            scopes: [],
            locale: 'th',
            tx,
          },
          async () => {
            let m = mapped;
            if (!m && !recover) {
              // จับคู่รหัส (อ่านฐานข้อมูล — ล้ม = ข้อผิดพลาดของระบบ ไม่ใช่ข้อมูล)
              let refs: MappedRefs | null = null;
              try {
                refs = await this.refs(tx, ext ?? ({} as ExternalOrder));
              } catch (e) {
                if (isTransient(e)) throw e;
              }
              try {
                m = mapExternalOrder(
                  ext ?? ({} as ExternalOrder),
                  connector,
                  refs ?? { customerId: null, sites: new Map(), vehicleTypes: new Map() },
                  today,
                );
              } catch (e) {
                // ข้อมูลพิษ (แปลงไม่ได้เลย) → ใบขั้นต่ำ SOURCE_ERROR — ไม่ใช่ error ของระบบ ไม่ค้าง cursor
                this.logger.warn(
                  `tenant ${tenantId} connector ${connector}: unreadable order — minimal (${show(
                    e instanceof Error ? e.message : e,
                  )})`,
                );
                m = minimalOrder(ext ?? ({} as ExternalOrder), connector, today, e);
              }
            }
            if (!m)
              m = minimalOrder(ext ?? ({} as ExternalOrder), connector, today, recover?.cause);
            mapped = m;
            // ต้นทางยังไม่ให้วันรับของ → ใบเดิมคงวันที่เดิม (ไม่เลื่อนเป็นวันที่ดึงทุกรอบ)
            if (m.dateFallback) {
              const cur = await tx.salesOrder.findUnique({
                where: { tenantId_externalId: { tenantId, externalId: m.input.externalId! } },
                select: { requestedDate: true },
              });
              if (cur) m.input.requestedDate = cur.requestedDate.toISOString().slice(0, 10);
            }
            // ST8-T04 ข้อมูลอาจไม่ครบ (holdOnly) หรือรายการน้อยกว่าที่เก็บอยู่ (noLineShrink) → ใบเดิม: ไม่ทับ ตั้งปัญหาอย่างเดียว
            if (!recover && m.input.externalId) {
              const hold = await this.holdIssues(tx, ext, m);
              if (hold) {
                const held = await this.intake.holdFromSource(m.input.externalId, hold, tx);
                if (held) return held;
              }
            }
            // ST8-T05 ต้นทางส่งใบนี้แบบปกติ → ล้างธง "ต้นทางยกเลิก" ของใบที่ยังไม่ถูกยกเลิก (ถ้ามี)
            if (m.input.externalId) await this.intake.clearSourceCancelled(tx, m.input.externalId);
            const input = recover ? fallbackInput(m, recover.errors) : m.input;
            // ใบสำรองแก้ใบที่พ้นช่วงรับงานไม่ได้ (→ 409 locked) — ไม่เก็บข้อมูลลดรูปเป็นชุดรอตัดสิน
            return this.intake.upsertOrder(input, tx, recover ? { forbidStaging: true } : {});
          },
        ),
      );
    const done = (
      r: Awaited<ReturnType<OrderIntakeService['upsertOrder']>>,
      fallback: boolean,
    ): PullItemResult => ({
      externalId: r.order.externalId ?? label(),
      outcome: r.created
        ? 'created'
        : r.sourceChange && r.changed
          ? 'source_changed'
          : r.changed
            ? 'updated'
            : 'unchanged',
      ...(r.sourceChange
        ? {
            sourceChangeId: r.sourceChange.id,
            ...(!r.changed
              ? {
                  reason:
                    r.sourceChange.status === 'REJECTED'
                      ? ('source_change_rejected' as const)
                      : ('source_change_pending' as const),
                }
              : {}),
          }
        : {}),
      orderId: r.order.id,
      soNo: r.order.soNo,
      status: r.order.status,
      holds: r.holds.map((h) => h.code),
      sourceIssues: ((r.order.sourceIssues as string[] | null) ?? []).length,
      ...(mapped?.warnings.length ? { warnings: mapped.warnings } : {}),
      ...(fallback ? { fallback: true } : {}),
    });
    const failed = (e: unknown): PullItemResult => {
      if (e instanceof ProblemException) {
        if (e.code === 'external_id_conflict' || e.code === 'order_locked_for_update') {
          const outcome = e.code === 'external_id_conflict' ? 'conflict' : 'locked';
          this.logger.warn(
            `tenant ${tenantId} connector ${connector}: order ${label()} ${outcome} (${JSON.stringify(
              e.extra ?? {},
            )}${e.errors?.length ? ` ${e.errors.map((x) => x.field).join(',')}` : ''})`,
          );
          return {
            externalId: label(),
            outcome,
            error: {
              code: e.code,
              message: e.errors?.length
                ? e.errors.map((x) => x.field).join(', ')
                : JSON.stringify(e.extra ?? {}),
            },
          };
        }
      }
      const msg = (e instanceof Error ? e.message : show(e)).slice(0, 300);
      this.logger.error(
        `tenant ${tenantId} connector ${connector}: order ${label()} failed — ${msg}`,
      );
      return {
        externalId: label(),
        outcome: 'error',
        error: { code: e instanceof ProblemException ? e.code : 'internal_error', message: msg },
      };
    };

    try {
      return done(await attempt(null), false);
    } catch (e) {
      // ผลสุดท้ายที่ไม่ทับข้อมูล (conflict/locked) และฐานข้อมูลใช้ไม่ได้ชั่วคราว (ลองใหม่รอบหน้า) → ไม่รับเป็นใบสำรอง
      if (
        (e instanceof ProblemException &&
          (e.code === 'external_id_conflict' || e.code === 'order_locked_for_update')) ||
        isTransient(e)
      )
        return failed(e);
      // อย่างอื่น (422 ของ upsert, ข้อมูลที่ฐานข้อมูลปฏิเสธ ฯลฯ) → ใบสำรอง SOURCE_ERROR พร้อมข้อผิดพลาด — ไม่ทิ้งใบ
      const errs =
        e instanceof ProblemException && e.code === 'validation_failed' && e.errors?.length
          ? e.errors.map((x) => `${x.field} ${x.code}`)
          : [
              e instanceof ProblemException
                ? e.code
                : (e instanceof Error ? e.message : show(e)).slice(0, 200),
            ];
      this.logger.warn(
        `tenant ${tenantId} connector ${connector}: order ${label()} rejected (${errs.join(', ')}) — fallback`,
      );
      try {
        return done(await attempt({ errors: errs, cause: e }), true);
      } catch (e2) {
        return failed(e2);
      }
    }
  }

  /**
   * ST8-T05 ใบที่ต้นทางยกเลิก (`ExternalOrder.cancelled`) → `OrderStateService.cancelFromSource` ใน transaction ของใบ
   * (ผู้กระทำ `connector:{key}`) · ฐานข้อมูลใช้ไม่ได้ชั่วคราว = `error` (ไม่เลื่อน cursor) · อื่น ๆ = `error` พร้อมรหัส
   */
  private async cancelOne(
    tenantId: string,
    connector: string,
    runId: string,
    ext: ExternalOrder,
  ): Promise<PullItemResult> {
    const externalId = externalKey(ext, connector).value;
    try {
      const r = await this.db.withTenant(tenantId, (tx) =>
        requestContext.run(
          {
            requestId: `connector:${connector}:${runId}`,
            tenantId,
            actorId: `connector:${connector}`,
            principalType: 'connector',
            scopes: [],
            locale: 'th',
            tx,
          },
          () => this.orderState.cancelFromSource(tx, { externalId, connector }),
        ),
      );
      if (r.outcome === 'cancel_alert')
        this.logger.warn(
          `tenant ${tenantId} connector ${connector}: order ${externalId} cancelled at source but has delivery orders — alerted`,
        );
      return {
        externalId,
        outcome: r.outcome,
        reason: 'source_cancelled',
        ...(r.orderId ? { orderId: r.orderId, soNo: r.soNo ?? null, status: r.status } : {}),
        ...(r.outcome === 'conflict'
          ? { error: { code: 'external_id_conflict', message: 'order belongs to another source' } }
          : {}),
      };
    } catch (e) {
      const msg = (e instanceof Error ? e.message : show(e)).slice(0, 300);
      this.logger.error(
        `tenant ${tenantId} connector ${connector}: cancel ${externalId} failed — ${msg}`,
      );
      return {
        externalId,
        outcome: 'error',
        error: { code: e instanceof ProblemException ? e.code : 'internal_error', message: msg },
      };
    }
  }

  /**
   * ST8-T04 หยุด connector จากปัญหาของรอบดึง (ใช้ `ConnectorsService.markError` ตัวเดียวกับ sink — ACTIVE → ERROR,
   * audit `connector.error`, แจ้งผู้ดูแล, webhook) · ต้นทางทดสอบตามรหัส (ไม่มีแถว connector) = ไม่ทำอะไร · ล้ม = log เท่านั้น
   */
  private async stopConnector(tenantId: string, source: PullSource, problem: PullProblem) {
    if (!source.connectorId) return;
    const connectorId = source.connectorId;
    await this.db
      .withTenant(tenantId, async (tx) => {
        const row = await tx.connector.findUnique({ where: { id: connectorId } });
        if (row)
          await this.connectors.markError(
            tx,
            row,
            { code: problem.code, message: problem.message },
            problem.errorClass,
          );
      })
      .catch((e) =>
        this.logger.warn(
          `tenant ${tenantId} connector ${source.key}: cannot mark ERROR — ${show(e)}`,
        ),
      );
  }

  /**
   * ST8-T04 ปัญหาที่ต้องตั้งบนใบเดิมแทนการทับ — null = upsert ตามปกติ
   * `holdOnly` = ปัญหาของใบ (อย่างน้อย 1 ข้อ) · `noLineShrink` + รายการที่รับได้น้อยกว่าที่เก็บอยู่ = ปัญหา + ข้อความจำนวนรายการ
   */
  private async holdIssues(tx: Tx, ext: ExternalOrder, m: MappedOrder): Promise<string[] | null> {
    const holdOnly = ext?.holdOnly === true;
    if (!holdOnly && ext?.noLineShrink !== true) return null;
    const cur = await tx.salesOrder.findUnique({
      where: {
        tenantId_externalId: {
          tenantId: requestContext.require().tenantId!,
          externalId: m.input.externalId!,
        },
      },
      select: { _count: { select: { lines: true } } },
    });
    if (!cur) return null;
    const got = m.input.lines?.length ?? 0;
    const shrink = cur._count.lines > got;
    if (!holdOnly && !shrink) return null;
    const issues = [...m.issues];
    if (shrink)
      issues.push(
        `ต้นทางส่งรายการสินค้ามา ${got} รายการ น้อยกว่าที่มีอยู่ ${cur._count.lines} รายการ — ไม่ทับข้อมูลเดิม ตรวจกับต้นทาง`,
      );
    if (!issues.length) issues.push('ข้อมูลจากต้นทางอาจไม่ครบ — ไม่ทับข้อมูลเดิม ตรวจกับต้นทาง');
    return issues;
  }

  /** ST8-T04 รอบดึงล้ม TRANSIENT → จดเวลาเริ่มล้ม (ครบ 30 นาที = ERROR; worker ตรวจซ้ำ/กู้คืนเอง — `applySystemHealth`) */
  private async noteTransient(tenantId: string, source: PullSource, code: string, message: string) {
    if (!source.connectorId) return;
    const connectorId = source.connectorId;
    await this.db
      .withTenant(tenantId, (tx) =>
        this.connectors.applySystemHealth(
          tx,
          connectorId,
          { ok: false, errorClass: 'TRANSIENT', problem: { code, message } },
          this.clock.now(),
        ),
      )
      .catch((e) =>
        this.logger.warn(
          `tenant ${tenantId} connector ${source.key}: cannot record transient failure — ${show(e)}`,
        ),
      );
  }

  // ---------------------------------------------------------------------------------------------

  /** จับคู่รหัสต้นทาง (อ่านอย่างเดียว — RLS จำกัด tenant) */
  private async refs(tx: Tx, ext: ExternalOrder): Promise<MappedRefs> {
    const c = externalCodes(ext);
    const customer = c.customer
      ? await tx.customer.findFirst({
          where: { externalId: c.customer, deletedAt: null, status: 'ACTIVE' },
          select: { id: true },
        })
      : null;
    const sites = c.sites.length
      ? await tx.customerSite.findMany({
          where: { externalId: { in: c.sites }, deletedAt: null, status: 'ACTIVE' },
          select: { id: true, externalId: true, customerId: true },
        })
      : [];
    let vehicleType: string | null = null;
    if (c.vehicleType) {
      const vt =
        (await tx.vehicleType.findFirst({
          where: { externalId: c.vehicleType, deletedAt: null, status: 'ACTIVE' },
          select: { id: true },
        })) ??
        (await tx.vehicleType.findFirst({
          where: { code: iEquals(c.vehicleType), deletedAt: null, status: 'ACTIVE' },
          select: { id: true },
        }));
      vehicleType = vt?.id ?? null;
    }
    return {
      customerId: customer?.id ?? null,
      sites: new Map(sites.map((s) => [s.externalId!, { id: s.id, customerId: s.customerId }])),
      vehicleTypes: new Map(vehicleType ? [[c.vehicleType!, vehicleType]] : []),
    };
  }

  /** แถว cursor ของต้นทาง: ต่อ connector id (ST7-T14) หรือต่อรหัสสำหรับต้นทางทดสอบ */
  private cursorWhere(source: PullSource) {
    return source.connectorId
      ? Prisma.sql`connector_id = ${source.connectorId}::uuid`
      : Prisma.sql`connector_id IS NULL AND connector_key = ${source.key}`;
  }

  /** จองรอบดึง: สร้างแถวถ้ายังไม่มี แล้วตั้ง lease เมื่อว่าง/หมดอายุ (UPDATE ล็อกแถว → สองรอบพร้อมกันได้ lease รอบเดียว) */
  private async claim(tx: Tx, tenantId: string, source: PullSource, leaseId: string) {
    // unique บางส่วน 2 ตัว (ต่อ connector / ต่อรหัสเมื่อไม่มี connector — migration 0102) → ON CONFLICT ไม่ระบุคอลัมน์
    await tx.$executeRaw`
      INSERT INTO connector_cursor (id, tenant_id, connector_key, connector_id)
      VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${source.key}, ${source.connectorId}::uuid)
      ON CONFLICT DO NOTHING`;
    const rows = await tx.$queryRaw<{ cursor: string | null }[]>`
      UPDATE connector_cursor
         SET lease_id = ${leaseId}::uuid,
             lease_until = now() + (${PULL_LEASE_MS}::int * interval '1 millisecond'),
             last_pull_at = now(), updated_at = now()
       WHERE tenant_id = ${tenantId}::uuid AND ${this.cursorWhere(source)}
         AND (lease_until IS NULL OR lease_until < now())
      RETURNING cursor`;
    return rows[0] ?? null;
  }

  /** เลื่อน cursor + ต่อ lease — false = lease หลุด (รอบอื่นหยิบไปแล้ว) */
  private async saveCursor(
    tx: Tx,
    tenantId: string,
    source: PullSource,
    leaseId: string,
    cursor: string | null,
  ): Promise<boolean> {
    const n = await tx.$executeRaw`
      UPDATE connector_cursor
         SET cursor = ${cursor},
             lease_until = now() + (${PULL_LEASE_MS}::int * interval '1 millisecond'),
             updated_at = now()
       WHERE tenant_id = ${tenantId}::uuid AND ${this.cursorWhere(source)} AND lease_id = ${leaseId}::uuid`;
    return n === 1;
  }

  /** ปล่อย lease + เก็บสรุปรอบ + audit (เฉพาะรอบที่มีอะไรเกิดขึ้น — ไม่ลง audit ทุก 5 นาทีเมื่อไม่มีใบใหม่) */
  private async finish(tenantId: string, source: PullSource, leaseId: string, run: PullRunResult) {
    const connector = source.key;
    const ok = !run.sourceError && run.counts.error === 0;
    const summary = {
      at: this.clock.now().toISOString(),
      ok,
      pages: run.pages,
      counts: run.counts,
      ...(run.sourceError ? { sourceError: run.sourceError } : {}),
      ...(run.warnings?.length ? { warnings: run.warnings } : {}),
      results: run.results.filter((r) => r.outcome !== 'unchanged').slice(0, MAX_STORED_RESULTS),
    };
    await this.db
      .withTenant(tenantId, (tx) =>
        requestContext.run(
          {
            requestId: `connector:${connector}:${leaseId}`,
            tenantId,
            actorId: `connector:${connector}`,
            principalType: 'connector',
            scopes: [],
            locale: 'th',
            tx,
          },
          async () => {
            const row = await tx.connectorCursor.findFirst({
              where: source.connectorId
                ? { tenantId, connectorId: source.connectorId }
                : { tenantId, connectorKey: connector, connectorId: null },
              select: { id: true, leaseId: true },
            });
            if (!row || row.leaseId !== leaseId) return;
            await tx.connectorCursor.update({
              where: { id: row.id },
              data: {
                leaseId: null,
                leaseUntil: null,
                lastResult: summary as unknown as Prisma.InputJsonValue,
                ...(ok ? { lastSuccessAt: this.clock.now() } : {}),
              },
            });
            const c = run.counts;
            if (c.total - c.unchanged > 0 || !ok || run.warnings?.length)
              await this.audit.record({
                action: 'connector.orders_pulled',
                entityType: 'connector_cursor',
                entityId: row.id,
                after: {
                  connector,
                  ...(source.connectorId ? { connectorId: source.connectorId } : {}),
                  pages: run.pages,
                  cursor: run.cursor,
                  counts: c,
                  ...(run.sourceError ? { sourceError: run.sourceError } : {}),
                  ...(run.warnings?.length ? { warnings: run.warnings } : {}),
                  // ใบที่มีผล (ไม่รวม unchanged) จนกว่าจะมีหน้า error queue (ST7-T19) — จำกัด 100 ใบ
                  items: run.results
                    .filter((r) => r.outcome !== 'unchanged')
                    .slice(0, AUDIT_ITEMS)
                    .map((r) => ({
                      externalId: r.externalId,
                      outcome: r.outcome,
                      ...(r.orderId ? { orderId: r.orderId } : {}),
                      ...(r.error ? { error: r.error.code } : {}),
                    })),
                },
              });
          },
        ),
      )
      .catch((e) =>
        this.logger.warn(`tenant ${tenantId} connector ${connector}: finish failed — ${String(e)}`),
      );
  }

  private async tenantActive(tenantId: string): Promise<boolean> {
    // ST7-T09: ต้นทางทดสอบ (mock) ดึงให้บริษัทจริงเท่านั้น
    return (await this.tenantMode(tenantId)) === 'live';
  }

  /**
   * โหมดของ tenant ที่ยังใช้งานได้ (TRIAL/ACTIVE) — null = ไม่มี/ถูกระงับ (ไม่ดึง)
   * D-81 · D68-58/96: sandbox ดึงผ่าน connector ได้ (เฉพาะ DemoProvider — ตัดสินใน `describe`)
   */
  private async tenantMode(tenantId: string): Promise<'live' | 'test' | null> {
    const t = await this.prisma.platform.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true, mode: true },
    });
    if (!t || (t.status !== 'TRIAL' && t.status !== 'ACTIVE')) return null;
    return t.mode === 'test' ? 'test' : 'live';
  }
}
