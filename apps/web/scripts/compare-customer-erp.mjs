// ภาพเทียบ "ต้นแบบ | ของจริง" ของ drawer ลูกค้า แท็บ "รหัสระบบบัญชี" + กล่องเตือน "ยังไม่ได้ map รหัสลูกค้า" (ST8-T05) ที่ 1440 px
// ต้องมี web dev + API dev + seed (DemoProvider เปิดใน dev) · ใช้: WEB=http://localhost:4420 node scripts/compare-customer-erp.mjs
// owner (ข้าม 2FA ด้วย cookie อุปกรณ์ของ seed — ข้อมูลเดโมเท่านั้น) · สร้าง connector demo + ลูกค้าตัวอย่าง (สมมติ) แล้วยกเลิก connector เมื่อจบ
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
const vp = { width: 1440, height: 900 };
const b = await chromium.launch();

function taxId(n) {
  const base = `09998${String(n).padStart(7, '0')}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
  return base + String((11 - (sum % 11)) % 10);
}

// ---------- ต้นแบบ: ตั้งค่า → การเชื่อมต่อ "เชื่อม 1 ตัว" (KRS) → ข้อมูลหลัก → ลูกค้า ----------
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(`http://localhost:${port}/TMS%20v4.dc.html`);
await P.waitForTimeout(3000);
for (const el of await P.getByText('ตั้งค่า', { exact: true }).filter({ visible: true }).all()) {
  await el.click();
  await P.waitForTimeout(600);
  if (await P.getByText('นิติบุคคลและสาขา', { exact: true }).filter({ visible: true }).count())
    break;
}
await P.getByText('การเชื่อมต่อ', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(800);
const one = P.getByText('เชื่อม 1 ตัว', { exact: true }).filter({ visible: true });
if (await one.count()) await one.first().click();
await P.waitForTimeout(800);
await P.getByText('ข้อมูลหลัก', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(400);
await P.getByText('ลูกค้า', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(1200);
const a = {};
// ลูกค้าที่ยังไม่มีรหัส (C0005) → แท็บทั่วไปมีกล่องเตือน
await P.locator('tbody tr', { hasText: 'C0005' }).first().click();
await P.waitForTimeout(900);
a.warn = await P.screenshot();
await P.getByText('รหัสระบบบัญชี', { exact: true }).filter({ visible: true }).last().click();
await P.waitForTimeout(600);
a.erpc = await P.screenshot();

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
const cust = await (
  await W.request.put('/v1/customers/external/DEMO-CUS-ERP-1', {
    headers: auth,
    data: { legalName: 'บจก. ตัวอย่างรหัสบัญชี', taxId: taxId(51) },
  })
).json();
if (!cust.id) throw new Error(JSON.stringify(cust));
const con = await (
  await W.request.post('/v1/connectors', {
    headers: auth,
    data: { adapterKey: 'demo', credentials: { apiKey: 'demo-compare' } },
  })
).json();
if (!con.id) throw new Error(JSON.stringify(con));
try {
  await W.request.post(`/v1/connectors/${con.id}/resume`, { headers: auth, data: {} });
  await W.goto('/master/customers');
  await W.getByRole('row', { name: /บจก\. ตัวอย่างรหัสบัญชี/ }).click();
  await W.getByTestId('cust-erp-warn').waitFor({ timeout: 60000 });
  await W.waitForTimeout(600);
  const c = { warn: await W.screenshot() };
  await W.getByRole('dialog').getByRole('tab', { name: 'รหัสระบบบัญชี' }).click();
  await W.waitForTimeout(600);
  c.erpc = await W.screenshot();

  const M = await (await b.newContext({ viewport: { width: 2900, height: 960 } })).newPage();
  for (const k of ['warn', 'erpc']) {
    await M.setContent(
      `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ (TMS v4)</div><img src="data:image/png;base64,${a[k].toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web)</div><img src="data:image/png;base64,${c[k].toString('base64')}"></div></body>`,
    );
    await M.screenshot({ path: `${out}st8-t05-customer-erp-${k}-1440.png` });
    console.log(`wrote design/compare/st8-t05-customer-erp-${k}-1440.png`);
  }
} finally {
  await W.request.post(`/v1/connectors/${con.id}/disconnect`, {
    headers: auth,
    data: { reason: 'จบการถ่ายภาพเทียบต้นแบบ' },
  });
  await b.close();
  srv.close();
}
