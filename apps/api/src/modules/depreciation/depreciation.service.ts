import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Clock } from '../../common/clock';
import { DbService, type Tx } from '../../db/db.service';
import { PrismaService } from '../../db/prisma.service';
import { JobQueue } from '../../jobs/job-queue.service';
import {
  MONTH_RE,
  addMonths,
  bangkokMonth,
  dueLines,
  lastDayOf,
  type Month,
} from './depreciation-policy';

export const DEPRECIATION_JOB = 'depreciation.monthly';
/** job ของเดือนที่เพิ่งปิด สร้างตั้งแต่วันที่ 1 เวลา 02:00 น. ไทย */
export const RUN_FROM_HOUR_BKK = 2;
/** advisory lock namespace 9 (1–5 auth, 8 เตือนต่ออายุ ST2-T18, 11 idempotency) — เขียนเป็นตัวเลขตรงใน SQL (พารามิเตอร์จะเป็น bigint) */
export const DEPRECIATION_SOURCE = 'depreciation';

export interface DepreciationRunResult {
  through: Month;
  /** รถบริษัทที่ตั้งค่าเสื่อมเส้นตรงครบ (ราคาซื้อ + วันซื้อ + อายุ) */
  vehicles: number;
  /** แถว vehicle_cost ที่เขียนรอบนี้ */
  rows: number;
  /** รถที่ตั้งวิธีค่าเสื่อมแต่ยังไม่กรอกวันซื้อ (ข้าม) */
  incomplete: number;
  failed: number;
}

type WithTx = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

const asDate = (d: string) => new Date(`${d}T00:00:00Z`);
const day = (d: Date) => d.toISOString().slice(0, 10);

/** เดือนล่าสุดที่ปิดแล้ว ณ เวลา `now` (ก่อนวันที่ 1 02:00 น. ไทย ยังนับเดือนก่อนหน้านั้น) */
export function closedMonth(now: Date): Month {
  return addMonths(bangkokMonth(new Date(now.getTime() - RUN_FROM_HOUR_BKK * 3600_000)), -1);
}

/**
 * ค่าเสื่อมรายเดือน (ST2-T22; docs/04 B2.1 ส่วน 1 "เส้นตรง N ปี → ค่าเสื่อม/เดือนลง vehicle_cost", docs/01 §3.8, spec/06 FLT-004)
 *
 * - worker เรียก `scheduleDue()` ทุก 10 นาที → ตั้งแต่วันที่ 1 เวลา 02:00 น. ไทย สร้าง job `depreciation.monthly`
 *   1 ชิ้น/tenant/เดือน (tenant TRIAL/ACTIVE; advisory lock กันสอง worker สร้างซ้ำ) payload `{ through: 'YYYY-MM' }`
 * - handler (outsideTransaction): ตรวจสถานะ tenant ซ้ำ → อ่านรถบริษัท (OWN) ที่ตั้ง STRAIGHT_LINE + ราคาซื้อ + วันซื้อ + อายุ
 *   → ทีละคัน (transaction สั้นของ tenant + advisory lock ต่อรถ) คำนวณแถวที่ขาดถึงเดือน `through` แล้ว INSERT … ON CONFLICT DO NOTHING
 *   (unique tenant + รถ + หมวด + period_month) → รันซ้ำ/พร้อมกัน/ย้อนหลังไม่เกิดแถวซ้ำ
 * - กติกาเงิน/เดือนเริ่ม-จบ อยู่ใน depreciation-policy.ts
 * - ไม่ลง audit ต่อแถว: แถวระบบคำนวณจากข้อมูลรถ (การแก้ข้อมูลการเงินรถมี audit อยู่แล้ว) · vehicle_cost แก้/ลบไม่ได้ (REVOKE)
 */
@Injectable()
export class DepreciationService implements OnModuleInit {
  private readonly logger = new Logger('DepreciationService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly db: DbService,
    private readonly queue: JobQueue,
    private readonly clock: Clock,
  ) {}

  onModuleInit() {
    this.queue.register(
      DEPRECIATION_JOB,
      async ({ tenantId, job, withTx }) => {
        const p = (job.payload ?? {}) as { through?: unknown };
        const through =
          typeof p.through === 'string' && MONTH_RE.test(p.through)
            ? p.through
            : closedMonth(this.clock.now());
        // ตรวจสถานะ tenant ซ้ำตอนรัน — ถูกระงับ/ยกเลิกหลังสร้าง job แล้วต้องไม่ลงค่าเสื่อม
        if (!(await this.tenantActive(tenantId))) return { skipped: 'tenant_inactive', through };
        const r = await this.runForTenant(tenantId, through, withTx);
        if (r.failed > 0)
          throw new Error(
            `depreciation failed for ${r.failed} vehicle(s) — retrying (${r.rows} rows written)`,
          );
        return r;
      },
      { outsideTransaction: true },
    );
  }

