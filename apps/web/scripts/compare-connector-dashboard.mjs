// ภาพเทียบ "ต้นแบบ | ของจริง" ของการ์ด "การเชื่อมต่อ {ระบบ}" บนหน้าภาพรวม (ST9-T04) ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้องมี web dev (WEB_PORT) + API dev + seed + connector ของ tenant เดโม (สคริปต์ไม่สร้างให้)
// ใช้: node scripts/compare-connector-dashboard.mjs · OUT = โฟลเดอร์ปลายทางเพิ่ม (เช่น scratchpad) — เขียน design/compare/ เสมอ
// ภาพ: ok = เชื่อมต่อปกติ · (ของจริงเท่านั้น) err = ปลายทางล่ม — ตั้งสถานะในฐานเองก่อนรันด้วย TAG=err
import { chromium } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../../../design/compare/', import.meta.url));
const proto =
  'file://' + fileURLToPath(new URL('../../../design/prototype/TMS v4.dc.html', import.meta.url));
const WEB = process.env.WEB ?? `http://localhost:${process.env.WEB_PORT ?? 4420}`;
const TAG = process.env.TAG ?? 'ok';
const vp = { width: 1440, height: 900 };
const b = await chromium.launch();

// ---------- ต้นแบบ: โหมดตัวอย่าง "เชื่อม 1 ตัว" บนหน้าภาพรวม ----------
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(proto);
await P.waitForTimeout(2500);
// ปุ่มโหมดตัวอย่าง "เชื่อม 1 ตัว" ของต้นแบบ (setMode('one') — connector ที่เลือก ค่าเริ่ม KRS)
const clicked = await P.evaluate(() => {
  const el = [...document.querySelectorAll('button, [role=button], div, span')].find(
    (x) => x.textContent?.trim() === 'เชื่อม 1 ตัว',
  );
  el?.click();
  return !!el;
});
if (!clicked) throw new Error('ไม่พบปุ่ม "เชื่อม 1 ตัว" ในต้นแบบ');
await P.waitForTimeout(1200);
await P.getByText('คิวรอส่ง (outbox)').first().scrollIntoViewIfNeeded();
await P.mouse.move(800, 600);
await P.mouse.wheel(0, 300);
await P.waitForTimeout(600);
const a = await P.screenshot();

// ---------- ของจริง ----------
const ctx = await b.newContext({ viewport: vp, locale: 'th-TH', baseURL: WEB });
await ctx.addCookies([
  {
    name: 'tms_td',
    value: 'demo-trusted-device-e2e-only-0000000000000:00000000-0000-4000-8000-0000000e0a01',
    url: `${WEB}/v1/auth`,
  },
]);
const W = await ctx.newPage();
const v = randomBytes(32).toString('base64url');
const r1 = await W.request.post('/v1/auth/login', {
  data: {
    email: 'owner@demo-a.test',
    password: 'demo-password-2569',
    codeChallenge: createHash('sha256').update(v).digest('base64url'),
  },
});
const { code } = await r1.json();
await W.request.post('/v1/oauth/token', {
  data: { grantType: 'authorization_code', code, codeVerifier: v },
});
await W.goto('/');
await W.getByTestId('dash-conn').waitFor({ timeout: 15000 });
await W.waitForTimeout(1500);
await W.getByTestId('dash-conn').scrollIntoViewIfNeeded();
await W.mouse.move(800, 600);
await W.mouse.wheel(0, 300);
await W.waitForTimeout(600);
const c = await W.screenshot();

const M = await (await b.newContext({ viewport: { width: 2900, height: 960 } })).newPage();
await M.setContent(
  `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ (TMS v4)</div><img src="data:image/png;base64,${a.toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web)</div><img src="data:image/png;base64,${c.toString('base64')}"></div></body>`,
);
const f = `st9-connector-dashboard-${TAG}-1440.png`;
await M.screenshot({ path: `${out}${f}` });
console.log(`wrote design/compare/${f}`);
if (process.env.OUT) copyFileSync(`${out}${f}`, `${process.env.OUT}/st9t04-${f}`);
await b.close();
