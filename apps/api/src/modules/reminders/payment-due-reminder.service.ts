import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  PAYMENT_DUE_WINDOW,
  paymentDueLevel,
  scopeAllows,
  type PaymentDueLevel,
} from '@tms/domain';
import { Clock } from '../../common/clock';
import { DbService, type Tx } from '../../db/db.service';
import { PrismaService } from '../../db/prisma.service';
import { JobQueue } from '../../jobs/job-queue.service';
import { NotificationService } from '../notifications/notification.service';
import type { PaymentDueItem } from '../notifications/templates';
import { addDays, bangkokToday, daysBetween, isRealDate } from '../vehicle-documents/expiry';
import { DIGEST_MAX_ITEMS, RUN_FROM_HOUR_BKK } from './expiry-reminder.service';

export const PAYMENT_DUE_JOB = 'invoice.payment_due';
/** สมุดเตือน (expiry_reminder) entity_type ของใบแจ้งหนี้ — migration 0148 */
const ENTITY = 'INVOICE';
/** ผู้ดูแลลูกค้าต้องอ่านใบแจ้งหนี้ได้ ไม่งั้นส่งให้ฝ่ายบัญชีแทน */
const OWNER_SCOPE = 'invoices:read';
/** ผู้รับแทนเมื่อลูกค้าไม่มีผู้ดูแล (หรือผู้ดูแลใช้ไม่ได้) = ผู้บันทึกรับชำระ (owner/admin/manager/accounting + role กำหนดเอง) */
const FALLBACK_SCOPE = 'payments:record';
const LINK = '/pay';

const LEVEL_RANK: Record<PaymentDueLevel, number> = {
  OVERDUE_30: 0,
  OVERDUE_7: 1,
  DUE_TODAY: 2,
  DUE_IN_3: 3,
};

type WithTx = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

export interface PaymentDueCandidate {
  invoiceId: string;
  dueDate: string;
  level: PaymentDueLevel;
  /** ผู้ดูแลลูกค้า (customer.sales_owner_user_id) — null = ไม่มี */
  ownerId: string | null;
  item: PaymentDueItem;
}

export interface PaymentDueRunResult {
  day: string;
  /** ใบที่ถึงระดับเตือนวันนี้ (ก่อนตัดที่เคยเตือนแล้ว) */
  candidates: number;
  /** ผู้รับที่ได้สรุปรอบนี้ */
  digests: number;
  /** แถวสมุดเตือนที่จองได้ (ใบ × ผู้รับ) */
  reminders: number;
  /** ใบที่ไม่มีผู้รับเลย (ไม่มีผู้ดูแลที่ใช้ได้ และไม่มีผู้ใช้ `payments:record`) */
  unrouted: number;
  failedRecipients: number;
}

const toDate = (d: string) => new Date(`${d}T00:00:00Z`);
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const keyOf = (invoiceId: string, level: string, dueDate: string) =>
  `${invoiceId}|${level}|${dueDate}`;

