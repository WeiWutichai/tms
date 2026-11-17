import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DB_KEYS = ['DATABASE_URL', 'APP_DATABASE_URL', 'PLATFORM_DATABASE_URL'] as const;

/** ชื่อฐานจาก connection string (ไม่สน query string) */
export function dbName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.slice(1));
}

/** connection string เดิมแต่เปลี่ยนชื่อฐาน (คง user/host/port/query ไว้) */
export function withDb(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

/**
 * env สำหรับ test: ใช้ค่าจาก .env ของ worktree นี้ แต่สลับไปฐาน `<ฐาน dev>_test`
 * (ฐาน dev `tms` → `tms_test` · lane `tms_l2` → `tms_l2_test` — ทำงานขนานหลาย worktree ได้ ดู HANDOFF §ทำงานขนาน)
 */
export function testEnv(): Record<string, string> {
  const raw = readFileSync(resolve(__dirname, '../../../.env'), 'utf8');
  const env: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]!] = m[2]!;
  }
  const test = `${dbName(env.DATABASE_URL!)}_test`;
  for (const k of DB_KEYS) if (env[k]) env[k] = withDb(env[k]!, test);
  env.NODE_ENV = 'test';
  return env;
}
