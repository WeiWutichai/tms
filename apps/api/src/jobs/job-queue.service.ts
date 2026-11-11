import { Injectable, Logger, Optional } from '@nestjs/common';
import { EntitlementService } from '../modules/entitlements/entitlement.service';
import type { Job } from '@prisma/client';
import { PrismaService } from '../db/prisma.service';
import { encodeId } from '../common/ids';
import { DbService, type Tx } from '../db/db.service';
import { NotificationService } from '../modules/notifications/notification.service';

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
}
export type JobHandler = (ctx: JobContext) => Promise<unknown>;

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly db: DbService,
    @Optional() private readonly entitlements?: EntitlementService,
    @Optional() private readonly notifications?: NotificationService,
  ) {}

  register(type: string, handler: JobHandler, opts: { feature?: string } = {}): void {
    if (this.handlers.has(type)) throw new Error(`job handler '${type}' already registered`);
    this.handlers.set(type, handler);
    if (opts.feature) this.features.set(type, opts.feature);
  }

  enqueue(
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
    const payload = {
      ...(input.payload ?? {}),
      ...(input.notify ? { _notify: input.notify } : {}),
    };
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
  async claim(leaseMs = 5 * 60_000): Promise<Job | null> {
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
      await this.prisma.platform.job.update({
        where: { id: job.id },
        data: {
          status: 'SKIPPED',
          finishedAt: new Date(),
          lockedUntil: null,
          error: { code: 'feature_not_in_plan', featureKey: feature },
        },
      });
      return true;
    }
    try {
      if (!handler) throw new Error(`no handler for job type '${job.type}'`);
      const result = await this.db.withTenant(job.tenantId, (tx) =>
        handler({ tenantId: job.tenantId, job, tx, progress: (p) => this.setProgress(job.id, p) }),
      );
      await this.prisma.platform.job.update({
        where: { id: job.id },
        data: {
          status: 'SUCCEEDED',
          progress: 100,
          result: (result ?? null) as any,
          finishedAt: new Date(),
          lockedUntil: null,
        },
      });
      await this.notifyDone(job, 'job.succeeded');
    } catch (err) {
      const retry = job.attempts < job.maxAttempts;
      this.logger.warn(
        `job ${job.id} (${job.type}) failed attempt ${job.attempts}: ${String(err)}`,
      );
      await this.prisma.platform.job.update({
        where: { id: job.id },
        data: retry
          ? {
              status: 'PENDING',
              runAt: new Date(Date.now() + 2 ** job.attempts * 1000),
              lockedUntil: null,
              error: { message: String(err) },
            }
          : {
              status: 'FAILED',
              finishedAt: new Date(),
              lockedUntil: null,
              error: { message: String(err) },
            },
      });
      if (!retry) await this.notifyDone(job, 'job.failed');
    }
    return true;
  }

  /** แจ้งผลแยก transaction — แจ้งไม่สำเร็จไม่ทำให้สถานะงานเปลี่ยน */
  private async notifyDone(job: Job, template: 'job.succeeded' | 'job.failed'): Promise<void> {
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

  private async setProgress(id: string, pct: number): Promise<void> {
    await this.prisma.platform.job.update({
      where: { id },
      data: { progress: Math.max(0, Math.min(99, Math.round(pct))) },
    });
  }
}

/** scheduler รายเวลาแบบเบา: ทุก everyMs สร้างงานให้ทุก tenant ที่ resolveTenants คืน (ใช้ใน worker) */
export interface ScheduleSpec {
  name: string;
  everyMs: number;
  type: string;
  resolveTenants: () => Promise<string[]>;
}
