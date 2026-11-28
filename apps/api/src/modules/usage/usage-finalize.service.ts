import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Clock } from '../../common/clock';
import { PrismaService } from '../../db/prisma.service';
import { readPlatformSetting } from '../../platform/platform-settings.service';
import { addMonths, type Month } from '../depreciation/depreciation-policy';
import {
  ACTIVE_VEHICLES_METRIC,
  finalizablePeriod,
  periodRange,
  tallyActiveVehicles,
} from './active-vehicles';
import { monthRecords, recomputeFlows, rollupUsageDaily, sumMonth } from './usage-metrics';

/** worker เรียก scheduleDue ทุก 10 นาที (แบบเดียวกับค่าเสื่อม ST2-T22) */
export const USAGE_FINALIZE_EVERY_MS = 10 * 60 * 1000;
/** เดือนแรกที่ปิดยอด = เดือนที่ใช้ migration 0190 (PO 22 พ.ย. 2569: ยังไม่มีลูกค้าจริง) · เดือนก่อนนี้ไม่ปิดยอด */
export const USAGE_METERING_FROM: Month = '2026-11';
/** ปิดยอดย้อนหลังได้สูงสุดกี่เดือน (worker หยุดข้ามเดือน — review M1) */
export const FINALIZE_CATCH_UP_MONTHS = 3;

/**
 * ปิดยอดรถ active รายเดือน (P1-ST1-T06; spec/01 PLT-074 "finalize วันที่ 1 เวลา 02:00 ของเดือนถัดไป → UsageRecord.finalizedAt")
 *
 * - ตั้งแต่วันที่ 1 เวลา 02:00 น. ไทย: tenant live ทุกรายที่สร้างก่อนสิ้นเดือนและยังไม่มี `usage_record` ของเดือนที่เพิ่งจบ
 *   (รวมเดือนก่อนหน้าที่ตกหล่น ย้อนได้ FINALIZE_CATCH_UP_MONTHS เดือน)
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

  /**
   * ปิดยอดทุกเดือนที่ถึงเวลาแล้วแต่ยังไม่ปิด — เดือนล่าสุดที่ถึงเวลา + ย้อนหลังรวม FINALIZE_CATCH_UP_MONTHS เดือน
   * (worker หยุดข้ามวันที่ 1 หลายครั้งก็ปิดครบ) · ไม่ก่อน USAGE_METERING_FROM และไม่ก่อนเดือนที่สร้าง tenant
   * เรียงจากเดือนเก่าไปใหม่ · คืนจำนวน (tenant × เดือน) ที่ปิดรอบนี้
   */
  async scheduleDue(now: Date = this.clock.now()): Promise<number> {
    const last = finalizablePeriod(now);
    const periods: Month[] = [];
    for (let i = FINALIZE_CATCH_UP_MONTHS - 1; i >= 0; i--) {
      const p = addMonths(last, -i);
      if (p >= USAGE_METERING_FROM) periods.push(p);
    }
    const db = this.prisma.platform;
    let n = 0;
    for (const period of periods) {
      const { end } = periodRange(period);
      // tenant ที่มีตัวตนในเดือนนั้น (สร้างก่อนสิ้นเดือน) และยังไม่ปิดยอด
      const todo = await db.$queryRaw<{ id: string }[]>`
        SELECT t.id FROM tenant t
         WHERE t.mode = 'live' AND t.created_at < ${end}
           AND NOT EXISTS (SELECT 1 FROM usage_record u
                            WHERE u.tenant_id = t.id AND u.metric = ${ACTIVE_VEHICLES_METRIC} AND u.period = ${period})
         ORDER BY t.created_at`;
      for (const t of todo) {
        try {
          if (await this.finalize(t.id, period, now)) n += 1;
        } catch (e) {
          this.logger.warn(`tenant ${t.id} ${period}: usage finalize failed: ${String(e)}`);
        }
      }
    }
    return n;
  }

  /** P1-ST1-T07 ยอดรายวัน (worker ทุก 10 นาที หลัง scheduleDue) — set-based ทุก tenant live */
  async rollupDaily(now: Date = this.clock.now()): Promise<void> {
    await this.prisma.platform.$transaction((tx) => rollupUsageDaily(tx, now));
  }

  /**
   * ปิดยอด 1 tenant × 1 เดือน — false = ปิดไปแล้ว
   * P1-ST1-T07: ปิดเมตริกอื่นในรอบเดียวกัน — คำนวณ DO/ใบแจ้งหนี้รายวันของทั้งเดือนใหม่ก่อน แล้ว usage_record = ผลรวมรายวัน
   * (GAUGE = วันล่าสุดในเดือน) · เขียนก่อนแถวรถ active เพราะแถว usage_record ใด ๆ ของเดือน = เดือนปิดแล้ว (rollup/flush ไม่แตะ)
   */
  async finalize(tenantId: string, period: Month, now: Date = this.clock.now()): Promise<boolean> {
    return this.prisma.platform.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(20, hashtext(${`${tenantId}:${period}`}))`;
      const done = await tx.$queryRaw<unknown[]>`
        SELECT 1 FROM usage_record WHERE tenant_id = ${tenantId}::uuid AND metric = ${ACTIVE_VEHICLES_METRIC}
           AND period = ${period}`;
      if (done.length) return false;
      const { start, end } = periodRange(period);
      await recomputeFlows(tx, { from: start, to: end }, tenantId);
      const month = await sumMonth(tx, tenantId, period);
      const t = await tallyActiveVehicles(tx, tenantId, period);
      const rule = await readPlatformSetting<string>(tx, 'usage.activeVehicleRule');
      const subconWeight = await readPlatformSetting<string>(tx, 'usage.subconWeight');
      for (const m of monthRecords(month))
        await tx.$executeRaw`
          INSERT INTO usage_record (tenant_id, metric, period, value, status, finalized_at, detail)
          VALUES (${tenantId}::uuid, ${m.metric}, ${period}, ${new Prisma.Decimal(m.value)}, 'finalized', ${now},
                  ${JSON.stringify(m.detail)}::jsonb)
          ON CONFLICT (tenant_id, metric, period) DO NOTHING`;
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
