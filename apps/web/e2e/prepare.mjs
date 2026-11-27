// เตรียมฐานข้อมูล `<ฐาน dev>_e2e` เช่น tms_e2e (สร้าง → migrate → seed ผู้ใช้เดโม) ก่อนรัน Playwright — test login ผ่าน API จริง
// แยกจากฐาน dev (tms) และ test (tms_test) — รันซ้ำได้: ล้างข้อมูลแล้ว seed ใหม่ทุกครั้ง
// ชื่อฐานตามฐาน dev ใน DATABASE_URL ของ .env worktree นี้ (lane `tms_l2` → `tms_l2_e2e`) — ทำงานขนานหลาย worktree ได้ (HANDOFF §ทำงานขนาน)
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const root = new URL('../../../', import.meta.url).pathname;
const api = root + 'apps/api';
const env = { ...process.env };
try {
  for (const line of readFileSync(root + '.env', 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && !env[m[1]]) env[m[1]] = m[2];
  }
} catch {
  /* CI ตั้ง env เอง */
}
const dbName = (url) => decodeURIComponent(new URL(url).pathname.slice(1));
const withDb = (url, name) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};
const e2eDb = `${dbName(env.DATABASE_URL)}_e2e`;
for (const k of ['DATABASE_URL', 'APP_DATABASE_URL', 'PLATFORM_DATABASE_URL'])
  env[k] = withDb(env[k], e2eDb);
// กันล้าง/migrate ฐาน dev โดยไม่ตั้งใจ — ตรวจทันทีหลังเขียน env ใหม่
// ก่อน CREATE DATABASE / migrate: ใช้ได้เฉพาะฐานที่ชื่อลงท้าย _e2e / _test / _qa
for (const k of ['DATABASE_URL', 'APP_DATABASE_URL', 'PLATFORM_DATABASE_URL']) {
  const name = dbName(env[k]);
  if (!/^[a-z0-9_]+_(e2e|test|qa)$/.test(name))
    throw new Error(`prepare.mjs ปฏิเสธฐาน "${name}" (${k})`);
}
const sh = (cmd, cwd = api) =>
  execSync(cmd, { cwd, env, stdio: 'pipe', encoding: 'utf8', shell: '/bin/bash' });

const { PrismaClient } = createRequire(api + '/package.json')('@prisma/client');
const admin = new PrismaClient({
  datasources: { db: { url: withDb(env.DATABASE_URL, 'postgres') } },
});
if (
  (await admin.$queryRawUnsafe('SELECT 1 FROM pg_database WHERE datname = $1', e2eDb)).length === 0
)
  await admin.$executeRawUnsafe(`CREATE DATABASE "${e2eDb}"`);
await admin.$disconnect();
sh('pnpm -s db:migrate'); // ทางเดียวกับทุกที่: migrate + bootstrap tenant
const owner = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
const tables = await owner.$queryRawUnsafe(
  // แคตตาล็อกแพ็กเกจ (plan / plan_version / plan_entitlement / feature) มากับ migration 0175+ — ไม่ล้าง (เหมือน REFERENCE_TABLES ของ test API)
  "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> ALL(ARRAY['_prisma_migrations', 'plan', 'plan_version', 'plan_entitlement', 'feature'])",
);
if (tables.length)
  await owner.$executeRawUnsafe(
    `TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`,
  );
await owner.$disconnect();
sh('NODE_ENV=test pnpm -s db:seed'); // seed ต้องมี NODE_ENV ชัด ๆ (D-78 review) — ฐาน _e2e เท่านั้น
writeFileSync(
  new URL('./.env.e2e', import.meta.url),
  [
    'DATABASE_URL',
    'APP_DATABASE_URL',
    'PLATFORM_DATABASE_URL',
    'AUTH_DEV_SECRET',
    'FIELD_ENCRYPTION_KEYS',
    'BLIND_INDEX_KEY',
  ]
    .map((k) => `${k}=${env[k]}`)
    .join('\n') + '\n',
);
console.log(`e2e: database ${dbName(env.DATABASE_URL)} ready (ผู้ใช้เดโมจาก seed)`);
