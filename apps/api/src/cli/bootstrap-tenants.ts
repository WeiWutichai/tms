/**
 * ใส่ค่าเริ่มต้นของ tenant (bootstrap ทุกขั้น) ให้ tenant ที่มีอยู่แล้วทุกราย — รันซ้ำได้ (ทุกขั้น idempotent)
 * แก้ปัญหา "tenant เดิมไม่ได้ค่าเริ่มต้นใหม่" (PROGRESS: role ระบบ/สิทธิ์ใหม่ ST1-T19, ประเภทรถ ST2-T04 …)
 *
 * ทางเดียวของการ migrate ทุกที่ = `pnpm --filter @tms/api db:migrate` (`prisma migrate deploy` แล้วตามด้วยไฟล์นี้)
 * — dev/ci-local/test global-setup/e2e prepare/CI ใช้ตัวเดียวกัน · production (image ที่ build แล้ว):
 *   `prisma migrate deploy && node dist/cli/bootstrap-tenants.js` (= `db:migrate:prod` — ไม่ต้องใช้ @swc-node)
 *
 * ฐานข้อมูล: ต่อด้วย PLATFORM_DATABASE_URL (role ต้อง BYPASSRLS) และต้องเป็น host/port/ฐานเดียวกับ DATABASE_URL
 * (ฐานที่เพิ่ง migrate) — ไม่ตรง/ไม่มีสิทธิ์ = จบด้วย exit 1 (ไม่เงียบ) · ไม่ได้ตั้ง env = อ่าน .env ที่ราก repo
 * นับ tenant ด้วยทั้งสอง connection: platform เห็นน้อยกว่า owner = ถูก RLS ซ่อน → exit 1
 * tenant ละ 1 transaction (ตั้ง app.tenant_id ด้วย — ทำงานได้แม้ภายหลังเปลี่ยนเป็น role ที่ไม่ bypass)
 */
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bootstrapTenant } from '../modules/tenants/bootstrap';

function loadRootEnv() {
  for (const p of [join(process.cwd(), '.env'), join(process.cwd(), '../../.env')]) {
    try {
      for (const line of readFileSync(p, 'utf8').split('\n')) {
        const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2];
      }
      return;
    } catch {
      /* ไม่มีไฟล์ — CI/production ตั้ง env เอง */
    }
  }
}

/** host:port/ฐาน ของ connection string (ไม่สน user/password/query) */
export function dbTarget(url: string): string {
  const u = new URL(url);
  return `${u.hostname}:${u.port || '5432'}${u.pathname}`;
}

export interface BootstrapAllResult {
  total: number;
  ok: number;
  failed: { tenantId: string; error: string }[];
}

export async function bootstrapAllTenants(env: {
  platformUrl: string;
  ownerUrl?: string;
}): Promise<BootstrapAllResult> {
  if (env.ownerUrl && dbTarget(env.ownerUrl) !== dbTarget(env.platformUrl))
    throw new Error(
      `PLATFORM_DATABASE_URL (${dbTarget(env.platformUrl)}) ไม่ใช่ฐานเดียวกับ DATABASE_URL (${dbTarget(env.ownerUrl)})`,
    );
  const db = new PrismaClient({ datasources: { db: { url: env.platformUrl } } });
  try {
    const [role] = await db.$queryRaw<{ ok: boolean }[]>`
      SELECT (rolbypassrls OR rolsuper) AS ok FROM pg_roles WHERE rolname = current_user`;
    if (!role?.ok)
      throw new Error('role ของ PLATFORM_DATABASE_URL ต้องมี BYPASSRLS (มองเห็นทุก tenant)');
    const tenants = await db.tenant.findMany({
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    if (env.ownerUrl) {
      const owner = new PrismaClient({ datasources: { db: { url: env.ownerUrl } } });
      try {
        const [c] = await owner.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM tenant`;
        if (Number(c?.n ?? 0) > tenants.length)
          throw new Error(
            `เห็น tenant ${tenants.length} ราย แต่ฐานมี ${Number(c?.n)} ราย — connection ถูก RLS ซ่อนข้อมูล`,
          );
      } finally {
        await owner.$disconnect();
      }
    }
    const failed: BootstrapAllResult['failed'] = [];
    for (const t of tenants) {
      try {
        await db.$transaction(
          async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.tenant_id', ${t.id}, true)`;
            await bootstrapTenant(tx, t.id);
          },
          { timeout: 60_000 },
        );
      } catch (e) {
        failed.push({ tenantId: t.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { total: tenants.length, ok: tenants.length - failed.length, failed };
  } finally {
    await db.$disconnect();
  }
}

async function main() {
  loadRootEnv();
  const platformUrl = process.env.PLATFORM_DATABASE_URL;
  if (!platformUrl) throw new Error('PLATFORM_DATABASE_URL required');
  const r = await bootstrapAllTenants({
    platformUrl,
    ...(process.env.DATABASE_URL ? { ownerUrl: process.env.DATABASE_URL } : {}),
  });
  for (const f of r.failed) console.error(`bootstrap ${f.tenantId} failed: ${f.error}`);
  console.log(`tenants:bootstrap — ${r.ok}/${r.total} tenant OK (${dbTarget(platformUrl)})`);
  if (r.failed.length) process.exit(1);
}

if (require.main === module)
  void main().catch((e: unknown) => {
    console.error(`tenants:bootstrap ล้ม: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
