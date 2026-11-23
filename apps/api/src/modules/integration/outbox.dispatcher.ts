import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { PrismaService } from '../../db/prisma.service';
import { OutboxSinkRegistry } from './outbox-sink.registry';
import {
  ERROR_CLASSES,
  OutboxSinkError,
  type ErrorClass,
  type OutboxEvent,
  type OutboxSink,
  type SettledCommand,
} from './outbox.types';

/** lease ค่าเริ่มต้น (docs/01 §6.2: 5 นาที; sink ใบใหญ่ตั้ง `leaseMs` เอง) */
export const DEFAULT_LEASE_MS = 5 * 60_000;
/** retry TRANSIENT: 1, 2, 5, 15, 30, 60 นาที (docs/01 §6.3) + jitter ±10% → ครั้งที่ 7 ล้ม = FAILED_FINAL */
export const RETRY_SCHEDULE_MIN = [1, 2, 5, 15, 30, 60] as const;
/** AMBIGUOUS: ไม่ส่งซ้ำทันที — รอ 2 นาที (docs/01 §6.3) */
const AMBIGUOUS_DELAY_MIN = 2;
/**
 * AUTH: คำสั่งคง PENDING ไม่นับครั้ง — ตรวจอีกครั้งทุก 15 นาที (docs/01 §6.3 "คำสั่งคง `PENDING`") · sink เป็นผู้หยุด connector ทั้งตัว
 * (`ERROR` + แจ้ง admin ทันที — ErpAdapterSink/ConnectorsService.markError; D-81 · D68-47) แล้วรอบถัดไปพักโดยไม่เรียกปลายทาง
 * (ไม่ retry ด้วย credential เดิม) · ปลุกทันทีเมื่อ connector กลับมา ACTIVE (`wakeParked`)
 */
const AUTH_DELAY_MIN = 15;
/** คำสั่งที่ส่งพร้อมกันต่อปลายทาง (docs/01 §6.2 config.maxConcurrency default 3) — นับแบบหลวม (soft cap) */
export const MAX_IN_FLIGHT_PER_TARGET = 3;

export interface ClaimedCommand {
  id: string;
  tenantId: string;
  kind: 'ADAPTER' | 'WEBHOOK';
  sink: string;
  targetId: string | null;
  operation: string;
  entityType: string;
  localId: string;
  eventId: string | null;
  serializeKey: string;
  idempotencyKey: string;
  payload: unknown;
  attempt: number;
  maxAttempt: number;
  leaseId: string;
}

export interface OutboxStats {
  byStatus: Record<string, number>;
  /** อายุคำสั่งที่รอนานสุด (วินาที) ของ PENDING/FAILED_RETRYABLE — 0 = ไม่มีคิวค้าง */
  oldestWaitingSec: number;
}

export function retryDelayMin(attempt: number, schedule: readonly number[]): number {
  const base = schedule[Math.min(attempt - 1, schedule.length - 1)]!;
  return base * (0.9 + Math.random() * 0.2);
}

function classify(err: unknown): { cls: ErrorClass; detail: Record<string, unknown> } {
  if (
    err instanceof OutboxSinkError &&
    (ERROR_CLASSES as readonly string[]).includes(err.errorClass)
  )
    return { cls: err.errorClass, detail: { message: err.message, ...(err.detail ?? {}) } };
  return {
    cls: 'TRANSIENT',
    detail: { message: (err instanceof Error ? err.message : String(err)).slice(0, 500) },
  };
}

