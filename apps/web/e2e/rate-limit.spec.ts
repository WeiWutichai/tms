import type { Response } from '@playwright/test';
import { expect, test } from './fixtures';

/**
 * E2E ST7-T08 rate limit (docs/04 G1/J) — UI ใช้ `/v1` ชุดเดียวกับลูกค้า จึงโดนเพดานเดียวกัน (API-first)
 * ชุด E2E ทั้งหมดรันโดยเปิดตัวจำกัด (`RATE_LIMIT=on` ใน playwright.config) · spec นี้เดินหน้าหลักต่อเนื่องเร็ว ๆ
 * (รวมกระดานวางแผนที่ poll) แล้วตรวจว่าไม่มีคำขอใดได้ 429 และ response มี header `RateLimit-*`
 */
test('ใช้งานหน้าหลักต่อเนื่องไม่ชนเพดาน (ไม่มี 429) · response มี RateLimit-*', async ({
  page,
}) => {
  // เดิน 11 หน้าแบบโหลดใหม่ทั้งหน้า (page.goto = บูตแอป + ต่ออายุ token + ดึงข้อมูลหน้า) รอ networkidle ทุกหน้า + ค้างบนกระดาน 5 วิ
  // วัดจริง: เครื่องว่าง ~15 วิ · ci:local ที่มี lane อื่นรันขนาน (load > 10) 25–32 วิ → ชนเพดาน 30 วิ ของ test ทั้งที่ไม่มี 429
  // spec นี้ตรวจเพดานคำขอ ไม่ได้ตรวจความเร็ว — ให้เวลาตามจำนวนหน้า
  test.setTimeout(60_000);
  const seen: Response[] = [];
  page.on('response', (r) => {
    if (new URL(r.url()).pathname.startsWith('/v1/')) seen.push(r);
  });
  const pages = [
    '/',
    '/so',
    '/plan',
    '/master/customers',
    '/master/locations',
    '/fleet/vehicles',
    '/fleet/drivers',
    '/settings',
    '/settings/api',
    '/so',
    '/plan',
  ];
  for (const p of pages) {
    await page.goto(p);
    await page.waitForLoadState('networkidle');
  }
  // อยู่บนกระดานวางแผนต่ออีกพัก (poll)
  await page.waitForTimeout(5_000);
  const limited = seen.filter((r) => r.status() === 429).map((r) => r.url());
  expect(limited, 'ไม่มีคำขอใดถูกจำกัด').toEqual([]);
  expect(seen.length).toBeGreaterThan(20);
  const authed = seen.filter((r) => r.headers()['ratelimit-limit']);
  expect(authed.length, 'response ของ /v1 ที่ยืนยันตัวตนมี header RateLimit-*').toBeGreaterThan(10);
  const h = authed.at(-1)!.headers();
  expect(Number(h['ratelimit-remaining'])).toBeGreaterThan(0);
  expect(h['ratelimit-reset']).toMatch(/^\d+$/);
});
