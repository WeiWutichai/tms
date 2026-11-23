import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { type Connector, Prisma } from '@prisma/client';
import { CONNECTOR_KEY_RE, effectiveCapabilities } from '@tms/domain';
import { createHash, randomUUID } from 'node:crypto';
import { encodeId } from '../../common/ids';
import { requestContext } from '../../common/request-context';
import { ProblemException } from '../../common/problem';
import { DbService, type Tx } from '../../db/db.service';
import { PrismaService } from '../../db/prisma.service';
import { ipKey, RateLimitService, slidingWindow } from '../../http/rate-limit/rate-limit.service';
import { JobQueue } from '../../jobs/job-queue.service';
import { CONNECTOR_PULL_JOB, ConnectorIntakeService } from '../connectors/connector-intake.service';
import { EntitlementService } from '../entitlements/entitlement.service';
import { ConnectorsService, redactSecrets } from './connectors.service';
import {
  type ErpContext,
  type InboundEvent,
  type InboundHandleResult,
  type InboundRequest,
  INBOUND_TRIGGERS,
  readyCapabilities,
} from './erp-adapter';
import { ErpAdapterRegistry, usableAdapter } from './erp-adapter.registry';
import { ErpInboundEffects, type InboundEffectsResult } from './erp-inbound-effects';
import {
  hashInboundToken,
  INBOUND_MAX_ATTEMPTS,
  INBOUND_PROCESS_JOB,
  INBOUND_RETRY_DELAYS_MS,
  INBOUND_TOKEN_RE,
  inboundTokenRateKey,
} from './inbound-token';

export { INBOUND_MAX_ATTEMPTS, INBOUND_PROCESS_JOB };
const MIN = 60_000;
/** body สูงสุดของ webhook ขาเข้า (ตัดที่ body parser → 413 ก่อนถึง handler) */
export const INBOUND_MAX_BYTES = 256 * 1024;
/** rate limit (หน้าต่างเลื่อน 1 นาที) — ต่อ IP และต่อ token · ที่เก็บกลาง fail-closed (ฐานใช้ไม่ได้ = 503) */
export const INBOUND_PER_IP_PER_MIN = Number(process.env.INBOUND_RATE_LIMIT_PER_IP_MIN ?? 600);
export const INBOUND_PER_TOKEN_PER_MIN = Number(
  process.env.INBOUND_RATE_LIMIT_PER_TOKEN_MIN ?? 600,
);
/** เพดานเวลาของ adapter.verify (ไม่ควรเรียกภายนอก) และ handle */
const VERIFY_TIMEOUT_MS = 5_000;
const HANDLE_TIMEOUT_MS = 60_000;
/**
 * retention: payload (body ที่เข้ารหัส) 30 วัน (INT-085) — แถวที่ยังไม่ประมวลผลแล้ว payload ถูกล้าง = FAILED `payload_expired`
 * แถว ledger **ไม่ลบอัตโนมัติ** (docs/01 §3.7 "24 เดือน แล้ว archive" — วิธี archive [OPEN — PO], spec/12 §3)
 */
export const INBOUND_PAYLOAD_RETENTION_DAYS = 30;
const DAY = 24 * 3600_000;
const BATCH = 5000;
const UUID_RE = /^[0-9a-f-]{36}$/i;
/** ผู้กระทำของผลจาก webhook ขาเข้า (audit/event) */
const INBOUND_ACTOR = 'system:connector-inbound';

export interface InboundReceiveInput {
  provider: string;
  token: string;
  rawBody: Buffer;
  headers: Record<string, string>;
  ip: string | undefined;
  requestId: string | undefined;
}

export interface InboundReceipt {
  received: true;
  duplicate: boolean;
  id: string;
}

