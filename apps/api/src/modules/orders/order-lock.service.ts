import { Injectable } from '@nestjs/common';
import { scopeAllows } from '@tms/domain';
import { AuditService } from '../../audit/audit.service';
import { Clock } from '../../common/clock';
import { encodeId } from '../../common/ids';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';
import { DbService } from '../../db/db.service';
import type { OrderEditLockDto } from './order.dto';

/** ล็อกหมดอายุเมื่อไม่มีกิจกรรม 10 นาที (docs/04 C Edit lock — ยึด docs แทน heartbeat 2 นาทีของ spec/03 ORD-031) */
export const EDIT_LOCK_TTL_MS = 10 * 60_000;
export const UNLOCK_SCOPE = 'orders:unlock';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LockRow {
  id: string;
  userId: string;
  acquiredAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  user: { name: string };
}

/**
 * ล็อกการแก้ใบสั่งขนส่ง (ST3-T08; docs/04 C "Edit lock", spec/03 ORD-031, research O4)
 *
 * - ขอ/ต่ออายุ (`acquire`): คำสั่งเดียว `INSERT … ON CONFLICT DO UPDATE … WHERE ผู้ถือเดิม OR หมดอายุแล้ว` — ปลอดภัยเมื่อขอพร้อมกัน
 *   (unique ต่อใบ: แถวเดียว คนแรกได้ อีกคน 409 `order_locked_by_user`)
 * - หมดอายุตามเวลา (`expires_at` ≤ ตอนนี้ = ไม่มีล็อก) — ไม่มี job ล้าง · เวลาจาก `Clock` (test เลื่อนเวลาได้)
 * - ใช้ล็อกเฉพาะทางแก้ของหน้าจอ: PATCH /v1/orders/{id} ของผู้ที่ไม่ใช่ผู้ถือ → 409 · ทางเข้า POST/PUT external
 *   (API/connector/นำเข้า) และการเปลี่ยนสถานะจากเที่ยว/DO ไม่ติดล็อก (docs/04 C "ทุกใบเข้าระบบ"; คนที่แก้อยู่จะได้ 412 ตอนบันทึก)
 * - ปลดของตัวเอง/ล็อกหมดอายุ = ลบแถว · ปลดของคนอื่นต้องมี `orders:unlock` + เหตุผล ≥ 10 ตัวอักษร + audit
 *   + บันทึก `order_edit_lock_release` ให้ผู้ถือเดิม heartbeat/PATCH ได้ 409 `order_lock_released` จนกว่าจะเปิดแก้ใหม่ (QA)
 */
