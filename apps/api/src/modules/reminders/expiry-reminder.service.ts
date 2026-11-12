import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { scopeAllows } from '@tms/domain';
import { Clock } from '../../common/clock';
import { DbService, type Tx } from '../../db/db.service';
import { PrismaService } from '../../db/prisma.service';
import { JobQueue } from '../../jobs/job-queue.service';
import { NotificationService } from '../notifications/notification.service';
import type { ExpiryDigestItem } from '../notifications/templates';
import {
  EXPIRING_DAYS,
  addDays,
  bangkokToday,
  daysBetween,
  isRealDate,
} from '../vehicle-documents/expiry';
import {
  EXPIRED_NOTICE_WINDOW_DAYS,
  REMINDER_THRESHOLDS,
  dueLevel,
  lookahead,
  type ReminderEntityType,
  type ReminderLevel,
} from './expiry-policy';

export const EXPIRY_REMINDER_JOB = 'expiry.reminders';
/** สรุปรายวันส่งตั้งแต่ 08:00 เวลาไทย (docs/04 I "สรุปรายวัน 08:00" — ทับ spec/06 FLT-040 06:00; spec/12 §3 #40) */
export const RUN_FROM_HOUR_BKK = 8;
/** รายการที่แสดงในสรุปหนึ่งฉบับ — ที่เกินขึ้น "และอีก N รายการ" */
export const DIGEST_MAX_ITEMS = 20;

/** ผู้รับตามสิทธิ์ (role ใดก็ได้ที่มี scope นี้ — รวม role กำหนดเอง) [OPEN #40 — ยังไม่มีหน้าตั้งผู้รับผิดชอบ] */
const RECIPIENT_SCOPE = {
  VEHICLE_DOCUMENT: 'master:write',
  DRIVER_LICENCE: 'master:write',
  RATE_CARD_SELL: 'prices.sell:write',
  RATE_CARD_BUY: 'prices.buy:write',
} as const;
type RecipientKey = keyof typeof RECIPIENT_SCOPE;

export interface ExpiryCandidate {
  entityType: ReminderEntityType;
  entityId: string;
  expiresOn: string;
  level: ReminderLevel;
  recipients: RecipientKey;
  item: ExpiryDigestItem;
}
interface Recipient {
  userId: string;
  keys: Set<RecipientKey>;
}

export interface ExpiryRunResult {
  day: string;
  /** เอกสารรถที่ตั้งสถานะใหม่ (ACTIVE/EXPIRING/EXPIRED) */
  statusUpdated: number;
  /** รายการที่ถึงระดับเตือนวันนี้ (ก่อนตัดที่เคยเตือนแล้ว) */
  candidates: number;
  /** ผู้รับที่ได้สรุปรอบนี้ (1 คน = in-app 1 + อีเมล 1) */
  digests: number;
  /** แถวสมุดเตือนที่จองได้รอบนี้ (รายการ × ผู้รับ) */
  reminders: number;
  /** รายการ/ผู้รับที่ล้ม (ข้ามไป — รอบหน้าลองใหม่ เพราะไม่ได้จอง) */
  failedItems: number;
  failedRecipients: number;
}

type WithTx = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

const day = (d: Date) => d.toISOString().slice(0, 10);
const toDate = (d: string) => new Date(`${d}T00:00:00Z`);
const keyOf = (c: { entityType: string; entityId: string; level: string; expiresOn: string }) =>
  `${c.entityType}|${c.entityId}|${c.level}|${c.expiresOn}`;
/** ลำดับรายการในสรุป: หมดแล้ว → ใกล้สุด, แล้วตามวันหมด */
const LEVEL_RANK: Record<ReminderLevel, number> = { EXPIRED: 0, D7: 1, D30: 2, D60: 3 };
const LINK: Record<ExpiryDigestItem['kind'], string> = {
  VEHICLE_DOCUMENT: '/fleet/documents',
  DRIVER_LICENCE: '/fleet/drivers',
  RATE_CARD: '/master/rate-cards',
};

