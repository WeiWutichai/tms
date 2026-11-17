// ภาพเทียบ "ต้นแบบ | ของจริง" ของ POD checklist (ST4-T05; CLAUDE.md: ทุก PR ที่มี UI ต้องแนบ) — ใช้กับเครื่อง dev เท่านั้น
// ต้นแบบไม่มีหน้านี้ [DECISION spec/12 §3] → ซ้ายแสดงหน้าที่ใช้เป็นแบบ: ตั้งค่า → เหตุผล (ตารางติ๊ก) และ drawer ลูกค้า แท็บ เงื่อนไข
// ต้องมี web dev + API dev + seed · ใช้: WEB=http://localhost:4420 node scripts/compare-pod.mjs
// owner ใช้ cookie อุปกรณ์ที่จำไว้จาก seed (ข้าม 2FA) — ข้อมูลเดโมเท่านั้น
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

// ---- ต้นแบบ ----
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(`http://localhost:${port}/TMS%20v4.dc.html`);
await P.waitForTimeout(3000);
for (const el of await P.getByText('ตั้งค่า', { exact: true }).filter({ visible: true }).all()) {
  await el.click();
  await P.waitForTimeout(600);
  if (await P.getByText('นิติบุคคลและสาขา', { exact: true }).filter({ visible: true }).count())
    break;
}
await P.getByText('เหตุผล', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(500);
const a = { settings: await P.screenshot() };
await P.getByText('ข้อมูลหลัก', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(400);
await P.getByText('ลูกค้า', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(1200);
await P.locator('tbody tr').nth(1).click();
await P.waitForTimeout(900);
await P.getByText('เงื่อนไข', { exact: true }).filter({ visible: true }).last().click();
await P.waitForTimeout(600);
a.default = await P.screenshot();
a.custom = a.default;

// ---- ของจริง ----
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
const H = { Authorization: `Bearer ${tok.accessToken}` };
const r = await W.request.put('/v1/customers/external/DEMO-POD-1', {
  headers: H,
  data: {
    legalName: 'บจก. ตัวอย่างพลาสติก',
    billingAddress: { line1: '1/1 ถนนตัวอย่าง แขวงตัวอย่าง เขตตัวอย่าง กรุงเทพมหานคร 10000' },
    podRequirements: {},
  },
});
if (!r.ok()) console.error('seed customer failed', r.status(), await r.text());
const cust = await r.json();

await W.goto('/settings?sec=pod');
await W.waitForTimeout(1500);
await W.getByRole('button', { name: 'เพิ่มข้อยืนยัน' }).click();
await W.getByLabel('ข้อความข้อยืนยัน').fill('สินค้าครบ ไม่เสียหาย');
const c = { settings: await W.screenshot() };

await W.goto('/master/customers');
await W.waitForTimeout(1500);
await W.getByRole('row', { name: new RegExp(cust.code) }).click();
await W.waitForTimeout(900);
const d = W.getByRole('dialog');
await d.getByRole('tab', { name: 'เงื่อนไข' }).click();
await W.waitForTimeout(800);
await d.getByRole('radiogroup', { name: 'หลักฐานส่ง (POD)' }).scrollIntoViewIfNeeded();
c.default = await W.screenshot();
await d.getByRole('radio', { name: 'กำหนดเองสำหรับลูกค้านี้' }).click();
await d.getByRole('radio', { name: 'บังคับ — หมายเหตุ', exact: true }).check();
await W.waitForTimeout(300);
await d.getByRole('radiogroup', { name: 'หลักฐานส่ง (POD)' }).scrollIntoViewIfNeeded();
c.custom = await W.screenshot();

const NOTE = {
  settings: 'ต้นแบบไม่มีหน้า POD — แสดง ตั้งค่า → เหตุผล (แบบตารางที่ใช้)',
  default: 'ต้นแบบไม่มีส่วน POD — แสดงแท็บ เงื่อนไข',
  custom: 'ต้นแบบไม่มีส่วน POD — แสดงแท็บ เงื่อนไข',
};
for (const tag of ['settings', 'default', 'custom']) {
  const M = await (await b.newContext({ viewport: { width: 2900, height: 1060 } })).newPage();
  await M.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ (TMS v4) — ${NOTE[tag]}</div><img src="data:image/png;base64,${a[tag].toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web)</div><img src="data:image/png;base64,${c[tag].toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st4-pod-${tag}-1440.png` });
  console.log(`wrote design/compare/st4-pod-${tag}-1440.png`);
}
await b.close();
srv.close();
