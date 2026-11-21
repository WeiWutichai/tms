import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { scopeAllows } from '@tms/domain';
import { Clock } from '../../common/clock';
import { DbService, type Tx } from '../../db/db.service';
import { PrismaService } from '../../db/prisma.service';
import { JobQueue } from '../../jobs/job-queue.service';
import { EntitlementService } from '../entitlements/entitlement.service';
import { NotificationService } from '../notifications/notification.service';
import type { UnbilledDoItem } from '../notifications/templates';
import { UnbilledReportService, type UnbilledRow } from '../reports/unbilled-report.service';
import { bangkokToday, daysBetween, isRealDate } from '../vehicle-documents/expiry';
import { DIGEST_MAX_ITEMS, RUN_FROM_HOUR_BKK } from './expiry-reminder.service';

export const UNBILLED_REMINDER_JOB = 'delivery_order.unbilled';
/** สมุดเตือน (expiry_reminder) — migration 0153 */
const ENTITY = 'DELIVERY_ORDER';
const LEVEL = 'UNBILLED';
/** ผู้วางบิล = ผู้ทำร่างใบแจ้งหนี้ได้ (Invoicer / บัญชี / owner / admin + role กำหนดเองที่มีสิทธิ์นี้) */
const RECIPIENT_SCOPE = 'invoices:draft';
const LINK_REPORT = '/reports?tab=unbilled';
/** แพ็กเกจไม่มีโมดูลรายงาน (`report`) → ลิงก์ไปหน้าวางบิล (คิวพร้อมวางบิล) แทน — review M1 */
const LINK_BILL = '/bill';
/** อ่าน DO ที่เกินเกณฑ์ทีละหน้า และเพดานต่อรอบ (กัน job ใหญ่ผิดปกติ — ที่เหลือจองรอบวันถัดไป) */
const PAGE = 1000;
const MAX_CANDIDATES = 20_000;

type WithTx = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

export interface UnbilledCandidate {
  id: string;
  deliveredOn: string;
  item: UnbilledDoItem;
}

export interface UnbilledRunResult {
  day: string;
  minDays: number;
  /** DO ที่เกินเกณฑ์ ณ วันนี้ */
  candidates: number;
  recipients: number;
  /** ผู้รับที่ได้ข้อความรอบนี้ (มี DO ใหม่) */
  digests: number;
  /** แถวสมุดเตือนที่จองได้ (DO × ผู้รับ) */
  reminders: number;
  failedRecipients: number;
}

const toDate = (d: string) => new Date(`${d}T00:00:00Z`);
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const keyOf = (id: string, on: string) => `${id}|${on}`;

/**
 * แจ้งผู้วางบิลอัตโนมัติ "DO ยังไม่วางบิลเกิน N วัน" (ST9-T06; docs/04 H "กันรายได้ตกหล่น; ส่ง LINE/อีเมลให้ Invoicer อัตโนมัติ",
 * I เหตุการณ์ "DO ยังไม่วางบิล" + "สรุปรายวัน 08:00") — แบบเดียวกับเตือนครบกำหนดชำระ ST5-T22
 *
 * - worker เรียก `scheduleDue()` ทุก 10 นาที → ตั้งแต่ 08:00 เวลาไทย สร้าง job 1 ชิ้น/tenant/วัน (advisory lock) · เฉพาะ tenant live (sandbox ไม่ส่ง)
 * - DO = ชุดเดียวกับรายงาน (`UnbilledReportService` — ส่งถึงแล้ว + ยังไม่อยู่ในใบใด + เกิน `billing.unbilledAlertDays` วัน)
 * - ผู้รับ = ผู้ใช้ ACTIVE ที่มี `invoices:draft` · ทีละคน (transaction ของตัวเอง): จองสมุดเตือน DO × วันที่ส่งถึง × ผู้รับ
 *   (ON CONFLICT DO NOTHING) → **ส่งเฉพาะเมื่อมี DO ที่เพิ่งเกินเกณฑ์** (ไม่ทวงซ้ำทุกวัน — ค้างเก่าดูในรายงาน) ฉบับเดียว/คน/วัน
 *   [DECISION spec/12 §3] · ข้อความตามการตั้งค่า event `delivery_order.unbilled` (กระดิ่ง/อีเมล) · ไม่ใส่ยอดเงิน · ภายในเท่านั้น (ไม่ลง audit)
 * - LINE ทีมภายใน = P1 (docs/04 I) — ยังไม่ส่ง
 */
@Injectable()
export class UnbilledReminderService implements OnModuleInit {
  private readonly logger = new Logger('UnbilledReminderService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly db: DbService,
    private readonly queue: JobQueue,
    private readonly notifications: NotificationService,
    private readonly report: UnbilledReportService,
    private readonly entitlements: EntitlementService,
    private readonly clock: Clock,
  ) {}

