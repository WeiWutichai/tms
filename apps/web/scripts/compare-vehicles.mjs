// ภาพเทียบ "ต้นแบบ | ของจริง" ของหน้า รถ → ทะเบียนรถ (ST2-T06) ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้องมี web dev + API dev ที่รันโค้ด ST2-T06 + seed · ใช้: node scripts/compare-vehicles.mjs
// (web อื่น: WEB=http://localhost:4620 node scripts/compare-vehicles.mjs) · PROTO_ONLY=<dir> = ถ่ายเฉพาะต้นแบบ
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

// ต้นแบบต้องเปิดผ่าน http (file:// ตารางว่าง)
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
await P.getByText('ทะเบียนรถ', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(1200);
const a = { list: await P.screenshot() };
await P.getByText('เพิ่มรถ', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(900);
a.create = await P.screenshot();
await P.getByText('เพิ่มรถ', { exact: true }).filter({ visible: true }).last().click();
await P.waitForTimeout(500);
a.invalid = await P.screenshot();
await close(P);
// แก้ไข = drawer รถ (ต้นแบบเปิดจากปุ่ม "แก้ไข" ในโปรไฟล์รถ)
await P.locator('tbody tr').nth(0).click();
await P.waitForTimeout(900);
await P.getByText('แก้ไข', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(900);
a.drawer = await P.screenshot();
await P.getByText('กิจกรรม', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(400);
a.act = await P.screenshot();

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

await W.goto('/fleet/vehicles');
await W.waitForTimeout(1500);
const c = { list: await W.screenshot() };
if (process.env.DEBUG_DIR) writeFileSync(`${process.env.DEBUG_DIR}/real-list.png`, c.list);
await W.getByRole('button', { name: 'เพิ่มรถ' }).click();
await W.waitForTimeout(900);
c.create = await W.screenshot();
await W.getByRole('dialog').getByRole('button', { name: 'เพิ่มรถ' }).click();
await W.waitForTimeout(400);
c.invalid = await W.screenshot();
await W.keyboard.press('Escape');
await W.waitForTimeout(300);
await W.locator('tbody tr').nth(0).click();
await W.waitForTimeout(900);
c.drawer = await W.screenshot();
await W.getByRole('tab', { name: 'กิจกรรม' }).click();
await W.waitForTimeout(800);
c.act = await W.screenshot();

for (const tag of ['list', 'create', 'invalid', 'drawer', 'act']) {
  const M = await (await b.newContext({ viewport: { width: 2900, height: 960 } })).newPage();
  await M.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ (TMS v4)</div><img src="data:image/png;base64,${a[tag].toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web)</div><img src="data:image/png;base64,${c[tag].toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st2-vehicles-${tag}-1440.png` });
  console.log(`wrote design/compare/st2-vehicles-${tag}-1440.png`);
}
await b.close();
srv.close();
