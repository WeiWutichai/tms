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
import { OrderIntakeService } from '../orders/order-intake.service';
import { bangkokToday } from '../vehicle-documents/expiry';
import {
  externalCodes,
  fallbackInput,
  mapExternalOrder,
  type MappedOrder,
  type MappedRefs,
} from './connector-mapping';
import { OrderSourceRegistry } from './order-source-registry';
import type { ExternalOrder } from './order-source.port';

export const CONNECTOR_PULL_JOB = 'connector.pull';
/** จำนวนใบต่อหน้าที่ขอจาก adapter */
export const PULL_PAGE_SIZE = 50;
/** หน้าสูงสุดต่อรอบ (ที่เหลือรอบถัดไป — ไม่ถือ lease นานเกิน) */
export const PULL_MAX_PAGES = 20;
/** lease ของรอบดึง — worker ตายกลางรอบ รอบถัดไปหยิบต่อได้หลังหมดอายุ */
export const PULL_LEASE_MS = 5 * 60_000;
/** ผลรายใบที่เก็บใน last_result (ไม่รวมใบที่ไม่เปลี่ยน) */
const MAX_STORED_RESULTS = 200;

/**
 * ผลต่อใบ: created/updated/unchanged = เข้าระบบแล้ว (ดู `status`/`holds`) ·
 * conflict = externalId เดียวกันเป็นของช่องทางอื่น (409 `external_id_conflict` — ไม่ทับ) ·
 * locked = ใบวางแผน/ออกรถแล้วและต้นทางแก้ช่องที่ล็อก (ไม่ทับ — ใบค้าง SOURCE_CHANGED_AFTER_PLAN + diff คือ ST3-T10) ·
 * error = ล้มเหลวที่ไม่คาดคิด (เช่น ฐานข้อมูล) → ไม่เลื่อน cursor รอบหน้าดึงซ้ำ (ไม่ทิ้งใบ)
 */
export type PullOutcome = 'created' | 'updated' | 'unchanged' | 'conflict' | 'locked' | 'error';

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
  error?: { code: string; message: string };
}

export type PullCounts = Record<PullOutcome, number> & { held: number; total: number };

export interface PullRunResult {
  connector: string;
  /** ข้ามเพราะมีรอบอื่นถือ lease อยู่ */
  skipped?: 'in_progress';
  pages: number;
  cursor: string | null;
  counts: PullCounts;
  results: PullItemResult[];
  /** ดึงจากต้นทางไม่สำเร็จ */
  sourceError?: string;
}