/**
 * เตือนครบกำหนดชำระ (ST5-T22; spec/05 §10 BIL-121 "ก่อนครบกำหนด 3 วัน, วันครบกำหนด, เกิน 7/30 วัน — ในระบบถึงผู้ดูแลลูกค้า";
 * docs/04 F5 "เตือนครบกำหนด", I "ครบกำหนดชำระ" + "สรุปรายวัน 08:00") — แบบเดียวกับเตือนต่ออายุ ST2-T18
 *
 * - worker เรียก `scheduleDue()` ทุก 10 นาที → ตั้งแต่ 08:00 เวลาไทย สร้าง job `invoice.payment_due` 1 ชิ้น/tenant/วัน (advisory lock)
 * - ใบค้างรับ (ISSUED / PARTIALLY_PAID ที่ยอดตัด < ยอดรวม) ที่ `daysPastDue` อยู่ในช่วงระดับ (`paymentDueLevel` — @tms/domain)
 * - ผู้รับ = ผู้ดูแลลูกค้า (ACTIVE + อ่านใบแจ้งหนี้ได้) · ไม่มี/ใช้ไม่ได้ → ผู้ใช้ทุกคนที่มี `payments:record` [DECISION spec/12 §3]
 * - ผู้รับทีละคน (transaction ของตัวเอง): จองสมุดเตือน (ON CONFLICT DO NOTHING — ใบ × ระดับ × วันครบกำหนด × ผู้รับ) → ส่ง **สรุปฉบับเดียว**
 *   (กระดิ่ง + อีเมลภายในตามการตั้งค่า event `payment.due`) · รันซ้ำวันเดียวกัน/สอง worker = ไม่ส่งซ้ำ · ล้ม = rollback เฉพาะคนนั้น (job ลองใหม่)
 * - **ภายในเท่านั้น** — ไม่ส่งถึงลูกค้า (อีเมลลูกค้า = ST5-T21 · เตือนลูกค้าอัตโนมัติ = P1 ตาม spec/05 §10 ข้อ 10) → ไม่ลง audit (แบบ ST2-T18)
 * - ไม่ใส่ยอดเงินในข้อความ (สิทธิ์ดูราคาขายแยกต่อผู้ใช้)
 */
@Injectable()
export class PaymentDueReminderService implements OnModuleInit {
  private readonly logger = new Logger('PaymentDueReminderService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly db: DbService,
    private readonly queue: JobQueue,
    private readonly notifications: NotificationService,
    private readonly clock: Clock,
  ) {}

  onModuleInit() {
    this.queue.register(
      PAYMENT_DUE_JOB,
      async ({ tenantId, job, withTx }) => {
        const p = (job.payload ?? {}) as { day?: unknown };
        const today =
          typeof p.day === 'string' && isRealDate(p.day) ? p.day : bangkokToday(this.clock.now());
        if (!(await this.tenantActive(tenantId))) return { skipped: 'tenant_inactive', day: today };
        const r = await this.runForTenant(tenantId, today, withTx);
        if (r.failedRecipients > 0)
          throw new Error(
            `payment due digest failed for ${r.failedRecipients} recipient(s) — retrying (${r.digests} delivered)`,
          );
        return r;
      },
      { outsideTransaction: true },
    );
  }

  /** สร้าง job ของวันนี้ให้ทุก tenant ที่ยังไม่มี (เรียกซ้ำได้ — ก่อน 08:00 เวลาไทยไม่ทำอะไร) */
  async scheduleDue(now: Date = this.clock.now()): Promise<number> {
    const bkk = new Date(now.getTime() + 7 * 3600_000);
    if (bkk.getUTCHours() < RUN_FROM_HOUR_BKK) return 0;
    const today = bangkokToday(now);
    return this.prisma.platform.$transaction(async (db) => {
      await db.$executeRaw`SELECT pg_advisory_xact_lock(8, hashtext(${PAYMENT_DUE_JOB}))`;
      const tenants = await db.tenant.findMany({
        where: { status: { in: ['TRIAL', 'ACTIVE'] }, mode: 'live' },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });
      if (!tenants.length) return 0;
      const existing = await db.job.findMany({
        where: {
          tenantId: { in: tenants.map((t) => t.id) },
          type: PAYMENT_DUE_JOB,
          // created_at = เวลาจริงของฐาน — ใช้ค่าที่น้อยกว่าระหว่างนาฬิกาที่ฉีดกับเวลาจริง (test เลื่อนเวลาได้ทั้งสองทิศ)
          createdAt: { gte: new Date(Math.min(now.getTime(), Date.now()) - 3 * 86_400_000) },
          payload: { path: ['day'], equals: today },
        },
        select: { tenantId: true },
      });
      const done = new Set(existing.map((j) => j.tenantId));
      const todo = tenants.filter((t) => !done.has(t.id));
      for (const t of todo)
        await this.queue.enqueue(db as never as Tx, {
          tenantId: t.id,
          type: PAYMENT_DUE_JOB,
          payload: { day: today },
        });
      return todo.length;
    });
  }

