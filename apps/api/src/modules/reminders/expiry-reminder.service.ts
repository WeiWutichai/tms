import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { scopeAllows } from '@tms/domain';
import { Clock } from '../../common/clock';
import { encodeId } from '../../common/ids';
import type { Tx } from '../../db/db.service';
import { PrismaService } from '../../db/prisma.service';
import { JobQueue } from '../../jobs/job-queue.service';
import { NotificationService } from '../notifications/notification.service';
import type { NotificationTemplate, NotificationVars } from '../notifications/templates';
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
/** job รายวันเริ่มได้ตั้งแต่ 06:00 เวลาไทย (spec/06 FLT-040) */
export const RUN_FROM_HOUR_BKK = 6;

/** ผู้รับตามสิทธิ์ (role ใดก็ได้ที่มี scope นี้ — รวม role กำหนดเอง) [OPEN #40 — ยังไม่มีหน้าตั้งผู้รับผิดชอบ] */
const RECIPIENT_SCOPE = {
  VEHICLE_DOCUMENT: 'master:write',
  DRIVER_LICENCE: 'master:write',
  RATE_CARD_SELL: 'prices.sell:write',
  RATE_CARD_BUY: 'prices.buy:write',
} as const;
type RecipientKey = keyof typeof RECIPIENT_SCOPE;

interface Candidate<K extends NotificationTemplate> {
  entityType: ReminderEntityType;
  entityId: string;
  expiresOn: string;
  level: ReminderLevel;
  recipients: RecipientKey;
  template: K;
  vars: NotificationVars[K];
  link: string;
  entity: { type: string; id: string };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCandidate = Candidate<any>;

export interface ExpiryRunResult {
  day: string;
  /** เอกสารรถที่ตั้งสถานะใหม่ (ACTIVE/EXPIRING/EXPIRED) */
  statusUpdated: number;
  /** การเตือนที่ส่งรอบนี้ (ที่ส่งไปแล้วก่อนหน้าไม่นับ) */
  reminders: number;
  /** ผู้รับรวม (คน × การเตือน) */
  recipients: number;
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const toDate = (d: string) => new Date(`${d}T00:00:00Z`);

/**
 * เตือนต่ออายุ (ST2-T18; docs/04 B2.1 ส่วน 2, B คนขับ, B Rate card NEAR_EXPIRY; spec/06 FLT-040/041/300)
 *
 * - worker เรียก `scheduleDue()` เป็นระยะ → ตั้งแต่ 06:00 เวลาไทย สร้าง job `expiry.reminders` 1 ชิ้น/tenant/วัน
 *   (tenant TRIAL/ACTIVE เท่านั้น) → JobQueue รัน handler ใน transaction ของ tenant (RLS)
 * - handler: (1) ตั้ง `vehicle_document.status` ให้ตรงวันหมด (คอลัมน์ที่มีอยู่แล้วของ T17 — API คำนวณเองเสมอ)
 *   ใบขับขี่/rate card สถานะคำนวณจากวันที่ (T08/T13) ไม่มีคอลัมน์ให้ตั้ง (2) หาเรื่องที่ถึงระดับเตือน
 *   (3) จองแถวใน `expiry_reminder` (unique — ON CONFLICT DO NOTHING) แล้วแจ้งเฉพาะแถวที่จองได้
 *   → รันซ้ำวันเดียวกัน/สอง worker พร้อมกัน/วันถัดไปก่อนถึงระดับถัดไป = ไม่ส่งซ้ำ
 *   แจ้งเตือนอยู่ใน transaction เดียวกับการจอง → แจ้งล้ม = rollback การจอง → รอบหน้าส่งใหม่
 * - ต่ออายุ: เอกสารรถ = ฉบับใหม่ (id ใหม่ ฉบับเดิม SUPERSEDED) · ใบขับขี่/rate card = วันหมดใหม่ → key ใหม่ = รอบเตือนใหม่
 */
@Injectable()
export class ExpiryReminderService implements OnModuleInit {
  private readonly logger = new Logger('ExpiryReminderService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: JobQueue,
    private readonly notifications: NotificationService,
    private readonly clock: Clock,
  ) {}

  onModuleInit() {
    this.queue.register(
      EXPIRY_REMINDER_JOB,
      async ({ tx, tenantId, job }) => {
        const p = (job.payload ?? {}) as { day?: unknown };
        const today =
          typeof p.day === 'string' && isRealDate(p.day) ? p.day : bangkokToday(this.clock.now());
        return this.runForTenant(tx, tenantId, today);
      },
      { timeoutMs: 60_000 },
    );
  }

