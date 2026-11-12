// ภาพเทียบ "ต้นแบบ | ของจริง" ของ ST2-T21 (รถร่วมอัปโหลดเอกสารผ่านลิงก์) — เครื่อง dev เท่านั้น
// หน้าลิงก์ (public) เทียบ TMS Subcon ที่ 390 + 1440 px · แท็บเอกสารแนบของผู้รับเหมา เทียบ TMS v4 ที่ 1440 px
// ต้องมี web + API dev ที่รันโค้ด ST2-T21 + seed + ลิงก์ตัวอย่าง (CARRIER = ชื่อผู้รับเหมาในตาราง):
//   TOKEN=<ml1…> CARRIER=<ชื่อผู้รับเหมา> WEB=http://localhost:4420 node scripts/compare-carrier-upload.mjs
// (ต้นแบบไม่มีหน้าส่งเอกสาร — เทียบกับชิ้นที่ใช้: แท็บ "ส่ง POD" / ฟอร์ม "รับงาน" — spec/12 §3)
import { chromium } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = process.env.WEB ?? 'http://localhost:4420';
const TOKEN = process.env.TOKEN;
const CARRIER = process.env.CARRIER;
if (!TOKEN || !CARRIER) throw new Error('ต้องตั้ง TOKEN และ CARRIER');
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
const b = await chromium.launch();
const vis = (p, text) => p.getByText(text, { exact: true }).filter({ visible: true }).first();

async function pair(name, left, right, w, h, labels = ['ต้นแบบ', 'ของจริง (apps/web)']) {
  const M = await (await b.newContext({ viewport: { width: w * 2 + 60, height: h } })).newPage();
  await M.setContent(
    `<body style="margin:0;display:flex;align-items:flex-start;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">${labels[0]}</div><img src="data:image/png;base64,${left.toString('base64')}"></div><div><div style="padding:8px">${labels[1]}</div><img src="data:image/png;base64,${right.toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st2-carrier-upload-${name}.png`, fullPage: true });
  console.log(`wrote design/compare/st2-carrier-upload-${name}.png`);
}

// ---------- หน้าลิงก์ (390 + 1440) ----------
for (const vp of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
  await P.goto(`http://localhost:${port}/TMS%20Subcon.dc.html`);
  await P.waitForTimeout(2500);
  await vis(P, 'ส่ง POD').click();
  await P.getByRole('textbox').filter({ visible: true }).first().fill('DO-2611-00069');
  await P.waitForTimeout(300);
  await vis(P, '+ เพิ่มรูป').click();
  await vis(P, '+ เพิ่มรูป').click();
  await P.waitForTimeout(300);
  const aPod = await P.screenshot({ fullPage: true });
  await vis(P, 'ส่ง POD').click(); // แท็บ
  await vis(P, 'งาน').click();
  await vis(P, 'รับงาน').click();
  await P.waitForTimeout(300);
  const aForm = await P.screenshot({ fullPage: true });

  const W = await (await b.newContext({ viewport: vp, locale: 'th-TH', baseURL: WEB })).newPage();
  await W.goto(`/link/carrier-docs/${TOKEN}`);
  await W.waitForTimeout(1800);
  const cList = await W.screenshot({ fullPage: true });
  await W.locator('[data-testid=cdl-vehicle]').nth(1).locator('button').first().click();
  await W.waitForTimeout(300);
  await W.getByRole('button', { name: 'ส่งเอกสาร' }).click();
  await W.waitForTimeout(300);
  const cForm = await W.screenshot({ fullPage: true });
  await W.getByRole('button', { name: 'ย้อนกลับ' }).click();
  await W.getByRole('tab', { name: 'ใบขับขี่' }).click();
  await W.waitForTimeout(300);
  const cDrv = await W.screenshot({ fullPage: true });
  const bad = await (await b.newContext({ viewport: vp, locale: 'th-TH', baseURL: WEB })).newPage();
  await bad.goto(
    '/link/carrier-docs/ml1.00000000000000000000000000000000.1.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  );
  await bad.waitForTimeout(1500);
  const cBad = await bad.screenshot({ fullPage: true });

  const h = vp.height + 120;
  await pair(`list-${vp.width}`, aPod, cList, vp.width, h, [
    'ต้นแบบ (TMS Subcon · ส่ง POD)',
    'ของจริง (เอกสารรถ)',
  ]);
  await pair(`form-${vp.width}`, aForm, cForm, vp.width, h, [
    'ต้นแบบ (TMS Subcon · ฟอร์มรับงาน)',
    'ของจริง (ฟอร์มส่งเอกสาร + ตรวจช่อง)',
  ]);
  if (vp.width === 390) {
    await pair('driver-390', aPod, cDrv, vp.width, h, [
      'ต้นแบบ (TMS Subcon · ส่ง POD)',
      'ของจริง (ใบขับขี่)',
    ]);
    await pair('invalid-390', aPod, cBad, vp.width, h, [
      'ต้นแบบ (TMS Subcon · ไม่พบ)',
      'ของจริง (ลิงก์ใช้ไม่ได้)',
    ]);
  }
}

// ---------- admin: แท็บเอกสารแนบของผู้รับเหมา (1440) ----------
const vp = { width: 1440, height: 900 };
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(`http://localhost:${port}/TMS%20v4.dc.html`);
await P.waitForTimeout(3000);
await vis(P, 'คนขับและผู้รับเหมา').click();
await P.waitForTimeout(800);
await vis(P, 'ผู้รับเหมา').click();
await P.waitForTimeout(1000);
await P.locator('tbody tr').nth(0).click();
await P.waitForTimeout(900);
await vis(P, 'เอกสารแนบ').click();
await P.waitForTimeout(400);
const aDocs = await P.screenshot();

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
await W.goto('/fleet/drivers');
await W.waitForTimeout(1500);
await W.locator('button', { hasText: /^ผู้รับเหมา/ })
  .first()
  .click();
await W.waitForTimeout(1200);
await W.locator('tbody tr', { hasText: CARRIER }).first().click();
await W.waitForTimeout(900);
await W.getByRole('tab', { name: 'เอกสารแนบ' }).click();
await W.waitForTimeout(800);
const cDocs = await W.screenshot();
await W.getByRole('button', { name: 'สร้างลิงก์' }).click();
await W.waitForTimeout(800);
const cIssued = await W.screenshot();
await W.locator('[data-testid=cdoc-subs] [data-status=pending_review]')
  .first()
  .getByRole('button', { name: 'อนุมัติ', exact: true })
  .click();
await W.waitForTimeout(500);
const cApprove = await W.screenshot();
await pair('admin-docs-1440', aDocs, cDocs, 1440, 960, [
  'ต้นแบบ (TMS v4 · ผู้รับเหมา · เอกสารแนบ)',
  'ของจริง',
]);
await pair('admin-link-1440', aDocs, cIssued, 1440, 960, [
  'ต้นแบบ (TMS v4)',
  'ของจริง (สร้างลิงก์แล้ว)',
]);
await pair('admin-approve-1440', aDocs, cApprove, 1440, 960, [
  'ต้นแบบ (TMS v4)',
  'ของจริง (อนุมัติ — เหตุผล ≥ 10)',
]);
await b.close();
srv.close();
