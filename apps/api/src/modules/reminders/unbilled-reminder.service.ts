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
import { addDays, bangkokToday, daysBetween, isRealDate } from '../vehicle-documents/expiry';
import { DIGEST_MAX_ITEMS, RUN_FROM_HOUR_BKK } from './expiry-reminder.service';

export const UNBILLED_REMINDER_JOB = 'delivery_order.unbilled';
/**
 * สมุดเตือน (expiry_reminder — migration 0153): D-71 จองแถว**ต่อผู้รับต่อวัน** (ไม่ใช่ต่อ DO แล้ว) —
 * entity_type 'DELIVERY_ORDER' + level 'UNBILLED' (ค่าที่ CHECK ของ 0153 ยอมอยู่แล้ว → ไม่ต้อง migration) · entity_id = tenant_id (ตัวแทน
 * "สรุปของบริษัท" — ไม่ชน id ของ DO) · expires_on = sent_on = วันที่ส่ง · unique เดิมกันส่งซ้ำวันเดียวกัน (job ลองใหม่/สอง worker)
 * แถวแบบเดิม (DO × วันที่ส่งถึง × ผู้รับ ของ ST9-T06 ก่อน D-71) ยังอยู่ — นับเป็น "ส่งแล้ววันนั้น" ด้วย (วันที่ deploy ไม่ส่งซ้ำ)
 */
const ENTITY = 'DELIVERY_ORDER';
const LEVEL = 'UNBILLED';
/** ผู้วางบิล = ผู้ทำร่างใบแจ้งหนี้ได้ (Invoicer / บัญชี / owner / admin + role กำหนดเองที่มีสิทธิ์นี้) */
const RECIPIENT_SCOPE = 'invoices:draft';
const LINK_REPORT = '/reports?tab=unbilled';
/** แพ็กเกจไม่มีโมดูลรายงาน (`report`) → ลิงก์ไปหน้าวางบิล (คิวพร้อมวางบิล) แทน — review M1 */
const LINK_BILL = '/bill';

type WithTx = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

/** ยอดของวัน (D-71) — ชุดเดียวกับรายงาน */
export interface UnbilledDigestCounts {
  /** เพิ่งเกินเกณฑ์วันนี้ = ยังไม่อยู่ในใบใด และส่งถึงวันที่ asOf − N − 1 พอดี (วันนี้ − วันที่ส่งถึง = N + 1) */
  fresh: number;
  /** ค้างเกินเกณฑ์ทั้งหมด (ยังไม่อยู่ในใบใด) */
  outstanding: number;
  /** อยู่ในร่างใบแจ้งหนี้ค้างเกิน N วัน */
  staleDrafts: number;
  /** DO ที่เพิ่งเกินวันนี้ สูงสุด DIGEST_MAX_ITEMS (เรียงส่งถึงเก่าสุดก่อน) */
  items: UnbilledDoItem[];
}

export interface UnbilledRunResult {
  day: string;
  minDays: number;
  fresh: number;
  outstanding: number;
  staleDrafts: number;
  recipients: number;
  /** ผู้รับที่ได้ข้อความรอบนี้ */
  digests: number;
  failedRecipients: number;
}

const toDate = (d: string) => new Date(`${d}T00:00:00Z`);

