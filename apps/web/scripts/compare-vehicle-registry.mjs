// ภาพเทียบ "ต้นแบบ | ของจริง" ของ ทะเบียนรถ (แท็บสถานะ + ป้ายเอกสาร) และโปรไฟล์รถ (ST2-T07) ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้องมี web dev + API dev ที่รันโค้ด ST2-T07 + seed · ใช้: node scripts/compare-vehicle-registry.mjs
// (web อื่น: WEB=http://localhost:4620 node scripts/compare-vehicle-registry.mjs) · PROTO_ONLY=<dir> = ถ่ายเฉพาะต้นแบบ
// ข้อมูลตัวอย่าง (สมมติ ตามต้นแบบ) ใส่ผ่าน PUT /v1/vehicles/external/DEMO-V0x — ส่งซ้ำได้ ไม่สร้างแถวซ้ำ
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

// ---------- ต้นแบบ ----------
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(`http://localhost:${port}/TMS%20v4.dc.html`);
await P.waitForTimeout(3000);
await P.getByText('ทะเบียนรถ', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(1200);
const a = { list: await P.screenshot() };
await P.getByText('ซ่อม', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(600);
a.tab = await P.screenshot();
await P.getByText('ทั้งหมด', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(400);
await P.locator('tbody tr').nth(0).click();
await P.waitForTimeout(1000);
a.profile = await P.screenshot();
await P.getByText('เอกสาร', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(600);
a.docs = await P.screenshot();

if (process.env.PROTO_ONLY) {
  for (const [k, v] of Object.entries(a))
    writeFileSync(`${process.env.PROTO_ONLY}/proto-${k}.png`, v);
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
const H = { authorization: `Bearer ${tok.accessToken ?? tok.access_token}` };
const types = (await (await W.request.get('/v1/vehicle-types?limit=50', { headers: H })).json())
  .data;
const vt = (c) => types.find((x) => x.code === c).id;
const tax = (base12) => {
  let s = 0;
  for (let i = 0; i < 12; i++) s += Number(base12[i]) * (13 - i);
  return base12 + String((11 - (s % 11)) % 10);
};
const car = await W.request.put('/v1/carriers/external/DEMO-S01', {
  headers: H,
  data: {
    legalName: 'หจก. ทรัพย์สมบูรณ์ขนส่ง',
    entityType: 'JURISTIC',
    taxId: tax('010355601234'),
  },
});
const carrierId = (await car.json()).id;
// ข้อมูลตัวอย่าง (สมมติ) ตามต้นแบบ specFVeh
const SAMPLE = [
  ['DEMO-V01', '70-1234', 'TH-10', '6W', 'Isuzu', 'FRR 210', 2021, 148220],
  ['DEMO-V02', '70-2281', 'TH-10', '6W', 'Hino', 'XZU 650', 2020, 96410],
  ['DEMO-V03', '71-0457', 'TH-10', '6W', 'Isuzu', 'FRR 210', 2021, 203880],
  ['DEMO-V04', '70-5512', 'TH-20', '6W', 'Hino', 'XZU 650', 2020, 187650],
  ['DEMO-V05', '82-4410', 'TH-20', '10W', 'Hino', 'FM1A 260', 2019, 254100],
];
for (const [ext, plate, prov, type, brand, model, year, odo] of SAMPLE) {
  const r = await W.request.put(`/v1/vehicles/external/${ext}`, {
    headers: H,
    data: {
      plate,
      plateProvince: prov,
      vehicleTypeId: vt(type),
      ownership: 'OWN',
      brand,
      model,
      year,
      odometerKm: odo,
      gpsProvider: 'Cartrack',
    },
  });
  if (!r.ok()) throw new Error(`seed ${ext}: ${r.status()} ${await r.text()}`);
}
const head = await (
  await W.request.put('/v1/vehicles/external/DEMO-V06', {
    headers: H,
    data: {
      plate: '72-1180',
      plateProvince: 'TH-11',
      vehicleTypeId: vt('TRC'),
      ownership: 'SUBCONTRACT',
      carrierId,
      unitRole: 'TRACTOR',
      brand: 'Volvo',
      model: 'FM 440',
      year: 2018,
      odometerKm: 412300,
    },
  })
).json();
const trl = await (
  await W.request.put('/v1/vehicles/external/DEMO-V07', {
    headers: H,
    data: {
      plate: '72-1181',
      plateProvince: 'TH-11',
      vehicleTypeId: vt('TRC'),
      ownership: 'SUBCONTRACT',
      carrierId,
      unitRole: 'TRAILER',
      brand: 'Panus',
      model: 'Flatbed 3 เพลา',
      year: 2018,
    },
  })
).json();
if (!head.paired)
  await W.request.patch(`/v1/vehicles/${head.id}`, {
    headers: H,
    data: { pairedVehicleId: trl.id },
  });

// เอกสารรถตัวอย่าง (สมมติ ตามต้นแบบ fdocs) — ฉบับปัจจุบันมีอยู่แล้ว (409 current_exists) = ข้าม
const byExt = async (ext) =>
  (await (await W.request.get(`/v1/vehicles/ext:${ext}`, { headers: H })).json()).id;
const day = (n) => new Date(Date.now() + 7 * 3600_000 + n * 864e5).toISOString().slice(0, 10);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const upload = async (filename) => {
  const r = await (
    await W.request.post('/v1/documents', {
      headers: H,
      data: { kind: 'VEHICLE_DOC', mime: 'application/pdf', bytes: PDF.length, filename },
    })
  ).json();
  const u = new URL(r.uploadUrl);
  await W.request.put(u.pathname + u.search, {
    headers: { 'content-type': 'application/octet-stream' },
    data: PDF,
  });
  return r.id;
};
const DOCS = [
  ['DEMO-V01', 'INSURANCE', 'POL-2610431', 'วิริยะประกันภัย', 120, '28500.00', 'POL-70-1234.pdf'],
  ['DEMO-V01', 'COMPULSORY_ACT', 'CMI-2610444', 'ทิพยประกันภัย', 210, '1830.00', 'CMI-70-1234.pdf'],
  ['DEMO-V01', 'ANNUAL_TAX', 'TAX-2610457', 'กรมการขนส่งทางบก', 200, '3240.00', 'TAX-70-1234.pdf'],
  ['DEMO-V03', 'INSPECTION', 'INS-2610470', 'ตรอ. บางนา', 12, '200.00', 'INS-71-0457.pdf'],
  ['DEMO-V05', 'COMPULSORY_ACT', 'CMI-2610483', 'ทิพยประกันภัย', -5, '1830.00', 'CMI-82-4410.pdf'],
];
for (const [ext, docType, docNo, issuer, left, cost, file] of DOCS) {
  const vid = await byExt(ext);
  const r = await W.request.post(`/v1/vehicles/${vid}/documents`, {
    headers: H,
    data: {
      docType,
      docNo,
      issuer,
      startsOn: day(left - 365),
      expiresOn: day(left),
      ...(docType === 'INSURANCE'
        ? { insuranceClass: '1', sumInsured: '800000.00', premiumAmount: cost }
        : {}),
      costAmount: cost,
      fileDocumentIds: [await upload(file)],
    },
  });
  if (!r.ok() && r.status() !== 409) throw new Error(`doc ${ext}: ${r.status()} ${await r.text()}`);
}
// สถานะตัวอย่าง: 70-5512 ซ่อม (ต้นแบบมีรถซ่อม 2 คัน)
const v4 = await (await W.request.get(`/v1/vehicles/ext:DEMO-V04`, { headers: H })).json();
if (v4.status === 'ready')
  await W.request.post(`/v1/vehicles/${v4.id}/status`, {
    headers: { ...H, 'If-Match': `"${v4.version}"` },
    data: { status: 'maintenance', reason: 'เข้าอู่เปลี่ยนน้ำมันเครื่อง (ตัวอย่าง)' },
  });

await W.goto('/fleet/vehicles');
await W.waitForTimeout(1500);
const c = { list: await W.screenshot() };
await W.getByRole('tab', { name: /^ซ่อม/ }).click();
await W.waitForTimeout(900);
c.tab = await W.screenshot();
await W.getByRole('tab', { name: /^ทั้งหมด/ }).click();
await W.waitForTimeout(900);
await W.locator('tbody tr').nth(0).click();
await W.waitForTimeout(1200);
c.profile = await W.screenshot();
await W.getByRole('tab', { name: 'เอกสาร', exact: true }).click();
await W.waitForTimeout(1000);
c.docs = await W.screenshot();
if (process.env.DEBUG_DIR)
  for (const [k, v] of Object.entries(c))
    writeFileSync(`${process.env.DEBUG_DIR}/real-${k}.png`, v);

for (const tag of ['list', 'tab', 'profile', 'docs']) {
  const M = await (await b.newContext({ viewport: { width: 2900, height: 960 } })).newPage();
  await M.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ (TMS v4)</div><img src="data:image/png;base64,${a[tag].toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web)</div><img src="data:image/png;base64,${c[tag].toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st2-vehicle-registry-${tag}-1440.png` });
  console.log(`wrote design/compare/st2-vehicle-registry-${tag}-1440.png`);
}
await b.close();
srv.close();