  /**
   * สร้าง job ของวันนี้ให้ทุก tenant ที่ยังไม่มี (เรียกจาก worker ซ้ำได้ — ก่อน 06:00 ไม่ทำอะไร)
   * สร้างซ้ำโดยบังเอิญ (สอง worker) ไม่เป็นไร: สมุดเตือนกันส่งซ้ำอยู่แล้ว
   */
  async scheduleDue(now: Date = this.clock.now()): Promise<number> {
    const bkk = new Date(now.getTime() + 7 * 3600_000);
    if (bkk.getUTCHours() < RUN_FROM_HOUR_BKK) return 0;
    const today = bangkokToday(now);
    const db = this.prisma.platform;
    const tenants = await db.tenant.findMany({
      where: { status: { in: ['TRIAL', 'ACTIVE'] } },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!tenants.length) return 0;
    // job ของวันนี้ที่มีแล้ว — created_at เป็นเวลาจริงของฐาน (ไม่ใช่ Clock) จำกัด 3 วันล่าสุดให้ใช้ดัชนี (tenant_id, created_at)
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
  }

  /** งานของ tenant หนึ่ง ณ วัน `today` (YYYY-MM-DD เวลาไทย) — `tx` ต้องตั้ง app.tenant_id แล้ว */
  async runForTenant(tx: Tx, tenantId: string, today: string): Promise<ExpiryRunResult> {
    const statusUpdated = await this.syncVehicleDocStatus(tx, today);
    const candidates = [
      ...(await this.vehicleDocCandidates(tx, today)),
      ...(await this.licenceCandidates(tx, today)),
      ...(await this.rateCardCandidates(tx, today)),
    ];
    if (!candidates.length) return { day: today, statusUpdated, reminders: 0, recipients: 0 };

    // จองการเตือน — แถวที่มีอยู่แล้ว (เตือนไปแล้ว/อีก transaction จองไปแล้ว) ถูกข้าม
    const claimed = await tx.expiryReminder.createManyAndReturn({
      data: candidates.map((c) => ({
        tenantId,
        entityType: c.entityType,
        entityId: c.entityId,
        level: c.level,
        expiresOn: toDate(c.expiresOn),
        sentOn: toDate(today),
      })),
      skipDuplicates: true,
      select: { id: true, entityType: true, entityId: true, level: true, expiresOn: true },
    });
    const byKey = new Map(
      candidates.map((c) => [`${c.entityType}|${c.entityId}|${c.level}|${c.expiresOn}`, c]),
    );
    const roleCache = new Map<RecipientKey, string[]>();
    let recipients = 0;
    for (const row of claimed) {
      const c = byKey.get(`${row.entityType}|${row.entityId}|${row.level}|${day(row.expiresOn)}`);
      if (!c) continue;
      let roles = roleCache.get(c.recipients);
      if (!roles) {
        roles = await this.rolesWith(tx, tenantId, RECIPIENT_SCOPE[c.recipients]);
        roleCache.set(c.recipients, roles);
      }
      const n = roles.length
        ? await this.notifications.notify(tx, {
            tenantId,
            to: { roles },
            template: c.template,
            vars: c.vars,
            link: c.link,
            entity: c.entity,
          })
        : 0;
      recipients += n;
      if (n) await tx.expiryReminder.update({ where: { id: row.id }, data: { recipients: n } });
    }
    if (claimed.length)
      this.logger.log(`tenant ${tenantId} ${today}: ${claimed.length} expiry reminders`);
    return { day: today, statusUpdated, reminders: claimed.length, recipients };
  }

  /** role code ที่มี scope นี้ (owner มี `*` / รายการเต็ม) */
  private async rolesWith(tx: Tx, tenantId: string, scope: string): Promise<string[]> {
    const roles = await tx.role.findMany({
      where: { tenantId },
      select: { code: true, permissions: true },
      orderBy: { code: 'asc' },
    });
    return roles.filter((r) => scopeAllows(r.permissions, scope)).map((r) => r.code);
  }

  /**
   * สถานะในฐานของเอกสารรถฉบับปัจจุบัน (T17 schema: "job รายวัน ST2-T18 ตั้ง") — เขียนเฉพาะแถวที่เปลี่ยน
   * ไม่ลง audit: เป็นค่าที่คำนวณจากวันหมดซ้ำ (API คำนวณเองทุกครั้งอยู่แล้ว) ไม่ใช่การตัดสินของคน
   */
  private async syncVehicleDocStatus(tx: Tx, today: string): Promise<number> {
    const t = toDate(today);
    // ขอบ EXPIRING = EXPIRING_DAYS ของ T17 (≤ 60 วัน) — ผลตรงกับ currentDbStatus() (test ตรวจ)
    const edge = toDate(addDays(today, EXPIRING_DAYS));
    const [a, b, c] = await Promise.all([
      tx.vehicleDocument.updateMany({
        where: { status: { in: ['ACTIVE', 'EXPIRING'] }, expiresOn: { lt: t } },
        data: { status: 'EXPIRED' },
      }),
      tx.vehicleDocument.updateMany({
        where: { status: { in: ['ACTIVE', 'EXPIRED'] }, expiresOn: { gte: t, lte: edge } },
        data: { status: 'EXPIRING' },
      }),
      tx.vehicleDocument.updateMany({
        where: { status: { in: ['EXPIRING', 'EXPIRED'] }, expiresOn: { gt: edge } },
        data: { status: 'ACTIVE' },
      }),
    ]);
    return a.count + b.count + c.count;
  }

  private async vehicleDocCandidates(tx: Tx, today: string): Promise<AnyCandidate[]> {
    const th = REMINDER_THRESHOLDS.VEHICLE_DOCUMENT;
    const docs = await tx.vehicleDocument.findMany({
      where: {
        status: { in: ['ACTIVE', 'EXPIRING', 'EXPIRED'] },
        expiresOn: {
          gte: toDate(addDays(today, -EXPIRED_NOTICE_WINDOW_DAYS)),
          lte: toDate(addDays(today, lookahead(th))),
        },
        // รถที่ปลดแล้วไม่ต้องเตือน
        vehicle: { status: { not: 'RETIRED' } },
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
    const out: AnyCandidate[] = [];
    for (const d of docs) {
      const expiresOn = day(d.expiresOn);
      const days = daysBetween(today, expiresOn);
      const level = dueLevel(days, th);
      if (!level) continue;
      out.push({
        entityType: 'VEHICLE_DOCUMENT',
        entityId: d.id,
        expiresOn,
        level,
        recipients: 'VEHICLE_DOCUMENT',
        template: 'expiry.vehicle_document',
        vars: {
          level,
          expiresOn,
          days,
          plate: d.vehicle.plate,
          docType: d.docType,
          title: d.title,
        },
        link: '/fleet/documents',
        entity: { type: 'vehicle_document', id: encodeId('vehicleDocument', d.id) },
      });
    }
    return out;
  }

  private async licenceCandidates(tx: Tx, today: string): Promise<AnyCandidate[]> {
    const th = REMINDER_THRESHOLDS.DRIVER_LICENCE;
    const drivers = await tx.driver.findMany({
      where: {
        deletedAt: null,
        status: { not: 'INACTIVE' },
        licenceExpiresAt: {
          gte: toDate(addDays(today, -EXPIRED_NOTICE_WINDOW_DAYS)),
          lte: toDate(addDays(today, lookahead(th))),
        },
      },
      select: { id: true, code: true, name: true, licenceExpiresAt: true },
      orderBy: [{ licenceExpiresAt: 'asc' }, { id: 'asc' }],
    });
    const out: AnyCandidate[] = [];
    for (const d of drivers) {
      const expiresOn = day(d.licenceExpiresAt!);
      const days = daysBetween(today, expiresOn);
      const level = dueLevel(days, th);
      if (!level) continue;
      out.push({
        entityType: 'DRIVER_LICENCE',
        entityId: d.id,
        expiresOn,
        level,
        recipients: 'DRIVER_LICENCE',
        template: 'expiry.driver_licence',
        vars: { level, expiresOn, days, name: d.name, code: d.code },
        link: '/fleet/drivers',
        entity: { type: 'driver', id: encodeId('driver', d.id) },
      });
    }
    return out;
  }

  /**
   * rate card ที่อนุมัติแล้วและมีวันหมด — ข้ามฉบับที่ "มีราคาต่อแล้ว" (rate อนุมัติ key เดียวกันเริ่มหลังวันหมดของฉบับนี้
   * เช่น ฉบับแก้ไขที่ปิดฉบับเดิม หรือ rate ช่วงถัดไป) = ต่ออายุแล้ว
   */
  private async rateCardCandidates(tx: Tx, today: string): Promise<AnyCandidate[]> {
    const th = REMINDER_THRESHOLDS.RATE_CARD;
    const cards = await tx.rateCard.findMany({
      where: {
        status: 'APPROVED',
        deletedAt: null,
        validTo: {
          gte: toDate(addDays(today, -EXPIRED_NOTICE_WINDOW_DAYS)),
          lte: toDate(addDays(today, lookahead(th))),
        },
      },
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
    const out: AnyCandidate[] = [];
    for (const r of cards) {
      const expiresOn = day(r.validTo!);
      const days = daysBetween(today, expiresOn);
      const level = dueLevel(days, th);
      if (!level) continue;
      const next = await tx.rateCard.findFirst({
        where: {
          id: { not: r.id },
          status: 'APPROVED',
          deletedAt: null,
          side: r.side,
          customerId: r.customerId,
          carrierId: r.carrierId,
          originSiteId: r.originSiteId,
          destSiteId: r.destSiteId,
          vehicleTypeId: r.vehicleTypeId,
          validFrom: { gt: r.validTo! },
        },
        select: { id: true },
      });
      if (next) continue;
      const party = (r.side === 'BUY' ? r.carrier?.legalName : r.customer?.legalName) ?? '-';
      out.push({
        entityType: 'RATE_CARD',
        entityId: r.id,
        expiresOn,
        level,
        recipients: r.side === 'BUY' ? 'RATE_CARD_BUY' : 'RATE_CARD_SELL',
        template: 'expiry.rate_card',
        vars: {
          level,
          expiresOn,
          days,
          code: r.code,
          revision: r.revision,
          side: r.side,
          party,
          route: `${r.origin?.name ?? '-'} → ${r.dest?.name ?? '-'}`,
        },
        link: r.side === 'BUY' ? '/master/rate-cards?side=buy' : '/master/rate-cards',
        entity: { type: 'rate_card', id: encodeId('rateCard', r.id) },
      });
    }
    return out;
  }
}
