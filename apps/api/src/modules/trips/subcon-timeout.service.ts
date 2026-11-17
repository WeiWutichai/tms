import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { scopeAllows } from '@tms/domain';
import { AuditService } from '../../audit/audit.service';
import { Clock } from '../../common/clock';
import { encodeId } from '../../common/ids';
import { requestContext } from '../../common/request-context';
import { DbService, type Tx } from '../../db/db.service';
import { PrismaService } from '../../db/prisma.service';
import { JobQueue } from '../../jobs/job-queue.service';
import { NotificationService } from '../notifications/notification.service';
import { TripService } from './trip.service';

export const OFFER_TIMEOUT_JOB = 'subcon_offer.timeouts';
/** worker ตรวจทุก 1 นาที (spec/03 PLN-154 "job ตรวจทุก 1 นาที") */
export const OFFER_TIMEOUT_EVERY_MS = 60_000;
/** ผู้รับแจ้งเตือน = ผู้จ้าง (ถ้ายังใช้งานและยังจัดรถได้) ไม่งั้นทุกคนที่มีสิทธิ์นี้ */
const DISPATCH_SCOPE = 'trips:assign';
/** ข้อเสนอต่อรอบต่อ tenant (ที่เหลือรอบถัดไป) */
const BATCH = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTOR = 'system:subcon-offer-timeout';
/** backoff ของแถวที่ล้ม (review L2): 2^ครั้ง นาที สูงสุด 60 นาที · ครบ ALERT_AFTER ครั้ง → log error (เตือนทีม) */
export const ALERT_AFTER = 5;
export const backoffMs = (attempts: number) => Math.min(60, 2 ** attempts) * 60_000;

/** ลิงก์ในแจ้งเตือน = กระดานวางแผน เปิด drawer เที่ยวนั้น (QA M1 — route จริง `/plan`) */
export const tripLink = (tripId: string) => `/plan?trip=${encodeId('trip', tripId)}`;

type WithTx = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

export interface OfferTimeoutRunResult {
  /** แจ้ง "ไม่ตอบใน N ชม." รอบนี้ (ข้อเสนอ) */
  notified: number;
  /** ข้อเสนอที่ปิดเป็น EXPIRED รอบนี้ */
  expired: number;
  /** ข้อเสนอที่ล้ม (รอบหน้าลองใหม่ — ไม่ได้ทำเครื่องหมาย) */
  failed: number;
}

/**
 * หมดเวลาข้อเสนองานรถร่วม (ST3-T24; docs/04 D3 "หมดเวลา → แจ้ง dispatcher": "ไม่ตอบใน N ชม. → แจ้งเตือน + ปุ่มส่งรายถัดไป",
 * docs/04 I "งานรถร่วมหมดเวลา"; docs/01 §4.2 "OFFERED → PLANNING : ปฏิเสธ/หมดอายุ → SO กลับ ON_HOLD(CARRIER_REJECTED)";
 * spec/03 PLN-154 — ไม่มี cascade อัตโนมัติ: docs/04 D3 Cascade = P1)
 *
 * - worker เรียก `scheduleDue()` ทุก 1 นาที → สร้าง job `subcon_offer.timeouts` ให้ tenant (TRIAL/ACTIVE) ที่มีข้อเสนอถึงเวลา
 *   และยังไม่มี job ค้าง (advisory lock — สอง worker ได้ job ชุดเดียว) · handler รัน `runForTenant` ด้วยเวลา `Clock`
 * - (ก) ครบ N ชม. (`response_due_at`) ยังไม่ตอบ: ทำเครื่องหมาย `timeout_notified_at` แบบมีเงื่อนไข (updateMany … IS NULL —
 *   รันซ้ำ/สอง worker พร้อมกันได้แจ้ง 1 ครั้ง) แล้วแจ้ง in-app + อีเมลใน transaction เดียวกัน (ล้ม = ไม่ได้ทำเครื่องหมาย รอบหน้าส่งใหม่)
 * - (ข) ถึง `expires_at` (48 ชม.): `TripService.expireOffer` (ล็อก SO → DO → trip แล้วตรวจซ้ำ — รับ/ปฏิเสธ/จ้างใหม่ก่อน = ไม่ทำอะไร)
 *   → แจ้ง "ข้อเสนองานรถร่วมหมดเวลา" ครั้งเดียว (transition เกิดได้ครั้งเดียว)
 * - ข้อเสนอแต่ละรายการเป็น transaction ของตัวเอง — รายการหนึ่งล้มไม่ขวางรายการอื่น (job ล้ม → JobQueue ลองใหม่)
 */
