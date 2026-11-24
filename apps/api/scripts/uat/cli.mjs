#!/usr/bin/env node
/**
 * ST5-T25 ชุดเอกสารตัวอย่าง AR/AP แบบเบา (รวม ST6-T12) — ตัวเรียก (`pnpm --filter @tms/api uat:samples`)
 *
 * - ใช้ .env ของ worktree นี้ แต่สลับไปฐาน `<ฐาน lane>_uat` (เช่น lane me: tms_me → tms_me_uat) — ไม่แตะฐาน dev/test/e2e ของ lane
 * - **ปฏิเสธ** ถ้าฐาน dev เป็น `tms` (worktree หลัก) หรือไม่ใช่รูปแบบ `tms_<lane>` — ให้รันใน worktree ที่ตั้ง lane แล้ว
 *   (`bash scripts/lane-init.sh <lane> <portBase>`) เท่านั้น เพราะสคริปต์ลบ/สร้างฐาน `_uat` ใหม่ทุกครั้ง
 * - พอร์ต API ชั่วคราว = API_PORT + 10 (ตั้งเองได้: UAT_API_PORT) · ฟังเฉพาะ 127.0.0.1 · ปิดเองเมื่อจบ
 * - ไม่อยู่ใน `pnpm ci:local` · ไม่ส่งอีเมล/ข้อมูลออกนอกเครื่อง (EMAIL_TRANSPORT=log, MONITOR=off)
 * - ผล: `apps/api/.data/uat/ar-ap/` (PDF + manifest.json + manifest.md) — ไม่ commit (.data อยู่ใน .gitignore)
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
const laneDb = dbName(env.DATABASE_URL);
// กันพลาด: ต้องเป็นฐานของ lane (tms_<lane>) — ห้ามฐานหลัก `tms` และห้ามฐาน test/e2e/perf/uat
if (
  laneDb === 'tms' ||
  !/^tms_[a-z0-9]+$/.test(laneDb) ||
  /_(test|e2e|perf|uat|qa)$/.test(laneDb)
) {
  console.error(
    `uat:samples: ปฏิเสธฐาน "${laneDb}" — รันได้เฉพาะ worktree ที่ตั้ง lane แล้ว (bash scripts/lane-init.sh <lane> <portBase>)`,
  );
  process.exit(2);
}
const uatDb = `${laneDb}_uat`;
for (const k of ['DATABASE_URL', 'APP_DATABASE_URL', 'PLATFORM_DATABASE_URL']) {
  if (dbName(env[k]) !== laneDb) {
    console.error(`uat:samples: ${k} ไม่ได้ชี้ฐานเดียวกับ DATABASE_URL (${laneDb}) — ปฏิเสธ`);
    process.exit(2);
  }
  env[k] = withDb(env[k], uatDb);
}

const apiPort = Number(process.env.UAT_API_PORT ?? Number(env.API_PORT ?? 4410) + 10);
Object.assign(env, {
  NODE_ENV: 'development',
  API_PORT: String(apiPort),
  UAT_API_PORT: String(apiPort),
  UAT_DB: uatDb,
  FILES_ROOT: './.data/uat/files',
  MONITOR: 'off',
  EMAIL_TRANSPORT: 'log',
  HIBP_ENABLED: 'false',
  RATE_LIMIT: 'off',
  // ปิดต้นทุนเที่ยว (COMPLETED → COSTED) ปิดโดยค่าเริ่มต้น — ชุดนี้เปิดเพื่อสร้างใบสำคัญจ่ายรถร่วม (เหมือน test/settlements.test.ts)
  TRIP_COSTING_ENABLED: '1',
  SWC_NODE_PROJECT: 'tsconfig.json',
});

const r = spawnSync(
  process.execPath,
  ['-r', '@swc-node/register', resolve(here, 'ar-ap-sample-set.ts'), ...process.argv.slice(2)],
  { cwd: apiDir, env: { ...process.env, ...env }, stdio: 'inherit' },
);
process.exit(r.status ?? 1);