/**
 * เตือนต่ออายุ (ST2-T18; docs/04 B2.1 ส่วน 2, B คนขับ, B Rate card NEAR_EXPIRY, I สรุปรายวัน; spec/06 FLT-040/041/300)
 *
 * - worker เรียก `scheduleDue()` ทุก 10 นาที → ตั้งแต่ 08:00 เวลาไทย สร้าง job `expiry.reminders` 1 ชิ้น/tenant/วัน
 *   (tenant TRIAL/ACTIVE; advisory lock กันสอง worker สร้างซ้ำ) → JobQueue รัน handler แบบ outsideTransaction
 * - handler แบ่งเป็น transaction สั้น ๆ ของ tenant (RLS):
 *   (1) ตั้ง `vehicle_document.status` ให้ตรงวันหมด (คอลัมน์ของ T17) แล้ว commit ทันที — ไม่ถือ row lock ระหว่างแจ้ง
 *       ใบขับขี่/rate card สถานะคำนวณจากวันที่ (T08/T13) ไม่มีคอลัมน์ให้ตั้ง
 *   (2) อ่านรายการที่ถึงระดับเตือน — รายการที่สร้างไม่ได้ (ข้อมูลเสีย) ข้ามและ log ไม่ขวางรายการอื่น
 *   (3) ผู้รับทีละคน (transaction ของตัวเอง): จองแถวสมุด (ON CONFLICT DO NOTHING) เฉพาะรายการที่คนนั้นมีสิทธิ์
 *       → ส่ง **สรุปฉบับเดียว** (in-app 1 + อีเมล 1) ของรายการที่จองได้ · ล้ม = rollback เฉพาะคนนั้น (รอบหน้าส่งใหม่)
 *   → รันซ้ำวันเดียวกัน/สอง worker พร้อมกัน/วันถัดไปก่อนถึงระดับถัดไป = ไม่ส่งซ้ำ · ผู้รับกี่คนก็ได้ (ไม่ชนเพดาน 500 ของ notify)
 * - ต่ออายุ: เอกสารรถ = ฉบับใหม่ (id ใหม่ ฉบับเดิม SUPERSEDED) · ใบขับขี่/rate card = วันหมดใหม่ → key ใหม่ = รอบเตือนใหม่
 */
@Injectable()
export class ExpiryReminderService implements OnModuleInit {
  private readonly logger = new Logger('ExpiryReminderService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly db: DbService,
    private readonly queue: JobQueue,
    private readonly notifications: NotificationService,
    private readonly clock: Clock,
  ) {}

  onModuleInit() {
    this.queue.register(
      EXPIRY_REMINDER_JOB,
      async ({ tenantId, job, withTx }) => {
        const p = (job.payload ?? {}) as { day?: unknown };
        const today =
          typeof p.day === 'string' && isRealDate(p.day) ? p.day : bangkokToday(this.clock.now());
        // ตรวจสถานะ tenant ซ้ำตอนรัน — ถูกระงับ/ยกเลิกหลังสร้าง job แล้วต้องไม่ได้เตือน (QA ST2-T18)
        if (!(await this.tenantActive(tenantId))) return { skipped: 'tenant_inactive', day: today };
        return this.runForTenant(tenantId, today, withTx);
      },
      { outsideTransaction: true },
    );
  }