@Injectable()
export class SubconTimeoutService implements OnModuleInit {
  private readonly logger = new Logger('SubconTimeoutService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly db: DbService,
    private readonly queue: JobQueue,
    private readonly notifications: NotificationService,
    private readonly trips: TripService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  onModuleInit() {
    this.queue.register(
      OFFER_TIMEOUT_JOB,
      async ({ tenantId, job, withTx }) => {
        // แถวที่ล้มถูกเลื่อนรอบด้วย backoff ต่อแถวแล้ว — job ไม่ต้องล้ม/ลองซ้ำทันที
        return this.runForTenant(tenantId, this.clock.now(), withTx, `job:${job.id}`);
      },
      { outsideTransaction: true },
    );
  }

  /**
   * สร้าง job ให้ tenant ที่มีข้อเสนอถึงเวลา (ครบ N ชม. ยังไม่แจ้ง / ถึงเวลาหมดอายุ) และยังไม่มี job ค้าง — เรียกซ้ำได้
   * คืนจำนวน job ที่สร้าง
   */
  async scheduleDue(now: Date = this.clock.now()): Promise<number> {
    return this.prisma.platform.$transaction(async (db) => {
      await db.$executeRaw`SELECT pg_advisory_xact_lock(8, hashtext(${OFFER_TIMEOUT_JOB}))`;
      const rows = await db.$queryRaw<{ tenant_id: string }[]>`
        SELECT DISTINCT o.tenant_id
          FROM subcon_offer o
          JOIN tenant t ON t.id = o.tenant_id
         WHERE o.status = 'OFFERED'
           AND t.status IN ('TRIAL', 'ACTIVE')
           AND (o.timeout_next_at IS NULL OR o.timeout_next_at <= ${now})
           AND ((o.timeout_notified_at IS NULL AND o.response_due_at <= ${now})
                OR o.expires_at <= ${now})`;
      if (!rows.length) return 0;
      const ids = rows.map((r) => r.tenant_id);
      const open = await db.job.findMany({
        where: {
          tenantId: { in: ids },
          type: OFFER_TIMEOUT_JOB,
          status: { in: ['PENDING', 'RUNNING'] },
        },
        select: { tenantId: true },
      });
      const busy = new Set(open.map((j) => j.tenantId));
      const todo = ids.filter((id) => !busy.has(id));
      for (const tenantId of todo)
        await this.queue.enqueue(db as unknown as Tx, {
          tenantId,
          type: OFFER_TIMEOUT_JOB,
          maxAttempts: 3,
        });
      return todo.length;
    });
  }

  /** งานของ tenant หนึ่ง ณ เวลา `now` — แต่ละข้อเสนอเป็น transaction สั้นของ tenant (RLS) */
  async runForTenant(
    tenantId: string,
    now: Date,
    withTx: WithTx = (fn) => this.db.withTenant(tenantId, fn),
    requestId = `subcon-timeout:${now.toISOString()}`,
  ): Promise<OfferTimeoutRunResult> {
    const due = await withTx((tx) =>
      tx.subconOffer.findMany({
        where: {
          status: 'OFFERED',
          AND: [
            { OR: [{ timeoutNextAt: null }, { timeoutNextAt: { lte: now } }] },
            {
              OR: [
                { timeoutNotifiedAt: null, responseDueAt: { lte: now } },
                { expiresAt: { lte: now } },
              ],
            },
          ],
        },
        select: { id: true, expiresAt: true },
        orderBy: [{ offeredAt: 'asc' }, { id: 'asc' }],
        take: BATCH,
      }),
    );
    const out: OfferTimeoutRunResult = { notified: 0, expired: 0, failed: 0 };
    for (const o of due) {
      const expiring = !!o.expiresAt && o.expiresAt.getTime() <= now.getTime();
      try {
        const done = await withTx((tx) =>
          this.inContext(tx, tenantId, requestId, () =>
            expiring
              ? this.expire(tx, tenantId, o.id, now)
              : this.notifyNoResponse(tx, tenantId, o.id, now),
          ),
        );
        if (done) out[expiring ? 'expired' : 'notified']++;
      } catch (e) {
        out.failed++;
        await this.deferFailed(tenantId, o.id, now, e, withTx);
      }
    }
    return out;
  }

  /**
   * แถวที่ปิด/แจ้งไม่สำเร็จ (transaction หลัก rollback แล้ว): นับครั้ง + เลื่อนรอบถัดไป (backoff) — ตัวตั้งเวลาไม่สร้าง job
   * ให้แถวนี้จนถึงรอบ และไม่บังแถวอื่นใน batch · ครบ ALERT_AFTER ครั้ง → log error (ทุกครั้งหลังจากนั้น)
   */
  private async deferFailed(
    tenantId: string,
    offerId: string,
    now: Date,
    e: unknown,
    withTx: WithTx,
  ) {
    try {
      const r = await withTx((tx) =>
        tx.subconOffer.update({
          where: { id: offerId },
          data: { timeoutAttempts: { increment: 1 } },
          select: { timeoutAttempts: true },
        }),
      );
      await withTx((tx) =>
        tx.subconOffer.update({
          where: { id: offerId },
          data: { timeoutNextAt: new Date(now.getTime() + backoffMs(r.timeoutAttempts)) },
        }),
      );
      const msg = `offer ${offerId} (tenant ${tenantId}) timeout failed attempt ${r.timeoutAttempts}: ${String(e)}`;
      if (r.timeoutAttempts >= ALERT_AFTER) this.logger.error(msg);
      else this.logger.warn(msg);
    } catch (e2) {
      this.logger.error(`offer ${offerId} timeout failed and could not be deferred: ${String(e2)}`);
    }
  }

  /** job ไม่มี request context — ตั้งให้ audit/event/state ทำงาน (ผู้กระทำ = ระบบ) */
  private inContext<T>(tx: Tx, tenantId: string, requestId: string, fn: () => Promise<T>) {
    return requestContext.run(
      {
        requestId,
        tenantId,
        actorId: ACTOR,
        principalType: 'system',
        scopes: [],
        locale: 'th',
        tx,
      },
      fn,
    );
  }

  /** (ก) ครบ N ชม. ยังไม่ตอบ → แจ้งครั้งเดียว (คืน true เมื่อรอบนี้เป็นผู้แจ้ง) */
  async notifyNoResponse(tx: Tx, tenantId: string, offerId: string, now: Date): Promise<boolean> {
    const claimed = await tx.subconOffer.updateMany({
      where: {
        id: offerId,
        status: 'OFFERED',
        timeoutNotifiedAt: null,
        responseDueAt: { lte: now },
        expiresAt: { gt: now },
      },
      data: { timeoutNotifiedAt: now },
    });
    if (claimed.count !== 1) return false;
    const o = await tx.subconOffer.findUniqueOrThrow({
      where: { id: offerId },
      select: {
        tripId: true,
        carrierNameSnapshot: true,
        offeredBy: true,
        offeredAt: true,
        responseDueAt: true,
        trip: { select: { tripNo: true } },
      },
    });
    const hours = Math.round((o.responseDueAt!.getTime() - o.offeredAt.getTime()) / 3600_000);
    const to = await this.recipients(tx, tenantId, o.offeredBy);
    const sent = to.length
      ? await this.notifications.notify(tx, {
          tenantId,
          to: { userIds: to },
          template: 'subcon_offer.no_response',
          vars: { tripNo: o.trip.tripNo ?? '', carrier: o.carrierNameSnapshot, hours },
          link: tripLink(o.tripId),
          entity: { type: 'trip', id: encodeId('trip', o.tripId) },
        })
      : 0;
    await this.audit.record({
      action: 'subcon_offer.no_response',
      entityType: 'trip',
      entityId: o.tripId,
      after: {
        offerId: encodeId('subconOffer', offerId),
        responseDueAt: o.responseDueAt!.toISOString(),
        hours,
        notifiedUsers: sent,
      },
    });
    return true;
  }

  /** (ข) ลิงก์หมดอายุ → EXPIRED + เที่ยวกลับ PLANNING + ใบสั่งค้าง CARRIER_REJECTED → แจ้ง (คืน true เมื่อรอบนี้เป็นผู้ปิด) */
  async expire(tx: Tx, tenantId: string, offerId: string, now: Date): Promise<boolean> {
    const head = await tx.subconOffer.findUnique({
      where: { id: offerId },
      select: { tripId: true, offeredBy: true, carrierNameSnapshot: true },
    });
    if (!head) return false;
    const r = await this.trips.expireOffer(head.tripId, offerId, now, tx);
    if (!r) {
      // ข้อเสนอยังรอตอบแต่เที่ยวไม่ได้รอตอบ (ข้อมูลไม่สอดคล้อง) → นับเป็นล้ม (backoff) ไม่วนทุกนาที
      const still = await tx.subconOffer.findUnique({
        where: { id: offerId },
        select: { status: true },
      });
      if (still?.status === 'OFFERED')
        throw new Error('offer is open but its trip is not awaiting a response');
      return false;
    }
    const to = await this.recipients(tx, tenantId, head.offeredBy);
    if (to.length)
      await this.notifications.notify(tx, {
        tenantId,
        to: { userIds: to },
        template: 'subcon_offer.expired',
        vars: { tripNo: r.trip.tripNo ?? '', carrier: head.carrierNameSnapshot },
        link: tripLink(head.tripId),
        entity: { type: 'trip', id: encodeId('trip', head.tripId) },
      });
    return true;
  }

  /**
   * ผู้รับ (docs/04 D3 "แจ้ง dispatcher"): ผู้จ้าง ถ้ายังใช้งานและ role ยังมี `trips:assign` · ไม่งั้น (ผู้จ้างลาออก/ถูกถอดสิทธิ์/
   * จ้างผ่าน API client) = ผู้ใช้ที่ใช้งานอยู่ทุกคนที่ role มี `trips:assign` (รวม role กำหนดเอง) — ไม่ซ้ำ
   */
  async recipients(tx: Tx, tenantId: string, offeredBy: string | null): Promise<string[]> {
    const roles = await tx.role.findMany({
      where: { tenantId },
      select: { id: true, permissions: true },
    });
    const allowed = roles
      .filter((r) => scopeAllows(r.permissions, DISPATCH_SCOPE))
      .map((r) => r.id);
    if (!allowed.length) return [];
    const active = async (userIds?: string[]) => {
      const links = await tx.userRole.findMany({
        where: {
          tenantId,
          roleId: { in: allowed },
          ...(userIds ? { userId: { in: userIds } } : {}),
        },
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
        orderBy: { id: 'asc' },
      });
      return users.map((u) => u.id);
    };
    if (offeredBy && UUID_RE.test(offeredBy)) {
      const me = await active([offeredBy]);
      if (me.length) return me;
    }
    return active();
  }
}
