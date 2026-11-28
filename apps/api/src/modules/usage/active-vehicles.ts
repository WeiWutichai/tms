import type { Prisma } from '@prisma/client';
import { encodeId } from '../../common/ids';
import { addMonths, MONTH_RE, type Month } from '../depreciation/depreciation-policy';

/**
 * รถ active ต่อเดือน (P1-ST1-T06; spec/01 §7 PLT-070–075 · plan/13 R-05 / D-41 · docs/02 §2)
 *
 * - การนับเกิดใน DB: trigger `trip_active_vehicle` → `tms_active_vehicle_recount` (migration 0190) เขียน `active_vehicle_usage`
 *   ครอบทุกทางที่เปลี่ยนสถานะเที่ยว (ปล่อยรถ / เริ่มวิ่ง / ปิดงาน / ยกเลิก / นำเข้า) · ไฟล์นี้อ่านอย่างเดียว + ปิดยอด
 * - เดือน = เดือนปฏิทินเวลาไทย (YYYY-MM) · เดือนที่ยังไม่ปิดยอด = ค่าสด · ปิดยอดแล้ว = `usage_record.value`
 * - เที่ยวที่ใช้รถ/รถร่วมตัวอย่างขณะบริษัทยังอยู่ช่วงทดลองใช้ (P1-ST2-T09 — `tms_trip_is_sample`, migration 0202) ไม่นับ
 * - แถวที่ Console การเงินตัดออก (`excluded_at`) ไม่นับ และไม่แสดงให้ลูกค้า · เหตุผลจริงอยู่ใน platform_audit_log (PLT-066 pattern)
 */

export const ACTIVE_VEHICLES_METRIC = 'vehicles.active';
/** ปิดยอดของเดือนที่เพิ่งจบตั้งแต่วันที่ 1 เวลา 02:00 น. ไทย (PLT-074) */
export const FINALIZE_FROM_HOUR_BKK = 2;

type Db = Prisma.TransactionClient;

/** เดือนปฏิทินเวลาไทยของเวลา `now` */
export function bangkokPeriod(now: Date): Month {
  return new Date(now.getTime() + 7 * 3600_000).toISOString().slice(0, 7);
}

/** เดือนล่าสุดที่ถึงเวลาปิดยอด ณ `now` (ก่อนวันที่ 1 02:00 น. ไทย = ยังเป็นเดือนก่อนหน้านั้น) */
export function finalizablePeriod(now: Date): Month {
  return addMonths(bangkokPeriod(new Date(now.getTime() - FINALIZE_FROM_HOUR_BKK * 3600_000)), -1);
}

/** ช่วงเวลา [start, end) ของเดือนเวลาไทย */
export function periodRange(p: Month): { start: Date; end: Date } {
  const start = new Date(`${p}-01T00:00:00+07:00`);
  const end = new Date(`${addMonths(p, 1)}-01T00:00:00+07:00`);
  return { start, end };
}

export const isPeriod = (p: unknown): p is Month => typeof p === 'string' && MONTH_RE.test(p);

export interface ActiveVehicleItem {
  rowId: string;
  plate: string | null;
  plateMissing: boolean;
  subcontract: boolean;
  vehicleType: string | null;
  carrierName: string | null;
  trips: number;
  firstTripId: string | null;
  firstTripNo: string | null;
  firstCountedAt: string;
  /** เพิ่มโดยทีมผู้ให้บริการหลังปิดยอด */
  adjusted: boolean;
  excluded: boolean;
}

export interface ActiveVehicleUsage {
  period: Month;
  status: 'open' | 'finalized' | 'invoiced';
  finalizedAt: string | null;
  /** จำนวนรถ active (ปิดยอดแล้ว = ค่าที่ปิด) */
  count: number;
  own: number;
  subcontract: number;
  items: ActiveVehicleItem[];
}

interface Row {
  id: string;
  plate_normalized: string;
  plate: string | null;
  plate_missing: boolean;
  subcontract: boolean;
  rule: string;
  source: string;
  excluded_at: Date | null;
  first_trip_id: string | null;
  first_counted_at: Date;
  trip_no: string | null;
  vehicle_type: string | null;
  carrier_name: string | null;
}

/**
 * รายการรถ active ของเดือน + จำนวนเที่ยวที่เข้าเงื่อนไขต่อทะเบียน (ตามกติกาที่ใช้นับแถวนั้น)
 * `includeExcluded` = Console เห็นแถวที่ตัดออกด้วย
 */