  onModuleInit() {
    this.queue.register(
      UNBILLED_REMINDER_JOB,
      async ({ tenantId, job, withTx }) => {
        const p = (job.payload ?? {}) as { day?: unknown };
        const today =
          typeof p.day === 'string' && isRealDate(p.day) ? p.day : bangkokToday(this.clock.now());
        if (!(await this.tenantActive(tenantId))) return { skipped: 'tenant_inactive', day: today };
        const r = await this.runForTenant(tenantId, today, withTx);
        if (r.failedRecipients > 0)
          throw new Error(
            `unbilled DO digest failed for ${r.failedRecipients} recipient(s) — retrying (${r.digests} delivered)`,
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
      await db.$executeRaw`SELECT pg_advisory_xact_lock(8, hashtext(${UNBILLED_REMINDER_JOB}))`;
      const tenants = await db.tenant.findMany({
        where: { status: { in: ['TRIAL', 'ACTIVE'] }, mode: 'live' },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });
      if (!tenants.length) return 0;
      const existing = await db.job.findMany({
        where: {
          tenantId: { in: tenants.map((t) => t.id) },
          type: UNBILLED_REMINDER_JOB,
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
          type: UNBILLED_REMINDER_JOB,
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
  ): Promise<UnbilledRunResult> {
    const { minDays, candidates } = await withTx(async (tx) => {
      const minDays = await this.report.thresholdDays(tx, tenantId);
      return { minDays, candidates: await this.candidates(tx, today, minDays) };
    });
    const result: UnbilledRunResult = {
      day: today,
      minDays,
      candidates: candidates.length,
      recipients: 0,
      digests: 0,
      reminders: 0,
      failedRecipients: 0,
    };
    if (!candidates.length) return result;
    const users = await withTx((tx) => this.recipients(tx, tenantId));
    result.recipients = users.length;
    const target = (await this.entitlements.enabled(tenantId, 'report')) ? 'report' : 'bill';
    for (const userId of users) {
      try {
        const n = await withTx((tx) =>
          this.deliver(tx, tenantId, today, userId, minDays, candidates, target),
        );
        if (n) {
          result.digests += 1;
          result.reminders += n;
        }
      } catch (e) {
        result.failedRecipients += 1;
        this.logger.warn(
          `tenant ${tenantId} ${today}: unbilled DO digest for user ${userId} failed — retry: ${String(e)}`,
        );
      }
    }
    if (result.reminders || result.failedRecipients)
      this.logger.log(`tenant ${tenantId} ${today}: unbilled DO ${JSON.stringify(result)}`);
    return result;
  }

  /** DO ที่เกินเกณฑ์ ณ `today` — เรียงส่งถึงเก่าสุดก่อน (ชุดเดียวกับรายงาน) */
  async candidates(tx: Tx, today: string, minDays: number): Promise<UnbilledCandidate[]> {
    const out: UnbilledCandidate[] = [];
    let after: { id: string } | null = null;
    while (out.length < MAX_CANDIDATES) {
      const rows: UnbilledRow[] = await this.report.rows(
        tx,
        { asOf: today, minDays },
        { take: PAGE, after },
      );
      for (const r of rows)
        out.push({
          id: r.id,
          deliveredOn: r.delivered_on,
          item: {
            doNo: r.do_no ?? '—',
            customer: r.customer_name,
            deliveredOn: r.delivered_on,
            days: daysBetween(r.delivered_on, today),
          },
        });
      if (rows.length < PAGE) break;
      after = { id: rows[rows.length - 1]!.id };
    }
    return out.slice(0, MAX_CANDIDATES);
  }

  /** ผู้วางบิล: ACTIVE + role ที่มี `invoices:draft` */
  private async recipients(tx: Tx, tenantId: string): Promise<string[]> {
    const roles = await tx.role.findMany({
      where: { tenantId },
      select: { id: true, permissions: true },
    });
    const ok = roles.filter((r) => scopeAllows(r.permissions, RECIPIENT_SCOPE)).map((r) => r.id);
    if (!ok.length) return [];
    const links = await tx.userRole.findMany({
      where: { tenantId, roleId: { in: ok } },
      select: { userId: true },
    });
    const users = await tx.appUser.findMany({
      where: {
        tenantId,
        id: { in: [...new Set(links.map((l) => l.userId))] },
        status: 'ACTIVE',
        deletedAt: null,
      },
      select: { id: true },
    });
    return users.map((u) => u.id).sort();
  }

  /** จองสมุดเตือนของผู้รับคนนี้ แล้วแจ้งฉบับเดียวเมื่อมี DO ใหม่ — คืนจำนวนที่จองได้ */
  private async deliver(
    tx: Tx,
    tenantId: string,
    today: string,
    userId: string,
    minDays: number,
    items: UnbilledCandidate[],
    target: 'report' | 'bill',
  ): Promise<number> {
    // วันละฉบับต่อคน — job ลองใหม่ (ผู้รับอื่นล้ม) ต้องไม่ส่งฉบับที่สอง · DO ที่เพิ่งเข้าเงื่อนไขจองรอบวันถัดไป
    const sentToday = await tx.expiryReminder.findFirst({
      where: { tenantId, entityType: ENTITY, recipientId: userId, sentOn: toDate(today) },
      select: { id: true },
    });
    if (sentToday) return 0;
    const claimed = await tx.expiryReminder.createManyAndReturn({
      data: items.map((c) => ({
        tenantId,
        entityType: ENTITY,
        entityId: c.id,
        level: LEVEL,
        expiresOn: toDate(c.deliveredOn),
        recipientId: userId,
        sentOn: toDate(today),
      })),
      skipDuplicates: true,
      select: { entityId: true, expiresOn: true },
    });
    if (!claimed.length) return 0;
    const got = new Set(claimed.map((r) => keyOf(r.entityId, ymd(r.expiresOn))));
    const fresh = items.filter((c) => got.has(keyOf(c.id, c.deliveredOn)));
    await this.notifications.notify(tx, {
      tenantId,
      to: { userIds: [userId] },
      template: 'delivery_order.unbilled',
      vars: {
        target,
        minDays,
        fresh: fresh.length,
        outstanding: items.length,
        more: Math.max(0, fresh.length - DIGEST_MAX_ITEMS),
        items: fresh.slice(0, DIGEST_MAX_ITEMS).map((c) => c.item),
      },
      link: target === 'report' ? LINK_REPORT : LINK_BILL,
    });
    return claimed.length;
  }
}
