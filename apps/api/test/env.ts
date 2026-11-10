import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** env สำหรับ test: ใช้ค่าจาก .env แต่สลับไปฐานข้อมูล tms_test */
export function testEnv(): Record<string, string> {
  const raw = readFileSync(resolve(__dirname, '../../../.env'), 'utf8');
  const env: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]!] = m[2]!;
  }
  for (const k of ['DATABASE_URL', 'APP_DATABASE_URL', 'PLATFORM_DATABASE_URL']) {
    if (env[k]) env[k] = env[k]!.replace(/\/tms\?/, '/tms_test?');
  }
  env.NODE_ENV = 'test';
  return env;
}
