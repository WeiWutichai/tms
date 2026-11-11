import type { Prisma, PrismaClient, TenantStatus } from '@prisma/client';
import { ensureSystemRoles } from '../../auth/system-roles';
import { ensureDefaultSeries } from '../sequences/sequences.service';
import { SETTINGS, type SettingKey } from '../settings/registry';
import { ensureDefaultVehicleTypes } from '../vehicle-types/defaults';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * ค่าเริ่มต้นภาษาไทยพร้อมใช้ตอนสร้าง tenant (ST1-T20; docs/04 A5, K5 "ห้ามให้เราตั้งให้")
 * ขั้นทั้งหมดอยู่ในรายการ STEPS ที่เดียว (ไม่ลงทะเบียนตอน import — กันผู้เรียกบางทางได้ขั้นไม่ครบ)
 * stage ถัดไปเพิ่มขั้นของตัวเองที่นี่ (ST2: accessorial, reason) + แก้ test/bootstrap.test.ts
 * tenant ที่มีอยู่แล้วได้ขั้นใหม่จาก `pnpm --filter @tms/api db:migrate` (เรียก scripts/bootstrap-tenants.ts หลัง migrate)
 * รันซ้ำได้: ชุดเลขและค่าภาษีไม่ทับค่าที่ tenant แก้แล้ว · role ระบบถูก sync กลับเป็นค่าในโค้ดเสมอ
 * (role ระบบแก้จาก UI ไม่ได้ — spec/01 PLT-131)
 */
export interface BootstrapStep {
  name: string;
  run: (db: Db, tenantId: string) => Promise<void>;
}

/**
 * ค่าภาษี/วางบิลเขียนเป็นแถวจริงตอนสร้าง (snapshot) — ถ้าค่าเริ่มต้นใน registry เปลี่ยนภายหลัง
 * tenant เดิมไม่ถูกเปลี่ยนกฎภาษีเงียบ ๆ
 */
const SNAPSHOT_KEYS = (Object.keys(SETTINGS) as SettingKey[]).filter(
  (k) => k.startsWith('tax.') || k.startsWith('billing.'),
);

const STEPS: readonly BootstrapStep[] = [
  {
    name: 'system-roles',
    run: async (db, t) => void (await ensureSystemRoles(db as PrismaClient, t)),
  },
  { name: 'document-series', run: (db, t) => ensureDefaultSeries(db as PrismaClient, t) },
  {
    name: 'tax-billing-defaults',
    run: async (db, tenantId) => {
      for (const key of SNAPSHOT_KEYS)
        await db.tenantSetting.upsert({
          where: { tenantId_key: { tenantId, key } },
          create: {
            tenantId,
            key,
            value: SETTINGS[key].default as Prisma.InputJsonValue,
            updatedBy: 'bootstrap',
          },
          update: {},
        });
    },
  },
  // ST2-T04: ประเภทรถภาษาไทย 6 แบบ (spec/02 §4) — จำแถวด้วย system_key ไม่สร้างซ้ำ/ไม่ทับที่ผู้ใช้แก้
  { name: 'vehicle-types', run: (db, t) => ensureDefaultVehicleTypes(db, t) },
];

export function bootstrapSteps(): readonly BootstrapStep[] {
  return STEPS;
}

/** ใส่ค่าเริ่มต้นทุกขั้นให้ tenant (ใช้ client platform — ก่อนมีผู้ใช้/สิทธิ์ใน tenant) */
export async function bootstrapTenant(
  db: Db,
  tenantId: string,
  steps: readonly BootstrapStep[] = STEPS,
): Promise<void> {
  for (const s of steps) await s.run(db, tenantId);
}

/** สร้าง tenant + ค่าเริ่มต้นใน transaction เดียว (ล้มกลางทาง = ไม่มี tenant ครึ่ง ๆ — spec/01 PLT-025) */
export async function createTenantWithDefaults(
  db: PrismaClient,
  input: { name: string; status?: TenantStatus; yearStyle?: 'BE' | 'CE' },
  /** สำหรับ test เท่านั้น */
  steps: readonly BootstrapStep[] = STEPS,
) {
  return db.$transaction(
    async (tx) => {
      const t = await tx.tenant.create({
        data: {
          name: input.name,
          status: input.status ?? 'TRIAL',
          yearStyle: input.yearStyle ?? 'BE',
        },
      });
      await bootstrapTenant(tx, t.id, steps);
      return t;
    },
    { timeout: 30_000 },
  );
}
