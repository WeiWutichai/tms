import { Injectable, Logger } from '@nestjs/common';
import { Clock } from '../../common/clock';
import { DbService } from '../../db/db.service';
import { PrismaService } from '../../db/prisma.service';
import { EntitlementService } from '../entitlements/entitlement.service';
import { reachedLevels } from '../entitlements/quota';
import { NotificationService } from '../notifications/notification.service';
import { ACTIVE_VEHICLES_METRIC, bangkokPeriod } from './active-vehicles';

/**
 * แจ้งผู้ดูแลระบบเมื่อรถ active ถึง 80 / 90 / 100% ของโควตา (P1-ST1-T08; spec/01 PLT-082 — อีเมล + ในแอป ครั้งเดียวต่อระดับต่อเดือน)
 * - worker เรียก `scheduleDue()` ทุก 10 นาที (ต่อจากปิดยอด/ยอดรายวัน) — ทุก tenant live ที่ยังใช้งาน · sandbox ไม่นับ
 * - ระดับที่ถึงแล้ว → แถว `quota_alert` (unique tenant×metric×เดือน×ระดับ — ON CONFLICT DO NOTHING) · ระดับใหม่หลายระดับในรอบเดียว
 *   = แจ้งฉบับเดียว (ระดับสูงสุด) · ระดับที่แจ้งแล้วไม่แจ้งซ้ำแม้ยอดลดแล้วขึ้นใหม่ในเดือนเดียวกัน
 * - ผู้รับ = role owner / admin (แบบเดียวกับ webhook ถูกปิดอัตโนมัติ)
 * - metric อื่นที่เป็น hard limit (connector / webhook / ผู้ใช้) สร้างเกินไม่ได้อยู่แล้ว → ยังไม่แจ้งตามระดับ [DECISION — lead 2026-11-28, ย้อนได้]
 */
@Injectable()
export class QuotaAlertService {
  private readonly logger = new Logger('QuotaAlertService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly db: DbService,
    private readonly entitlements: EntitlementService,
    private readonly notifications: NotificationService,
    private readonly clock: Clock,
  ) {}

  async scheduleDue(now: Date = this.clock.now()): Promise<number> {
    const tenants = await this.prisma.platform.tenant.findMany({
      where: {
        mode: 'live',
        status: { in: ['PENDING_VERIFICATION', 'TRIALING', 'ACTIVE', 'PAST_DUE'] },
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    let n = 0;
    for (const t of tenants) {
      try {
        if ((await this.check(t.id, now)) !== null) n += 1;
      } catch (e) {
        this.logger.warn(`tenant ${t.id}: quota alert failed: ${String(e)}`);
      }
    }
    return n;
  }

  /** ตรวจ 1 tenant — คืนระดับที่เพิ่งแจ้ง (null = ไม่มีระดับใหม่) */
  async check(tenantId: string, now: Date = this.clock.now()): Promise<number | null> {
    const { limit } = await this.entitlements.vehicleLimit(tenantId);
    if (limit === null) return null;
    const period = bangkokPeriod(now);
    return this.db.withTenant(tenantId, async (tx) => {
      const used = await tx.activeVehicleUsage.count({ where: { period, excludedAt: null } });
      const levels = reachedLevels(used, limit);
      if (!levels.length) return null;
      // แถวแจ้งเตือนเขียนด้วย client แพลตฟอร์ม (role แอปอ่านอย่างเดียว) — ชนกันพร้อมกัน = ฝั่งเดียวได้แถว
      const fresh = await this.prisma.platform.$queryRaw<{ level: number }[]>`
        INSERT INTO quota_alert (tenant_id, metric, period, level, used, "limit")
        SELECT ${tenantId}::uuid, ${ACTIVE_VEHICLES_METRIC}, ${period}, l, ${used}, ${limit}
          FROM unnest(${levels}::int[]) AS l
        ON CONFLICT (tenant_id, metric, period, level) DO NOTHING
        RETURNING level`;
      if (!fresh.length) return null;
      const level = Math.max(...fresh.map((r) => Number(r.level)));
      try {
        await this.notifications.notify(tx, {
          tenantId,
          to: { roles: ['owner', 'admin'] },
          template: 'quota.threshold',
          vars: { metric: ACTIVE_VEHICLES_METRIC, level, used, limit },
          link: '/fleet/vehicles',
        });
      } catch (e) {
        // ส่งไม่สำเร็จ → ถอนแถวที่เพิ่งใส่ ให้รอบถัดไปแจ้งใหม่
        await this.prisma.platform.quotaAlert.deleteMany({
          where: {
            tenantId,
            metric: ACTIVE_VEHICLES_METRIC,
            period,
            level: { in: fresh.map((r) => Number(r.level)) },
          },
        });
        throw e;
      }
      return level;
    });
  }
}
