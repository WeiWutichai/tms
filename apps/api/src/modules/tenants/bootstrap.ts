import type { Prisma, PrismaClient, TenantStatus } from '@prisma/client';
import { ensureSystemRoles } from '../../auth/system-roles';
import { ensureDefaultSeries } from '../sequences/sequences.service';
import { SETTINGS, type SettingKey } from '../settings/registry';

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * ค่าเริ่มต้นภาษาไทยพร้อมใช้ตอนสร้าง tenant (ST1-T20; docs/04 A5, K5 "ห้ามให้เราตั้งให้")
 * ลำดับขั้นเป็น registry — stage ถัดไปเพิ่มขั้นของตัวเอง (ST2: ประเภทรถ, accessorial, reason) ด้วย `registerBootstrapStep`
 * ทุกขั้นรันซ้ำได้ (ไม่ทับค่าที่ tenant แก้แล้ว)
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

const STEPS: BootstrapStep[] = [
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
];

export function registerBootstrapStep(step: BootstrapStep) {
  if (STEPS.some((s) => s.name === step.name))
    throw new Error(`bootstrap step '${step.name}' exists`);
  STEPS.push(step);
}

export function bootstrapSteps(): readonly BootstrapStep[] {
  return STEPS;
}

/** ใส่ค่าเริ่มต้นทุกขั้นให้ tenant (ใช้ client platform — ก่อนมีผู้ใช้/สิทธิ์ใน tenant) */
export async function bootstrapTenant(db: Db, tenantId: string): Promise<void> {
  for (const s of STEPS) await s.run(db, tenantId);
}

/** สร้าง tenant + ค่าเริ่มต้นใน transaction เดียว (ล้มกลางทาง = ไม่มี tenant ครึ่ง ๆ — spec/01 PLT-025) */
export async function createTenantWithDefaults(
  db: PrismaClient,
  input: { name: string; status?: TenantStatus; yearStyle?: 'BE' | 'CE' },
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
      await bootstrapTenant(tx, t.id);
      return t;
    },
    { timeout: 30_000 },
  );
}