/**
 * ST7-T03 Outbox worker (docs/01 §6.2 ชั้น worker; docs/04 G3 Outbox)
 * - หยิบด้วย role platform ข้าม tenant + `FOR UPDATE SKIP LOCKED` → IN_FLIGHT + lease (lease_id = fencing token)
 * - ส่งตามลำดับต่อ serialize_key: หยิบได้เฉพาะหัวคิว (seq ต่ำสุดที่ยังไม่จบ) — คำสั่งก่อนหน้า IN_FLIGHT/รอ retry = คีย์นั้นรอ
 *   ⚠ ลำดับ = ลำดับ seq ตอน INSERT ไม่ใช่ลำดับ commit: transaction ที่ได้ seq น้อยกว่าแต่ commit ทีหลัง (หลังคำสั่ง seq มากกว่า
 *   ถูกส่งไปแล้ว) จะถูกส่งทีหลัง — ไม่ใช้ advisory lock ใน trigger เพราะ transaction ที่ปล่อย event ของหลายลูกค้าสลับลำดับกัน
 *   จะ deadlock แล้ว request ของผู้ใช้ล้ม (spec/12 §3) · เอกสารที่ต้องเรียงจริง (invoice → credit note) เรียงได้เพราะ
 *   credit note สร้างได้หลัง invoice commit แล้วเท่านั้น · ปลายทาง webhook ใช้ occurredAt/version ตัดสินลำดับเอง
 * - ใน process เดียว claim ทีละรายการ (mutex) → นับ IN_FLIGHT ต่อปลายทางจากฐานได้ตรง (cap MAX_IN_FLIGHT_PER_TARGET)
 * - round-robin ต่อ tenant: tenant ที่ถูกหยิบล่าสุดนานที่สุดก่อน · จำกัดส่งพร้อมกันต่อปลายทาง
 * - ระหว่างส่ง ต่อ lease (heartbeat) · worker ตาย → lease หมด → worker อื่นหยิบใหม่ด้วย idempotency key เดิม (ปลายทางกันซ้ำ)
 * - ผลเขียนเฉพาะถ้า lease ยังเป็นของเรา · ส่งถึงปลายทางแล้วแต่เขียนผลไม่ได้ → ไม่ตั้ง retry เอง ปล่อยให้ lease หมด
 * - sink ทำงานนอก transaction; ต้องการข้อมูล tenant ใช้ `withTx` (RLS ของ tenant นั้น)
 */