/** 401 รูปเดียวทุกกรณี (token ผิด/หมุนแล้ว/ไม่ตรง provider/connector ยกเลิก/บริษัทใช้ไม่ได้/ลายเซ็นผิด) — ไม่มี oracle */
const denied = () => new ProblemException('unauthorized');

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, rej) => {
        timer = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** ISO 8601 วันที่ + เวลา + timezone (Z หรือ ±hh:mm) เท่านั้น — ไม่มี timezone = ตีความผิดได้ */
const ISO_TZ_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const isIsoDate = (v: unknown): v is string =>
  typeof v === 'string' && ISO_TZ_RE.test(v) && !Number.isNaN(Date.parse(v));

/**
 * Inbound webhook ledger (ST7-T22; docs/04 G3 "Inbound webhook ledger" I10)
 * `POST /v1/inbound/{provider}/{token}` — ไม่ login: token ใน URL ชี้ tenant + connector แล้ว **ตรวจลายเซ็นผ่าน adapter ก่อน**
 * เขียนอะไรลงฐาน (นอกจากตัวนับ rate limit) → ledger `processed_webhook_event` unique (tenant, connector, eventKey)
 * → event ใหม่: บันทึก RECEIVED + job ประมวลผลใน transaction เดียวกัน (ส่งซ้ำ/พร้อมกัน = แถวเดียว job เดียว)
 * → worker เรียก `adapter.inbound.handle` ครั้งเดียว → PROCESSED / FAILED (+ trigger ที่ core ทำต่อ เช่น ดึง order)
 */
@Injectable()
export class InboundWebhookService implements OnModuleInit {
  private readonly logger = new Logger('InboundWebhook');

  constructor(
    private readonly prisma: PrismaService,
    private readonly db: DbService,
    private readonly adapters: ErpAdapterRegistry,
    private readonly connectors: ConnectorsService,
    private readonly queue: JobQueue,
    private readonly intake: ConnectorIntakeService,
    private readonly limiter: RateLimitService,
    private readonly entitlements: EntitlementService,
    private readonly effects: ErpInboundEffects,
  ) {}

  onModuleInit() {
    this.queue.register(
      INBOUND_PROCESS_JOB,
      async ({ tenantId, job }) => {
        const id = (job.payload as { eventId?: unknown } | null)?.eventId;
        if (typeof id !== 'string' || !UUID_RE.test(id))
          throw new Error('inbound.process: invalid event id');
        return this.process(tenantId, id, job.attempts >= job.maxAttempts);
      },
      {
        outsideTransaction: true,
        timeoutMs: HANDLE_TIMEOUT_MS + 15_000,
        retryDelaysMs: INBOUND_RETRY_DELAYS_MS,
        onFinalFailure: async ({ job, tx, error }) => {
          const id = (job.payload as { eventId?: unknown } | null)?.eventId;
          if (typeof id === 'string' && UUID_RE.test(id))
            await this.fail(
              tx,
              id,
              'processing_failed',
              String((error as Error)?.message ?? error),
            );
        },
      },
    );
  }

  // ---------- รับ ----------

  async receive(input: InboundReceiveInput): Promise<InboundReceipt> {
    // 1) rate limit ต่อ IP + ต่อ token (ก่อนแตะข้อมูลใด — token ผิดก็นับ)
    await this.limiter.assert([
      slidingWindow(`inb:ip:${ipKey(input.ip)}`, INBOUND_PER_IP_PER_MIN, MIN, 'ip'),
      slidingWindow(
        `inb:tk:${inboundTokenRateKey(input.token)}`,
        INBOUND_PER_TOKEN_PER_MIN,
        MIN,
        'token',
      ),
    ]);
    // 2) token → connector (อ่านอย่างเดียว ข้าม tenant ด้วย role platform)
    if (!CONNECTOR_KEY_RE.test(input.provider) || !INBOUND_TOKEN_RE.test(input.token))
      throw denied();
    const c = await this.prisma.platform.connector.findUnique({
      where: { inboundTokenHash: hashInboundToken(input.token) },
    });
    if (!c || c.adapterKey !== input.provider || c.status === 'DISCONNECTED') throw denied();
    const tenant = await this.prisma.platform.tenant.findUnique({
      where: { id: c.tenantId },
      select: { status: true },
    });
    if (!tenant || !['TRIAL', 'ACTIVE'].includes(tenant.status)) throw denied();
    if (!(await this.entitlements.enabled(c.tenantId, 'conn'))) throw denied();
    // D68-58/96 ตามโหมดของ tenant (sandbox = เฉพาะ DemoProvider · demo ใน production = เฉพาะ sandbox)
    const adapter = await usableAdapter(this.adapters, this.prisma.platform, c);
    if (!adapter?.inbound) throw denied();
    let ctx: ErpContext;
    try {
      ctx = this.connectors.contextOf(c);
    } catch {
      throw denied();
    }
    const req: InboundRequest = Object.freeze({
      headers: Object.freeze({ ...input.headers }),
      rawBody: input.rawBody,
      receivedAt: new Date(),
    });
    // 3) ลายเซ็น — ก่อนเขียนฐาน · ผิด/throw/ช้าเกิน = 401
    let ok = false;
    try {
      ok =
        (await withTimeout(
          Promise.resolve(adapter.inbound.verify(ctx, req)),
          VERIFY_TIMEOUT_MS,
          'verify',
        )) === true;
    } catch (e) {
      this.logger.warn(`inbound verify error (${c.adapterKey}): ${String((e as Error)?.message)}`);
      ok = false;
    }
    if (!ok) throw denied();
    // 4) แยก event (หลังลายเซ็นผ่านเท่านั้น)
    let event: InboundEvent | null = null;
    try {
      event = adapter.inbound.parse(ctx, req);
    } catch {
      event = null;
    }
    if (
      !event ||
      typeof event.eventKey !== 'string' ||
      !event.eventKey.length ||
      event.eventKey.length > 200 ||
      typeof event.type !== 'string' ||
      !event.type.length ||
      event.type.length > 100 ||
      (event.occurredAt != null && !isIsoDate(event.occurredAt))
    )
      throw new ProblemException('bad_request', 'unrecognized inbound event');
    // 5) ledger + job ใน transaction เดียว — unique (tenant, connector, event_key) ตัดสินว่าใครได้ประมวลผล
    //    (ต่อ connector: 2 connector ของ adapter เดียวกัน = 2 ระบบต้นทาง รหัส event ชนกันได้)
    const ev = event;
    return this.db.withTenant(c.tenantId, async (tx) => {
      const id = randomUUID();
      const inserted = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO processed_webhook_event
          (id, tenant_id, connector_id, provider, event_key, event_type, status, payload_enc,
           payload_sha256, payload_bytes, occurred_at, received_at, request_id, ip, updated_at)
        VALUES (${id}::uuid, ${c.tenantId}::uuid, ${c.id}::uuid, ${c.adapterKey}, ${ev.eventKey},
                ${ev.type}, 'RECEIVED', ${this.connectors.cipher.encrypt(input.rawBody.toString('base64'))},
                ${createHash('sha256').update(input.rawBody).digest('hex')}, ${input.rawBody.length},
                ${ev.occurredAt ? new Date(ev.occurredAt) : null}::timestamptz, ${req.receivedAt},
                ${input.requestId ?? null}, ${input.ip ?? null}, now())
        ON CONFLICT (tenant_id, connector_id, event_key) DO NOTHING
        RETURNING id::text`;
      if (inserted.length) {
        await this.queue.enqueue(tx, {
          tenantId: c.tenantId,
          type: INBOUND_PROCESS_JOB,
          payload: { eventId: id },
          maxAttempts: INBOUND_MAX_ATTEMPTS,
        });
        return { received: true as const, duplicate: false, id: encodeId('inboundEvent', id) };
      }
      const dup = await tx.$queryRaw<{ id: string }[]>`
        UPDATE processed_webhook_event
           SET duplicate_count = duplicate_count + 1, last_duplicate_at = now()
         WHERE tenant_id = ${c.tenantId}::uuid AND connector_id = ${c.id}::uuid AND event_key = ${ev.eventKey}
        RETURNING id::text`;
      if (!dup[0]) throw new Error('inbound ledger row vanished');
      return { received: true as const, duplicate: true, id: encodeId('inboundEvent', dup[0].id) };
    });
  }

  // ---------- ประมวลผล (worker) ----------

  /**
   * ประมวลผล event 1 รายการ — ทำเฉพาะแถว RECEIVED (PROCESSED/FAILED = จบแล้ว ไม่ทำซ้ำ)
   * throw = ลองใหม่ (job backoff) · ครั้งสุดท้ายล้ม → FAILED (onFinalFailure)
   */
  async process(
    tenantId: string,
    eventId: string,
    lastAttempt = false,
  ): Promise<Record<string, unknown>> {
    const row = await this.db.withTenant(tenantId, (tx) =>
      tx.processedWebhookEvent.findUnique({ where: { id: eventId } }),
    );
    if (!row) return { skipped: 'not_found' };
    if (row.status !== 'RECEIVED') return { skipped: 'done', status: row.status };
    // payload ถูกล้างตาม retention → จบเลย (ไม่ต้องรอ connector เปิดใหม่)
    if (!row.payloadEnc) {
      await this.db.withTenant(tenantId, (tx) =>
        this.fail(tx, eventId, 'payload_expired', 'payload purged by retention'),
      );
      return { status: 'FAILED' };
    }
    // บริษัทถูกระงับ/ปิด: ไม่ประมวลผล — คง RECEIVED (เปิดใหม่แล้วยังไม่มีการปลุกอัตโนมัติ — ค้างใน PROGRESS)
    const tenant = await this.prisma.platform.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true },
    });
    if (!tenant || !['TRIAL', 'ACTIVE'].includes(tenant.status))
      return { skipped: 'tenant_inactive' };
    const c = await this.db.withTenant(tenantId, (tx) =>
      tx.connector.findUnique({ where: { id: row.connectorId } }),
    );
    const adapter = c ? await usableAdapter(this.adapters, this.prisma.platform, c) : undefined;
    if (!c || c.status === 'DISCONNECTED' || !adapter?.inbound) {
      await this.db.withTenant(tenantId, (tx) =>
        this.fail(
          tx,
          eventId,
          'connector_unavailable',
          'connector disconnected or adapter unavailable',
        ),
      );
      return { status: 'FAILED' };
    }
    // PAUSED / ERROR: ยังไม่ประมวลผล — คงเป็น RECEIVED ไม่มี job ค้าง · เปิดใช้ (resume / ERROR → ACTIVE) แล้ว
    // `ConnectorsService.wakeParked` สร้าง job ให้ (เหมือนคำสั่งขาออกที่พัก — spec/07 §1.6) · พักเกิน 30 วัน = payload_expired
    if (c.status !== 'ACTIVE') return { deferred: c.status };
    const payloadEnc = row.payloadEnc;
    const rawBody = Buffer.from(this.connectors.cipher.decrypt(payloadEnc), 'base64');
    const ctx = this.connectors.contextOf(c, {
      idempotencyKey: `${row.provider}:${row.eventKey}`,
    });
    const secrets = c.credentialKeys.map((k) => ctx.config[k] ?? '');
    await this.db.withTenant(tenantId, (tx) =>
      tx.processedWebhookEvent.updateMany({
        where: { id: eventId, status: 'RECEIVED' },
        data: { attempts: { increment: 1 }, updatedAt: new Date() },
      }),
    );
    const event: InboundEvent = {
      eventKey: row.eventKey,
      type: row.eventType,
      occurredAt: row.occurredAt?.toISOString() ?? null,
    };
    let r: InboundHandleResult;
    try {
      r = await withTimeout(
        adapter.inbound.handle(ctx, event, { rawBody }),
        HANDLE_TIMEOUT_MS,
        'handle',
      );
    } catch (e) {
      throw new Error(redactSecrets(String((e as Error)?.message ?? e), secrets).slice(0, 500));
    }
    if (!r.ok) {
      const message = redactSecrets(String(r.problem?.message ?? ''), secrets).slice(0, 500);
      const code = redactSecrets(String(r.problem?.code ?? 'handle_failed'), secrets).slice(0, 60);
      if (r.retryable && !lastAttempt) throw new Error(`${code}: ${message}`);
      await this.db.withTenant(tenantId, (tx) => this.fail(tx, eventId, code, message));
      return { status: 'FAILED', code };
    }
    const triggers = (r.triggers ?? []).filter((t) => INBOUND_TRIGGERS.includes(t));
    const effects = Array.isArray(r.effects) ? r.effects : [];
    return this.db.withTenant(tenantId, (tx) =>
      // ST8-T16 ผลทางธุรกิจ (รับชำระ ฯลฯ) เขียน audit/event ในนามระบบ — ต้องมี request context ของงาน
      requestContext.run(
        {
          requestId: `inbound:${eventId}`,
          tenantId,
          actorId: INBOUND_ACTOR,
          principalType: 'system',
          scopes: [],
          locale: 'th',
          tx: tx as never,
        },
        async () => {
          // ล็อกแถว event ก่อนทำผล — งานซ้อน (lease หลุด) รายที่สองเห็นว่าไม่ใช่ RECEIVED แล้วไม่ทำซ้ำ
          const locked = await tx.$queryRaw<{ status: string }[]>`
            SELECT status::text FROM processed_webhook_event WHERE id = ${eventId}::uuid FOR UPDATE`;
          if (locked[0]?.status !== 'RECEIVED') return { status: 'raced', triggers: [] };
          const done: string[] = [];
          for (const t of triggers)
            if (t === 'pullOrders' && (await this.triggerPull(tx, c))) done.push(t);
          const fx: InboundEffectsResult = effects.length
            ? await this.effects.apply(tx, c, effects)
            : { applied: [], review: null };
          // review L1 ยังทำไม่ได้ตอนนี้ (เช่น ผลการส่งยังไม่บันทึก) → ล้ม transaction แล้วลองใหม่ · ครั้งสุดท้าย = คิวตรวจ
          if (fx.retry && !fx.review) {
            if (!lastAttempt) throw new Error(`${fx.retry.code}: ${fx.retry.message}`);
            fx.review = fx.retry;
          }
          const result = {
            triggers: done,
            ...(fx.applied.length ? { effects: fx.applied } : {}),
            ...(r.summary ? { summary: JSON.parse(JSON.stringify(r.summary)) } : {}),
          } as Prisma.InputJsonValue;
          // ต้องให้คนตัดสิน (เช่น ระบบบัญชียกเลิกเอกสาร/ยอดรับชำระไม่ตรง) = FAILED พร้อมรหัส → คิวตรวจ
          const n = await tx.processedWebhookEvent.updateMany({
            where: { id: eventId, status: 'RECEIVED' },
            data: fx.review
              ? {
                  status: 'FAILED',
                  processedAt: new Date(),
                  lastError: {
                    code: redactSecrets(fx.review.code, secrets).slice(0, 60),
                    message: redactSecrets(fx.review.message, secrets).slice(0, 500),
                    review: true,
                  },
                  result,
                  updatedAt: new Date(),
                }
              : {
                  status: 'PROCESSED',
                  processedAt: new Date(),
                  lastError: Prisma.DbNull,
                  result,
                  updatedAt: new Date(),
                },
          });
          return {
            status: n.count ? (fx.review ? 'FAILED' : 'PROCESSED') : 'raced',
            triggers: done,
            ...(fx.review ? { review: fx.review.code } : {}),
          };
        },
      ),
    );
  }

  /** ตั้งรอบดึง order ทันที — เฉพาะเมื่อ connector ACTIVE และเปิด pullOrders · มีรอบค้างแล้วไม่สร้างซ้ำ */
  private async triggerPull(tx: Tx, c: Connector): Promise<boolean> {
    const adapter = this.adapters.get(c.adapterKey);
    const caps = effectiveCapabilities(
      adapter ? readyCapabilities(adapter) : [],
      c.capabilitiesEnabled,
      c.status,
    );
    if (c.status !== 'ACTIVE' || !caps.includes('pullOrders')) return false;
    const open = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM job
       WHERE type = ${CONNECTOR_PULL_JOB} AND status IN ('PENDING', 'RUNNING')
         AND payload->>'connectorId' = ${c.id}`;
    if (open[0]?.n) return true;
    await this.intake.enqueueConnector(tx, c.tenantId, c.id);
    return true;
  }

  private async fail(tx: Tx, eventId: string, code: string, message: string) {
    await tx.processedWebhookEvent.updateMany({
      where: { id: eventId, status: 'RECEIVED' },
      data: {
        status: 'FAILED',
        processedAt: new Date(),
        lastError: { code, message: message.slice(0, 500) },
        updatedAt: new Date(),
      },
    });
  }

  // ---------- retention (worker รายวัน — role platform) ----------

  /**
   * ล้าง payload ที่เกิน 30 วัน (ทีละ 5,000 แถว) — แถวที่ยังเป็น RECEIVED ปิดเป็น FAILED `payload_expired` ทันที
   * ไม่ลบแถว ledger (archive หลัง 24 เดือน = [OPEN — PO])
   */
  async purge(now = new Date()): Promise<{ payloadsCleared: number; expired: number }> {
    const db = this.prisma.platform;
    const payloadCutoff = new Date(now.getTime() - INBOUND_PAYLOAD_RETENTION_DAYS * DAY);
    let payloadsCleared = 0;
    let expired = 0;
    for (;;) {
      const rows = await db.$queryRaw<{ expired: boolean }[]>`
        UPDATE processed_webhook_event e
           SET payload_enc = NULL, updated_at = now(),
               status = CASE WHEN e.status = 'RECEIVED' THEN 'FAILED'::"InboundEventStatus" ELSE e.status END,
               processed_at = CASE WHEN e.status = 'RECEIVED' THEN now() ELSE e.processed_at END,
               last_error = CASE WHEN e.status = 'RECEIVED'
                                 THEN jsonb_build_object('code', 'payload_expired', 'message', 'payload purged by retention')
                                 ELSE e.last_error END
          FROM (SELECT id, status = 'RECEIVED' AS was_received FROM processed_webhook_event
                 WHERE received_at < ${payloadCutoff} AND payload_enc IS NOT NULL LIMIT ${BATCH}) x
         WHERE e.id = x.id
        RETURNING x.was_received AS expired`;
      payloadsCleared += rows.length;
      expired += rows.filter((r) => r.expired).length;
      if (rows.length < BATCH) break;
    }
    return { payloadsCleared, expired };
  }
}
