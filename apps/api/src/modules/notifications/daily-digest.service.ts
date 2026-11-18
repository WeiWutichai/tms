import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Clock } from '../../common/clock';
import { DbService, type Tx } from '../../db/db.service';
import { PrismaService } from '../../db/prisma.service';
import { JobQueue } from '../../jobs/job-queue.service';
import { addDays, bangkokToday, isRealDate } from '../vehicle-documents/expiry';
import {
  NOTIFICATION_EVENTS,
  NOTIFICATION_PREF_KEY,
  digestEnabled,
  eventOfTemplate,
  parsePrefs,
} from './catalogue';
import { NotificationService } from './notification.service';
import type { DailyDigestGroup } from './templates';

export const DAILY_DIGEST_JOB = 'notification.daily_digest';
/** สรุปรายวันส่งตั้งแต่ 08:00 เวลาไทย (docs/04 I) */
export const DIGEST_HOUR_BKK = 8;
/** หัวข้อที่แสดงต่อกลุ่มในอีเมลสรุป — ที่เกินขึ้น "และอีก N รายการ" */
export const DIGEST_TITLES = 5;
const DIGEST_TEMPLATE = 'daily.digest';

type WithTx = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

export interface DailyDigestResult {
  day: string;
  /** ผู้ใช้ที่จองสรุปของวันนี้ได้รอบนี้ (รวมที่ไม่มีอะไรให้สรุป) */
  claimed: number;
  /** อีเมลสรุปที่ส่ง (มีแจ้งเตือน ≥ 1 รายการในช่วง) */
  sent: number;
  failed: number;
}

/** ช่วง 24 ชม. ของสรุปวัน `day`: [day−1 08:00, day 08:00) เวลาไทย */
export function digestWindow(day: string): { from: Date; to: Date } {
  const hh = String(DIGEST_HOUR_BKK).padStart(2, '0');
  return {
    from: new Date(`${addDays(day, -1)}T${hh}:00:00+07:00`),
    to: new Date(`${day}T${hh}:00:00+07:00`),
  };
}

/**
 * สรุปรายวัน 08:00 (ST9-T08; docs/04 I "สรุปรายวัน 08:00")
 *
 * - worker เรียก `scheduleDue()` ทุก 10 นาที → ตั้งแต่ 08:00 เวลาไทย (Clock) สร้าง job 1 ชิ้น/tenant/วัน
 *   (TRIAL/ACTIVE · advisory lock กันสอง worker สร้างซ้ำ — แบบเดียวกับ ST2-T18)
 * - handler: ผู้ใช้ ACTIVE ที่เปิด "สรุปรายวัน" (ค่าเริ่มต้นเปิด) ทีละคนใน transaction ของตัวเอง:
 *   จองแถว `notification_digest` (unique tenant × ผู้ใช้ × วัน; ON CONFLICT DO NOTHING) → รวมแจ้งเตือนในกระดิ่งช่วง
 *   [เมื่อวาน 08:00, วันนี้ 08:00) แยกตาม event → อีเมลฉบับเดียว (ไม่มีอะไร = ไม่ส่ง แต่จองไว้แล้ว)
 *   → job รันซ้ำ / สอง worker / ลองใหม่หลังบางคนล้ม = **ส่งครั้งเดียว** ต่อคนต่อวัน
 * - ไม่สร้างแถวในกระดิ่ง (สรุปของสิ่งที่อยู่ในกระดิ่งแล้ว) · ปิดสรุปรายวันได้ที่ ตั้งค่า → การแจ้งเตือน
 */
@Injectable()
export class DailyDigestService implements OnModuleInit {
  private readonly logger = new Logger('DailyDigestService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly db: DbService,
    private readonly queue: JobQueue,
    private readonly notifications: NotificationService,
    private readonly clock: Clock,
  ) {}

  onModuleInit() {
    this.queue.register(
      DAILY_DIGEST_JOB,
      async ({ tenantId, job, withTx }) => {
        const p = (job.payload ?? {}) as { day?: unknown };
        const day =
          typeof p.day === 'string' && isRealDate(p.day) ? p.day : bangkokToday(this.clock.now());
        if (!(await this.tenantActive(tenantId))) return { skipped: 'tenant_inactive', day };
        const r = await this.runForTenant(tenantId, day, withTx);
        if (r.failed > 0)
          throw new Error(
            `daily digest failed for ${r.failed} user(s) — retrying (${r.sent} sent)`,
          );
        return r;
      },
      { outsideTransaction: true },
    );
  }

