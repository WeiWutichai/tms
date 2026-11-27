import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, Tenant, TenantStatus } from '@prisma/client';
import { Clock } from '../../common/clock';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { safeName } from '../../common/safe-text';
import { PrismaService } from '../../db/prisma.service';
import { PlatformSettingsService } from '../../platform/platform-settings.service';
import { EmailService } from '../email/email.service';
import { EntitlementService } from '../entitlements/entitlement.service';
import { INBOUND_MAX_ATTEMPTS, INBOUND_PROCESS_JOB } from '../erp/inbound-token';
import { addDays, bangkokToday, daysBetween } from '../vehicle-documents/expiry';
import {
  canSync,
  dunningStage,
  dunningStageFirstDay,
  dunningSteps,
  subscriptionStatusFor,
  tenantStatusOut,
  transitionAllowed,
  type DunningKind,
  type DunningSettings,
} from './tenant-status';

type Tx = Prisma.TransactionClient;

export type StatusActor =
  { type: 'system' } | { type: 'platform_user'; id: string } | { type: 'tenant_user'; id: string };

export interface TransitionInput {
  tenantId: string;
  to: TenantStatus;
  reason: string;
  actor: StatusActor;
  /** cron: เปลี่ยนเฉพาะเมื่อสถานะยังเป็นค่านี้ (อ่านหลัง row lock) — ไม่ตรง = ข้าม (การชำระที่เกิดพร้อมกันชนะ — spec/01 §1.8) */
  expectFrom?: TenantStatus;
  /** ชื่อ action ใน audit_log (ค่าเริ่มต้น `tenant.status_changed`) */
  auditAction?: string;
  /** ตั้ง/ล้างวัน 0 ของ dunning พร้อมการเปลี่ยน (undefined = คงเดิม · null = ล้าง) */
  dunning?: { kind: DunningKind; since: string } | null;
  /** cron รันย้อน: เวลาที่ขั้นนี้มีผลจริง (ประวัติ/statusChangedAt/cancelledAt ใช้ค่านี้ — review N1) · ไม่ส่ง = ตอนนี้ */
  effectiveAt?: Date;
  /** ส่งอีเมลแจ้ง owner (ค่าเริ่มต้น true — cron รันย้อนหลายขั้นส่งเฉพาะขั้นสุดท้าย — review N1) */
  notify?: boolean;
}

/** ผลของการกวาดรายวัน */
export interface LifecycleSweepResult {
  day: string;
  /** tenant ที่ถูกเปลี่ยนสถานะอย่างน้อย 1 ขั้น */
  tenants: number;
  /** จำนวนขั้นทั้งหมด (1 ขั้น = 1 แถวประวัติ) */
  transitions: number;
  failed: number;
}

/** cron รายวัน 00:30 เวลาไทย (spec/01 §1 ข้อ 2) */
export const LIFECYCLE_RUN_FROM_MINUTE_BKK = 30;
const BKK_MS = 7 * 3600_000;

/** เริ่มวัน (00:00 เวลาไทย) ของวันที่ `day` (YYYY-MM-DD) เป็น instant */
const bangkokDayStart = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - BKK_MS);

const SYSTEM_REASON: Record<string, string> = {
  trial_READ_ONLY: 'หมดระยะทดลองใช้โดยยังไม่ได้เลือกแพ็กเกจ/ชำระเงิน',
  invoice_PAST_DUE: 'ใบแจ้งหนี้ค่าบริการเลยกำหนดชำระ',
  READ_ONLY: 'ค้างชำระเกินระยะผ่อนผัน',
  SUSPENDED: 'ค้างชำระเกินระยะอ่านอย่างเดียว',
  CANCELLED: 'ค้างชำระเกินระยะระงับ',
};

