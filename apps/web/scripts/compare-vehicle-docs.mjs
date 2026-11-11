// ภาพเทียบ "ต้นแบบ | ของจริง" ของเอกสารรถ (ST2-T17) ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้นแบบ: drawer รถ แท็บ "เอกสารแนบ" (vPanel veh `P.docs`), ตารางเอกสารในโปรไฟล์รถ (`pr.docs`), modal ต่ออายุ (`RNW`)
// ของจริง: drawer รถ แท็บ "เอกสารแนบ" + modal ต่ออายุ + modal เพิ่มเอกสาร + ประวัติการต่ออายุ
// ต้องมี web dev + API dev ที่รันโค้ด ST2-T17 + seed · ใช้: WEB=http://localhost:4620 node scripts/compare-vehicle-docs.mjs
// ข้อมูลตัวอย่าง (สมมติ) — รถ DEMO-V01 (PUT external ส่งซ้ำได้) + เอกสารสร้างครั้งแรกเท่านั้น (มีฉบับปัจจุบันแล้ว = ข้าม)
import { chromium } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = process.env.WEB ?? 'http://localhost:4420';
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
const vis = (page, text) => page.getByText(text, { exact: true }).filter({ visible: true }).first();

// ---------- ต้นแบบ ----------
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(`http://localhost:${port}/TMS%20v4.dc.html`);
await P.waitForTimeout(3000);
await vis(P, 'ทะเบียนรถ').click();
await P.waitForTimeout(1200);
await P.locator('tbody tr').nth(0).click();
await P.waitForTimeout(1000);
await vis(P, 'เอกสาร').click();
await P.waitForTimeout(600);
const a = { profile: await P.screenshot() };
await P.getByRole('button', { name: 'ต่ออายุ' }).filter({ visible: true }).first().click();
await P.waitForTimeout(600);
a.renew = await P.screenshot();
await P.keyboard.press('Escape');
await P.getByRole('button', { name: 'ยกเลิก' })
  .filter({ visible: true })
  .first()
  .click()
  .catch(() => {});
await P.waitForTimeout(400);
await vis(P, 'แก้ไข').click();
await P.waitForTimeout(900);
await vis(P, 'เอกสารแนบ').click();
await P.waitForTimeout(500);
a.drawer = await P.screenshot();

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
const { code } = await (
  await W.request.post('/v1/auth/login', {
    data: {
      email: 'owner@demo-a.test',
      password: 'demo-password-2569',
      codeChallenge: createHash('sha256').update(v).digest('base64url'),
    },
  })
).json();
const tok = await (
  await W.request.post('/v1/oauth/token', {
    data: { grantType: 'authorization_code', code, codeVerifier: v },
  })
).json();
const H = { authorization: `Bearer ${tok.accessToken ?? tok.access_token}` };
const types = (await (await W.request.get('/v1/vehicle-types?limit=50', { headers: H })).json())
  .data;
