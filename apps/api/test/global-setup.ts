import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { testEnv } from './env';

/** สร้างฐานข้อมูล tms_test (ถ้ายังไม่มี) แล้ว migrate ให้ล่าสุด — ทางเดียวกับทุกที่ (`db:migrate` = migrate + bootstrap tenant) */
export default async function setup() {
  const env = testEnv();
  const admin = new PrismaClient({
    datasources: { db: { url: env.DATABASE_URL!.replace('/tms_test?', '/postgres?') } },
  });
  const exists = await admin.$queryRaw<
    unknown[]
  >`SELECT 1 FROM pg_database WHERE datname = 'tms_test'`;
  if (exists.length === 0) await admin.$executeRawUnsafe('CREATE DATABASE tms_test');
  await admin.$disconnect();
  execSync('pnpm -s db:migrate', {
    cwd: resolve(__dirname, '..'),
    env: { ...process.env, ...env },
    stdio: 'pipe',
  });
  // ข้อมูลอ้างอิง (แพ็กเกจ) — test ล้างตาราง business แต่ไม่ล้างตารางนี้ ใส่ซ้ำเผื่อฐานเก่า
  const { ensurePlanCatalog } = await import('../src/modules/entitlements/plan-catalog');
  const plat = new PrismaClient({ datasources: { db: { url: env.PLATFORM_DATABASE_URL } } });
  await ensurePlanCatalog(plat);
  await plat.$disconnect();
}
