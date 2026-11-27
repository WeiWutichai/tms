import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Clock } from '../../common/clock';
import { PrismaService } from '../../db/prisma.service';
import { readPlatformSetting } from '../../platform/platform-settings.service';
import type { Month } from '../depreciation/depreciation-policy';
import {
  ACTIVE_VEHICLES_METRIC,
  finalizablePeriod,
  periodRange,
  tallyActiveVehicles,
} from './active-vehicles';

/** worker เรียก scheduleDue ทุก 10 นาที (แบบเดียวกับค่าเสื่อม ST2-T22) */
export const USAGE_FINALIZE_EVERY_MS = 10 * 60 * 1000;

/**
 * ปิดยอดรถ active รายเดือน (P1-ST1-T06; spec/01 PLT-074 "finalize วันที่ 1 เวลา 02:00 ของเดือนถัดไป → UsageRecord.finalizedAt")
 *
 * - ตั้งแต่วันที่ 1 เวลา 02:00 น. ไทย: tenant live ทุกรายที่สร้างก่อนสิ้นเดือนและยังไม่มี `usage_record` ของเดือนที่เพิ่งจบ
 *   → นับแถว `active_vehicle_usage` (ไม่รวมที่ตัดออก) แล้วเขียน `usage_record` สถานะ finalized (รันซ้ำได้ — ON CONFLICT DO NOTHING)
 * - lock (20, tenant:เดือน) แบบ exclusive — trigger นับรถถือแบบ shared → เที่ยวที่กำลังเปลี่ยนสถานะอยู่ตอนปิดยอดรอให้ปิดเสร็จ
 *   แล้วเห็นว่าเดือนปิดแล้ว (ไม่แตะ) · หลังปิดยอดแก้ได้เฉพาะ Console การเงิน + เหตุผล (PlatformUsageController)
 * - sandbox (mode = test) ไม่มีแถวและไม่ปิดยอด (PLT-071)
 */
@Injectable()
export class UsageFinalizeService {
  private readonly logger = new Logger('UsageFinalizeService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  /** ปิดยอดเดือนที่ถึงเวลาให้ทุก tenant ที่ยังไม่ปิด — คืนจำนวน tenant ที่ปิดรอบนี้ */
  async scheduleDue(now: Date = this.clock.now()): Promise<number> {
    const period = finalizablePeriod(now);
    const { end } = periodRange(period);
    const db = this.prisma.platform;
    const todo = await db.$queryRaw<{ id: string }[]>`
      SELECT t.id FROM tenant t
       WHERE t.mode = 'live' AND t.created_at < ${end}
         AND NOT EXISTS (SELECT 1 FROM usage_record u
                          WHERE u.tenant_id = t.id AND u.metric = ${ACTIVE_VEHICLES_METRIC} AND u.period = ${period})
       ORDER BY t.created_at`;
    let n = 0;
    for (const t of todo) {
      try {
        if (await this.finalize(t.id, period, now)) n += 1;
      } catch (e) {
        this.logger.warn(`tenant ${t.id} ${period}: usage finalize failed: ${String(e)}`);
      }
    }
    return n;
  }

  /** ปิดยอด 1 tenant × 1 เดือน — false = ปิดไปแล้ว */
  async finalize(tenantId: string, period: Month, now: Date = this.clock.now()): Promise<boolean> {
    return this.prisma.platform.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(20, hashtext(${`${tenantId}:${period}`}))`;
      const t = await tallyActiveVehicles(tx, tenantId, period);
      const rule = await readPlatformSetting<string>(tx, 'usage.activeVehicleRule');
      const subconWeight = await readPlatformSetting<string>(tx, 'usage.subconWeight');
      const r = await tx.$executeRaw`
        INSERT INTO usage_record (tenant_id, metric, period, value, status, finalized_at, detail)
        VALUES (${tenantId}::uuid, ${ACTIVE_VEHICLES_METRIC}, ${period}, ${new Prisma.Decimal(t.total)},
                'finalized', ${now},
                ${JSON.stringify({ own: t.own, subcontract: t.sub, plateMissing: t.missing, rule, subconWeight })}::jsonb)
        ON CONFLICT (tenant_id, metric, period) DO NOTHING`;
      return r > 0;
    });
  }
}
