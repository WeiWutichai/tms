// ภาพเทียบ "ต้นแบบ | ของจริง" ของ dialog "ส่งออกให้นักบัญชี" (ST7-T23 + D-73) ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้องมี web dev + API dev + seed · ใช้: WEB=http://localhost:5761 OUT=<โฟลเดอร์> node scripts/compare-accountant-export.mjs
// ต้นแบบ: หน้าใบแจ้งหนี้ → ปุ่ม "ส่งออกให้นักบัญชี" (openXp / vXp) · ของจริง: /bill → ปุ่มเดียวกัน
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
await P.waitForTimeout(3000);
await P.getByText('วางบิลและใบแจ้งหนี้', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(1200);
await P.getByText('ส่งออกให้นักบัญชี').filter({ visible: true }).first().click();
await P.waitForTimeout(800);
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
await W.goto('/bill');
await W.getByRole('button', { name: 'ส่งออกให้นักบัญชี' }).first().click({ timeout: 20000 });
await W.getByRole('dialog').getByText('หัก ณ ที่จ่าย', { exact: true }).waitFor({ timeout: 15000 });
await W.waitForTimeout(800);
const c = await W.screenshot();

const M = await (await b.newContext({ viewport: { width: 2900, height: 960 } })).newPage();
await M.setContent(
  `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ (TMS v4 vXp)</div><img src="data:image/png;base64,${a.toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web /bill — D-73)</div><img src="data:image/png;base64,${c.toString('base64')}"></div></body>`,
);
const f = 'st7-t23-accountant-export-1440.png';
await M.screenshot({ path: `${out}${f}` });
console.log(`wrote design/compare/${f}`);
if (process.env.OUT) {
  copyFileSync(`${out}${f}`, `${process.env.OUT}/d73-accountant-export-compare-1440.png`);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(`${process.env.OUT}/d73-prototype-1440.png`, a);
  writeFileSync(`${process.env.OUT}/d73-real-1440.png`, c);
}
await b.close();
