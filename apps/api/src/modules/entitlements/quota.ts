import type { Prisma, PrismaClient } from '@prisma/client';
import { ProblemException } from '../../common/problem';
import { readPlatformSetting } from '../../platform/platform-settings.service';
import { resolveEntitlements } from './entitlement.service';
import { currentPlanVersions, PLANS } from './plan-catalog';

/**
 * บังคับโควตา (P1-ST1-T08; spec/01 §7.1 PLT-079–082 · docs/02 §2 "trial รถไม่เกิน 20 คัน" · D68-14/21)
 *
 * - `vehicles.active` = **soft limit** (PLT-080 — ยัง [OPEN O-PLT-4]; ใช้ทิศ D68-14 "คำเตือน ไม่ปฏิเสธ"):
 *   จ่ายงานให้ทะเบียนที่ยังไม่ถูกนับเดือนนี้และจะเกิน → คำเตือน `vehicle_quota_exceeded` ในกฎตอนจัด (ยืนยันแล้วจ่ายต่อได้)
 * - limit อื่น (connector `conn`, webhook `webhook`, ผู้ใช้ `users`) = **hard limit** (PLT-079): สร้างใหม่ไม่ได้ → 409 `*_limit_reached`
 *   พร้อม `featureKey` / `limit` / `used` / `upgradePlan` (UI แสดง dialog เสนออัปเกรด) · ตรวจเฉพาะตอนสร้าง → ลด limit ต่ำกว่าที่ใช้อยู่ไม่ลบของเดิม
 * - สาขา/นิติบุคคล: แคตตาล็อกยังไม่มี feature limit ของสาขา (มีแค่ `multi` เปิด/ปิด) → ยังไม่บังคับ [OPEN — PO] (spec/12 §3)
 */
type Db = PrismaClient | Prisma.TransactionClient;

export interface VehicleLimit {
  /** null = ไม่จำกัด / ไม่นับ (sandbox) */
  limit: number | null;
  /** เพดานมาจากไหน — contract = tenant.vehicle_quota (Console) · plan = entitlement `veh` · trial / pending = ค่าตั้งแพลตฟอร์ม */
  source: 'contract' | 'plan' | 'trial' | 'pending' | null;
}

const minLimit = (a: VehicleLimit, cap: number, source: VehicleLimit['source']): VehicleLimit =>
  a.limit === null || cap < a.limit ? { limit: cap, source } : a;

/**
 * เพดานรถ active ต่อเดือนที่มีผลกับ tenant
 * ค่าในสัญญา (`tenant.vehicle_quota`) → limit `veh` ของแพ็กเกจ · ทดลองใช้ = ไม่เกิน `trial.vehicleLimit` (20 — docs/02 §2) ·
 * รอยืนยันบริษัท = ไม่เกิน `pendingVerification.vehicleLimit` (spec/01 §9 [PROPOSED]) · sandbox ไม่ถูกนับ (PLT-071) → null
 */
/** `db` ต้องเป็น client ระดับแพลตฟอร์ม (อ่าน platform_setting / แคตตาล็อก) */
export async function resolveVehicleLimit(
  db: PrismaClient,
  tenantId: string,
): Promise<VehicleLimit> {
  const t = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { vehicleQuota: true, status: true, mode: true },
  });
  if (!t || t.mode !== 'live') return { limit: null, source: null };
  let out: VehicleLimit = { limit: null, source: null };
  if (t.vehicleQuota !== null) out = { limit: t.vehicleQuota, source: 'contract' };
  else {
    const veh = (await resolveEntitlements(db, tenantId)).veh?.limit ?? null;
    if (veh !== null) out = { limit: veh, source: 'plan' };
  }
  if (t.status === 'TRIALING')
    out = minLimit(out, await readPlatformSetting<number>(db, 'trial.vehicleLimit'), 'trial');
  else if (t.status === 'PENDING_VERIFICATION')
    out = minLimit(
      out,
      await readPlatformSetting<number>(db, 'pendingVerification.vehicleLimit'),
      'pending',
    );
  return out;
}

/** ระดับแจ้งเตือน (PLT-082) ที่ถึงแล้ว ณ used/limit — limit 0 = ถึง 100% ทันทีที่มีการใช้ */
export const QUOTA_ALERT_LEVELS = [80, 90, 100] as const;
export function reachedLevels(used: number, limit: number): number[] {
  if (limit <= 0) return used > 0 ? [...QUOTA_ALERT_LEVELS] : [];
  // เทียบแบบจำนวนเต็ม (ไม่ใช้ทศนิยม): used × 100 ≥ level × limit
  return QUOTA_ALERT_LEVELS.filter((l) => used * 100 >= l * limit);
}

/**
 * แพ็กเกจถัดไป (เรียงถูก → แพง) ที่รวมฟีเจอร์นี้และ limit มากกว่า `need` (null = ไม่จำกัด) — ใช้ใน dialog เสนออัปเกรด
 * ไม่มี = null (เช่น อยู่แพ็กเกจสูงสุดแล้ว → ติดต่อทีมขาย)
 */
export async function upgradePlanFor(
  db: Db,
  tenantId: string,
  featureKey: string,
  need: number,
): Promise<{ code: string; name: string; limit: number | null } | null> {
  const t = await db.tenant.findUnique({ where: { id: tenantId }, select: { planCode: true } });
  const order = PLANS.map((p) => p.code as string);
  const from = t ? order.indexOf(t.planCode) + 1 : 0;
  const cur = await currentPlanVersions(db);
  const ids = order.slice(from).flatMap((c) => (cur.get(c) ? [cur.get(c)!.id] : []));
  if (!ids.length) return null;
  const rows = await db.planEntitlement.findMany({
    where: { planVersionId: { in: ids }, featureKey, mode: 'included' },
  });
  for (const code of order.slice(from)) {
    const r = rows.find((x) => x.planVersionId === cur.get(code)?.id);
    if (r && (r.limit === null || r.limit > need)) {
      const p = PLANS.find((x) => x.code === code)!;
      return { code, name: p.nameTh, limit: r.limit };
    }
  }
  return null;
}

/**
 * hard limit (PLT-079): `used >= limit` → 409 `code` พร้อม featureKey / limit / used / upgradePlan
 * limit null = ไม่จำกัด (ไม่ตรวจ) · ผู้เรียกต้อง lock ก่อนนับถ้ามีการสร้างพร้อมกัน
 */
export async function assertHardLimit(
  db: Db,
  tenantId: string,
  code: 'connector_limit_reached' | 'webhook_limit_reached' | 'seat_limit_reached',
  featureKey: string,
  limit: number | null,
  used: number,
): Promise<void> {
  if (limit === null || used < limit) return;
  throw new ProblemException(code, undefined, undefined, {
    featureKey,
    limit,
    used,
    upgradePlan: await upgradePlanFor(db, tenantId, featureKey, used),
  });
}