const emptyCounts = (): PullCounts => ({
  created: 0,
  updated: 0,
  unchanged: 0,
  conflict: 0,
  locked: 0,
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
 * - idempotent: externalId เดิม + ข้อมูลเดิม = unchanged (hash ใน upsertOrder) — ดึงซ้ำไม่เกิดใบซ้ำ
 * - cursor ต่อ tenant + connector (`connector_cursor`) เลื่อนเมื่อทุกใบในหน้าได้ผลสุดท้าย (มี error = ไม่เลื่อน, job ลองใหม่)
 * - lease ในแถว cursor กันสองรอบดึงพร้อมกัน (รอบที่สองได้ `skipped: in_progress`)
 * - ไม่มี endpoint (docs §5.2 #14 connectors = ST7) — สั่งผ่าน job `connector.pull` + audit สรุปรอบ
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
  ) {}

  onModuleInit() {
    this.queue.register(
      CONNECTOR_PULL_JOB,
      async ({ tenantId, job }) => {
        const key = (job.payload as { connector?: unknown } | null)?.connector;
        if (typeof key !== 'string' || !CONNECTOR_KEY_RE.test(key))
          throw new Error('connector.pull: invalid connector key');
        if (!(await this.tenantActive(tenantId))) return { skipped: 'tenant_inactive' };
        const r = await this.pull(tenantId, key);
        // ใบที่ error / ต้นทางล่ม → ให้ JobQueue ลองใหม่ (cursor ไม่เลื่อน — ดึงซ้ำได้ใบเดิม)
        if (r.sourceError) throw new Error(`connector ${key}: source failed — ${r.sourceError}`);
        if (r.counts.error) throw new Error(`connector ${key}: ${r.counts.error} order(s) failed`);
        return { connector: key, pages: r.pages, counts: r.counts, skipped: r.skipped ?? null };
      },
      { outsideTransaction: true },
    );
  }

  /** สั่งดึง (ใน transaction ของผู้เรียก) — scheduler ต่อ connector ที่เปิด = ST7-T13/ST8-T04 */
  enqueue(tx: Tx, tenantId: string, connector: string) {
    if (!CONNECTOR_KEY_RE.test(connector)) throw new Error('invalid connector key');
    return this.queue.enqueue(tx, {
      tenantId,
      type: CONNECTOR_PULL_JOB,
      payload: { connector },
    });
  }

  /** ดึงหนึ่งรอบ: หลายหน้าจนหมดหรือครบ PULL_MAX_PAGES */
  async pull(
    tenantId: string,
    connector: string,
    opts: { pageSize?: number; maxPages?: number } = {},
  ): Promise<PullRunResult> {
    const port = this.registry.get(connector);
    if (!port) throw new Error(`connector '${connector}' is not registered`);
    const pageSize = opts.pageSize ?? PULL_PAGE_SIZE;
    const maxPages = opts.maxPages ?? PULL_MAX_PAGES;
    const leaseId = randomUUID();
    const run: PullRunResult = {
      connector,
      pages: 0,
      cursor: null,
      counts: emptyCounts(),
      results: [],
    };

    const claimed = await this.db.withTenant(tenantId, (tx) =>
      this.claim(tx, tenantId, connector, leaseId),
    );
    if (!claimed) return { ...run, skipped: 'in_progress' };
    run.cursor = claimed.cursor;

    let ownLease = true;
    try {
      for (let page = 0; page < maxPages; page++) {
        let got;
        try {
          got = await port.pullOrders({ tenantId }, run.cursor, pageSize);
        } catch (e) {
          run.sourceError = String(e instanceof Error ? e.message : e).slice(0, 500);
          this.logger.warn(
            `tenant ${tenantId} connector ${connector}: pull failed — ${run.sourceError}`,
          );
          break;
        }
        run.pages += 1;
        const today = bangkokToday(this.clock.now());
        let pageErrors = 0;
        for (const ext of got.orders) {
          const r = await this.intakeOne(tenantId, connector, leaseId, ext, today);
          run.counts[r.outcome] += 1;
          run.counts.total += 1;
          if (r.status === 'ON_HOLD') run.counts.held += 1;
          if (r.outcome === 'error') pageErrors += 1;
          run.results.push(r);
        }
        // หน้านี้มีใบที่ไม่ได้ผลสุดท้าย → ไม่เลื่อน cursor (รอบหน้าดึงหน้าเดิมซ้ำ — idempotent)
        if (pageErrors) break;
        const next = got.nextCursor ?? run.cursor;
        ownLease = await this.db.withTenant(tenantId, (tx) =>
          this.saveCursor(tx, tenantId, connector, leaseId, next),
        );
        if (!ownLease) {
          this.logger.warn(`tenant ${tenantId} connector ${connector}: lease lost — stop`);
          break;
        }
        run.cursor = next;
        if (!got.hasMore) break;
      }
    } finally {
      if (ownLease) await this.finish(tenantId, connector, leaseId, run);
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
    let mapped: MappedOrder | null = null;
    const label = () => mapped?.input.externalId ?? String(ext?.externalId ?? '');
    const attempt = (fallback: string[] | null) =>
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
            if (!mapped)
              mapped = mapExternalOrder(
                ext ?? ({} as ExternalOrder),
                connector,
                await this.refs(tx, ext ?? ({} as ExternalOrder)),
                today,
              );
            const input = fallback ? fallbackInput(mapped, fallback) : mapped.input;
            return this.intake.upsertOrder(input, tx);
          },
        ),
      );
    const done = (
      r: Awaited<ReturnType<OrderIntakeService['upsertOrder']>>,
      fallback: boolean,
    ): PullItemResult => ({
      externalId: r.order.externalId ?? label(),
      outcome: r.created ? 'created' : r.changed ? 'updated' : 'unchanged',
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
      this.logger.error(
        `tenant ${tenantId} connector ${connector}: order ${label()} failed — ${String(e)}`,
      );
      return {
        externalId: label(),
        outcome: 'error',
        error: {
          code: e instanceof ProblemException ? e.code : 'internal_error',
          message: String(e instanceof Error ? e.message : e).slice(0, 300),
        },
      };
    };

    try {
      return done(await attempt(null), false);
    } catch (e) {
      if (!(e instanceof ProblemException) || e.code !== 'validation_failed' || !mapped)
        return failed(e);
      // กฎรูปแบบของ upsert ยังไม่ผ่าน (ไม่ควรเกิด) → รับเป็นใบสำรองพร้อมข้อผิดพลาดเป็น sourceIssues — ไม่ทิ้งใบ
      const errs = (e.errors ?? []).map((x) => `${x.field} ${x.code}`);
      this.logger.warn(
        `tenant ${tenantId} connector ${connector}: order ${label()} rejected (${errs.join(', ')}) — fallback`,
      );
      try {
        return done(await attempt(errs.length ? errs : ['validation_failed']), true);
      } catch (e2) {
        return failed(e2);
      }
    }
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

  /** จองรอบดึง: สร้างแถวถ้ายังไม่มี แล้วตั้ง lease เมื่อว่าง/หมดอายุ (UPDATE ล็อกแถว → สองรอบพร้อมกันได้ lease รอบเดียว) */
  private async claim(tx: Tx, tenantId: string, connector: string, leaseId: string) {
    await tx.$executeRaw`
      INSERT INTO connector_cursor (id, tenant_id, connector_key)
      VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${connector})
      ON CONFLICT (tenant_id, connector_key) DO NOTHING`;
    const rows = await tx.$queryRaw<{ cursor: string | null }[]>`
      UPDATE connector_cursor
         SET lease_id = ${leaseId}::uuid,
             lease_until = now() + (${PULL_LEASE_MS}::int * interval '1 millisecond'),
             last_pull_at = now(), updated_at = now()
       WHERE tenant_id = ${tenantId}::uuid AND connector_key = ${connector}
         AND (lease_until IS NULL OR lease_until < now())
      RETURNING cursor`;
    return rows[0] ?? null;
  }

  /** เลื่อน cursor + ต่อ lease — false = lease หลุด (รอบอื่นหยิบไปแล้ว) */
  private async saveCursor(
    tx: Tx,
    tenantId: string,
    connector: string,
    leaseId: string,
    cursor: string | null,
  ): Promise<boolean> {
    const n = await tx.$executeRaw`
      UPDATE connector_cursor
         SET cursor = ${cursor},
             lease_until = now() + (${PULL_LEASE_MS}::int * interval '1 millisecond'),
             updated_at = now()
       WHERE tenant_id = ${tenantId}::uuid AND connector_key = ${connector} AND lease_id = ${leaseId}::uuid`;
    return n === 1;
  }

  /** ปล่อย lease + เก็บสรุปรอบ + audit (เฉพาะรอบที่มีอะไรเกิดขึ้น — ไม่ลง audit ทุก 5 นาทีเมื่อไม่มีใบใหม่) */
  private async finish(tenantId: string, connector: string, leaseId: string, run: PullRunResult) {
    const ok = !run.sourceError && run.counts.error === 0;
    const summary = {
      at: this.clock.now().toISOString(),
      ok,
      pages: run.pages,
      counts: run.counts,
      ...(run.sourceError ? { sourceError: run.sourceError } : {}),
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
            const row = await tx.connectorCursor.findUnique({
              where: { tenantId_connectorKey: { tenantId, connectorKey: connector } },
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
            if (c.total - c.unchanged > 0 || !ok)
              await this.audit.record({
                action: 'connector.orders_pulled',
                entityType: 'connector_cursor',
                entityId: row.id,
                after: {
                  connector,
                  pages: run.pages,
                  cursor: run.cursor,
                  counts: c,
                  ...(run.sourceError ? { sourceError: run.sourceError } : {}),
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
    const t = await this.prisma.platform.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true },
    });
    return t?.status === 'TRIAL' || t?.status === 'ACTIVE';
  }
}