@Injectable()
export class OrderLockService {
  constructor(
    private readonly db: DbService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  /** ผู้ใช้ของบริษัทที่เรียก (ล็อกแสดงชื่อ) — token อื่น (API client/link) → 403 `edit_lock_user_required` */
  private async actorUser(): Promise<string> {
    const actor = requestContext.require().actorId ?? '';
    if (!UUID.test(actor)) throw new ProblemException('edit_lock_user_required');
    const u = await this.db.tx.appUser.findFirst({
      where: { id: actor, deletedAt: null },
      select: { id: true },
    });
    if (!u) throw new ProblemException('edit_lock_user_required');
    return u.id;
  }

  private async row(salesOrderId: string): Promise<LockRow | null> {
    return this.db.tx.orderEditLock.findUnique({
      where: { salesOrderId },
      select: {
        id: true,
        userId: true,
        acquiredAt: true,
        lastSeenAt: true,
        expiresAt: true,
        user: { select: { name: true } },
      },
    });
  }

  private toDto(r: LockRow): OrderEditLockDto {
    return {
      userId: encodeId('user', r.userId),
      userName: r.user.name,
      acquiredAt: r.acquiredAt.toISOString(),
      lastSeenAt: r.lastSeenAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      mine: r.userId === requestContext.get()?.actorId,
    };
  }

  /** ล็อกที่ยังไม่หมดอายุ (null = ไม่มีใครแก้) */
  async active(salesOrderId: string): Promise<LockRow | null> {
    const r = await this.row(salesOrderId);
    return r && r.expiresAt > this.clock.now() ? r : null;
  }

  async view(salesOrderId: string): Promise<OrderEditLockDto | null> {
    const r = await this.active(salesOrderId);
    return r ? this.toDto(r) : null;
  }

  private lockedBy(r: LockRow): ProblemException {
    return new ProblemException('order_locked_by_user', undefined, undefined, {
      editLock: this.toDto(r),
    });
  }

  /**
   * การปลดล็อกของผู้อื่นที่ยังมีผลกับผู้ใช้นี้ (QA ST3-T08) → 409 `order_lock_released` พร้อมชื่อผู้ปลด + เหตุผล
   * ผู้ถือเดิมต่ออายุ/บันทึกไม่ได้จนกว่าจะเปิดแก้ใหม่ (POST /lock แบบเปิด) หรือหมดอายุ (ปลด + 10 นาที)
   */
  private async assertNotReleased(salesOrderId: string, userId: string | undefined, now: Date) {
    if (!userId || !UUID.test(userId)) return;
    const rel = await this.db.tx.orderEditLockRelease.findUnique({
      where: { salesOrderId_userId: { salesOrderId, userId } },
      select: {
        releasedAt: true,
        reason: true,
        expiresAt: true,
        releaser: { select: { id: true, name: true } },
      },
    });
    if (rel && rel.expiresAt > now)
      throw new ProblemException('order_lock_released', undefined, undefined, {
        releasedBy: { userId: encodeId('user', rel.releaser.id), userName: rel.releaser.name },
        releasedAt: rel.releasedAt.toISOString(),
        reason: rel.reason,
      });
  }

  /**
   * เปิดแก้ (ขอล็อก — ค่าตั้งต้น) / ต่ออายุ (`heartbeat`) — ผู้อื่นถืออยู่และยังไม่หมดอายุ → 409 `order_locked_by_user`
   * heartbeat ของผู้ที่ถูกปลดล็อก → 409 `order_lock_released` (ไม่ได้ล็อกคืนเงียบ ๆ) · เปิดแก้ใหม่ = ล้างการแจ้งแล้วขอตามปกติ
   */
  async acquire(salesOrderId: string, heartbeat = false): Promise<OrderEditLockDto> {
    const userId = await this.actorUser();
    const tenantId = requestContext.require().tenantId!;
    const now = this.clock.now();
    const exp = new Date(now.getTime() + EDIT_LOCK_TTL_MS);
    if (heartbeat) await this.assertNotReleased(salesOrderId, userId, now);
    else await this.db.tx.orderEditLockRelease.deleteMany({ where: { salesOrderId, userId } });
    const got = await this.db.tx.$queryRaw<{ id: string }[]>`
      INSERT INTO order_edit_lock (id, tenant_id, sales_order_id, user_id, acquired_at, last_seen_at, expires_at)
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${salesOrderId}::uuid, ${userId}::uuid, ${now}, ${now}, ${exp})
      ON CONFLICT (sales_order_id) DO UPDATE SET
        acquired_at = CASE
          WHEN order_edit_lock.user_id = EXCLUDED.user_id AND order_edit_lock.expires_at > EXCLUDED.last_seen_at
          THEN LEAST(order_edit_lock.acquired_at, EXCLUDED.acquired_at)
          ELSE EXCLUDED.acquired_at END,
        user_id = EXCLUDED.user_id,
        last_seen_at = EXCLUDED.last_seen_at,
        expires_at = EXCLUDED.expires_at
      WHERE order_edit_lock.user_id = EXCLUDED.user_id
         OR order_edit_lock.expires_at <= EXCLUDED.last_seen_at
      RETURNING id`;
    const r = await this.row(salesOrderId);
    if (!got.length) {
      // ผู้อื่นถืออยู่ (แถวไม่ถูกแก้) — อ่านใหม่เพื่อบอกชื่อ; หายไประหว่างนั้น (เพิ่งปลด) = ให้ลองใหม่
      if (r && r.userId !== userId) throw this.lockedBy(r);
      throw new ProblemException('concurrent_update');
    }
    return this.toDto(r!);
  }

  /**
   * PATCH จากผู้ที่ไม่ใช่ผู้ถือล็อก → 409 `order_locked_by_user` · ผู้ถือ = ต่ออายุ (กิจกรรม)
   * ไม่มีล็อก/หมดอายุ = เขียนได้ (ล็อกเป็นข้อตกลงของหน้าจอ — ผู้เรียก API ไม่ต้องขอก่อน)
   * อ่านแถวล็อกด้วย `FOR UPDATE` (ค้างจนจบ transaction ของ PATCH) — คนอื่นขอล็อกระหว่างนี้ต้องรอ แล้วเห็นล็อกที่ต่ออายุแล้ว
   * ต่ออายุไม่สำเร็จ (ล็อกเปลี่ยนมือระหว่างอ่าน) → อ่านใหม่แล้ว 409 ถ้าคนอื่นถืออยู่ (review ST3-T08 TOCTOU)
   */
  async assertWritable(salesOrderId: string): Promise<void> {
    const actor = requestContext.require().actorId;
    const now = this.clock.now();
    await this.assertNotReleased(salesOrderId, actor, now);
    const rows = await this.db.tx.$queryRaw<{ id: string; user_id: string; expires_at: Date }[]>`
      SELECT id, user_id, expires_at FROM order_edit_lock
       WHERE sales_order_id = ${salesOrderId}::uuid FOR UPDATE`;
    const r = rows[0];
    if (!r || r.expires_at <= now) return;
    if (r.user_id !== actor) {
      const cur = await this.active(salesOrderId);
      if (cur) throw this.lockedBy(cur);
      return;
    }
    const u = await this.db.tx.orderEditLock.updateMany({
      where: { id: r.id, userId: r.user_id, expiresAt: { gt: now } },
      data: { lastSeenAt: now, expiresAt: new Date(now.getTime() + EDIT_LOCK_TTL_MS) },
    });
    if (u.count === 0) {
      const cur = await this.active(salesOrderId);
      if (cur && cur.userId !== actor) throw this.lockedBy(cur);
    }
  }

  /**
   * ปลดล็อก — ไม่มีล็อก/หมดอายุ/ของตัวเอง = ลบ (ส่งซ้ำได้) · ของคนอื่น = ต้องมี `orders:unlock` (ไม่มี → 403)
   * + เหตุผล ≥ 10 ตัวอักษร (422) แล้วลง audit `order.edit_lock_released` (before = ผู้ถือเดิม)
   */
  async release(salesOrderId: string, reason?: string): Promise<void> {
    const ctx = requestContext.require();
    const r = await this.row(salesOrderId);
    if (!r) return;
    const expired = r.expiresAt <= this.clock.now();
    if (!expired && r.userId !== ctx.actorId) {
      if (!scopeAllows(ctx.scopes ?? [], UNLOCK_SCOPE))
        throw new ProblemException('permission_denied', undefined, undefined, {
          module: 'orders',
          action: 'unlock',
          required: [UNLOCK_SCOPE],
        });
      const why = reason?.trim() ?? '';
      if (why.length < 10)
        throw new ProblemException('validation_failed', undefined, [
          { field: 'reason', code: 'minLength', message: 'reason must be at least 10 characters' },
        ]);
      // ผู้ปลดต้องเป็นผู้ใช้ (บันทึกชื่อให้ผู้ถือเดิมเห็น) — ตรวจก่อนลบ
      const releaser = await this.actorUser();
      // ลบเฉพาะล็อกที่เห็น (ผู้ถือเดิมยังไม่ต่ออายุ/ปลดเองระหว่างนี้ก็ยังเป็นแถวเดิม — id + user ตรง)
      const del = await this.db.tx.orderEditLock.deleteMany({
        where: { id: r.id, userId: r.userId },
      });
      if (!del.count) return;
      // แจ้งผู้ถือเดิม (QA): heartbeat/บันทึกครั้งถัดไปได้ 409 "ถูกปลดล็อกโดย …" ไม่ว่าล็อกจะเปลี่ยนมือหรือถูกลบต่อ
      const until = new Date(this.clock.now().getTime() + EDIT_LOCK_TTL_MS);
      const at = this.clock.now();
      await this.db.tx.orderEditLockRelease.upsert({
        where: { salesOrderId_userId: { salesOrderId, userId: r.userId } },
        create: {
          tenantId: ctx.tenantId!,
          salesOrderId,
          userId: r.userId,
          releasedBy: releaser,
          releasedAt: at,
          reason: why,
          expiresAt: until,
        },
        update: { releasedBy: releaser, releasedAt: at, reason: why, expiresAt: until },
      });
      await this.audit.record({
        action: 'order.edit_lock_released',
        entityType: 'sales_order',
        entityId: salesOrderId,
        before: this.toDto(r),
        reason: why,
      });
      return;
    }
    // ของตัวเอง = ลบเฉพาะแถวของตัวเอง · ของคนอื่นที่หมดอายุ = ลบเมื่อยังหมดอายุอยู่ (ผู้ถือต่ออายุทันระหว่างนี้ → ไม่ลบ)
    await this.db.tx.orderEditLock.deleteMany({
      where:
        r.userId === ctx.actorId
          ? { id: r.id, userId: r.userId }
          : { id: r.id, userId: r.userId, expiresAt: { lte: this.clock.now() } },
    });
  }
}