export async function readActiveVehicles(
  db: Db,
  tenantId: string,
  period: Month,
  o: { includeExcluded?: boolean } = {},
): Promise<ActiveVehicleUsage> {
  const rows = await db.$queryRaw<Row[]>`
    SELECT a.id, a.plate_normalized, a.plate, a.plate_missing, a.subcontract, a.rule, a.source, a.excluded_at,
           a.first_trip_id, a.first_counted_at, t.trip_no, t.vehicle_type_snapshot AS vehicle_type,
           t.carrier_name_snapshot AS carrier_name
      FROM active_vehicle_usage a
      LEFT JOIN trip t ON t.id = a.first_trip_id AND t.tenant_id = a.tenant_id
     WHERE a.tenant_id = ${tenantId}::uuid AND a.period = ${period}
     ORDER BY a.first_counted_at, a.plate_normalized`;
  const { start, end } = periodRange(period);
  // จำนวนเที่ยวที่เข้าเงื่อนไขต่อทะเบียน (กติกาเดียวกับ trigger — tms_trip_usage_at / tms_trip_usage_key)
  const counts = await db.$queryRaw<{ k: string; rule: string; n: number }[]>`
    SELECT x.k, x.rule, count(*)::int AS n FROM (
      SELECT tms_trip_usage_key(t.vehicle_plate_snapshot, t.carrier_id, t.driver_id, t.driver_name_snapshot, t.id) AS k,
             r.rule
        FROM trip t CROSS JOIN (VALUES ('trip_started'), ('doc_closed')) AS r(rule)
       WHERE t.tenant_id = ${tenantId}::uuid
         AND NOT tms_trip_is_sample(t.tenant_id, t.vehicle_id, t.carrier_id,
               tms_trip_usage_at(r.rule, t.status::text, t.dispatched_at, t.completed_at))
         AND (t.dispatched_at >= ${start} OR t.completed_at >= ${start})
         AND tms_trip_usage_at(r.rule, t.status::text, t.dispatched_at, t.completed_at) >= ${start}
         AND tms_trip_usage_at(r.rule, t.status::text, t.dispatched_at, t.completed_at) < ${end}
    ) x GROUP BY x.k, x.rule`;
  const n = new Map(counts.map((c) => [`${c.rule}|${c.k}`, c.n]));
  const rec = await db.usageRecord.findUnique({
    where: {
      tenantId_metric_period: { tenantId, metric: ACTIVE_VEHICLES_METRIC, period },
    },
  });
  const counted = rows.filter((r) => !r.excluded_at);
  const items = (o.includeExcluded ? rows : counted).map((r): ActiveVehicleItem => ({
    rowId: r.id,
    plate: r.plate,
    plateMissing: r.plate_missing,
    subcontract: r.subcontract,
    vehicleType: r.vehicle_type,
    carrierName: r.carrier_name,
    trips: n.get(`${r.rule}|${r.plate_normalized}`) ?? 0,
    firstTripId: r.first_trip_id ? encodeId('trip', r.first_trip_id) : null,
    firstTripNo: r.trip_no,
    firstCountedAt: r.first_counted_at.toISOString(),
    adjusted: r.source === 'console',
    excluded: !!r.excluded_at,
  }));
  const status = (rec?.status ?? 'open') as ActiveVehicleUsage['status'];
  return {
    period,
    status,
    finalizedAt: rec?.finalizedAt?.toISOString() ?? null,
    count: rec && status !== 'open' ? Number(rec.value) : counted.length,
    own: counted.filter((r) => !r.subcontract).length,
    subcontract: counted.filter((r) => r.subcontract).length,
    items,
  };
}

/** ค่า + รายละเอียดของยอดปิดจากแถวรถ (ใช้ตอนปิดยอดและตอน Console ปรับหลังปิดยอด) */
export async function tallyActiveVehicles(db: Db, tenantId: string, period: Month) {
  const [t] = await db.$queryRaw<
    { total: number; own: number; sub: number; missing: number; manual: number }[]
  >`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE NOT subcontract)::int AS own,
           count(*) FILTER (WHERE subcontract)::int AS sub,
           count(*) FILTER (WHERE plate_missing)::int AS missing,
           count(*) FILTER (WHERE source = 'console')::int AS manual
      FROM active_vehicle_usage
     WHERE tenant_id = ${tenantId}::uuid AND period = ${period} AND excluded_at IS NULL`;
  return t!;
}
