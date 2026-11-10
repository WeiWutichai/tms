import type { PrismaClient } from '@prisma/client';

/**
 * แพ็กเกจ + feature matrix ตัวอย่าง (ST1-T18) — จาก design/prototype/plans.js (v3 · 1 ต.ค. 2569; ราคา/โควตายังไม่สรุป)
 * ข้อมูลชุดเดียวกับ migration 0015 — ใช้ซ้ำใน seed และ test (สร้างที่ขาด ไม่ทับค่าที่แก้จาก Console)
 */
export const PLANS = [
  { code: 'start', nameTh: 'เริ่มต้น', nameEn: 'Starter' },
  { code: 'std', nameTh: 'มาตรฐาน', nameEn: 'Standard' },
  { code: 'ent', nameTh: 'องค์กร', nameEn: 'Enterprise' },
];

/** [plan, feature, mode, limit] — limit null = ไม่จำกัด */
export const PLAN_ENTITLEMENTS: Array<
  [string, string, 'included' | 'addon' | 'not_available', number | null]
> = [
  ['start', 'so', 'included', null],
  ['std', 'so', 'included', null],
  ['ent', 'so', 'included', null],
  ['start', 'plan', 'included', null],
  ['std', 'plan', 'included', null],
  ['ent', 'plan', 'included', null],
  ['start', 'driver', 'included', null],
  ['std', 'driver', 'included', null],
  ['ent', 'driver', 'included', null],
  ['start', 'trips', 'included', null],
  ['std', 'trips', 'included', null],
  ['ent', 'trips', 'included', null],
  ['start', 'sub', 'not_available', null],
  ['std', 'sub', 'included', null],
  ['ent', 'sub', 'included', null],
  ['start', 'track', 'not_available', null],
  ['std', 'track', 'included', null],
  ['ent', 'track', 'included', null],
  ['start', 'exc', 'not_available', null],
  ['std', 'exc', 'included', null],
  ['ent', 'exc', 'included', null],
  ['start', 'bill', 'included', null],
  ['std', 'bill', 'included', null],
  ['ent', 'bill', 'included', null],
  ['start', 'settle', 'not_available', null],
  ['std', 'settle', 'included', null],
  ['ent', 'settle', 'included', null],
  ['start', 'adv', 'included', null],
  ['std', 'adv', 'included', null],
  ['ent', 'adv', 'included', null],
  ['start', 'conn', 'not_available', null],
  ['std', 'conn', 'included', 1],
  ['ent', 'conn', 'included', null],
  ['start', 'multi', 'not_available', null],
  ['std', 'multi', 'not_available', null],
  ['ent', 'multi', 'included', null],
  ['start', 'fleet', 'not_available', null],
  ['std', 'fleet', 'included', null],
  ['ent', 'fleet', 'included', null],
  ['start', 'fleetx', 'not_available', null],
  ['std', 'fleetx', 'addon', null],
  ['ent', 'fleetx', 'included', null],
  ['start', 'report', 'not_available', null],
  ['std', 'report', 'included', null],
  ['ent', 'report', 'included', null],
  ['start', 'portal', 'not_available', null],
  ['std', 'portal', 'addon', null],
  ['ent', 'portal', 'included', null],
  ['start', 'api', 'not_available', null],
  ['std', 'api', 'included', 300],
  ['ent', 'api', 'included', 1000],
  ['start', 'webhook', 'not_available', null],
  ['std', 'webhook', 'included', 3],
  ['ent', 'webhook', 'included', null],
  ['start', 'cf', 'included', 5],
  ['std', 'cf', 'included', 20],
  ['ent', 'cf', 'included', null],
  ['start', 'veh', 'included', 20],
  ['std', 'veh', 'included', 80],
  ['ent', 'veh', 'included', null],
  ['start', 'users', 'included', null],
  ['std', 'users', 'included', null],
  ['ent', 'users', 'included', null],
];

export async function ensurePlanCatalog(db: PrismaClient) {
  for (const p of PLANS) await db.plan.upsert({ where: { code: p.code }, create: p, update: {} });
  for (const [planCode, featureKey, mode, limit] of PLAN_ENTITLEMENTS)
    await db.planEntitlement.upsert({
      where: { planCode_featureKey: { planCode, featureKey } },
      create: { planCode, featureKey, mode, limit },
      update: {},
    });
}
