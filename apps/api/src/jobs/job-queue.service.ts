import { Injectable, Logger, Optional } from '@nestjs/common';
import { EntitlementService } from '../modules/entitlements/entitlement.service';
import { Prisma, type Job } from '@prisma/client';
import { PrismaService } from '../db/prisma.service';
import { encodeId } from '../common/ids';
import { toJobDto } from './job-dto';
import { DbService, type Tx } from '../db/db.service';
import { NotificationService } from '../modules/notifications/notification.service';

export interface JobTypeOptions {
  /** งานที่ต้องเปิดฟีเจอร์ของ tenant */
  feature?: string;
  /** อายุ transaction ของ handler (ค่าเริ่มต้น 15 วิ — งานใหญ่ เช่น นำเข้า 5,000 แถว ตั้งยาวขึ้น) */
  timeoutMs?: number;
  /** เรียกเมื่อล้มครั้งสุดท้าย (transaction แยก — งานหลัก rollback ไปแล้ว) ให้โมดูลเจ้าของปิดสถานะของตัวเอง */
  onFinalFailure?: (ctx: { tenantId: string; job: Job; tx: Tx; error: unknown }) => Promise<void>;
  /**
   * true = handler ไม่ได้อยู่ใน transaction (ctx.tx ใช้ไม่ได้) — เปิด transaction สั้น ๆ เองด้วย `ctx.withTx`
   * ใช้กับงานที่เรียกระบบภายนอก (เช่น geocode ST2-T03) เพื่อไม่ถือ connection/lock ระหว่างรอ
   */
  outsideTransaction?: boolean;
  /**
   * ST7-T06: งาน async ที่ client สั่งเองแล้วได้ `jobId` (เช่น นำเข้าไฟล์) — จบ (สำเร็จ/ล้มครั้งสุดท้าย) ยิง webhook `job.completed`
   * (docs/01 §5.1 Bulk/async, §5.3) ใน transaction เดียวกับการปิดสถานะงาน · งานระบบ (เตือน/หมดเวลา/geocode) ไม่ยิง
   */
  publicEvent?: boolean;
  /** ช่วงรอก่อนลองใหม่ครั้งที่ n (ms) — ไม่ตั้ง/เกินรายการ = 2^n วินาที (ค่าเดิม) */
  retryDelaysMs?: readonly number[];
}

/** แจ้งผู้สั่งงานเมื่อจบ (ST1-T23; docs/04 I "งานใหญ่ background + แจ้งเมื่อเสร็จ") — เก็บใน payload._notify */
export interface JobNotify {
  userId: string;
  /** ชื่องานที่ผู้ใช้อ่านเข้าใจ เช่น "นำเข้าลูกค้า (ลูกค้า.xlsx)" */
  label: string;
  /** path ภายในเว็บที่ไปดูผล */
  link?: string;
}

export interface JobContext {
  tenantId: string;
  job: Job;
  tx: Tx;
  /** อัปเดตความคืบหน้า 0–100 (เขียนด้วย connection แยก ผู้ใช้เห็นทันทีแม้งานยังไม่ commit) */
  progress: (pct: number) => Promise<void>;
  /** เปิด transaction ใหม่ของ tenant นี้ (RLS ตั้งแล้ว) — สำหรับงาน `outsideTransaction` */
  withTx: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
}
export type JobHandler = (ctx: JobContext) => Promise<unknown>;

/**
 * ผลของ handler ที่ระบุสถานะจบเอง — ST7-T10 bulk: ทำครบทุกรายการแต่บางรายการไม่ผ่าน = `succeeded_with_errors`
 * (docs/04 G1 Bulk/async) · handler ที่คืนค่าอื่น = SUCCEEDED ตามเดิม
 */
export class JobOutcome {
  constructor(
    readonly result: unknown,
    readonly status: 'SUCCEEDED' | 'SUCCEEDED_WITH_ERRORS' = 'SUCCEEDED',
  ) {}
}

/** อายุ lease ของงานที่หยิบ — หมดแล้ว worker อื่นหยิบซ้ำได้ · `ctx.progress` ต่อให้ (heartbeat) */
export const JOB_LEASE_MS = 5 * 60_000;

/** งานที่ client เห็น (`publicEvent`) เก็บ 7 วันหลังจบ แล้วลบ — `GET /v1/jobs/{id}` ตอบ 404 (docs/04 G1 "job เก็บ 7 วัน") */
export const PUBLIC_JOB_RETENTION_DAYS = 7;

