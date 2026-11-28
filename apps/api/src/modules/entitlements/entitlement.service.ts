import { Injectable } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@prisma/client';
import { Clock } from '../../common/clock';
import { PrismaService } from '../../db/prisma.service';
import {
  addOnLayer,
  nextExpiry,
  overrideLayer,
  planLayer,
  statusLayer,
  type AddOnGrant,
  type Entitlements,
} from './entitlement-layers';
import { ProblemException } from '../../common/problem';
import { currentPlanVersion, currentPlanVersions, PLANS } from './plan-catalog';
import { assertHardLimit, resolveVehicleLimit, type VehicleLimit } from './quota';

/** tier ของ docs/02 §3.1 → รหัสแพ็กเกจ (plan-catalog: Growth = `std`) */
const TIER_PLAN = { growth: 'std' } as const;

/**
 * Feature flag ตามแพ็กเกจ (ST1-T18 → P1-ST1-T02 ฉบับเต็ม; docs/04 A5; spec/01 PLT-062, 076–078)
 * ที่มีผล = PlanEntitlement(เวอร์ชันของ subscription — P1-ST1-T01; ไม่มี subscription = เวอร์ชันที่มีผลของ plan_code)
 *   → add-on (`AddOnSource` — ตารางของ P1-ST4-T04; ตอนนี้ไม่มี = NO_ADD_ONS) → override ที่ยังไม่หมดอายุ (grant / revoke / set_limit)
 *   → ตัดตามสถานะ tenant (ตาราง 1.6) — ลำดับและกฎของแต่ละชั้นอยู่ใน `entitlement-layers.ts`
 * cache 60 วินาทีต่อ tenant (หรือสั้นกว่า: ถึงเวลาที่ override/add-on หมดอายุ) · ล้างด้วย invalidate เมื่อเปลี่ยนจาก Console
 * instance อื่น (API ตัวอื่น / worker) หมดอายุเองภายใน 60 วิ → เปลี่ยนสิทธิ์แล้วมีผลทุก instance ภายใน 60 วิ (เกณฑ์ตรวจรับ P1-ST1-T02)
 */
export type { Entitlement, Entitlements } from './entitlement-layers';

/** อายุ cache (spec/01 PLT-062) */
export const ENTITLEMENT_TTL_MS = 60_000;

type Db = PrismaClient | Prisma.TransactionClient;

/** แหล่ง add-on ที่ซื้อแล้วของ tenant — P1-ST4-T04 (ตาราง `subscription_add_on`) ใส่ตัวจริงแทน NO_ADD_ONS */
export interface AddOnSource {
  active(db: Db, tenantId: string, now: Date): Promise<AddOnGrant[]>;
}
/** ยังไม่มีตาราง add-on (P1-ST4-T04) — ไม่มี add-on ใด */
export const NO_ADD_ONS: AddOnSource = { active: async () => [] };

export interface EntitlementDetail {
  /** ผลสุดท้าย (หลังตัดตามสถานะ) — ใช้ gate API/job */
  effective: Entitlements;
  /** ผลก่อนตัดตามสถานะ — ใช้ตัดสิน 🔒 "ไม่รวมในแพ็กเกจ" (PLT-076) */
  beforeStatus: Entitlements;
  /** เซลล์ของแพ็กเกจปัจจุบัน (included / addon / not_available) — หน้า locked เลือกปุ่ม "อัปเกรด" หรือ "ซื้อ Add-on" */
  planModes: Record<string, string>;
  /** ฟีเจอร์พื้นฐาน (isBasic) — ไม่ขึ้น 🔒 ทุกกรณี (PLT-077) */
  basic: string[];
  /** override/add-on ที่จะหมดอายุเร็วที่สุด (null = ไม่มี) */
  nextExpiry: Date | null;
}

const EMPTY: EntitlementDetail = {
  effective: {},
  beforeStatus: {},
  planModes: {},
  basic: [],
  nextExpiry: null,
};

