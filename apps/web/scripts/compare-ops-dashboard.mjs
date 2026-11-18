// ภาพเทียบ "ต้นแบบ | ของจริง" ของหน้าภาพรวม = Dashboard ปฏิบัติการ (ST9-T01) ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้องมี web dev (WEB_PORT) + API dev + seed · ใช้: node scripts/compare-ops-dashboard.mjs
// ภาพ: top = KPI + เริ่มต้นใช้งาน + ทางลัด · table = ตาราง "ต้องทำวันนี้" กรองการ์ด "กำลังวิ่ง"/"ระหว่างส่ง" + การ์ดล่าง
import { chromium } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
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
await P.getByText('ระหว่างส่ง', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(600);
await P.mouse.move(800, 600);
await P.mouse.wheel(0, 900);
await P.waitForTimeout(600);
a.table = await P.screenshot();

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
await W.getByTestId('kpi-today').waitFor({ timeout: 15000 });
await W.waitForTimeout(1500);
const c = { top: await W.screenshot() };
await W.getByTestId('kpi-running').click();
await W.waitForTimeout(1200);
await W.mouse.move(800, 600);
await W.mouse.wheel(0, 900);
await W.waitForTimeout(600);
c.table = await W.screenshot();

for (const tag of ['top', 'table']) {
  const M = await (await b.newContext({ viewport: { width: 2900, height: 960 } })).newPage();
  await M.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ (TMS v4)</div><img src="data:image/png;base64,${a[tag].toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web)</div><img src="data:image/png;base64,${c[tag].toString('base64')}"></div></body>`,
  );
  const f = tag === 'top' ? 'st9-ops-dashboard-1440.png' : 'st9-ops-dashboard-table-1440.png';
  await M.screenshot({ path: `${out}${f}` });
  console.log(`wrote design/compare/${f}`);
}
await b.close();