  private async tenantActive(tenantId: string): Promise<boolean> {
    const t = await this.prisma.platform.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true },
    });
    return t?.status === 'TRIAL' || t?.status === 'ACTIVE';
  }

  /** งานของ tenant ณ วัน `today` (YYYY-MM-DD เวลาไทย) */
  async runForTenant(
    tenantId: string,
    today: string,
    withTx: WithTx = (fn) => this.db.withTenant(tenantId, fn),
  ): Promise<PaymentDueRunResult> {
    const candidates = await withTx((tx) => this.candidates(tx, today));
    const result: PaymentDueRunResult = {
      day: today,
      candidates: candidates.length,
      digests: 0,
      reminders: 0,
      unrouted: 0,
      failedRecipients: 0,
    };
    if (!candidates.length) return result;
    const { owners, fallback } = await withTx((tx) =>
      this.recipients(
        tx,
        tenantId,
        candidates.map((c) => c.ownerId).filter((x): x is string => !!x),
      ),
    );
    const byUser = new Map<string, PaymentDueCandidate[]>();
    for (const c of candidates) {
      const to = c.ownerId && owners.has(c.ownerId) ? [c.ownerId] : fallback;
      if (!to.length) result.unrouted += 1;
      for (const u of to) byUser.set(u, [...(byUser.get(u) ?? []), c]);
    }
    for (const [userId, mine] of [...byUser].sort(([a], [b]) => a.localeCompare(b))) {
      try {
        const n = await withTx((tx) => this.deliver(tx, tenantId, today, userId, mine));
        if (n) {
          result.digests += 1;
          result.reminders += n;
        }
      } catch (e) {
        result.failedRecipients += 1;
        this.logger.warn(
          `tenant ${tenantId} ${today}: payment due digest for user ${userId} failed (${mine.length} invoices) — retry: ${String(e)}`,
        );
      }
    }
    if (result.reminders || result.unrouted || result.failedRecipients)
      this.logger.log(`tenant ${tenantId} ${today}: payment due ${JSON.stringify(result)}`);
    return result;
  }

  /** ใบค้างรับที่ถึงระดับเตือนวันนี้ — เรียงเกินนานสุดก่อน แล้วตามวันครบกำหนด */
  async candidates(tx: Tx, today: string): Promise<PaymentDueCandidate[]> {
    const lo = Math.min(...Object.values(PAYMENT_DUE_WINDOW).map((w) => w[0]));
    const hi = Math.max(...Object.values(PAYMENT_DUE_WINDOW).map((w) => w[1]));
    const rows = await tx.invoice.findMany({
      where: {
        status: { in: ['ISSUED', 'PARTIALLY_PAID'] },
        paidAmount: { lt: tx.invoice.fields.totalAmount },
        invoiceNo: { not: null },
        // daysPastDue ∈ [lo, hi] ⇔ dueDate ∈ [today − hi, today − lo]
        dueDate: { gte: toDate(addDays(today, -hi)), lte: toDate(addDays(today, -lo)) },
      },
      select: {
        id: true,
        invoiceNo: true,
        dueDate: true,
        customer: { select: { legalName: true, salesOwnerUserId: true } },
      },
      orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
    });
    const out: PaymentDueCandidate[] = [];
    for (const r of rows) {
      const dueDate = ymd(r.dueDate!);
      const days = daysBetween(dueDate, today);
      const level = paymentDueLevel(days);
      if (!level) continue;
      out.push({
        invoiceId: r.id,
        dueDate,
        level,
        ownerId: r.customer.salesOwnerUserId,
        item: { level, invoiceNo: r.invoiceNo!, customer: r.customer.legalName, dueDate, days },
      });
    }
    return out.sort(
      (a, b) =>
        LEVEL_RANK[a.level] - LEVEL_RANK[b.level] ||
        a.dueDate.localeCompare(b.dueDate) ||
        a.invoiceId.localeCompare(b.invoiceId),
    );
  }

  /** ผู้ดูแลลูกค้าที่ใช้ได้ (ACTIVE + `invoices:read`) และผู้รับแทน (ACTIVE + `payments:record`) */
  private async recipients(
    tx: Tx,
    tenantId: string,
    ownerIds: string[],
  ): Promise<{ owners: Set<string>; fallback: string[] }> {
    const roles = await tx.role.findMany({
      where: { tenantId },
      select: { id: true, permissions: true },
    });
    const readRoles = new Set(
      roles.filter((r) => scopeAllows(r.permissions, OWNER_SCOPE)).map((r) => r.id),
    );
    const payRoles = new Set(
      roles.filter((r) => scopeAllows(r.permissions, FALLBACK_SCOPE)).map((r) => r.id),
    );
    const links = await tx.userRole.findMany({
      where: { tenantId, roleId: { in: [...new Set([...readRoles, ...payRoles])] } },
      select: { userId: true, roleId: true },
    });
    const active = new Set(
      (
        await tx.appUser.findMany({
          where: {
            tenantId,
            id: { in: [...new Set(links.map((l) => l.userId))] },
            status: 'ACTIVE',
            deletedAt: null,
          },
          select: { id: true },
        })
      ).map((u) => u.id),
    );
    const want = new Set(ownerIds);
    const owners = new Set(
      links
        .filter((l) => readRoles.has(l.roleId) && active.has(l.userId) && want.has(l.userId))
        .map((l) => l.userId),
    );
    const fallback = [
      ...new Set(
        links.filter((l) => payRoles.has(l.roleId) && active.has(l.userId)).map((l) => l.userId),
      ),
    ].sort();
    return { owners, fallback };
  }

  /** จองสมุดเตือนของผู้รับคนนี้ แล้วส่งสรุปฉบับเดียวของใบที่จองได้ — คืนจำนวนที่จองได้ */
  private async deliver(
    tx: Tx,
    tenantId: string,
    today: string,
    userId: string,
    items: PaymentDueCandidate[],
  ): Promise<number> {
    // review L1: วันละฉบับต่อคน — job ลองใหม่ (ผู้รับอื่นล้ม) หลังมีใบใหม่เข้าเงื่อนไข ต้องไม่ส่งฉบับที่สอง
    // ใบที่เพิ่งเข้าเงื่อนไขจะถูกจองรอบวันถัดไป (ช่วงระดับยาวหลายวัน — DUE_IN_3 วันสุดท้ายข้ามไปเป็น DUE_TODAY)
    const sentToday = await tx.expiryReminder.findFirst({
      where: { tenantId, entityType: ENTITY, recipientId: userId, sentOn: toDate(today) },
      select: { id: true },
    });
    if (sentToday) return 0;
    const claimed = await tx.expiryReminder.createManyAndReturn({
      data: items.map((c) => ({
        tenantId,
        entityType: ENTITY,
        entityId: c.invoiceId,
        level: c.level,
        expiresOn: toDate(c.dueDate),
        recipientId: userId,
        sentOn: toDate(today),
      })),
      skipDuplicates: true,
      select: { entityId: true, level: true, expiresOn: true },
    });
    if (!claimed.length) return 0;
    const got = new Set(claimed.map((r) => keyOf(r.entityId, r.level, ymd(r.expiresOn))));
    const list = items.filter((c) => got.has(keyOf(c.invoiceId, c.level, c.dueDate)));
    await this.notifications.notify(tx, {
      tenantId,
      to: { userIds: [userId] },
      template: 'invoice.payment_due',
      vars: {
        total: list.length,
        more: Math.max(0, list.length - DIGEST_MAX_ITEMS),
        items: list.slice(0, DIGEST_MAX_ITEMS).map((c) => c.item),
      },
      link: LINK,
    });
    return claimed.length;
  }
}
