// ภาพเทียบ "ต้นแบบ | ของจริง" ST7-T17 (ตั้งค่า → การเชื่อมต่อ → กล่อง "ตั้งค่า {ระบบ}" ช่อง "ใครออกเลขเอกสาร") ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้องมี web dev + API dev (ตาม .env ของ lane) + seed · ใช้: WEB_PORT=4783 node scripts/compare-sor.mjs
// ทิ้ง connector demo ที่สร้างไว้ด้วยการยกเลิกการเชื่อมตอนจบ
import { chromium } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
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

const vp = { width: 1440, height: 1000 };
const b = await chromium.launch();

// ---------- ต้นแบบ TMS v4: ตั้งค่า → การเชื่อมต่อ → เชื่อม KRS → กล่องตั้งค่า ----------
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(`http://localhost:${port}/TMS%20v4.dc.html`);
await P.waitForTimeout(3000);
for (const el of await P.getByText('ตั้งค่า', { exact: true }).filter({ visible: true }).all()) {
  await el.click();
  await P.waitForTimeout(600);
  if (await P.getByText('การเชื่อมต่อ', { exact: true }).filter({ visible: true }).count()) break;
}
await P.getByText('การเชื่อมต่อ', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(800);
await P.getByRole('button', { name: 'เชื่อมต่อ', exact: true }).first().click();
await P.waitForTimeout(800);
await P.getByText('ใครออกเลขเอกสาร', { exact: true }).first().scrollIntoViewIfNeeded();
await P.waitForTimeout(400);
const a = await P.screenshot();

// ---------- ของจริง: owner ของบริษัทเดโม ----------
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
await W.goto('/settings?sec=conn');
await W.waitForTimeout(1500);
await W.getByRole('group', { name: 'ERP จำลอง (Demo)' })
  .getByRole('button', { name: 'เชื่อมต่อ' })
  .click();
await W.getByLabel(/API key|apiKey/).fill('demo-compare-key-0001');
await W.getByRole('dialog').getByRole('button', { name: 'เชื่อมต่อ' }).click();
await W.waitForTimeout(2000);
await W.getByTestId('numbering-owner').scrollIntoViewIfNeeded();
await W.waitForTimeout(400);
const c = await W.screenshot();

const M = await (await b.newContext({ viewport: { width: 2900, height: 1060 } })).newPage();
await M.setContent(
  `<body style="margin:0;display:flex;gap:20px;align-items:flex-start;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ</div><img src="data:image/png;base64,${a.toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web)</div><img src="data:image/png;base64,${c.toString('base64')}"></div></body>`,
);
await M.screenshot({ path: `${out}st7-t17-numbering-owner-1440.png`, fullPage: true });
console.log('wrote design/compare/st7-t17-numbering-owner-1440.png');

// เก็บกวาด: ยกเลิกการเชื่อม demo ที่สร้าง
const list = await (await W.request.get('/v1/connectors', { headers: auth })).json();
for (const x of list.data ?? [])
  await W.request.post(`/v1/connectors/${x.id}/disconnect`, {
    headers: auth,
    data: { reason: 'เก็บกวาดหลังถ่ายภาพเทียบ' },
  });
await b.close();
srv.close();
