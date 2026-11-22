// ภาพเทียบ "ต้นแบบ | ของจริง" ของ Dashboard AP รถร่วม (ST9-T03) ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้องมี web dev (WEB_PORT) + API dev + seed (+ ใบสำคัญจ่ายตัวอย่างในฐาน dev) · ใช้: node scripts/compare-ap-dashboard.mjs
// ภาพ: dash = การ์ดล่างของภาพรวม (ต้นแบบ: ไม่มีการ์ด AP — การ์ดลูกหนี้/การเชื่อมต่อคือแบบที่ใช้ · ของจริง: การ์ด "Settlement รถร่วม")
//      settle = คลิกช่อง "มีรายการโต้แย้ง" → หน้า settle แท็บรอตรวจ + ตัวกรองสถานะ (ต้นแบบ: หน้า settle แท็บรอตรวจ)
// OUT = โฟลเดอร์ปลายทางเพิ่ม (เช่น scratchpad) — เขียน design/compare/ เสมอ
import { chromium } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../../../design/compare/', import.meta.url));
const proto =
  'file://' + fileURLToPath(new URL('../../../design/prototype/TMS v4.dc.html', import.meta.url));
const WEB = process.env.WEB ?? `http://localhost:${process.env.WEB_PORT ?? 4420}`;
const vp = { width: 1440, height: 900 };
const b = await chromium.launch();

// ---------- ต้นแบบ ----------
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(proto);
await P.waitForTimeout(2500);
await P.getByText('ลูกหนี้ค้างชำระ', { exact: true }).first().scrollIntoViewIfNeeded();
await P.mouse.move(800, 600);
await P.mouse.wheel(0, 300);
await P.waitForTimeout(600);
const a = { dash: await P.screenshot() };
await P.getByText('Settlement รถร่วม', { exact: true }).first().click();
await P.waitForTimeout(1200);
await P.getByText('รอตรวจ', { exact: true }).first().click();
await P.waitForTimeout(800);
a.settle = await P.screenshot();

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
await W.getByTestId('dash-ap').waitFor({ timeout: 15000 });
await W.waitForTimeout(1500);
await W.getByTestId('dash-ap').scrollIntoViewIfNeeded();
await W.mouse.move(800, 600);
await W.mouse.wheel(0, 2000);
await W.waitForTimeout(600);
const c = { dash: await W.screenshot() };
await W.getByTestId('ap-disputed').click();
await W.waitForURL(/\/settle$/);
await W.waitForTimeout(1500);
c.settle = await W.screenshot();

for (const tag of ['dash', 'settle']) {
  const M = await (await b.newContext({ viewport: { width: 2900, height: 960 } })).newPage();
  await M.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ (TMS v4)</div><img src="data:image/png;base64,${a[tag].toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web)</div><img src="data:image/png;base64,${c[tag].toString('base64')}"></div></body>`,
  );
  const f = `st9-ap-dashboard-${tag}-1440.png`;
  await M.screenshot({ path: `${out}${f}` });
  console.log(`wrote design/compare/${f}`);
  if (process.env.OUT) copyFileSync(`${out}${f}`, `${process.env.OUT}/t903-${f}`);
}
await b.close();