/**
 * วงจรสถานะ tenant (P1-ST1-T03 · R-10 · spec/01 §1 PLT-010–019)
 * - `transition()` จุดเดียวที่เปลี่ยน `tenant.status`: row lock → ตรวจตาราง 1.6 → อัปเดต tenant + sync `subscription.status`
 *   + ประวัติ (`tenant_status_history`) + audit_log ของ tenant + อีเมลแจ้ง owner — ทั้งหมดในธุรกรรมเดียว
 * - `sweep()` cron รายวัน 00:30 เวลาไทย: trial หมด → read_only → suspended → cancelled · ค้างชำระ past_due → read_only → suspended →
 *   cancelled — ระยะทุกช่วงอ่านจาก PlatformSetting (D-45) · ตัดสินจากวันที่ จึงรันซ้ำ/รันย้อนได้ (idempotent)
 * - `markPastDue()` (P1-ST3-T02 เรียกเมื่อใบแจ้งหนี้ค่าบริการเลยกำหนด) · `markPaid()` ชำระแล้ว → active ทันที (PLT-013)
 * - ใช้ client platform (ตาราง tenant/subscription/ประวัติ เขียนได้เฉพาะ role platform)
 * - retention purge ไม่มีในบริการนี้ (`retention.purgeEnabled=false` — R-12) — cancelled ตั้งแค่ `dataPurgeAt`
 */
