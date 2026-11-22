/**
 * ST9-T17 ส่วนเว็บ: เวลาแสดงตาราง (หน้ารายการที่มี 10,000 แถวในฐาน) วัดด้วย Chromium จริง — `perf run --only=web`
 *
 * เปิด vite (โหมด dev — ไม่ minify/ไม่รวมไฟล์ จึงช้ากว่า build จริง: ผลเป็น "ขอบบน") ชี้ API ของการวัด แล้ว login ผู้ใช้ viewer
 * ของ tenant ทดสอบ → เปิดหน้ารายการ จับเวลา "เริ่มนำทาง → แถวแรกของตารางแสดง" (โหลดเต็มหน้า รวมดาวน์โหลด bundle + /me + รายการ)
 * และ "เปลี่ยนหน้าในแอป" (กดเมนู → แถวแรกแสดง)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { API_PORT, BASE, PERF_DIR, sleep, stats } from './lib';

export const PERF_USER = { email: 'viewer@perf.test', password: 'perf-password-2569' };
const WEB_PORT = Number(process.env.PERF_WEB_PORT ?? API_PORT + 2);
const WEB = `http://localhost:${WEB_PORT}`;
/** หน้ารายการ (path ตาม apps/web/src/nav.ts) */
const PAGES: [path: string, label: string][] = [
  ['/so', 'ใบสั่งขนส่ง'],
  ['/do', 'ใบส่งของ'],
  ['/trips', 'เที่ยวรถ'],
  ['/bill', 'วางบิล'],
];
const ROW = 'table tbody tr';

export async function web(children: ChildProcess[]) {
  const out = createWriteStream(resolve(PERF_DIR, 'web.log'));
  const vite = spawn('npx', ['vite', '--port', String(WEB_PORT), '--strictPort'], {
    cwd: resolve(__dirname, '../../../web'),
    env: { ...process.env, VITE_API_TARGET: BASE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  vite.stdout!.pipe(out);
  vite.stderr!.pipe(out);
  children.push(vite);
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(WEB)).ok) break;
    } catch {
      /* ยังไม่ขึ้น */
    }
    if (i > 120) throw new Error(`vite ไม่ขึ้นที่ ${WEB} — ดู ${PERF_DIR}/web.log`);
    await sleep(500);
  }
  /* eslint-disable-next-line @typescript-eslint/no-require-imports */
  const { chromium } = require('playwright-core') as typeof import('playwright-core');
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ baseURL: WEB, viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    // login ผ่าน API จริง (Auth Code + PKCE) ใน context เดียวกับหน้า → refresh cookie (วิธีเดียวกับ E2E)
    const verifier = randomBytes(32).toString('base64url');
    const r1 = await page.request.post('/v1/auth/login', {
      data: {
        email: PERF_USER.email,
        password: PERF_USER.password,
        codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
      },
    });
    if (r1.status() !== 200) throw new Error(`login ${r1.status()} ${await r1.text()}`);
    const r2 = await page.request.post('/v1/oauth/token', {
      data: {
        grantType: 'authorization_code',
        code: (await r1.json()).code,
        codeVerifier: verifier,
      },
    });
    if (r2.status() !== 200) throw new Error(`token ${r2.status()} ${await r2.text()}`);

    // อุ่น: vite แปลงไฟล์ครั้งแรก (ไม่นับ)
    await page.goto('/so');
    await page.locator(ROW).first().waitFor({ state: 'visible', timeout: 120_000 });
    const results: Record<string, unknown>[] = [];
    for (const [path, label] of PAGES) {
      const full: number[] = [];
      const inApp: number[] = [];
      let rows = 0;
      for (let i = 0; i < 6; i++) {
        // (ก) โหลดเต็มหน้า (พิมพ์ URL / refresh)
        let t = Date.now();
        await page.goto(path, { waitUntil: 'commit' });
        await page.locator(ROW).first().waitFor({ state: 'visible', timeout: 60_000 });
        if (i > 0) full.push(Date.now() - t);
        rows = await page.locator(ROW).count();
        // (ข) เปลี่ยนหน้าในแอป: ไปหน้าแรก (/) แล้วกดเมนูกลับมา
        await page.goto('/', { waitUntil: 'networkidle' });
        const link = page.locator(`a[href="${path}"]`).first();
        if (await link.count()) {
          t = Date.now();
          await link.click();
          await page.locator(ROW).first().waitFor({ state: 'visible', timeout: 60_000 });
          if (i > 0) inApp.push(Date.now() - t);
        }
      }
      results.push({
        path,
        label,
        rowsShown: rows,
        fullLoad: stats(full),
        inApp: inApp.length ? stats(inApp) : null,
      });
    }
    return { mode: 'vite dev (ไม่ minify)', viewport: '1440×900', pages: results };
  } finally {
    await browser.close();
  }
}