  /**
   * สร้าง job ของวันนี้ให้ทุก tenant ที่ยังไม่มี (เรียกซ้ำได้ — ก่อน 08:00 ไม่ทำอะไร)
   * advisory lock ใน transaction เดียว: สอง worker เรียกพร้อมกันได้ job ชุดเดียว
   */
  async scheduleDue(now: Date = this.clock.now()): Promise<number> {
    const bkk = new Date(now.getTime() + 7 * 3600_000);
    if (bkk.getUTCHours() < RUN_FROM_HOUR_BKK) return 0;
    const today = bangkokToday(now);
    return this.prisma.platform.$transaction(async (db) => {
      await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('job:expiry.reminders'))`;
      const tenants = await db.tenant.findMany({
        where: { status: { in: ['TRIAL', 'ACTIVE'] } },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });
      if (!tenants.length) return 0;
      // created_at เป็นเวลาจริงของฐาน (ไม่ใช่ Clock) — จำกัด 3 วันล่าสุดให้ใช้ดัชนี (tenant_id, created_at)
      const existing = await db.job.findMany({
        where: {
          tenantId: { in: tenants.map((t) => t.id) },
          type: EXPIRY_REMINDER_JOB,
          createdAt: { gte: new Date(Date.now() - 3 * 86_400_000) },
          payload: { path: ['day'], equals: today },
        },
        select: { tenantId: true },
      });
      const done = new Set(existing.map((j) => j.tenantId));
      const todo = tenants.filter((t) => !done.has(t.id));
      for (const t of todo)
        await this.queue.enqueue(db as unknown as Tx, {
          tenantId: t.id,
          type: EXPIRY_REMINDER_JOB,
          payload: { day: today },
        });
      return todo.length;
    });
  }

  /** tenant ที่ยังได้เตือน = TRIAL / ACTIVE (เหมือนตอนสร้าง job) */
  async tenantActive(tenantId: string): Promise<boolean> {
    const t = await this.prisma.platform.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true },
    });
    return t?.status === 'TRIAL' || t?.status === 'ACTIVE';
  }

  /** งานของ tenant หนึ่ง ณ วัน `today` (YYYY-MM-DD เวลาไทย) — แต่ละขั้นเป็น transaction สั้นของ tenant */
  async runForTenant(
    tenantId: string,
    today: string,
    withTx: WithTx = (fn) => this.db.withTenant(tenantId, fn),
  ): Promise<ExpiryRunResult> {
    const statusUpdated = await withTx((tx) => this.syncVehicleDocStatus(tx, today));
    const failed = { items: 0 };
    const candidates = await withTx(async (tx) => [
      ...(await this.vehicleDocCandidates(tx, today, failed)),
      ...(await this.licenceCandidates(tx, today, failed)),
      ...(await this.rateCardCandidates(tx, today, failed)),
    ]);
    const result: ExpiryRunResult = {
      day: today,
      statusUpdated,
      candidates: candidates.length,
      digests: 0,
      reminders: 0,
      failedItems: failed.items,
      failedRecipients: 0,
    };
    if (!candidates.length) return result;
    candidates.sort(
      (a, b) =>
        LEVEL_RANK[a.level] - LEVEL_RANK[b.level] ||
        a.expiresOn.localeCompare(b.expiresOn) ||
        a.entityId.localeCompare(b.entityId),
    );
    const recipients = await withTx((tx) => this.recipients(tx, tenantId));
    for (const r of recipients) {
      const mine = candidates.filter((c) => r.keys.has(c.recipients));
      if (!mine.length) continue;
      try {
        const n = await withTx((tx) => this.deliver(tx, tenantId, today, r.userId, mine));
        if (n) {
          result.digests += 1;
          result.reminders += n;
        }
      } catch (e) {
        result.failedRecipients += 1;
        this.logger.warn(
          `tenant ${tenantId} ${today}: expiry digest for user ${r.userId} failed (${mine.length} items) — retry next run: ${String(e)}`,
        );
      }
    }
    if (result.reminders || result.failedItems || result.failedRecipients)
      this.logger.log(
        `tenant ${tenantId} ${today}: ${result.digests} digests, ${result.reminders} reminders, ` +
          `${result.failedItems} failed items, ${result.failedRecipients} failed recipients`,
      );
    return result;
  }

  /** จองรายการของผู้รับคนนี้ แล้วส่งสรุปฉบับเดียวของรายการที่จองได้ — คืนจำนวนที่จองได้ */
  private async deliver(
    tx: Tx,
    tenantId: string,
    today: string,
    userId: string,
    items: ExpiryCandidate[],
  ): Promise<number> {
    const claimed = await tx.expiryReminder.createManyAndReturn({
      data: items.map((c) => ({
        tenantId,
        entityType: c.entityType,
        entityId: c.entityId,
        level: c.level,
        expiresOn: toDate(c.expiresOn),
        recipientId: userId,
        sentOn: toDate(today),
      })),
      skipDuplicates: true,
      select: { entityType: true, entityId: true, level: true, expiresOn: true },
    });
    if (!claimed.length) return 0;
    const got = new Set(claimed.map((r) => keyOf({ ...r, expiresOn: day(r.expiresOn) })));
    const list = items.filter((c) => got.has(keyOf(c))); // ลำดับเดิม (เรียงแล้ว)
    const kinds = new Set(list.map((c) => c.item.kind));
    const only = kinds.size === 1 ? list[0]!.item : null;
    const link = only
      ? only.kind === 'RATE_CARD' && list.every((c) => c.item.side === 'BUY')
        ? '/master/rate-cards?side=buy'
        : LINK[only.kind]
      : LINK[list[0]!.item.kind]; // หลายชนิด → หน้าของรายการที่ด่วนสุด
    await this.notifications.notify(tx, {
      tenantId,
      to: { userIds: [userId] },
      template: 'expiry.digest',
      vars: {
        total: list.length,
        more: Math.max(0, list.length - DIGEST_MAX_ITEMS),
        items: list.slice(0, DIGEST_MAX_ITEMS).map((c) => c.item),
      },
      link,
    });
    return claimed.length;
  }

  /** ผู้ใช้ ACTIVE ทุกคนพร้อมชนิดรายการที่มีสิทธิ์รับ (resolve ครั้งเดียวต่อรอบ) */
  private async recipients(tx: Tx, tenantId: string): Promise<Recipient[]> {
    const roles = await tx.role.findMany({
      where: { tenantId },
      select: { id: true, permissions: true },
    });
    const keysOfRole = new Map(
      roles.map((r) => [
        r.id,
        (Object.keys(RECIPIENT_SCOPE) as RecipientKey[]).filter((k) =>
          scopeAllows(r.permissions, RECIPIENT_SCOPE[k]),
        ),
      ]),
    );
    const roleIds = roles.filter((r) => keysOfRole.get(r.id)!.length).map((r) => r.id);
    if (!roleIds.length) return [];
    const links = await tx.userRole.findMany({
      where: { tenantId, roleId: { in: roleIds } },
      select: { userId: true, roleId: true },
    });
    const users = await tx.appUser.findMany({
      where: {
        tenantId,
        id: { in: [...new Set(links.map((l) => l.userId))] },
        status: 'ACTIVE',
        deletedAt: null,
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    const active = new Set(users.map((u) => u.id));
    const byUser = new Map<string, Set<RecipientKey>>();
    for (const l of links) {
      if (!active.has(l.userId)) continue;
      const s = byUser.get(l.userId) ?? new Set<RecipientKey>();
      for (const k of keysOfRole.get(l.roleId)!) s.add(k);
      byUser.set(l.userId, s);
    }
    return users
      .filter((u) => byUser.has(u.id))
      .map((u) => ({ userId: u.id, keys: byUser.get(u.id)! }));
  }

  /**
   * สถานะในฐานของเอกสารรถฉบับปัจจุบัน (T17 schema: "job รายวัน ST2-T18 ตั้ง") — เขียนเฉพาะแถวที่เปลี่ยน
   * ไม่ลง audit: เป็นค่าที่คำนวณจากวันหมดซ้ำ (API คำนวณเองทุกครั้งอยู่แล้ว) ไม่ใช่การตัดสินของคน
   * ขอบ EXPIRING = EXPIRING_DAYS ของ T17 (≤ 60 วัน) — ผลตรงกับ currentDbStatus() (test ตรวจ)
   */
  private async syncVehicleDocStatus(tx: Tx, today: string): Promise<number> {
    const t = toDate(today);
    const edge = toDate(addDays(today, EXPIRING_DAYS));
    const a = await tx.vehicleDocument.updateMany({
      where: { status: { in: ['ACTIVE', 'EXPIRING'] }, expiresOn: { lt: t } },
      data: { status: 'EXPIRED' },
    });
    const b = await tx.vehicleDocument.updateMany({
      where: { status: { in: ['ACTIVE', 'EXPIRED'] }, expiresOn: { gte: t, lte: edge } },
      data: { status: 'EXPIRING' },
    });
    const c = await tx.vehicleDocument.updateMany({
      where: { status: { in: ['EXPIRING', 'EXPIRED'] }, expiresOn: { gt: edge } },
      data: { status: 'ACTIVE' },
    });
    return a.count + b.count + c.count;
  }

  /** สร้างรายการทีละแถว — แถวที่ล้มข้ามและ log (ไม่ขวางรายการอื่น) */
  private collect<R extends { id: string }>(
    rows: R[],
    kind: ReminderEntityType,
    failed: { items: number },
    build: (r: R) => ExpiryCandidate | null,
  ): ExpiryCandidate[] {
    const out: ExpiryCandidate[] = [];
    for (const r of rows) {
      try {
        const c = build(r);
        if (c) out.push(c);
      } catch (e) {
        failed.items += 1;
        this.logger.warn(`expiry reminder: skip ${kind} ${r.id}: ${String(e)}`);
      }
    }
    return out;
  }

  private window(today: string, th: readonly number[]) {
    return {
      gte: toDate(addDays(today, -EXPIRED_NOTICE_WINDOW_DAYS)),
      lte: toDate(addDays(today, lookahead(th))),
    };
  }

  private async vehicleDocCandidates(tx: Tx, today: string, failed: { items: number }) {
    const th = REMINDER_THRESHOLDS.VEHICLE_DOCUMENT;
    const docs = await tx.vehicleDocument.findMany({
      where: {
        status: { in: ['ACTIVE', 'EXPIRING', 'EXPIRED'] },
        expiresOn: this.window(today, th),
        vehicle: { status: { not: 'RETIRED' }, deletedAt: null }, // รถที่ปลดแล้ว/ลบแล้วไม่ต้องเตือน
      },
      select: {
        id: true,
        docType: true,
        title: true,
        expiresOn: true,
        vehicle: { select: { plate: true } },
      },
      orderBy: [{ expiresOn: 'asc' }, { id: 'asc' }],
    });
    return this.collect(docs, 'VEHICLE_DOCUMENT', failed, (d) =>
      this.vehicleDocCandidate(d, today),
    );
  }

  /** แยกเป็นเมธอด (test จำลองรายการที่ล้มได้) */
  vehicleDocCandidate(
    d: {
      id: string;
      docType: string;
      title: string | null;
      expiresOn: Date;
      vehicle: { plate: string };
    },
    today: string,
  ): ExpiryCandidate | null {
    const expiresOn = day(d.expiresOn);
    const days = daysBetween(today, expiresOn);
    const level = dueLevel(days, REMINDER_THRESHOLDS.VEHICLE_DOCUMENT);
    if (!level) return null;
    return {
      entityType: 'VEHICLE_DOCUMENT',
      entityId: d.id,
      expiresOn,
      level,
      recipients: 'VEHICLE_DOCUMENT',
      item: {
        kind: 'VEHICLE_DOCUMENT',
        level,
        expiresOn,
        days,
        label: d.vehicle.plate,
        docType: d.docType,
        title: d.title,
      },
    };
  }

  private async licenceCandidates(tx: Tx, today: string, failed: { items: number }) {
    const th = REMINDER_THRESHOLDS.DRIVER_LICENCE;
    const drivers = await tx.driver.findMany({
      where: {
        deletedAt: null,
        status: { not: 'INACTIVE' },
        licenceExpiresAt: this.window(today, th),
      },
      select: { id: true, code: true, name: true, licenceExpiresAt: true },
      orderBy: [{ licenceExpiresAt: 'asc' }, { id: 'asc' }],
    });
    return this.collect(drivers, 'DRIVER_LICENCE', failed, (d) => {
      const expiresOn = day(d.licenceExpiresAt!);
      const days = daysBetween(today, expiresOn);
      const level = dueLevel(days, th);
      if (!level) return null;
      return {
        entityType: 'DRIVER_LICENCE',
        entityId: d.id,
        expiresOn,
        level,
        recipients: 'DRIVER_LICENCE',
        item: { kind: 'DRIVER_LICENCE', level, expiresOn, days, label: `${d.name} (${d.code})` },
      };
    });
  }

  /**
   * rate card ที่อนุมัติแล้วและมีวันหมด — ข้ามฉบับที่ "ต่ออายุแล้ว" = มี rate อนุมัติ key เดียวกันเริ่มวันถัดจากวันหมดพอดี
   * (ฉบับแก้ไขที่ปิดฉบับเดิม หรือ rate ช่วงถัดไปที่ต่อเนื่อง) — ร่าง/รออนุมัติยังไม่นับ (ราคายังขาดช่วงได้)
   */
  private async rateCardCandidates(tx: Tx, today: string, failed: { items: number }) {
    const th = REMINDER_THRESHOLDS.RATE_CARD;
    const cards = await tx.rateCard.findMany({
      where: { status: 'APPROVED', deletedAt: null, validTo: this.window(today, th) },
      select: {
        id: true,
        code: true,
        revision: true,
        side: true,
        customerId: true,
        carrierId: true,
        originSiteId: true,
        destSiteId: true,
        vehicleTypeId: true,
        validTo: true,
        customer: { select: { legalName: true } },
        carrier: { select: { legalName: true } },
        origin: { select: { name: true } },
        dest: { select: { name: true } },
      },
      orderBy: [{ validTo: 'asc' }, { id: 'asc' }],
    });
    if (!cards.length) return [];
    // ฉบับต่อเนื่องทั้งหมดในครั้งเดียว: validFrom = validTo + 1 ของรายการใดก็ได้ในชุด
    const rkey = (r: {
      side: string;
      customerId: string | null;
      carrierId: string | null;
      originSiteId: string | null;
      destSiteId: string | null;
      vehicleTypeId: string;
    }) =>
      [r.side, r.customerId, r.carrierId, r.originSiteId, r.destSiteId, r.vehicleTypeId].join('|');
    const next = await tx.rateCard.findMany({
      where: {
        status: 'APPROVED',
        deletedAt: null,
        validFrom: { in: [...new Set(cards.map((r) => addDays(day(r.validTo!), 1)))].map(toDate) },
        vehicleTypeId: { in: [...new Set(cards.map((r) => r.vehicleTypeId))] },
      },
      select: {
        side: true,
        customerId: true,
        carrierId: true,
        originSiteId: true,
        destSiteId: true,
        vehicleTypeId: true,
        validFrom: true,
      },
    });
    const renewed = new Set(next.map((r) => `${rkey(r)}|${day(r.validFrom)}`));
    return this.collect(cards, 'RATE_CARD', failed, (r) => {
      const expiresOn = day(r.validTo!);
      if (renewed.has(`${rkey(r)}|${addDays(expiresOn, 1)}`)) return null;
      const days = daysBetween(today, expiresOn);
      const level = dueLevel(days, th);
      if (!level) return null;
      const party = (r.side === 'BUY' ? r.carrier?.legalName : r.customer?.legalName) ?? '-';
      const code = r.revision > 1 ? `${r.code}/${r.revision}` : r.code;
      return {
        entityType: 'RATE_CARD',
        entityId: r.id,
        expiresOn,
        level,
        recipients: r.side === 'BUY' ? 'RATE_CARD_BUY' : 'RATE_CARD_SELL',
        item: {
          kind: 'RATE_CARD',
          level,
          expiresOn,
          days,
          side: r.side,
          label: `${code} (${party} · ${r.origin?.name ?? '-'} → ${r.dest?.name ?? '-'})`,
        },
      };
    });
  }
}