@Injectable()
export class TenantLifecycleService {
  private readonly logger = new Logger('TenantLifecycleService');
  /** วันที่กวาดแล้วใน process นี้ (กันรันซ้ำทุก 10 นาที — รันซ้ำก็ไม่เปลี่ยนผลเพราะตัดสินจากวันที่) */
  private sweptDay: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PlatformSettingsService,
    private readonly email: EmailService,
    private readonly entitlements: EntitlementService,
    private readonly clock: Clock,
  ) {}

  private get db() {
    return this.prisma.platform;
  }

  /** เปลี่ยนสถานะ 1 ขั้น — คืน tenant หลังเปลี่ยน หรือ null เมื่อ `expectFrom` ไม่ตรง (ข้าม) */
  async transition(input: TransitionInput, tx?: Tx): Promise<Tenant | null> {
    const run = async (t: Tx) => this.apply(t, input);
    const out = tx ? await run(tx) : await this.db.$transaction(run, { timeout: 30_000 });
    if (out) this.entitlements.invalidate(input.tenantId);
    return out;
  }

  private async apply(tx: Tx, input: TransitionInput): Promise<Tenant | null> {
    const reason = input.reason.trim();
    if (!reason) throw new Error('tenant status change requires a reason');
    // row lock (spec/01 §1.8: การชำระที่เกิดพร้อม cron ชนะเสมอ — cron อ่านสถานะหลัง lock แล้วข้ามถ้าเปลี่ยนไปแล้ว)
    await tx.$queryRaw`SELECT id FROM tenant WHERE id = ${input.tenantId}::uuid FOR UPDATE`;
    const cur = await tx.tenant.findUnique({ where: { id: input.tenantId } });
    if (!cur || cur.mode !== 'live') throw new ProblemException('not_found');
    if (input.expectFrom && cur.status !== input.expectFrom) return null;
    // review N2: cron คำนวณขั้นจากแถวที่อ่านก่อน lock — วัน 0/ชนิดของ dunning เปลี่ยนไปแล้ว (ชำระแล้วค้างใหม่) = ข้าม
    if (
      input.expectFrom &&
      input.dunning &&
      cur.dunningKind &&
      (cur.dunningKind !== input.dunning.kind ||
        (cur.pastDueSince ? ymd(cur.pastDueSince) : null) !== input.dunning.since)
    )
      return null;
    if (cur.status === input.to || !transitionAllowed(cur.status, input.to))
      throw new ProblemException('invalid_state_transition', undefined, undefined, {
        from: tenantStatusOut(cur.status),
        to: tenantStatusOut(input.to),
      });
    const now = input.effectiveAt ?? this.clock.now();
    const dunning =
      input.to === 'ACTIVE' ||
      input.to === 'TRIALING' ||
      input.to === 'PENDING_VERIFICATION' ||
      input.to === 'CANCELLED'
        ? null
        : input.dunning;
    let dataPurgeAt: Date | null | undefined;
    if (input.to === 'CANCELLED') {
      const days = await this.settings.get<number>('retention.operationalDays', tx);
      dataPurgeAt = new Date(now.getTime() + days * 86_400_000);
    } else if (cur.status === 'CANCELLED') dataPurgeAt = null; // PLT-018 กลับมาใช้งาน
    const next = await tx.tenant.update({
      where: { id: cur.id },
      data: {
        status: input.to,
        statusChangedAt: now,
        statusReason: reason,
        ...(dunning === null
          ? { pastDueSince: null, dunningKind: null }
          : dunning
            ? { pastDueSince: new Date(`${dunning.since}T00:00:00Z`), dunningKind: dunning.kind }
            : {}),
        ...(input.to === 'CANCELLED' ? { cancelledAt: now } : {}),
        ...(cur.status === 'CANCELLED' ? { cancelledAt: null } : {}),
        ...(dataPurgeAt !== undefined ? { dataPurgeAt } : {}),
      },
    });
    // subscription.status ตาม tenant.status (เจ้าของงาน sync = T03 — review P1-ST1-T01)
    const sub = await tx.subscription.findUnique({ where: { tenantId: cur.id } });
    if (sub) {
      const status = subscriptionStatusFor(next.status, next.dunningKind, sub.status);
      if (status !== sub.status)
        await tx.subscription.update({
          where: { tenantId: cur.id },
          data: { status, version: { increment: 1 } },
        });
    }
    const actorId =
      input.actor.type === 'system'
        ? 'system'
        : input.actor.type === 'platform_user'
          ? `platform:${input.actor.id}`
          : input.actor.id;
    await tx.tenantStatusHistory.create({
      data: {
        tenantId: cur.id,
        fromStatus: cur.status,
        toStatus: next.status,
        reason,
        actorType: input.actor.type,
        actorId: input.actor.type === 'system' ? null : input.actor.id,
        at: now,
      },
    });
    const ctx = requestContext.get();
    await tx.auditLog.create({
      data: {
        tenantId: cur.id,
        actorId,
        action: input.auditAction ?? 'tenant.status_changed',
        entityType: 'tenant',
        entityId: cur.id,
        before: {
          status: tenantStatusOut(cur.status),
          ...(cur.dunningKind ? { dunningKind: cur.dunningKind } : {}),
        },
        after: {
          status: tenantStatusOut(next.status),
          ...(next.dunningKind
            ? { dunningKind: next.dunningKind, pastDueSince: ymd(next.pastDueSince!) }
            : {}),
          ...(next.dataPurgeAt ? { dataPurgeAt: next.dataPurgeAt.toISOString() } : {}),
        },
        reason,
        requestId: ctx?.requestId ?? null,
        ip: ctx?.ip ?? null,
      },
    });
    // ระงับ/ยกเลิก = เข้าใช้งานแทนที่เปิดอยู่จบทันที (เดิมของ Console ST1-T24)
    if (next.status === 'SUSPENDED' || next.status === 'CANCELLED')
      await tx.impersonationSession.updateMany({
        where: { tenantId: cur.id, endedAt: null },
        data: { endedAt: now, endReason: 'revoked' },
      });
    // review S4: กลับมา sync ได้ (เช่น ชำระแล้ว) → ปลุกงานที่พักไว้ทันที: คำสั่งขาออก (webhook/ERP) ที่ PENDING รอรอบตรวจ 15 นาที +
    // webhook ขาเข้าที่รับไว้ระหว่าง read_only (RECEIVED ไม่มี job — S5) · พักเกิน 30 วัน payload ถูกล้าง = payload_expired (INT-085)
    if (!canSync(cur.status) && canSync(next.status)) await this.wakeParked(tx, cur.id);
    if (input.notify !== false) await this.notifyOwners(tx, next, reason, now);
    return next;
  }

  /** ปลุกงานเชื่อมต่อที่พักไว้ของ tenant (ทุก sink + webhook ขาเข้าทุก connector) — ทำในธุรกรรมเดียวกับการเปลี่ยนสถานะ */
  private async wakeParked(tx: Tx, tenantId: string): Promise<number> {
    const out = await tx.$executeRaw`
      UPDATE integration_outbox SET next_run_at = now(), updated_at = now()
       WHERE tenant_id = ${tenantId}::uuid AND status = 'PENDING' AND next_run_at > now()`;
    const inbound = await tx.$executeRaw`
      INSERT INTO job (id, tenant_id, type, payload, max_attempts)
      SELECT gen_random_uuid(), e.tenant_id, ${INBOUND_PROCESS_JOB},
             jsonb_build_object('eventId', e.id::text), ${INBOUND_MAX_ATTEMPTS}::int
        FROM processed_webhook_event e
       WHERE e.tenant_id = ${tenantId}::uuid AND e.status = 'RECEIVED'
         AND NOT EXISTS (SELECT 1 FROM job j
                          WHERE j.tenant_id = e.tenant_id AND j.type = ${INBOUND_PROCESS_JOB}
                            AND j.status IN ('PENDING', 'RUNNING')
                            AND j.payload->>'eventId' = e.id::text)`;
    return out + inbound;
  }

  /** อีเมลแจ้ง owner ทุกคนที่ใช้งานอยู่ (spec/01 §1 ข้อ 6 · PLT-103) — ผ่าน outbox ธุรกรรมเดียวกัน */
  private async notifyOwners(tx: Tx, t: Tenant, reason: string, now: Date) {
    const role = await tx.role.findFirst({ where: { tenantId: t.id, code: 'owner' } });
    if (!role) return;
    const links = await tx.userRole.findMany({ where: { tenantId: t.id, roleId: role.id } });
    const owners = await tx.appUser.findMany({
      where: { tenantId: t.id, id: { in: links.map((l) => l.userId) }, status: 'ACTIVE' },
      orderBy: { createdAt: 'asc' },
    });
    if (!owners.length) return;
    const fmt = (d: Date, lang: string, time: boolean) =>
      new Intl.DateTimeFormat(lang === 'th' ? 'th-TH' : 'en-GB', {
        dateStyle: 'medium',
        ...(time ? { timeStyle: 'short' as const } : {}),
        timeZone: 'Asia/Bangkok',
      }).format(d);
    await this.email.enqueueMany(
      tx,
      owners.map((o) => ({
        tenantId: t.id,
        to: o.email,
        template: 'tenant_status_changed' as const,
        locale: o.locale,
        vars: {
          tenantName: safeName(t.name),
          to: tenantStatusOut(t.status),
          reason: safeName(reason, 300),
          at: fmt(now, o.locale, true),
          ...(t.dataPurgeAt ? { purgeDate: fmt(t.dataPurgeAt, o.locale, false) } : {}),
        },
      })),
    );
  }

  /** ค่าตั้ง dunning ณ ตอนนี้ (อ่านสด — ค่าใหม่มีผลกับรอบถัดไป) */
  async dunningSettings(): Promise<DunningSettings> {
    const s = await this.settings.all();
    return {
      pastDueDays: s['dunning.pastDueDays'] as number,
      readOnlyUntilDay: s['dunning.readOnlyUntilDay'] as number,
      suspendUntilDay: s['dunning.suspendUntilDay'] as number,
      trialReadOnlyDays: s['trialExpiry.readOnlyDays'] as number,
    };
  }

  /** worker เรียกทุก 10 นาที — ตั้งแต่ 00:30 เวลาไทยกวาดวันละครั้งต่อ process (รันซ้ำได้ ไม่เปลี่ยนผล) */
  async scheduleDue(now: Date = this.clock.now()): Promise<LifecycleSweepResult | null> {
    const bkk = new Date(now.getTime() + BKK_MS);
    if (bkk.getUTCHours() === 0 && bkk.getUTCMinutes() < LIFECYCLE_RUN_FROM_MINUTE_BKK) return null;
    const day = bangkokToday(now);
    if (this.sweptDay === day) return null;
    const r = await this.sweep(now);
    if (!r.failed) this.sweptDay = day;
    return r;
  }

  /** กวาดทุก tenant ณ วันที่ของ `now` (เวลาไทย) */
  async sweep(now: Date = this.clock.now()): Promise<LifecycleSweepResult> {
    const day = bangkokToday(now);
    const s = await this.dunningSettings();
    const res: LifecycleSweepResult = { day, tenants: 0, transitions: 0, failed: 0 };
    // trial หมด (PLT-012): วันหมด trial (เวลาไทย) ก่อนวันนี้ = วัน trial+1 ขึ้นไป · pending_verification รอทีมงานตรวจ ไม่เปลี่ยนเอง
    const trials = await this.db.tenant.findMany({
      where: {
        status: 'TRIALING',
        mode: 'live',
        subscription: { trialEndsAt: { lt: bangkokDayStart(day) } },
      },
      select: { id: true, subscription: { select: { trialEndsAt: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const dunning = await this.db.tenant.findMany({
      where: {
        status: { in: ['PAST_DUE', 'READ_ONLY', 'SUSPENDED'] },
        mode: 'live',
        dunningKind: { not: null },
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    const work: { id: string; trialEnd?: Date }[] = [
      ...trials.map((t) => ({ id: t.id, trialEnd: t.subscription!.trialEndsAt! })),
      ...dunning.map((t) => ({ id: t.id })),
    ];
    for (const w of work) {
      try {
        const n = await this.advance(w.id, day, s, w.trialEnd);
        if (n) {
          res.tenants += 1;
          res.transitions += n;
        }
      } catch (e) {
        res.failed += 1;
        this.logger.warn(
          `tenant ${w.id} ${day}: lifecycle step failed — retry next run: ${String(e)}`,
        );
      }
    }
    if (res.transitions || res.failed)
      this.logger.log(`tenant lifecycle ${day}: ${JSON.stringify(res)}`);
    return res;
  }

  /**
   * เดิน tenant 1 รายไปถึงสถานะตามวันที่ (ทีละขั้น ธุรกรรมละขั้น) — คืนจำนวนขั้นที่เปลี่ยน
   * `trialEnd` มีค่า = tenant ยัง trialing และ trial หมดแล้ว → เข้าช่วง dunning แบบ trial (วัน 0 = วันหมด trial)
   */
  async advance(
    tenantId: string,
    day: string,
    s?: DunningSettings,
    trialEnd?: Date,
  ): Promise<number> {
    const settings = s ?? (await this.dunningSettings());
    const t = await this.db.tenant.findUnique({ where: { id: tenantId } });
    if (!t || t.mode !== 'live') return 0;
    let kind = t.dunningKind as DunningKind | null;
    let since = t.pastDueSince ? ymd(t.pastDueSince) : null;
    let status = t.status;
    if (status === 'TRIALING') {
      if (!trialEnd) return 0;
      kind = 'trial';
      since = bangkokToday(trialEnd);
    }
    if (!kind || !since) return 0;
    const target = dunningStage(kind, daysBetween(since, day), settings);
    let n = 0;
    const steps = dunningSteps(status, kind, target);
    let prevAt = 0;
    for (const [i, to] of steps.entries()) {
      // review N1: รันย้อน → ประทับเวลา/เหตุผลด้วยวันที่ขั้นนั้นมีผลจริง (00:30 ของวันนั้น) · อีเมลเฉพาะขั้นสุดท้าย
      const effDay = addDays(since, dunningStageFirstDay(kind, to, settings));
      const late = effDay < day;
      const at = late
        ? new Date(
            Math.max(
              prevAt,
              bangkokDayStart(effDay).getTime() + LIFECYCLE_RUN_FROM_MINUTE_BKK * 60_000,
            ),
          )
        : undefined;
      if (at) prevAt = at.getTime();
      const base = SYSTEM_REASON[`${kind}_${to}`] ?? SYSTEM_REASON[to] ?? 'เปลี่ยนสถานะตามกำหนด';
      const reason = late ? `${base} (มีผลวันที่ ${effDay} — บันทึกย้อนหลัง)` : base;
      const done = await this.transition({
        tenantId,
        to,
        reason,
        actor: { type: 'system' },
        expectFrom: status,
        dunning: { kind, since },
        effectiveAt: at,
        notify: i === steps.length - 1,
      });
      if (!done) break; // มีคนเปลี่ยนสถานะพร้อมกัน (เช่น ชำระแล้ว) — หยุด
      status = done.status;
      n += 1;
    }
    return n;
  }

  /**
   * ใบแจ้งหนี้ค่าบริการเลยกำหนด (P1-ST3-T02 เรียก) — active → past_due (วัน 0 = `dueDate`) แล้วเดินต่อถึงวันนี้
   * สถานะอื่น (trial/read_only/…) ไม่เปลี่ยน → คืน false
   */
  async markPastDue(
    tenantId: string,
    dueDate: string,
    reason = SYSTEM_REASON.invoice_PAST_DUE!,
    actor: StatusActor = { type: 'system' },
  ): Promise<boolean> {
    const done = await this.transition({
      tenantId,
      to: 'PAST_DUE',
      reason,
      actor,
      expectFrom: 'ACTIVE',
      dunning: { kind: 'invoice', since: dueDate },
    });
    if (done) await this.advance(tenantId, bangkokToday(this.clock.now()));
    return !!done;
  }

  /**
   * ชำระแล้ว → active ทันที (PLT-013 — ภายใน 1 นาทีหลังได้ webhook/อนุมัติสลิป: เรียกแบบ synchronous ในคำขอเดียวกัน)
   * จาก trialing / past_due / read_only / suspended / cancelled (ยังไม่ถึง dataPurgeAt — PLT-018)
   */
  async markPaid(tenantId: string, reason: string, actor: StatusActor, auditAction?: string) {
    const t = await this.db.tenant.findUnique({ where: { id: tenantId } });
    if (!t) throw new ProblemException('not_found');
    if (t.status === 'CANCELLED' && t.dataPurgeAt && t.dataPurgeAt <= this.clock.now())
      throw new ProblemException('invalid_state_transition');
    return this.transition({ tenantId, to: 'ACTIVE', reason, actor, auditAction });
  }

  /** ระงับด้วยมือ (ละเมิดเงื่อนไข/ทุจริต) — ทุกสถานะยกเว้น cancelled · คง dunning เดิมไว้ (cron เดินต่อถึง cancelled ได้) */
  suspend(tenantId: string, reason: string, actor: StatusActor, auditAction?: string) {
    return this.transition({ tenantId, to: 'SUSPENDED', reason, actor, auditAction });
  }

  /** ปลดระงับ → สถานะก่อนถูกระงับ (spec/01 §1 ข้อ 6) · ไม่มีประวัติ (tenant ก่อน T03) → active */
  async unsuspend(tenantId: string, reason: string, actor: StatusActor, auditAction?: string) {
    const last = await this.db.tenantStatusHistory.findFirst({
      where: { tenantId, toStatus: 'SUSPENDED' },
      orderBy: { seq: 'desc' },
    });
    // review N4 (spec/01 §1 ข้อ 6 "suspended (ด้วยมือ) → สถานะก่อนหน้า"): ระงับโดยระบบ (ค้างชำระ) ปลดด้วยการชำระเท่านั้น
    if (last?.actorType === 'system') throw new ProblemException('invalid_state_transition');
    const to: TenantStatus = last?.fromStatus ?? 'ACTIVE';
    return this.transition({
      tenantId,
      to,
      reason,
      actor,
      auditAction,
      expectFrom: 'SUSPENDED',
    }).then((r) => {
      if (!r) throw new ProblemException('invalid_state_transition');
      return r;
    });
  }

  /** ระงับอยู่และเป็นการระงับด้วยมือ (ปลดระงับได้) — review N4 */
  async manuallySuspended(tenantId: string): Promise<boolean> {
    const t = await this.db.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true },
    });
    if (t?.status !== 'SUSPENDED') return false;
    const last = await this.db.tenantStatusHistory.findFirst({
      where: { tenantId, toStatus: 'SUSPENDED' },
      orderBy: { seq: 'desc' },
      select: { actorType: true },
    });
    return last?.actorType !== 'system';
  }

  /** ประวัติสถานะล่าสุด (Console — ใหม่สุดก่อน) */
  history(tenantId: string, take = 50) {
    return this.db.tenantStatusHistory.findMany({
      where: { tenantId },
      orderBy: { seq: 'desc' },
      take,
    });
  }

  /** แถวแรกของประวัติเมื่อสร้าง tenant (ใหม่ → สถานะเริ่มต้น) — ใช้ในธุรกรรมที่สร้าง tenant */
  static recordInitial(
    tx: Tx,
    tenantId: string,
    status: TenantStatus,
    reason: string,
    actor: StatusActor,
  ) {
    return tx.tenantStatusHistory.create({
      data: {
        tenantId,
        fromStatus: null,
        toStatus: status,
        reason,
        actorType: actor.type,
        actorId: actor.type === 'system' ? null : actor.id,
      },
    });
  }
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