export async function resolveEntitlementDetail(
  db: Db,
  tenantId: string,
  now: Date = new Date(),
  addOns: AddOnSource = NO_ADD_ONS,
): Promise<EntitlementDetail> {
  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    select: { planCode: true, status: true, mode: true, liveTenantId: true },
  });
  // ST7-T09: sandbox ใช้แพ็กเกจ/override/สถานะของบริษัทจริงเสมอ (บริษัทถูกระงับ → sandbox ไม่มีฟีเจอร์ใดทำงาน)
  if (tenant?.mode === 'test' && tenant.liveTenantId)
    return resolveEntitlementDetail(db, tenant.liveTenantId, now, addOns);
  if (!tenant) return EMPTY;
  // P1-ST1-T01: ลูกค้าอยู่บนเวอร์ชันของ subscription (grandfather — PLT-060) แม้มีเวอร์ชันใหม่กว่า
  // tenant.planCode เป็นตัวบอกแพ็กเกจ · subscription ปักเวอร์ชันภายในแพ็กเกจนั้น — ถ้าไม่ตรงกัน (plan_code ถูกแก้ไม่ผ่าน
  // moveSubscriptionPlan เช่น SQL/test ตรง) → ใช้เวอร์ชันที่มีผลของ planCode (ไม่ให้สิทธิ์ของแพ็กเกจเก่าค้าง)
  const sub = await db.subscription.findUnique({
    where: { tenantId },
    select: { planVersionId: true, planVersion: { select: { planCode: true } } },
  });
  const versionId =
    sub && sub.planVersion.planCode === tenant.planCode
      ? sub.planVersionId
      : (await currentPlanVersion(db, tenant.planCode))?.id;
  const current = [...(await currentPlanVersions(db)).values()].map((v) => v.id);
  const [rows, overrides, all, features, bought] = await Promise.all([
    versionId ? db.planEntitlement.findMany({ where: { planVersionId: versionId } }) : [],
    db.tenantEntitlementOverride.findMany({
      where: { tenantId, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    }),
    db.planEntitlement.findMany({ where: { mode: 'included', planVersionId: { in: current } } }),
    db.feature.findMany({ select: { key: true, type: true, isBasic: true } }),
    addOns.active(db, tenantId, now),
  ]);
  /** grant ที่ไม่ระบุ limit บนฟีเจอร์ที่แพ็กเกจไม่มี → ใช้ limit สูงสุดที่มีในแพ็กเกจใดแพ็กเกจหนึ่ง (เวอร์ชันที่มีผล — ไม่ใช่ไม่จำกัด) */
  const grantLimit = (key: string) => {
    const lim = all
      .filter((r) => r.featureKey === key && r.limit !== null)
      .map((r) => r.limit as number);
    return lim.length ? Math.max(...lim) : null; // ไม่มีแพ็กเกจไหนกำหนด limit = ฟีเจอร์แบบเปิด/ปิด
  };
  const limitTyped = new Set(features.filter((f) => f.type !== 'boolean').map((f) => f.key));
  const beforeStatus = overrideLayer(
    addOnLayer(planLayer(rows), bought, limitTyped, now),
    overrides,
    grantLimit,
    now,
  );
  return {
    effective: statusLayer(beforeStatus, tenant.status),
    beforeStatus,
    planModes: Object.fromEntries(rows.map((r) => [r.featureKey, r.mode])),
    basic: features.filter((f) => f.isBasic).map((f) => f.key),
    nextExpiry: nextExpiry(overrides, bought, now),
  };
}

/** ผลสุดท้ายอย่างเดียว (ที่เดิมของ ST1-T18) */
export async function resolveEntitlements(
  db: Db,
  tenantId: string,
  now: Date = new Date(),
): Promise<Entitlements> {
  return (await resolveEntitlementDetail(db, tenantId, now)).effective;
}

@Injectable()
export class EntitlementService {
  private readonly cache = new Map<string, { until: number; value: EntitlementDetail }>();
  private addOns: AddOnSource = NO_ADD_ONS;
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  /** P1-ST4-T04: ตั้งแหล่ง add-on จริง (ล้าง cache) */
  useAddOnSource(src: AddOnSource): void {
    this.addOns = src;
    this.cache.clear();
  }

  /** ST7-T09 sandbox → บริษัทจริง (แก้ไม่ได้หลังสร้าง — cache ถาวร) · live = ตัวเอง */
  private readonly liveOf = new Map<string, string>();

  private async live(tenantId: string): Promise<string> {
    let live = this.liveOf.get(tenantId);
    if (!live) {
      const t = await this.prisma.platform.tenant.findUnique({
        where: { id: tenantId },
        select: { liveTenantId: true },
      });
      live = t?.liveTenantId ?? tenantId;
      if (t) this.liveOf.set(tenantId, live);
    }
    return live;
  }

  /** ผลเต็มทุกชั้น (cache เดียวกับ resolve) */
  async detail(tenantId: string): Promise<EntitlementDetail> {
    // sandbox ใช้ cache ของบริษัทจริงตัวเดียวกัน → invalidate(บริษัทจริง) มีผลกับ sandbox ทันที (ระงับ/เปลี่ยนแพ็กเกจ)
    const live = await this.live(tenantId);
    const now = this.clock.now();
    const hit = this.cache.get(live);
    if (hit && now.getTime() < hit.until) return hit.value;
    const value = await resolveEntitlementDetail(this.prisma.platform, live, now, this.addOns);
    // override/add-on หมดอายุก่อน 60 วิ → cache หมดตรงเวลานั้น (spec/01 §6 ข้อ 8: ล็อกในรอบ cache ถัดไป)
    const ttlEnd = now.getTime() + ENTITLEMENT_TTL_MS;
    const until = value.nextExpiry ? Math.min(ttlEnd, value.nextExpiry.getTime()) : ttlEnd;
    this.cache.set(live, { until, value });
    return value;
  }