@Injectable()
export class OutboxDispatcher {
  private readonly logger = new Logger('OutboxDispatcher');
  /** claim ทีละรายการภายใน process — slot ของ OutboxWorkerPool ไม่แย่งนับ IN_FLIGHT ต่อปลายทางพร้อมกัน */
  private claimChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    private readonly db: DbService,
    private readonly sinks: OutboxSinkRegistry,
  ) {}

  /** หยิบคำสั่ง 1 รายการ (null = ไม่มีที่พร้อม) */
  claim(leaseMs = DEFAULT_LEASE_MS): Promise<ClaimedCommand | null> {
    const run = this.claimChain.then(() => this.claimNow(leaseMs));
    this.claimChain = run.catch(() => undefined);
    return run;
  }

  private async claimNow(leaseMs: number): Promise<ClaimedCommand | null> {
    const db = this.prisma.platform;
    // lease หมดในครั้งสุดท้าย (worker ตายระหว่างส่ง) → dead-letter ไม่วนไม่จบ (อาจส่งถึงแล้ว → AMBIGUOUS ให้คนตรวจ)
    const dead = await db.$queryRaw<Omit<SettledCommand, 'status' | 'code'>[]>`
      UPDATE integration_outbox
         SET status = 'FAILED_FINAL', error_class = 'AMBIGUOUS', lease_id = NULL, lease_until = NULL, done_at = now(),
             last_error = jsonb_build_object('code', 'lease_expired', 'message', 'worker lease expired on last attempt'),
             updated_at = now()
       WHERE status = 'IN_FLIGHT' AND lease_until < now() AND attempt >= max_attempt
      RETURNING id, tenant_id AS "tenantId", sink, target_id AS "targetId", operation, entity_type AS "entityType",
                local_id AS "localId", payload, error_class AS "errorClass"`;
    for (const r of dead)
      await this.settled({ ...r, status: 'FAILED_FINAL', code: 'lease_expired' });
    const rows = await db.$queryRaw<ClaimedCommand[]>`
      WITH heads AS (
        SELECT DISTINCT ON (o.tenant_id, o.serialize_key)
               o.id, o.tenant_id, o.sink, o.target_id, o.status, o.next_run_at, o.lease_until, o.seq
          FROM integration_outbox o
         WHERE o.status IN ('PENDING', 'IN_FLIGHT', 'FAILED_RETRYABLE')
         ORDER BY o.tenant_id, o.serialize_key, o.seq
      ),
      busy AS (
        SELECT tenant_id, sink, coalesce(target_id, '-') AS target, count(*) AS n
          FROM integration_outbox
         WHERE status = 'IN_FLIGHT' AND lease_until >= now()
         GROUP BY 1, 2, 3
      ),
      ready AS (
        SELECT h.id, h.next_run_at, h.seq
          FROM heads h
          LEFT JOIN busy b ON b.tenant_id = h.tenant_id AND b.sink = h.sink AND b.target = coalesce(h.target_id, '-')
         WHERE ((h.status IN ('PENDING', 'FAILED_RETRYABLE') AND h.next_run_at <= now())
                OR (h.status = 'IN_FLIGHT' AND h.lease_until < now()))
           AND coalesce(b.n, 0) < ${MAX_IN_FLIGHT_PER_TARGET}
      ),
      pick AS (
        SELECT o.id
          FROM integration_outbox o
          JOIN ready r ON r.id = o.id
          LEFT JOIN LATERAL (
            SELECT max(x.claimed_at) AS last_claimed FROM integration_outbox x WHERE x.tenant_id = o.tenant_id
          ) t ON true
         WHERE (o.status IN ('PENDING', 'FAILED_RETRYABLE') AND o.next_run_at <= now())
            OR (o.status = 'IN_FLIGHT' AND o.lease_until < now())
         ORDER BY t.last_claimed ASC NULLS FIRST, r.next_run_at, r.seq
         FOR UPDATE OF o SKIP LOCKED
         LIMIT 1
      )
      UPDATE integration_outbox u
         SET status = 'IN_FLIGHT', attempt = u.attempt + 1, lease_id = gen_random_uuid(),
             lease_until = now() + (${leaseMs}::int * interval '1 millisecond'),
             claimed_at = clock_timestamp(), updated_at = now()
        FROM pick
       WHERE u.id = pick.id
         AND NOT EXISTS (
           -- กันหัวคิวเปลี่ยนระหว่าง statement (คำสั่งก่อนหน้าในคีย์เดียวกันกลับมา PENDING/IN_FLIGHT)
           SELECT 1 FROM integration_outbox p
            WHERE p.tenant_id = u.tenant_id AND p.serialize_key = u.serialize_key AND p.seq < u.seq
              AND p.status IN ('PENDING', 'IN_FLIGHT', 'FAILED_RETRYABLE'))
      RETURNING u.id, u.tenant_id AS "tenantId", u.kind::text AS kind, u.sink, u.target_id AS "targetId",
                u.operation, u.entity_type AS "entityType", u.local_id AS "localId", u.event_id AS "eventId",
                u.serialize_key AS "serializeKey", u.idempotency_key AS "idempotencyKey", u.payload,
                u.attempt, u.max_attempt AS "maxAttempt", u.lease_id AS "leaseId"`;
    return rows[0] ?? null;
  }

  /**
   * หยิบคำสั่งที่ระบุแล้วส่งทันที (ST7-T05 ส่งซ้ำ webhook ด้วยมือ — ผู้ใช้รอผล) — ผ่าน lease/fencing เดียวกับ worker
   * หยิบได้เฉพาะคำสั่ง PENDING ที่ถึงเวลา เป็นหัวคิวของ serialize_key และปลายทางยังส่งพร้อมกันไม่ครบ MAX_IN_FLIGHT_PER_TARGET
   * หยิบไม่ได้ (worker หยิบไปแล้ว/ยังไม่ถึงคิว/เต็มเพดาน) → false (worker ส่งให้)
   */
  async runNow(id: string): Promise<boolean> {
    const [row] = await this.prisma.platform.$queryRaw<{ sink: string }[]>`
      SELECT sink FROM integration_outbox WHERE id = ${id}::uuid`;
    if (!row) return false;
    const leaseMs = this.sinks.get(row.sink)?.leaseMs ?? DEFAULT_LEASE_MS;
    const rows = await this.prisma.platform.$queryRaw<ClaimedCommand[]>`
      UPDATE integration_outbox u
         SET status = 'IN_FLIGHT', attempt = u.attempt + 1, lease_id = gen_random_uuid(),
             lease_until = now() + (${leaseMs}::int * interval '1 millisecond'),
             claimed_at = clock_timestamp(), updated_at = now()
       WHERE u.id = ${id}::uuid AND u.status = 'PENDING' AND u.next_run_at <= now()
         -- เพดานส่งพร้อมกันต่อปลายทางเดียวกับ worker (เต็ม = ให้ worker ส่งเมื่อว่าง)
         AND (SELECT count(*) FROM integration_outbox b
               WHERE b.tenant_id = u.tenant_id AND b.sink = u.sink
                 AND coalesce(b.target_id, '-') = coalesce(u.target_id, '-')
                 AND b.status = 'IN_FLIGHT' AND b.lease_until >= now()) < ${MAX_IN_FLIGHT_PER_TARGET}
         AND NOT EXISTS (
           SELECT 1 FROM integration_outbox p
            WHERE p.tenant_id = u.tenant_id AND p.serialize_key = u.serialize_key AND p.seq < u.seq
              AND p.status IN ('PENDING', 'IN_FLIGHT', 'FAILED_RETRYABLE'))
      RETURNING u.id, u.tenant_id AS "tenantId", u.kind::text AS kind, u.sink, u.target_id AS "targetId",
                u.operation, u.entity_type AS "entityType", u.local_id AS "localId", u.event_id AS "eventId",
                u.serialize_key AS "serializeKey", u.idempotency_key AS "idempotencyKey", u.payload,
                u.attempt, u.max_attempt AS "maxAttempt", u.lease_id AS "leaseId"`;
    if (!rows[0]) return false;
    await this.process(rows[0]);
    return true;
  }

  /** หยิบแล้วส่ง 1 รายการ — คืน true ถ้ามีงาน */
  async runOnce(): Promise<boolean> {
    const c = await this.claim();
    if (!c) return false;
    await this.process(c);
    return true;
  }

  /** ส่งที่ถึงเวลาทั้งหมด (test/งานเล็ก) */
  async drain(max = 1000): Promise<number> {
    let n = 0;
    while (n < max && (await this.runOnce())) n++;
    return n;
  }

  /** ส่งคำสั่งที่หยิบแล้ว + เขียนผล (fencing ด้วย lease_id) */
  async process(c: ClaimedCommand, stop?: AbortSignal): Promise<void> {
    const sink = this.sinks.get(c.sink);
    const leaseMs = sink?.leaseMs ?? DEFAULT_LEASE_MS;
    const abort = new AbortController();
    // worker กำลังปิด (SIGTERM เกินเวลาผ่อนผัน) → แจ้ง sink ให้หยุด
    if (stop) {
      if (stop.aborted) abort.abort(stop.reason);
      else stop.addEventListener('abort', () => abort.abort(stop.reason), { once: true });
    }
    const extend = async () => {
      const n = await this.prisma.platform.$executeRaw`
        UPDATE integration_outbox SET lease_until = now() + (${leaseMs}::int * interval '1 millisecond'), updated_at = now()
         WHERE id = ${c.id}::uuid AND status = 'IN_FLIGHT' AND lease_id = ${c.leaseId}::uuid`;
      if (n === 0) abort.abort(new Error('outbox lease lost'));
    };
    const heartbeat = setInterval(
      () => void extend().catch((e) => this.logger.warn(`heartbeat ${c.id}: ${String(e)}`)),
      Math.max(50, Math.floor(leaseMs / 3)),
    );
    heartbeat.unref?.();
    let delivered = false;
    const started = Date.now();
    try {
      if (leaseMs !== DEFAULT_LEASE_MS) await extend();
      if (!sink) throw new OutboxSinkError(`sink '${c.sink}' is not registered`, 'TRANSIENT');
      const event = c.eventId ? await this.loadEvent(c) : null;
      const r = await sink.deliver({
        id: c.id,
        tenantId: c.tenantId,
        kind: c.kind,
        sink: c.sink,
        targetId: c.targetId,
        operation: c.operation,
        entityType: c.entityType,
        localId: c.localId,
        idempotencyKey: c.idempotencyKey,
        attempt: c.attempt,
        payload: c.payload ?? event?.snapshot ?? null,
        event,
        signal: abort.signal,
        withTx: (fn) => this.db.withTenant(c.tenantId, fn),
      });
      delivered = true;
      clearInterval(heartbeat);
      const ok = await this.finish(c, {
        status: 'DONE',
        result: (r && r.result) ?? null,
        errorClass: null,
        lastError: null,
      });
      this.log(c, ok ? 'DONE' : 'DONE_LEASE_LOST', started);
    } catch (err) {
      clearInterval(heartbeat);
      if (delivered) {
        // ส่งถึงปลายทางแล้ว — ห้ามตั้งรอบใหม่เอง; lease หมดแล้วหยิบซ้ำด้วย idempotency key เดิม
        this.logger.error(`outbox ${c.id} delivered but status update failed: ${String(err)}`);
        return;
      }
      await this.fail(c, sink, err, started);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async fail(
    c: ClaimedCommand,
    sink: OutboxSink | undefined,
    err: unknown,
    started: number,
  ): Promise<void> {
    const { cls, detail } = classify(err);
    let status: 'DONE' | 'SKIPPED' | 'FAILED_FINAL' | 'FAILED_RETRYABLE' | 'PENDING';
    let delayMin = 0;
    let attempt = c.attempt;
    switch (cls) {
      case 'DUPLICATE':
        // ปลายทางมีอยู่แล้ว (ส่งถึงในรอบก่อน) — ไม่ใช่ error · ST7-T16 (docs/01 §6.3): sink ตามหาเอกสารฝั่งปลายทางแล้วบันทึก mapping
        // หาไม่เจอ (`unresolved`) = ขึ้นคิวล้มเหลวให้คนกรอกเลขจากระบบปลายทาง (FAILED_FINAL)
        status = detail.unresolved === true ? 'FAILED_FINAL' : 'DONE';
        break;
      case 'CAPABILITY':
        status = 'SKIPPED';
        break;
      case 'VALIDATION':
      case 'NOT_FOUND':
      case 'PERIOD_CLOSED':
        status = 'FAILED_FINAL';
        break;
      case 'AUTH':
        status = 'PENDING';
        delayMin = AUTH_DELAY_MIN;
        attempt = c.attempt - 1;
        break;
      default: {
        // sink กำหนดจำนวนครั้ง/ตาราง retry เองได้ (webhook ST7-T04 = 8 ครั้ง) — ไม่กำหนด = ของแถว (7) + ตาราง 01§6.3
        const max = sink?.retry?.maxAttempts ?? c.maxAttempt;
        const final = c.attempt >= max;
        status = final ? 'FAILED_FINAL' : 'FAILED_RETRYABLE';
        const own =
          err instanceof OutboxSinkError && cls === 'TRANSIENT' && err.retryInMs !== undefined
            ? Math.max(0, err.retryInMs) / 60_000
            : undefined;
        delayMin =
          cls === 'AMBIGUOUS'
            ? AMBIGUOUS_DELAY_MIN
            : (own ?? retryDelayMin(c.attempt, sink?.retry?.scheduleMin ?? RETRY_SCHEDULE_MIN));
      }
    }
    const ok = await this.finish(c, {
      status,
      errorClass: cls,
      lastError: { ...detail, attempt: c.attempt, at: new Date().toISOString() },
      result: null,
      delayMs: Math.round(delayMin * 60_000),
      attempt,
    });
    this.log(c, `${status}:${cls}`, started);
    if (ok && (status === 'FAILED_FINAL' || status === 'SKIPPED'))
      await this.settled({
        id: c.id,
        tenantId: c.tenantId,
        sink: c.sink,
        targetId: c.targetId,
        operation: c.operation,
        entityType: c.entityType,
        localId: c.localId,
        payload: c.payload,
        status,
        errorClass: cls,
        code: typeof detail.code === 'string' ? detail.code : null,
      });
  }

  /** D68-57 แจ้ง sink ว่าคำสั่งจบแบบไม่ถึงปลายทาง — ล้ม = log (ผลของคำสั่งบันทึกแล้ว ไม่ย้อน) */
  private async settled(c: SettledCommand): Promise<void> {
    const sink = this.sinks.get(c.sink);
    if (!sink?.onSettled) return;
    try {
      await sink.onSettled(c);
    } catch (e) {
      this.logger.warn(`outbox ${c.id} onSettled failed: ${String(e)}`);
    }
  }

  /** เขียนผลเฉพาะถ้ายังถือ lease (worker อื่นอาจหยิบซ้ำหลัง lease หมด) — คืน false ถ้าเสีย lease แล้ว */
  private async finish(
    c: ClaimedCommand,
    r: {
      status: 'DONE' | 'SKIPPED' | 'FAILED_FINAL' | 'FAILED_RETRYABLE' | 'PENDING';
      errorClass: string | null;
      lastError: Record<string, unknown> | null;
      result: Record<string, unknown> | null;
      delayMs?: number;
      attempt?: number;
    },
  ): Promise<boolean> {
    const terminal = r.status === 'DONE' || r.status === 'SKIPPED' || r.status === 'FAILED_FINAL';
    const n = await this.prisma.platform.$executeRaw`
      UPDATE integration_outbox
         SET status = ${r.status}::"OutboxStatus", lease_id = NULL, lease_until = NULL,
             attempt = ${r.attempt ?? c.attempt},
             error_class = ${r.errorClass}, last_error = ${r.lastError ? JSON.stringify(r.lastError) : null}::jsonb,
             result = coalesce(${r.result ? JSON.stringify(r.result) : null}::jsonb, result),
             done_at = CASE WHEN ${terminal} THEN now() ELSE NULL END,
             -- INT-109 เวลาที่เริ่มพัก (tenant ถูกระงับ = AUTH → PENDING) — คงค่าเดิมระหว่างพักต่อเนื่อง ล้างเมื่อพ้นสถานะพัก
             parked_at = CASE WHEN ${r.status === 'PENDING' && r.errorClass === 'AUTH'}
                              THEN coalesce(parked_at, now()) ELSE NULL END,
             next_run_at = CASE WHEN ${terminal} THEN next_run_at
                                ELSE now() + (${r.delayMs ?? 0}::int * interval '1 millisecond') END,
             updated_at = now()
       WHERE id = ${c.id}::uuid AND status = 'IN_FLIGHT' AND lease_id = ${c.leaseId}::uuid`;
    return n === 1;
  }

  private async loadEvent(c: ClaimedCommand): Promise<OutboxEvent | null> {
    const e = await this.prisma.platform.domainEvent.findUnique({ where: { id: c.eventId! } });
    if (!e || e.tenantId !== c.tenantId) return null;
    return {
      id: e.id,
      type: e.type,
      version: e.version,
      occurredAt: e.occurredAt,
      entityType: e.entityType,
      localId: e.localId,
      snapshot: e.snapshot,
      previousAttributes: e.previousAttributes,
      requestId: e.requestId,
      actorId: e.actorId,
    };
  }

  /**
   * คืนคำสั่งที่ยังส่งไม่จบตอนปิด worker (SIGTERM เกินเวลาผ่อนผัน) → PENDING พร้อมหยิบทันที (ไม่ต้องรอ lease หมด)
   * fencing ด้วย lease_id: ถ้า sink ยังทำงานต่อแล้วเขียนผล จะไม่ทับ · ปลายทางกันซ้ำด้วย idempotency key เดิม
   */
  async release(cmds: ClaimedCommand[]): Promise<number> {
    let n = 0;
    for (const c of cmds)
      n += await this.prisma.platform.$executeRaw`
        UPDATE integration_outbox SET status = 'PENDING', lease_id = NULL, lease_until = NULL, next_run_at = now(),
               last_error = jsonb_build_object('code', 'worker_shutdown', 'attempt', attempt), updated_at = now()
         WHERE id = ${c.id}::uuid AND status = 'IN_FLIGHT' AND lease_id = ${c.leaseId}::uuid`;
    return n;
  }

  private log(c: ClaimedCommand, outcome: string, started: number) {
    // ล้ม/เสีย lease = warn (worker เปิด log ระดับ warn ขึ้นไป) · สำเร็จ = log
    const ok = outcome === 'DONE' || outcome.startsWith('SKIPPED') || outcome === 'DONE:DUPLICATE';
    this.logger[ok ? 'log' : 'warn'](
      JSON.stringify({
        msg: 'outbox',
        id: c.id,
        tenantId: c.tenantId,
        sink: c.sink,
        operation: c.operation,
        attempt: c.attempt,
        outcome,
        ms: Date.now() - started,
      }),
    );
  }

  /** ตัวเลขคิวสำหรับ log/monitoring (ST9-T19 ตั้ง alert, ST7-T19 ทำหน้าจอ) */
  async stats(): Promise<OutboxStats> {
    const rows = await this.prisma.platform.$queryRaw<{ status: string; n: number }[]>`
      SELECT status::text AS status, count(*)::int AS n FROM integration_outbox GROUP BY status`;
    const [w] = await this.prisma.platform.$queryRaw<{ sec: number | null }[]>`
      SELECT extract(epoch FROM now() - min(created_at))::int AS sec FROM integration_outbox
       WHERE status IN ('PENDING', 'FAILED_RETRYABLE')`;
    return {
      byStatus: Object.fromEntries(rows.map((r) => [r.status, r.n])),
      oldestWaitingSec: w?.sec ?? 0,
    };
  }

  /** sink ที่ลงทะเบียน (test) */
  sink(key: string): OutboxSink | undefined {
    return this.sinks.get(key);
  }
}
