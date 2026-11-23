#!/usr/bin/env node
/**
 * ST9-T17 ทดสอบประสิทธิภาพ — ตัวเรียก (`pnpm --filter @tms/api perf [seed|run|all] [-- flags]`)
 *
 * - ใช้ .env ของ worktree นี้ แต่สลับไปฐาน `<ฐาน dev>_perf` (เช่น tms → tms_perf · lane tms_l2 → tms_l2_perf) — ไม่แตะฐาน dev/test/e2e
 * - พอร์ต: API = API_PORT + 2 · ตัวรับ webhook (ในเครื่อง) = API_PORT + 3 (ตั้งเองได้: PERF_API_PORT / PERF_RECEIVER_PORT)
 * - ไม่อยู่ใน `pnpm ci:local` (ใช้เวลาหลายนาที + ผลขึ้นกับโหลดของเครื่อง) — รันเองเมื่อเครื่องว่าง
 *
 *   seed  ลบ/สร้างฐาน perf ใหม่ → migrate → ข้อมูลตั้งต้น (ผลเท่าเดิมทุกครั้ง)
 *   run   วัดผล (ต้อง seed ก่อน — การวัด finalize / invoice run ใช้ข้อมูลหมดไป จึงรันซ้ำ = seed ใหม่)
 *   all   seed แล้ว run (ค่าเริ่ม)
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const apiDir = resolve(here, '../..');
const root = resolve(apiDir, '../..');

const env = {};
for (const line of readFileSync(resolve(root, '.env'), 'utf8').split('\n')) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}
const dbName = (url) => decodeURIComponent(new URL(url).pathname.slice(1));
const withDb = (url, name) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};
const perfDb = `${dbName(env.DATABASE_URL)}_perf`;
// กันพลาด: ทุก connection string ต้องชี้ฐาน *_perf เท่านั้น (seed ลบฐานนี้ทิ้งแล้วสร้างใหม่)
if (!/^[a-z0-9_]+_perf$/.test(perfDb)) {
  console.error(`perf: ปฏิเสธฐาน "${perfDb}"`);
  process.exit(2);
}
for (const k of ['DATABASE_URL', 'APP_DATABASE_URL', 'PLATFORM_DATABASE_URL'])
  env[k] = withDb(env[k], perfDb);

const apiPort = Number(process.env.PERF_API_PORT ?? Number(env.API_PORT ?? 4410) + 2);
const receiverPort = Number(process.env.PERF_RECEIVER_PORT ?? apiPort + 1);
Object.assign(env, {
  NODE_ENV: 'development',
  API_PORT: String(apiPort),
  PERF_API_PORT: String(apiPort),
  PERF_RECEIVER_PORT: String(receiverPort),
  PERF_DB: perfDb,
  // ตัวรับ webhook อยู่ในเครื่อง (http://127.0.0.1) — dev/test เท่านั้น
  WEBHOOK_ALLOW_PRIVATE_TARGETS: '1',
  // ไฟล์ (PDF) ของการวัด แยกจากไฟล์ dev
  FILES_ROOT: './.data/perf/files',
  // ไม่ส่ง alert/probe ระหว่างวัด (ไม่ใช่เส้นทางของคำขอ)
  MONITOR: 'off',
  EMAIL_TRANSPORT: 'log',
  HIBP_ENABLED: 'false',
  SWC_NODE_PROJECT: 'tsconfig.json',
});

const [cmd = 'all', ...rest] = process.argv.slice(2).filter((a) => a !== '--');
const script = (name, args) => {
  const r = spawnSync(
    process.execPath,
    ['-r', '@swc-node/register', resolve(here, `${name}.ts`), ...args],
    { cwd: apiDir, env: { ...process.env, ...env }, stdio: 'inherit' },
  );
  if (r.status !== 0) process.exit(r.status ?? 1);
};
if (cmd === 'seed') script('seed', rest);
else if (cmd === 'run') script('run', rest);
else if (cmd === 'all') {
  script('seed', []);
  script('run', rest);
} else {
  console.error(
    'ใช้: pnpm --filter @tms/api perf [seed|run|all] [--force] [--only=lists,mixed,webhook,finalize,run,web] [--web] [--max-load=8] [--abort-load=12]',
  );
  process.exit(2);
}