  async resolve(tenantId: string): Promise<Entitlements> {
    return (await this.detail(tenantId)).effective;
  }

  async enabled(tenantId: string, feature: string): Promise<boolean> {
    return (await this.resolve(tenantId))[feature]?.enabled === true;
  }

  /** P1-ST1-T08 hard limit (PLT-079) — limit ของฟีเจอร์ตามแพ็กเกจ + override · `used >= limit` → 409 `code` + upgradePlan */
  async assertLimit(
    tenantId: string,
    code: Parameters<typeof assertHardLimit>[2],
    featureKey: string,
    used: number,
  ): Promise<void> {
    const limit = (await this.resolve(tenantId))[featureKey]?.limit ?? null;
    await assertHardLimit(this.prisma.platform, tenantId, code, featureKey, limit, used);
  }

  /** P1-ST1-T08 เพดานรถ active ของเดือน (soft limit — PLT-080) */
  async vehicleLimit(tenantId: string): Promise<VehicleLimit> {
    // memo ต่อ tenant (TTL เดียวกับ entitlement) — refreshWarnings เรียกทุกการกระทำบนเที่ยว (review N6)
    const hit = this.vehLimit.get(tenantId);
    if (hit && Date.now() - hit.at < ENTITLEMENT_TTL_MS) return hit.value;
    const value = await resolveVehicleLimit(this.prisma.platform, tenantId);
    this.vehLimit.set(tenantId, { at: Date.now(), value });
    return value;
  }
  private readonly vehLimit = new Map<string, { at: number; value: VehicleLimit }>();

  /**
   * สิทธิ์ใช้ connector ที่ catalog ประกาศ feature + แพ็กเกจขั้นต่ำ (docs/02 §3.1: FlowAccount/PEAK ต่ำสุด Growth)
   * - feature ต้องเปิด (หลัง add-on/override/สถานะ)
   * - minTier: แพ็กเกจปัจจุบันต้องอยู่ลำดับ ≥ tier (ลำดับ `PLANS` — Growth = `std`) · ยกเว้นได้สิทธิ์ผ่าน add-on/override
   *   (แพ็กเกจเองไม่รวม แต่ทีมงานเปิดให้ — R-09: add-on connector เปิดโดย Innovera)
   * ไม่ผ่าน → 403 `feature_not_in_plan` + `featureKey` (+ `minTier`)
   */
  async assertConnector(
    tenantId: string,
    req: { feature: string; minTier: 'growth' | null },
  ): Promise<void> {
    const d = await this.detail(tenantId);
    const deny = () =>
      new ProblemException('feature_not_in_plan', undefined, undefined, {
        featureKey: req.feature,
        ...(req.minTier ? { minTier: req.minTier } : {}),
      });
    if (!d.effective[req.feature]?.enabled) throw deny();
    if (!req.minTier || d.planModes[req.feature] !== 'included') return;
    const live = await this.live(tenantId);
    const t = await this.prisma.platform.tenant.findUnique({
      where: { id: live },
      select: { planCode: true },
    });
    const order = PLANS.map((p) => p.code as string);
    const rank = t ? order.indexOf(t.planCode) : -1;
    if (rank < order.indexOf(TIER_PLAN[req.minTier])) throw deny();
  }

  invalidate(tenantId?: string) {
    if (tenantId) {
      this.cache.delete(tenantId);
      this.vehLimit.delete(tenantId);
    } else {
      this.cache.clear();
      this.vehLimit.clear();
    }
  }

  /** tenant ทั้งหมดที่เปิดฟีเจอร์นี้ — ใช้ใน scheduler/cron ให้ข้าม tenant ที่ปิด (A5 "ตรวจซ้ำใน cron job") */
  async tenantsWith(feature: string, tenantIds: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const t of tenantIds) if (await this.enabled(t, feature)) out.push(t);
    return out;
  }
}

/** แพ็กเกจแรก (เรียงตามลำดับในแคตตาล็อก) ที่รวมฟีเจอร์นี้ในเวอร์ชันที่มีผล — ใช้บอกในหน้า "ไม่รวมในแพ็กเกจ" (PLT-076) */
export async function cheapestPlanWith(db: PrismaClient, order: string[]) {
  const cur = await currentPlanVersions(db);
  const rows = await db.planEntitlement.findMany({
    where: { mode: 'included', planVersionId: { in: [...cur.values()].map((v) => v.id) } },
  });
  const codeOf = new Map([...cur.values()].map((v) => [v.id, v.planCode]));
  const out: Record<string, string> = {};
  for (const code of order)
    for (const r of rows)
      if (codeOf.get(r.planVersionId) === code && !(r.featureKey in out)) out[r.featureKey] = code;
  return out;
}
