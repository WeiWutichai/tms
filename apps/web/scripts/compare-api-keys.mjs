// ภาพเทียบ "ต้นแบบ | ของจริง" ของหน้า ตั้งค่า → นักพัฒนา / Open API แท็บ API keys (ST7-T01) ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้องมี web dev + API dev ที่รันโค้ด ST7-T01 + seed · ใช้: node scripts/compare-api-keys.mjs
// (web อื่น: WEB=http://localhost:4613 node scripts/compare-api-keys.mjs) · PROTO_ONLY=<dir> = ถ่ายเฉพาะต้นแบบ
// สคริปต์สร้าง key ตัวอย่าง 2 ตัวใน demo-a (ถ้ายังไม่มีชื่อนั้น) ผ่าน API จริง
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
await P.getByRole('button', { name: /^API keys/ }).first().click();
await P.waitForTimeout(900);
const a = { list: await P.screenshot() };
await P.locator('tbody tr').nth(0).click();
await P.waitForTimeout(900);
a.drawer = await P.screenshot();
await close(P);
await P.getByText('สร้าง API key', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(900);
a.create = await P.screenshot();
await P.locator('input[placeholder="เช่น ERP sync, Shopify"]').fill('ทดสอบ');
await P.getByText('orders:read', { exact: true }).filter({ visible: true }).first().click();
await P.getByText('สร้าง key', { exact: true }).filter({ visible: true }).last().click();
await P.waitForTimeout(700);
a.secret = await P.screenshot();
await P.getByText('คัดลอกแล้ว · ปิดหน้าต่าง').click();
await P.waitForTimeout(500);
await P.locator('tbody tr').nth(1).locator('button').last().click();
await P.waitForTimeout(400);
a.menu = await P.screenshot();
await P.getByText('หมุนเวียน key', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(600);
a.rotate = await P.screenshot();
await close(P);
await P.locator('tbody tr').nth(1).locator('button').last().click();
await P.waitForTimeout(300);
await P.getByText('แก้ scope', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(700);
a.scope = await P.screenshot();
await close(P);
await P.locator('tbody tr').nth(1).locator('button').last().click();
await P.waitForTimeout(300);
await P.getByText('เพิกถอน', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(600);
a.revoke = await P.screenshot();

if (process.env.PROTO_ONLY) {
  for (const [k, v] of Object.entries(a)) writeFileSync(`${process.env.PROTO_ONLY}/proto-${k}.png`, v);
  await b.close();
  srv.close();
  process.exit(0);
}

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
const auth = { Authorization: `Bearer ${tok.accessToken}` };
const have = (await (await W.request.get('/v1/api-keys?limit=200', { headers: auth })).json()).data;
for (const k of [
  { name: 'ERP บัญชี (sync ใบแจ้งหนี้)', scopes: ['invoices:read', 'orders:read'], expiresInDays: 365 },
  {
    name: 'WMS คลังบางนา',
    scopes: ['orders:read', 'orders:write', 'master:read'],
    ipAllowlist: ['203.150.12.0/24'],
    expiresInDays: 30,
  },
])
  if (!have.some((h) => h.name === k.name))
    await W.request.post('/v1/api-keys', { headers: auth, data: k });
await W.goto('/settings/api');
await W.waitForTimeout(1500);
const c = { list: await W.screenshot() };
await W.locator('tbody tr').nth(0).click();
await W.waitForTimeout(900);
c.drawer = await W.screenshot();
await W.keyboard.press('Escape');
await W.waitForTimeout(300);
await W.getByRole('button', { name: 'สร้าง API key' }).first().click();
await W.waitForTimeout(900);
c.create = await W.screenshot();
await W.getByRole('dialog').getByLabel('ชื่อ key').fill(`ทดสอบ ${Date.now() % 100000}`);
await W.getByRole('dialog').getByText('orders:read', { exact: true }).click();
await W.getByRole('dialog').getByRole('button', { name: 'สร้าง key' }).click();
await W.waitForTimeout(900);
c.secret = await W.screenshot();
await W.getByRole('button', { name: 'คัดลอกแล้ว · ปิดหน้าต่าง' }).click();
await W.waitForTimeout(500);
await W.locator('tbody tr').nth(1).getByRole('button').last().click();
await W.waitForTimeout(400);
c.menu = await W.screenshot();
await W.getByRole('menuitem', { name: 'หมุนเวียน key' }).click();
await W.waitForTimeout(600);
c.rotate = await W.screenshot();
await W.keyboard.press('Escape');
await W.waitForTimeout(300);
await W.locator('tbody tr').nth(1).getByRole('button').last().click();
await W.waitForTimeout(300);
await W.getByRole('menuitem', { name: 'แก้ scope' }).click();
await W.waitForTimeout(700);
c.scope = await W.screenshot();
await W.keyboard.press('Escape');
await W.waitForTimeout(300);
await W.locator('tbody tr').nth(1).getByRole('button').last().click();
await W.waitForTimeout(300);
await W.getByRole('menuitem', { name: 'เพิกถอน' }).click();
await W.waitForTimeout(600);
c.revoke = await W.screenshot();

for (const tag of Object.keys(c)) {
  const M = await (await b.newContext({ viewport: { width: 2900, height: 960 } })).newPage();
  await M.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ (TMS v4)</div><img src="data:image/png;base64,${a[tag].toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web)</div><img src="data:image/png;base64,${c[tag].toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st7-apikeys-${tag}-1440.png` });
  console.log(`wrote design/compare/st7-apikeys-${tag}-1440.png`);
}
await b.close();
srv.close();