const veh = await (
  await W.request.put('/v1/vehicles/external/DEMO-V01', {
    headers: H,
    data: {
      plate: '70-1234',
      plateProvince: 'TH-10',
      vehicleTypeId: types.find((x) => x.code === '6W').id,
      ownership: 'OWN',
      brand: 'Isuzu',
      model: 'FRR 210',
      year: 2021,
    },
  })
).json();
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const upload = async (name) => {
  const d = await (
    await W.request.post('/v1/documents', {
      headers: H,
      data: { kind: 'VEHICLE_DOC', mime: 'application/pdf', bytes: PDF.length, filename: name },
    })
  ).json();
  const u = new URL(d.uploadUrl);
  await W.request.put(u.pathname + u.search, {
    data: PDF,
    headers: { 'content-type': 'application/octet-stream' },
  });
  return d.id;
};
const day = (n) => new Date(Date.now() + 7 * 3600_000 + n * 86400_000).toISOString().slice(0, 10);
// ข้อมูลตัวอย่างตามต้นแบบ (fdocs ของ 70-1234): บริษัทประกัน/เบี้ย/หน่วยงาน สมมติ
const SAMPLE = [
  [
    'INSURANCE',
    'POL-26-10431',
    'วิริยะประกันภัย',
    '28500.00',
    12,
    { insuranceClass: '1', sumInsured: '800000.00', premiumAmount: '28500.00' },
  ],
  ['COMPULSORY_ACT', 'CMI-26-20431', 'ทิพยประกันภัย', '1830.00', 40],
  ['ANNUAL_TAX', 'TAX-26-30431', 'กรมการขนส่งทางบก', '3240.00', 95],
  ['INSPECTION', 'INS-26-40431', 'ตรอ. บางนาการช่าง', '300.00', 92],
  ['TRANSPORT_LICENSE', 'LIC-26-50431', 'กรมการขนส่งทางบก', '2500.00', 160],
  ['GPS_DLT_CERT', 'DLT-26-60431', 'กรมการขนส่งทางบก', '500.00', -2],
];
for (const [docType, docNo, issuer, cost, off, extra] of SAMPLE) {
  const r = await W.request.post(`/v1/vehicles/${veh.id}/documents`, {
    headers: H,
    data: {
      docType,
      docNo,
      issuer,
      costAmount: cost,
      startsOn: day(off - 365),
      expiresOn: day(off),
      fileDocumentIds: [await upload(`${docNo}.pdf`)],
      ...(extra ?? {}),
    },
  });
  if (!r.ok() && r.status() !== 409)
    throw new Error(`seed ${docType}: ${r.status()} ${await r.text()}`);
}

await W.goto('/fleet/vehicles');
await W.waitForTimeout(1500);
await W.locator('tbody tr', { hasText: '70-1234' }).first().click();
await W.waitForTimeout(900);
await W.getByRole('tab', { name: 'เอกสารแนบ' }).click();
await W.waitForTimeout(900);
const c = { drawer: await W.screenshot() };
c.profile = c.drawer;
await W.getByTestId('vdoc-list').getByRole('button', { name: 'ต่ออายุ' }).first().click();
await W.waitForTimeout(600);
c.renew = await W.screenshot();
await W.getByRole('dialog').getByRole('button', { name: 'ยกเลิก' }).click();
await W.waitForTimeout(300);
await W.getByRole('button', { name: 'เพิ่มเอกสาร' }).click();
await W.waitForTimeout(600);
const add = await W.screenshot();
await W.getByRole('dialog').getByRole('button', { name: 'ยกเลิก' }).click();
await W.waitForTimeout(300);
const hist = W.getByRole('button', { name: /ประวัติการต่ออายุ/ });
if (await hist.count()) {
  await hist.click();
  await W.waitForTimeout(400);
}
const history = await W.screenshot();

const pair = async (tag, left, right, leftLabel = 'ต้นแบบ (TMS v4)') => {
  const M = await (await b.newContext({ viewport: { width: 2900, height: 960 } })).newPage();
  await M.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">${leftLabel}</div><img src="data:image/png;base64,${left.toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web)</div><img src="data:image/png;base64,${right.toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st2-vehicle-docs-${tag}-1440.png` });
  console.log(`wrote design/compare/st2-vehicle-docs-${tag}-1440.png`);
};
await pair('drawer', a.drawer, c.drawer);
await pair('profile', a.profile, c.profile, 'ต้นแบบ (TMS v4) — ตารางเอกสารในโปรไฟล์รถ (ST2-T07)');
await pair('renew', a.renew, c.renew);
// ต้นแบบไม่มีฟอร์มเพิ่มเอกสาร/ประวัติ → เทียบกับ modal ต่ออายุ (pattern ที่ใช้) และ drawer ต้นแบบ
await pair('add', a.renew, add, 'ต้นแบบ (TMS v4) — modal ต่ออายุ (pattern ของฟอร์มเพิ่ม)');
await pair('history', a.drawer, history);
await b.close();
srv.close();