/**
 * แจ้งผู้วางบิลอัตโนมัติ "DO ยังไม่วางบิลเกิน N วัน" (ST9-T06; docs/04 H "กันรายได้ตกหล่น; ส่ง LINE/อีเมลให้ Invoicer อัตโนมัติ",
 * I เหตุการณ์ "DO ยังไม่วางบิล" + "สรุปรายวัน 08:00") — แบบเดียวกับเตือนครบกำหนดชำระ ST5-T22
 *
 * - worker เรียก `scheduleDue()` ทุก 10 นาที → ตั้งแต่ 08:00 เวลาไทย สร้าง job 1 ชิ้น/tenant/วัน (advisory lock) · เฉพาะ tenant live (sandbox ไม่ส่ง)
 * - D-71 (PO 22 พ.ย. 2569): **ส่งทุกเช้าที่ยังมีใบค้าง** — แยก "เพิ่งเกินวันนี้ X ใบ" / "ค้างทั้งหมด Y ใบ" / "อยู่ในร่างใบแจ้งหนี้ค้างเกิน N วัน Z ใบ"
 *   (ชุดเดียวกับรายงาน `UnbilledReportService`) · Y + Z = 0 → ไม่ส่ง
 * - ผู้รับ = ผู้ใช้ ACTIVE ที่มี `invoices:draft` · ทีละคน (transaction ของตัวเอง): จองสมุดเตือน 1 แถว/คน/วัน (ON CONFLICT DO NOTHING)
 *   → ข้อความตามการตั้งค่า event `delivery_order.unbilled` (กระดิ่ง/อีเมล) · ไม่ใส่ยอดเงิน · ภายในเท่านั้น (ไม่ลง audit)
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
    const { minDays, counts } = await withTx(async (tx) => {
      const minDays = await this.report.thresholdDays(tx, tenantId);
      return { minDays, counts: await this.counts(tx, today, minDays) };
    });
    const result: UnbilledRunResult = {
      day: today,
      minDays,
      fresh: counts.fresh,
      outstanding: counts.outstanding,
      staleDrafts: counts.staleDrafts,
      recipients: 0,
      digests: 0,
      failedRecipients: 0,
    };
    if (counts.outstanding + counts.staleDrafts === 0) return result;
    const users = await withTx((tx) => this.recipients(tx, tenantId));
    result.recipients = users.length;
    const target = (await this.entitlements.enabled(tenantId, 'report')) ? 'report' : 'bill';
    for (const userId of users) {
      try {
        if (
          await withTx((tx) => this.deliver(tx, tenantId, today, userId, minDays, counts, target))
        )
          result.digests += 1;
      } catch (e) {
        result.failedRecipients += 1;
        this.logger.warn(
          `tenant ${tenantId} ${today}: unbilled DO digest for user ${userId} failed — retry: ${String(e)}`,
        );
      }
    }
    if (result.digests || result.failedRecipients)
      this.logger.log(`tenant ${tenantId} ${today}: unbilled DO ${JSON.stringify(result)}`);
    return result;
  }

  /** ยอดของวัน `today` (ชุดเดียวกับรายงาน) + รายการ DO ที่เพิ่งเกินวันนี้ (สูงสุด DIGEST_MAX_ITEMS) */
  async counts(tx: Tx, today: string, minDays: number): Promise<UnbilledDigestCounts> {
    const crossedOn = addDays(today, -(minDays + 1));
    const base = { asOf: today, minDays };
    const outstanding = (await this.report.totals(tx, { ...base, scope: 'unbilled' })).n;
    const staleDrafts = (await this.report.totals(tx, { ...base, scope: 'drafts' })).n;
    const freshF = { ...base, scope: 'unbilled' as const, deliveredOnFrom: crossedOn };
    const fresh = outstanding ? (await this.report.totals(tx, freshF)).n : 0;
    const rows: UnbilledRow[] = fresh
      ? await this.report.rows(tx, freshF, { take: DIGEST_MAX_ITEMS })
      : [];
    return {
      fresh,
      outstanding,
      staleDrafts,
      items: rows.map((r) => ({
        doNo: r.do_no ?? '—',
        customer: r.customer_name,
        deliveredOn: r.delivered_on,
        days: daysBetween(r.delivered_on, today),
      })),
    };
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

  /** จองสมุดเตือนวันนี้ของผู้รับคนนี้ แล้วแจ้ง 1 ฉบับ — คืน true เมื่อส่ง (จองไม่ได้ = ส่งแล้ววันนี้) */
  private async deliver(
    tx: Tx,
    tenantId: string,
    today: string,
    userId: string,
    minDays: number,
    c: UnbilledDigestCounts,
    target: 'report' | 'bill',
  ): Promise<boolean> {
    // วันละฉบับต่อคน — รวมแถวแบบเดิม (ต่อ DO ก่อน D-71) ของวันเดียวกัน · job ลองใหม่ (ผู้รับอื่นล้ม) ต้องไม่ส่งฉบับที่สอง
    const sentToday = await tx.expiryReminder.findFirst({
      where: { tenantId, entityType: ENTITY, recipientId: userId, sentOn: toDate(today) },
      select: { id: true },
    });
    if (sentToday) return false;
    const claimed = await tx.expiryReminder.createMany({
      data: [
        {
          tenantId,
          entityType: ENTITY,
          entityId: tenantId,
          level: LEVEL,
          expiresOn: toDate(today),
          recipientId: userId,
          sentOn: toDate(today),
        },
      ],
      skipDuplicates: true,
    });
    if (!claimed.count) return false;
    await this.notifications.notify(tx, {
      tenantId,
      to: { userIds: [userId] },
      template: 'delivery_order.unbilled',
      vars: {
        target,
        minDays,
        fresh: c.fresh,
        outstanding: c.outstanding,
        staleDrafts: c.staleDrafts,
        more: Math.max(0, c.fresh - c.items.length),
        items: c.items,
      },
      link: target === 'report' ? LINK_REPORT : LINK_BILL,
    });
    return true;
  }
}
