// ภาพเทียบ "ต้นแบบ | ของจริง" ของโหมด Sandbox หน้า ตั้งค่า → นักพัฒนา / Open API (ST7-T09) ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้องมี web dev + API dev ที่รันโค้ด ST7-T09 + seed · ใช้: node scripts/compare-sandbox.mjs
// สคริปต์สร้าง key test ตัวอย่าง 1 ตัวใน sandbox ของ demo-a (ถ้ายังไม่มีชื่อนั้น) ผ่าน API จริง
import { chromium } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = process.env.WEB ?? `http://localhost:${process.env.WEB_PORT ?? 4420}`;
const out = fileURLToPath(new URL('../../../design/compare/', import.meta.url));
const protoDir = fileURLToPath(new URL('../../../design/prototype/', import.meta.url));

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const srv = createServer((req, res) => {
  const p = join(protoDir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(protoDir) || !existsSync(p)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
  createReadStream(p).pipe(res);
}).listen(0);
const port = srv.address().port;

const vp = { width: 1440, height: 900 };
const b = await chromium.launch();
const close = async (page) => {
  await page.keyboard.press('Escape');
  await page
    .locator('button[title="ปิด"]')
    .filter({ visible: true })
    .first()
    .click({ timeout: 1000 })
    .catch(() => {});
  await page.waitForTimeout(400);
};

// ---------- ต้นแบบ ----------
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(`http://localhost:${port}/TMS%20v4.dc.html`);
await P.waitForTimeout(3000);
await P.getByText('ตั้งค่า', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(400);
await P.getByText('นักพัฒนา / Open API', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(1200);
await P.getByRole('button', { name: /^API keys/ })
  .first()
  .click();
await P.waitForTimeout(600);
await P.getByRole('button', { name: 'Sandbox', exact: true }).first().click();
await P.waitForTimeout(900);
const a = { keys: await P.screenshot() };
await P.getByText('สร้าง API key', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(900);
a.create = await P.screenshot();
await close(P);
await P.getByRole('button', { name: /^Webhooks/ })
  .first()
  .click();
await P.waitForTimeout(900);
a.hooks = await P.screenshot();

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
const tok = await (
  await W.request.post('/v1/oauth/token', {
    data: { grantType: 'authorization_code', code, codeVerifier: v },
  })
).json();
const auth = { Authorization: `Bearer ${tok.accessToken}`, 'X-Tms-Mode': 'test' };
const have = (await (await W.request.get('/v1/api-keys?limit=200', { headers: auth })).json()).data;
if (!have.some((h) => h.name === 'ทดสอบ ERP (sandbox)'))
  await W.request.post('/v1/api-keys', {
    headers: auth,
    data: { name: 'ทดสอบ ERP (sandbox)', mode: 'test', scopes: ['orders:read', 'orders:write'] },
  });
await W.goto('/settings/api');
await W.waitForTimeout(1200);
await W.getByRole('group', { name: 'โหมด' }).getByRole('button', { name: 'Sandbox' }).click();
await W.waitForTimeout(1500);
const c = { keys: await W.screenshot() };
await W.getByRole('button', { name: 'สร้าง API key' }).first().click();
await W.waitForTimeout(900);
c.create = await W.screenshot();
await W.keyboard.press('Escape');
await W.waitForTimeout(400);
await W.getByRole('tab', { name: /Webhooks/ }).click();
await W.waitForTimeout(1200);
c.hooks = await W.screenshot();

for (const tag of Object.keys(c)) {
  const M = await (await b.newContext({ viewport: { width: 2900, height: 960 } })).newPage();
  await M.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ (TMS v4)</div><img src="data:image/png;base64,${a[tag].toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web)</div><img src="data:image/png;base64,${c[tag].toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st7-sandbox-${tag}-1440.png` });
  console.log(`wrote design/compare/st7-sandbox-${tag}-1440.png`);
}
await b.close();
srv.close();