/** ctx.tx ของงาน `outsideTransaction` — ใช้แล้วล้มทันที (กันเผลอ query นอก transaction ที่ไม่มี RLS context) */
const NO_TX = new Proxy({} as Tx, {
  get() {
    throw new Error('job runs outsideTransaction — use ctx.withTx()');
  },
});

/**
 * Job framework (ST0-T11, plan/02 T-06): ใช้ PostgreSQL เป็นคิว ไม่มี Redis
 * - enqueue อยู่ใน transaction ของ request (งานไม่หลุดถ้า request rollback)
 * - claim ข้าม tenant ด้วย role platform + FOR UPDATE SKIP LOCKED
 * - round-robin: เลือก tenant ที่ถูกหยิบงานล่าสุดนานที่สุดก่อน (fairness — docs/02 §4)
 * - handler รันใน transaction ของ tenant นั้น (RLS ทำงานเหมือน request ปกติ)
 */
@Injectable()
export class JobQueue {
  private readonly logger = new Logger('JobQueue');
  private readonly handlers = new Map<string, JobHandler>();
  /** งานที่ต้องเปิดฟีเจอร์ของ tenant (ST1-T18) — tenant ที่ปิดฟีเจอร์ถูกข้าม (A5 "ตรวจซ้ำใน cron job") */
  private readonly features = new Map<string, string>();
  private readonly opts = new Map<string, JobTypeOptions>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly db: DbService,
    @Optional() private readonly entitlements?: EntitlementService,
    @Optional() private readonly notifications?: NotificationService,
  ) {}

  register(type: string, handler: JobHandler, opts: JobTypeOptions = {}): void {
    if (this.handlers.has(type)) throw new Error(`job handler '${type}' already registered`);
    this.handlers.set(type, handler);
    if (opts.feature) this.features.set(type, opts.feature);
    this.opts.set(type, opts);
  }

  async enqueue(
    tx: Tx,
    input: {
      tenantId: string;
      type: string;
      payload?: object;
      runAt?: Date;
      maxAttempts?: number;
      notify?: JobNotify;
    },
  ) {
    // `_notify` มาจากตัวเลือก notify เท่านั้น (payload จากผู้ใช้ปลอมผู้รับไม่ได้) และตรวจตั้งแต่ตอนสั่งงาน
    const rest: Record<string, unknown> = { ...(input.payload ?? {}) };
    delete rest._notify;
    if (input.notify) {
      const n = input.notify;
      if (!/^[0-9a-f-]{36}$/i.test(n.userId)) throw new Error('job notify.userId must be a uuid');
      if (!n.label.trim()) throw new Error('job notify.label is required');
      if (n.link !== undefined && !/^\/(?![/\\])[^\s\\]*$/.test(n.link))
        throw new Error('job notify.link must be an internal path starting with /');
    }
    const payload = { ...rest, ...(input.notify ? { _notify: input.notify } : {}) };
    return tx.job.create({
      data: {
        tenantId: input.tenantId,
        type: input.type,
        payload: payload as any,
        ...(input.runAt ? { runAt: input.runAt } : {}),
        maxAttempts: input.maxAttempts ?? 3,
      },
    });
  }

  /** หยิบงาน 1 ชิ้น (คืน null ถ้าไม่มี) */
  async claim(leaseMs = JOB_LEASE_MS): Promise<Job | null> {
    const rows = await this.prisma.platform.$queryRaw<Job[]>`
      WITH candidate AS (
        SELECT j.id
          FROM job j
          LEFT JOIN LATERAL (
            SELECT max(x.started_at) AS last_started FROM job x WHERE x.tenant_id = j.tenant_id
          ) t ON true
         WHERE (j.status = 'PENDING' AND j.run_at <= now())
            OR (j.status = 'RUNNING' AND j.locked_until < now())
         ORDER BY t.last_started ASC NULLS FIRST, j.run_at ASC, j.created_at ASC
         FOR UPDATE OF j SKIP LOCKED
         LIMIT 1
      )
      UPDATE job SET status = 'RUNNING', started_at = clock_timestamp(), attempts = attempts + 1,
                     locked_until = now() + (${leaseMs}::int * interval '1 millisecond'), updated_at = now()
        FROM candidate WHERE job.id = candidate.id
      RETURNING job.id, job.tenant_id AS "tenantId", job.type, job.status, job.payload, job.progress,
                job.attempts, job.max_attempts AS "maxAttempts", job.started_at AS "startedAt"`;
    return rows[0] ?? null;
  }

  /** หยิบแล้วรัน 1 ชิ้น — คืน true ถ้ามีงานให้ทำ */
  async runOnce(): Promise<boolean> {
    const job = await this.claim();
    if (!job) return false;
    const handler = this.handlers.get(job.type);
    const feature = this.features.get(job.type);
    if (feature && this.entitlements && !(await this.entitlements.enabled(job.tenantId, feature))) {
      // ฟีเจอร์ถูกปิดหลังสร้างงาน (เช่น หมดแพ็กเกจ) → ข้าม ไม่ทำงานให้ tenant นั้น
      const r = await this.prisma.platform.job.updateMany({
        where: { id: job.id, status: 'RUNNING', attempts: job.attempts },
        data: {
          status: 'SKIPPED',
          finishedAt: new Date(),
          lockedUntil: null,
          error: { code: 'feature_not_in_plan', featureKey: feature },
        },
      });
      if (r.count === 1) await this.notifyDone(job, 'job.skipped');
      return true;
    }
    try {
      if (!handler) throw new Error(`no handler for job type '${job.type}'`);
      const o = this.opts.get(job.type);
      const base = {
        tenantId: job.tenantId,
        job,
        progress: (p: number) => this.setProgress(job, p),
        withTx: <T>(fn: (tx: Tx) => Promise<T>) =>
          this.db.withTenant(job.tenantId, fn, o?.timeoutMs),
      };
      const result = o?.outsideTransaction
        ? await handler({ ...base, tx: NO_TX })
        : await this.db.withTenant(job.tenantId, (tx) => handler({ ...base, tx }), o?.timeoutMs);
      const out = result instanceof JobOutcome ? result : new JobOutcome(result);
      // เขียนผลเฉพาะถ้ายังเป็นรอบที่เราหยิบ (lease หมดแล้ว worker อื่นหยิบซ้ำได้) — กันแจ้งเตือนซ้ำ/ทับผลกัน
      const done = await this.finish(job, true, {
        status: out.status,
        progress: 100,
        result: (out.result ?? null) as any,
        finishedAt: new Date(),
        lockedUntil: null,
      });
      if (done.count === 1) await this.notifyDone(job, 'job.succeeded');
    } catch (err) {
      const retry = job.attempts < job.maxAttempts;
      this.logger.warn(
        `job ${job.id} (${job.type}) failed attempt ${job.attempts}: ${String(err)}`,
      );
      // ล้มครั้งสุดท้าย: job.completed ยิงหลัง onFinalFailure (ข้างล่าง) — ไม่ใช่พร้อมปิดสถานะงาน
      const done = await this.finish(
        job,
        false,
        retry
          ? {
              status: 'PENDING',
              runAt: new Date(
                Date.now() +
                  (this.opts.get(job.type)?.retryDelaysMs?.[job.attempts - 1] ??
                    2 ** job.attempts * 1000),
              ),
              lockedUntil: null,
              error: { message: String(err) },
            }
          : {
              status: 'FAILED',
              finishedAt: new Date(),
              lockedUntil: null,
              error: { message: String(err) },
            },
      );
      if (!retry && done.count === 1) {
        const onFail = this.opts.get(job.type)?.onFinalFailure;
        const pub = !!this.opts.get(job.type)?.publicEvent;
        // ST7-T06 (review): โมดูลเจ้าของปิดสถานะของตัวเอง (เช่น นำเข้า → FAILED) แล้วจึงยิง `job.completed` ใน transaction เดียวกัน
        // → ผู้รับ webhook เรียก API แล้วเห็นสถานะสุดท้ายแล้ว · onFinalFailure ล้ม = rollback แล้วยิง event แยก (งานจบจริงแล้ว)
        let emitted = false;
        if (onFail || pub)
          await this.db
            .withTenant(job.tenantId, async (tx) => {
              if (onFail) await onFail({ tenantId: job.tenantId, job, tx, error: err });
              if (pub) await this.emitCompleted(tx, job.id);
            })
            .then(() => {
              emitted = pub; // commit แล้วเท่านั้น
            })
            .catch((e) => this.logger.warn(`job ${job.id} onFinalFailure failed: ${String(e)}`));
        if (pub && !emitted)
          await this.db
            .withTenant(job.tenantId, (tx) => this.emitCompleted(tx, job.id))
            .catch((e) => this.logger.error(`job ${job.id} job.completed failed: ${String(e)}`));
        await this.notifyDone(job, 'job.failed');
      }
    }
    return true;
  }

  /**
   * เขียนผลเฉพาะถ้ายังเป็นรอบที่เราหยิบ · `emit` (สำเร็จของงาน `publicEvent`) → domain_event `job.completed`
   * ใน transaction เดียวกัน (role platform — trigger สร้างคำสั่ง webhook ให้)
   */
  private async finish(job: Job, emit: boolean, data: Prisma.JobUpdateManyMutationInput) {
    const where = { id: job.id, status: 'RUNNING' as const, attempts: job.attempts };
    if (!emit || !this.opts.get(job.type)?.publicEvent)
      return this.prisma.platform.job.updateMany({ where, data });
    return this.prisma.platform.$transaction(async (tx) => {
      const r = await tx.job.updateMany({ where, data });
      if (r.count === 1) await this.emitCompleted(tx as unknown as Tx, job.id);
      return r;
    });
  }

  /** webhook `job.completed` (docs/01 §5.3) — payload ไม่มี result/error (ผู้รับเรียก GET /v1/jobs/{id}) */
  private async emitCompleted(tx: Tx, jobId: string): Promise<void> {
    const j = await tx.job.findUniqueOrThrow({ where: { id: jobId } });
    await tx.domainEvent.create({
      data: {
        tenantId: j.tenantId,
        type: 'job.completed',
        entityType: 'job',
        localId: j.id,
        // ST7-T06 (QA): data.object = JobDto เดียวกับ `GET /v1/jobs/{id}`
        snapshot: JSON.parse(JSON.stringify(toJobDto(j))) as Prisma.InputJsonValue,
        previousAttributes: { status: 'running' },
        requestId: null, // ไม่ได้มาจากคำขอ HTTP (envelope.request.id = null — docs/04 G1)
      },
    });
  }

  /**
   * ลบงานที่ client เห็น (ชนิดที่ลงทะเบียน `publicEvent`) ที่จบเกิน 7 วัน (ST7-T10) — worker เรียกวันละครั้ง (role platform)
   * งานระบบ (เตือน/ค่าเสื่อม/ดึง connector) ไม่ลบ: scheduler ใช้ประวัติ job กันสร้างซ้ำ (เช่น ค่าเสื่อมมองย้อน 70 วัน)
   */
  async purgeExpired(now = new Date()): Promise<number> {
    const types = [...this.opts].filter(([, o]) => o.publicEvent).map(([t]) => t);
    if (!types.length) return 0;
    const cutoff = new Date(now.getTime() - PUBLIC_JOB_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const r = await this.prisma.platform.job.deleteMany({
      where: {
        type: { in: types },
        status: { in: ['SUCCEEDED', 'SUCCEEDED_WITH_ERRORS', 'FAILED', 'SKIPPED'] },
        finishedAt: { lt: cutoff },
      },
    });
    return r.count;
  }

  /** แจ้งผลแยก transaction — แจ้งไม่สำเร็จไม่ทำให้สถานะงานเปลี่ยน */
  private async notifyDone(
    job: Job,
    template: 'job.succeeded' | 'job.failed' | 'job.skipped',
  ): Promise<void> {
    const n = (job.payload as { _notify?: JobNotify } | null)?._notify;
    if (!n || !this.notifications || typeof n.userId !== 'string' || typeof n.label !== 'string')
      return;
    const svc = this.notifications;
    await this.db
      .withTenant(job.tenantId, (tx) =>
        svc.notify(tx, {
          tenantId: job.tenantId,
          to: { userIds: [n.userId] },
          template,
          vars: { label: n.label },
          ...(n.link ? { link: n.link } : {}),
          entity: { type: 'job', id: encodeId('job', job.id) },
        }),
      )
      .catch((e) => this.logger.warn(`job ${job.id} notify failed: ${String(e)}`));
  }

  /**
   * ความคืบหน้า + ต่อ lease (heartbeat — ST7-T10): งานที่รายงานความคืบหน้ายังมีชีวิต → `locked_until` = now() + lease
   * (เวลาของฐาน เหมือนตอน claim) · เฉพาะรอบที่เราหยิบ (RUNNING + attempts เดิม) — worker อื่นหยิบซ้ำแล้วไม่ไปต่อให้
   */
  private async setProgress(job: Job, pct: number): Promise<void> {
    const p = Math.max(0, Math.min(99, Math.round(pct)));
    await this.prisma.platform.$executeRaw`
      UPDATE job SET progress = ${p},
             locked_until = GREATEST(locked_until, now() + (${JOB_LEASE_MS}::int * interval '1 millisecond')),
             updated_at = now()
       WHERE id = ${job.id}::uuid AND status = 'RUNNING' AND attempts = ${job.attempts}`;
  }
}

/** scheduler รายเวลาแบบเบา: ทุก everyMs สร้างงานให้ทุก tenant ที่ resolveTenants คืน (ใช้ใน worker) */
export interface ScheduleSpec {
  name: string;
  everyMs: number;
  type: string;
  resolveTenants: () => Promise<string[]>;
}