  /** สร้าง job ของวันนี้ให้ทุก tenant ที่ยังไม่มี (เรียกซ้ำได้ — ก่อน 08:00 ไม่ทำอะไร) */
  async scheduleDue(now: Date = this.clock.now()): Promise<number> {
    const bkk = new Date(now.getTime() + 7 * 3600_000);
    if (bkk.getUTCHours() < DIGEST_HOUR_BKK) return 0;
    const day = bangkokToday(now);
    return this.prisma.platform.$transaction(async (db) => {
      await db.$executeRaw`SELECT pg_advisory_xact_lock(8, hashtext(${DAILY_DIGEST_JOB}))`;
      const tenants = await db.tenant.findMany({
        where: { status: { in: ['TRIAL', 'ACTIVE'] } },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });
      if (!tenants.length) return 0;
      const existing = await db.job.findMany({
        where: {
          tenantId: { in: tenants.map((t) => t.id) },
          type: DAILY_DIGEST_JOB,
          createdAt: { gte: new Date(now.getTime() - 3 * 86_400_000) },
          payload: { path: ['day'], equals: day },
        },
        select: { tenantId: true },
      });
      const done = new Set(existing.map((j) => j.tenantId));
      const todo = tenants.filter((t) => !done.has(t.id));
      for (const t of todo)
        await this.queue.enqueue(db as unknown as Tx, {
          tenantId: t.id,
          type: DAILY_DIGEST_JOB,
          payload: { day },
        });
      return todo.length;
    });
  }

  async tenantActive(tenantId: string): Promise<boolean> {
    const t = await this.prisma.platform.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true },
    });
    return t?.status === 'TRIAL' || t?.status === 'ACTIVE';
  }

  async runForTenant(
    tenantId: string,
    day: string,
    withTx: WithTx = (fn) => this.db.withTenant(tenantId, fn),
  ): Promise<DailyDigestResult> {
    const users = await withTx(async (tx) => {
      const us = await tx.appUser.findMany({
        where: { tenantId, status: 'ACTIVE', deletedAt: null },
        select: { id: true },
        orderBy: { id: 'asc' },
      });
      const prefs = await tx.userPreference.findMany({
        where: { tenantId, key: NOTIFICATION_PREF_KEY },
        select: { userId: true, value: true },
      });
      const off = new Set(
        prefs.filter((p) => !digestEnabled(parsePrefs(p.value))).map((p) => p.userId),
      );
      return us.filter((u) => !off.has(u.id)).map((u) => u.id);
    });
    const result: DailyDigestResult = { day, claimed: 0, sent: 0, failed: 0 };
    for (const userId of users) {
      try {
        const r = await withTx((tx) => this.deliver(tx, tenantId, day, userId));
        if (r !== 'skipped') result.claimed += 1;
        if (r === 'sent') result.sent += 1;
      } catch (e) {
        result.failed += 1;
        this.logger.warn(
          `tenant ${tenantId} ${day}: daily digest for ${userId} failed: ${String(e)}`,
        );
      }
    }
    if (result.sent || result.failed)
      this.logger.log(
        `tenant ${tenantId} ${day}: daily digest ${result.sent} sent, ${result.failed} failed`,
      );
    return result;
  }

  /** จอง (ผู้ใช้, วัน) แล้วส่งสรุปถ้ามีรายการ — 'skipped' = เคยจองแล้ว (ส่งไปแล้ว/ไม่มีอะไร) */
  private async deliver(
    tx: Tx,
    tenantId: string,
    day: string,
    userId: string,
  ): Promise<'sent' | 'empty' | 'skipped'> {
    const { from, to } = digestWindow(day);
    const rows = await tx.notification.findMany({
      where: {
        recipientId: userId,
        channel: 'in_app',
        createdAt: { gte: from, lt: to },
        templateCode: { not: DIGEST_TEMPLATE },
      },
      select: { templateCode: true, title: true, body: true, readAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const claimed = await tx.notificationDigest.createManyAndReturn({
      data: [{ tenantId, userId, digestDay: new Date(`${day}T00:00:00Z`), items: rows.length }],
      skipDuplicates: true,
      select: { id: true },
    });
    if (!claimed.length) return 'skipped';
    if (!rows.length) return 'empty';
    const order = [...NOTIFICATION_EVENTS, 'other'] as string[];
    const by = new Map<string, DailyDigestGroup>();
    for (const r of rows) {
      const ev = eventOfTemplate(r.templateCode) ?? 'other';
      const g = by.get(ev) ?? { event: ev, count: 0, titles: [] };
      g.count += 1;
      if (g.titles.length < DIGEST_TITLES) g.titles.push(`${r.title}: ${r.body}`);
      by.set(ev, g);
    }
    const groups = [...by.values()].sort((a, b) => order.indexOf(a.event) - order.indexOf(b.event));
    await this.notifications.notify(tx, {
      tenantId,
      to: { userIds: [userId] },
      template: 'daily.digest',
      channels: ['email'],
      vars: {
        day,
        total: rows.length,
        unread: rows.filter((r) => !r.readAt).length,
        groups,
      },
      link: '/',
    });
    return 'sent';
  }
}
