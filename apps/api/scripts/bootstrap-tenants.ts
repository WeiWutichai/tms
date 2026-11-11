/**
 * ใส่ค่าเริ่มต้นของ tenant (bootstrap ทุกขั้น) ให้ tenant ที่มีอยู่แล้วทุกราย — รันซ้ำได้ (ทุกขั้น idempotent)
 * แก้ปัญหา "tenant เดิมไม่ได้ค่าเริ่มต้นใหม่" (PROGRESS: role ระบบ/สิทธิ์ใหม่ ST1-T19, ประเภทรถ ST2-T04 …)
 * `pnpm --filter @tms/api db:migrate` เรียกต่อจาก `prisma migrate deploy` อัตโนมัติ · เรียกเองได้: `pnpm --filter @tms/api tenants:bootstrap`
 * ต่อฐานด้วย PLATFORM_DATABASE_URL (BYPASSRLS) — ไม่มี = DATABASE_URL · ไม่ได้ตั้ง env = อ่านจาก .env ที่ราก repo
 * tenant ละ 1 transaction: ล้มรายใด = รายนั้นไม่เปลี่ยนเลย แล้วจบด้วย exit 1 (deploy แดง)
 */
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootstrapTenant } from '../src/modules/tenants/bootstrap';

function loadRootEnv() {
  try {
    for (const line of readFileSync(join(__dirname, '../../../.env'), 'utf8').split('\n')) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2];
    }
  } catch {
    /* CI/production ตั้ง env เอง */
  }
}

async function main() {
  loadRootEnv();
  const url = process.env.PLATFORM_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('PLATFORM_DATABASE_URL or DATABASE_URL required');
  const db = new PrismaClient({ datasources: { db: { url } } });
  let failed = 0;
  try {
    const tenants = await db.tenant.findMany({
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    for (const t of tenants) {
      try {
        await db.$transaction((tx) => bootstrapTenant(tx, t.id), { timeout: 60_000 });
      } catch (e) {
        failed++;
        console.error(`bootstrap ${t.id} failed:`, e instanceof Error ? e.message : e);
      }
    }
    console.log(`tenants:bootstrap — ${tenants.length - failed}/${tenants.length} tenant OK`);
  } finally {
    await db.$disconnect();
  }
  if (failed) process.exit(1);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
