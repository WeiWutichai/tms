// ภาพเทียบ "ต้นแบบ | ของจริง" ของหน้าเอกสารรถรวม (ST2-T19) ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้นแบบ: เมนู รถ → เอกสารรถ (specFDoc + kpisF('fdoc') + modal ต่ออายุ RNW)
// ต้องมี web dev + API dev ที่รันโค้ด ST2-T19 + seed · ใช้: WEB=http://localhost:4920 node scripts/compare-fleet-docs.mjs
// ข้อมูลตัวอย่าง (สมมติ ตามต้นแบบ fdocs) — รถ PUT external DEMO-D0x ส่งซ้ำได้ · เอกสารสร้างครั้งแรกเท่านั้น (มีฉบับปัจจุบันแล้ว = ข้าม)
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
await vis(P, 'เอกสารรถ').click();
await P.waitForTimeout(1200);
const a = { list: await P.screenshot() };
await vis(P, 'ภายใน 30 วัน').click();
await P.waitForTimeout(600);
a.d30 = await P.screenshot();
await P.locator('tbody tr').nth(0).click();
await P.waitForTimeout(600);
a.renew = await P.screenshot();

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
const vt = (c) => types.find((x) => x.code === c).id;
const VEH = [
  ['DEMO-D01', '70-1234', '6W'],
  ['DEMO-D02', '70-2281', '6W'],
  ['DEMO-D03', '82-4410', '10W'],
];
const vid = {};
for (const [ext, plate, type] of VEH) {
  const r = await W.request.put(`/v1/vehicles/external/${ext}`, {
    headers: H,
    data: { plate, plateProvince: 'TH-10', vehicleTypeId: vt(type), ownership: 'OWN' },
  });
  if (!r.ok()) throw new Error(`seed ${ext}: ${r.status()} ${await r.text()}`);
  vid[ext] = (await r.json()).id;
}
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const upload = async (filename) => {
  const d = await (
    await W.request.post('/v1/documents', {
      headers: H,
      data: { kind: 'VEHICLE_DOC', mime: 'application/pdf', bytes: PDF.length, filename },
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
// ตามรูปแบบ fdocs ของต้นแบบ: เลข POL/CMI/TAX/INS/LIC/DLT-26xxxxx, บริษัท/หน่วยงาน, เบี้ย (สมมติ)
const DOCS = [
  ['DEMO-D01', 'INSURANCE', 'POL-2610431', 'วิริยะประกันภัย', '28500.00', 12],
  ['DEMO-D01', 'COMPULSORY_ACT', 'CMI-2610444', 'ทิพยประกันภัย', '1830.00', 40],
  ['DEMO-D01', 'ANNUAL_TAX', 'TAX-2610457', 'กรมการขนส่งทางบก', '3240.00', 95],
  ['DEMO-D01', 'INSPECTION', 'INS-2610470', 'ตรอ. บางนาการช่าง', '300.00', 92],
  ['DEMO-D02', 'INSURANCE', 'POL-2610528', 'ทิพยประกันภัย', '28500.00', 5],
  ['DEMO-D02', 'COMPULSORY_ACT', 'CMI-2610541', 'กรุงเทพประกันภัย', '1830.00', 27],
  ['DEMO-D02', 'TRANSPORT_LICENSE', 'LIC-2610580', 'กรมการขนส่งทางบก', '2500.00', 18],
  ['DEMO-D02', 'GPS_DLT_CERT', 'DLT-2610593', 'Cartrack / DLT', '1800.00', 44],
  ['DEMO-D03', 'INSURANCE', 'POL-2610625', 'กรุงเทพประกันภัย', '41200.00', 160],
  ['DEMO-D03', 'ANNUAL_TAX', 'TAX-2610651', 'กรมการขนส่งทางบก', '5880.00', -2],
  ['DEMO-D03', 'GPS_DLT_CERT', 'DLT-2610690', 'Cartrack / DLT', '1800.00', 58],
];
for (const [ext, docType, docNo, issuer, cost, off] of DOCS) {
  const r = await W.request.post(`/v1/vehicles/${vid[ext]}/documents`, {
    headers: H,
    data: {
      docType,
      docNo,
      issuer,
      costAmount: cost,
      startsOn: day(off - 365),
      expiresOn: day(off),
      fileDocumentIds: [
        await upload(`${docNo.split('-')[0]}-${VEH.find((x) => x[0] === ext)[1]}.pdf`),
      ],
      ...(docType === 'INSURANCE' ? { insuranceClass: '1', premiumAmount: cost } : {}),
    },
  });
  if (!r.ok() && r.status() !== 409)
    throw new Error(`seed ${docType}: ${r.status()} ${await r.text()}`);
}

await W.goto('/');
await W.evaluate(() => sessionStorage.clear());
await W.goto('/fleet/documents');
await W.waitForTimeout(2000);
const c = { list: await W.screenshot() };
if (process.env.DEBUG_DIR) writeFileSync(`${process.env.DEBUG_DIR}/real-list.png`, c.list);
await W.getByRole('button', { name: /ภายใน 30 วัน/ })
  .first()
  .click();
await W.waitForTimeout(1200);
c.d30 = await W.screenshot();
await W.locator('tbody tr').nth(0).click();
await W.waitForTimeout(700);
c.renew = await W.screenshot();

const pair = async (tag, left, right) => {
  const M = await (await b.newContext({ viewport: { width: 2900, height: 960 } })).newPage();
  await M.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ (TMS v4)</div><img src="data:image/png;base64,${left.toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web)</div><img src="data:image/png;base64,${right.toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st2-vehicle-docs-overview-${tag}-1440.png` });
  console.log(`wrote design/compare/st2-vehicle-docs-overview-${tag}-1440.png`);
};
await pair('list', a.list, c.list);
await pair('d30', a.d30, c.d30);
await pair('renew', a.renew, c.renew);
await b.close();
srv.close();