  /** สร้าง job ของเดือนที่เพิ่งปิดให้ทุก tenant ที่ยังไม่มี (เรียกซ้ำได้) */
  async scheduleDue(now: Date = this.clock.now()): Promise<number> {
    const through = closedMonth(now);
    return this.prisma.platform.$transaction(async (db) => {
      await db.$executeRaw`SELECT pg_advisory_xact_lock(9, hashtext('depreciation.monthly'))`;
      const tenants = await db.tenant.findMany({
        where: { status: { in: ['TRIAL', 'ACTIVE'] } },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });
      if (!tenants.length) return 0;
      // created_at เป็นเวลาจริงของฐาน — จำกัด 70 วันล่าสุดให้ใช้ดัชนี; job ที่ล้มถาวร (FAILED) สร้างใหม่ได้
      const existing = await db.job.findMany({
        where: {
          tenantId: { in: tenants.map((t) => t.id) },
          type: DEPRECIATION_JOB,
          status: { not: 'FAILED' },
          createdAt: { gte: new Date(Date.now() - 70 * 86_400_000) },
          payload: { path: ['through'], equals: through },
        },
        select: { tenantId: true },
      });
      const done = new Set(existing.map((j) => j.tenantId));
      const todo = tenants.filter((t) => !done.has(t.id));
      for (const t of todo)
        await this.queue.enqueue(db as unknown as Tx, {
          tenantId: t.id,
          type: DEPRECIATION_JOB,
          payload: { through },
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

  /** ลงค่าเสื่อมของ tenant ถึงเดือน `through` (รวม) */
  async runForTenant(
    tenantId: string,
    through: Month,
    withTx: WithTx = (fn) => this.db.withTenant(tenantId, fn),
  ): Promise<DepreciationRunResult> {
    const vehicles = await withTx((tx) =>
      tx.vehicle.findMany({
        where: {
          ownership: 'OWN', // รถร่วมไม่มีค่าเสื่อม (docs/01 §3.8)
          deletedAt: null,
          depreciationMethod: 'STRAIGHT_LINE',
          purchaseCost: { not: null },
          depreciationYears: { not: null },
        },
        select: { id: true, purchasedOn: true },
        orderBy: { id: 'asc' },
      }),
    );
    const result: DepreciationRunResult = {
      through,
      vehicles: 0,
      rows: 0,
      incomplete: 0,
      failed: 0,
    };
    for (const v of vehicles) {
      if (!v.purchasedOn) {
        result.incomplete += 1;
        continue;
      }
      result.vehicles += 1;
      try {
        result.rows += await withTx((tx) => this.postVehicle(tx, tenantId, v.id, through));
      } catch (e) {
        result.failed += 1;
        this.logger.warn(
          `tenant ${tenantId} ${through}: depreciation for vehicle ${v.id} failed: ${String(e)}`,
        );
      }
    }
    if (result.rows || result.failed)
      this.logger.log(
        `tenant ${tenantId} through ${through}: ${result.rows} rows, ${result.vehicles} vehicles, ${result.failed} failed`,
      );
    return result;
  }

  /** รถหนึ่งคัน — อ่านข้อมูลล่าสุดใต้ lock ของรถ แล้วเขียนแถวที่ขาด (คืนจำนวนแถวที่เขียนได้จริง) */
  private async postVehicle(tx: Tx, tenantId: string, vehicleId: string, through: Month) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(9, hashtext(${`depreciation:${vehicleId}`}))`;
    const v = await tx.vehicle.findFirst({
      where: {
        id: vehicleId,
        ownership: 'OWN',
        deletedAt: null,
        depreciationMethod: 'STRAIGHT_LINE',
      },
      select: {
        purchaseCost: true,
        salvageValue: true,
        depreciationYears: true,
        purchasedOn: true,
        status: true,
        retiredAt: true,
      },
    });
    if (!v || !v.purchaseCost || !v.depreciationYears || !v.purchasedOn) return 0;
    // ปลดระวางแล้ว: หยุดหลังเดือนที่ปลด (เวลาไทย) — CHECK vehicle_retired_at บังคับ retired_at เมื่อ RETIRED; ปลดแล้วกลับไม่ได้
    const retiredMonth = v.status === 'RETIRED' && v.retiredAt ? bangkokMonth(v.retiredAt) : null;
    const posted = await tx.vehicleCost.findMany({
      where: { vehicleId, category: 'DEPRECIATION' },
      select: { periodMonth: true, amount: true },
    });
    const lines = dueLines(
      {
        purchaseCost: v.purchaseCost.toFixed(2),
        salvageValue: v.salvageValue?.toFixed(2) ?? null,
        years: v.depreciationYears,
        purchasedOn: day(v.purchasedOn),
        retiredMonth,
      },
      through,
      new Map(posted.map((r) => [day(r.periodMonth!).slice(0, 7), r.amount.toFixed(2)])),
    );
    if (!lines.length) return 0;
    const r = await tx.vehicleCost.createMany({
      data: lines.map((l) => ({
        tenantId,
        vehicleId,
        category: 'DEPRECIATION',
        amount: l.amount,
        periodMonth: asDate(`${l.month}-01`),
        occurredOn: asDate(lastDayOf(l.month)),
        sourceType: DEPRECIATION_SOURCE,
        note: `ค่าเสื่อมเส้นตรง เดือนที่ ${l.index}/${l.total}`,
        createdBy: null,
      })),
      skipDuplicates: true, // ON CONFLICT DO NOTHING (unique tenant + รถ + หมวด + เดือน)
    });
    return r.count;
  }
}
