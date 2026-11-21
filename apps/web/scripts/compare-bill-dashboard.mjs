// ภาพเทียบ "ต้นแบบ | ของจริง" ของ Dashboard บิล บนหน้าภาพรวม (ST9-T02) ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้องมี web dev (WEB_PORT) + API dev + seed (+ ใบแจ้งหนี้ตัวอย่างในฐาน dev) · ใช้: node scripts/compare-bill-dashboard.mjs
// ภาพ: top = แถว KPI (ใบที่ 4 = ใบแจ้งหนี้เกินกำหนด) · bottom = แถวการ์ดล่าง (ต้นแบบ: ลูกหนี้ค้างชำระ · ของจริง: สถานะบิล + ลูกหนี้ค้างชำระ)
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

// ---------- ต้นแบบ (หน้าแรก = ภาพรวม) ----------
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(proto);
await P.waitForTimeout(2500);
const a = { top: await P.screenshot() };
await P.getByText('ลูกหนี้ค้างชำระ', { exact: true }).first().scrollIntoViewIfNeeded();
await P.mouse.move(800, 600);
await P.mouse.wheel(0, 300);
await P.waitForTimeout(600);
a.bottom = await P.screenshot();

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
await W.getByTestId('kpi-invOver').waitFor({ timeout: 15000 });
await W.waitForTimeout(1500);
const c = { top: await W.screenshot() };
await W.getByTestId('dash-ar').scrollIntoViewIfNeeded();
await W.mouse.move(800, 600);
await W.mouse.wheel(0, 1200);
await W.waitForTimeout(600);
c.bottom = await W.screenshot();

for (const tag of ['top', 'bottom']) {
  const M = await (await b.newContext({ viewport: { width: 2900, height: 960 } })).newPage();
  await M.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ (TMS v4)</div><img src="data:image/png;base64,${a[tag].toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web)</div><img src="data:image/png;base64,${c[tag].toString('base64')}"></div></body>`,
  );
  const f = `st9-bill-dashboard-${tag}-1440.png`;
  await M.screenshot({ path: `${out}${f}` });
  console.log(`wrote design/compare/${f}`);
  if (process.env.OUT) copyFileSync(`${out}${f}`, `${process.env.OUT}/t902-${f}`);
}
await b.close();
