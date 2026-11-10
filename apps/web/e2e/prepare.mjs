// เตรียมฐานข้อมูล tms_e2e (สร้าง → migrate → seed) และ token ของ tenant เดโม A ก่อนรัน Playwright
// แยกจากฐาน dev (tms) และ test (tms_test) — รันซ้ำได้: ล้างข้อมูลแล้ว seed ใหม่ทุกครั้ง
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
for (const k of ['DATABASE_URL', 'APP_DATABASE_URL', 'PLATFORM_DATABASE_URL'])
  env[k] = env[k].replace(/\/tms\?/, '/tms_e2e?');
const sh = (cmd, cwd = api) =>
  execSync(cmd, { cwd, env, stdio: 'pipe', encoding: 'utf8', shell: '/bin/bash' });

const { PrismaClient } = createRequire(api + '/package.json')('@prisma/client');
const admin = new PrismaClient({
  datasources: { db: { url: env.DATABASE_URL.replace('/tms_e2e?', '/postgres?') } },
});
if (
  (await admin.$queryRawUnsafe("SELECT 1 FROM pg_database WHERE datname = 'tms_e2e'")).length === 0
)
  await admin.$executeRawUnsafe('CREATE DATABASE tms_e2e');
await admin.$disconnect();
sh('npx prisma migrate deploy');
const owner = new PrismaClient({ datasources: { db: { url: env.DATABASE_URL } } });
const tables = await owner.$queryRawUnsafe(
  "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'",
);
if (tables.length)
  await owner.$executeRawUnsafe(
    `TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(', ')} CASCADE`,
  );
await owner.$disconnect();
sh('pnpm -s db:seed');
const token = sh(
  `SWC_NODE_PROJECT=tsconfig.json node -r @swc-node/register -e "require('./src/auth/auth.guard').signDevToken({sub:'e2e-admin',tid:'00000000-0000-4000-8000-00000000000a'},'2h').then(t=>console.log(t))"`,
).trim();
writeFileSync(
  new URL('./.env.e2e', import.meta.url),
  [
    'DATABASE_URL',
    'APP_DATABASE_URL',
    'PLATFORM_DATABASE_URL',
    'AUTH_DEV_SECRET',
    'FIELD_ENCRYPTION_KEYS',
  ]
    .map((k) => `${k}=${env[k]}`)
    .join('\n') + `\nVITE_DEV_TOKEN=${token}\n`,
);
console.log('e2e: database tms_e2e ready, token written');
