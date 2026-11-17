// ภาพเทียบ "ต้นแบบ | ของจริง" ของกระดานวางแผน (ST3-T12) ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้องมี web dev (4420) + API dev (4410) ที่รันโค้ด ST3-T12 + seed · ใช้: node scripts/compare-planning.mjs
// (web อื่น: WEB=http://localhost:5720 node scripts/compare-planning.mjs)
// ข้อมูลตัวอย่าง (สมมติ): รถ 4 คัน + SO 6 ใบ (PUT external DEMO-PLAN-*) แล้ววาง 3 เที่ยว — 2 เที่ยวซ้อนเวลาบนรถคันเดียว (แถบแดง)
import { chromium } from '@playwright/test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
const bkk = (d = 0) =>
  new Date(Date.now() + 7 * 3600_000 + d * 86_400_000).toISOString().slice(0, 10);

const vp = { width: 1440, height: 900 };
const b = await chromium.launch();

// ---------- ต้นแบบ ----------
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(`http://localhost:${port}/TMS%20v4.dc.html`);
await P.waitForTimeout(3000);
await P.getByText('กระดานวางแผน', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(1500);
const a = {};
await P.getByRole('button', { name: /^วันนี้/ })
  .first()
  .click();
await P.waitForTimeout(800);
a.day = await P.screenshot();
await P.getByRole('button', { name: /^7 วัน/ })
  .first()
  .click();
await P.waitForTimeout(800);
a.week = await P.screenshot();

// ---------- ของจริง ----------
const ctx = await b.newContext({ viewport: vp, locale: 'th-TH', baseURL: WEB });
const W = await ctx.newPage();
const v = randomBytes(32).toString('base64url');
const r1 = await W.request.post('/v1/auth/login', {
  data: {
    email: 'planner@demo-a.test',
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
const call = async (method, path, data) => {
  const r = await W.request[method](path, {
    headers: { ...H, 'Idempotency-Key': randomUUID() },
    data,
  });
  if (!r.ok()) console.error('seed failed', path, r.status(), (await r.text()).slice(0, 300));
  return r.ok() ? r.json() : null;
};
const cos = await call('get', '/v1/companies?status=active&limit=50');
const vts = (await call('get', '/v1/vehicle-types?limit=50')).data;
const vt = (c) => vts.find((x) => x.code === c)?.id ?? vts[0].id;
const ton = (await call('get', '/v1/units?limit=50')).data.find((u) => u.code === 'TON').id;
const VEH = [
  ['70-1234', '6W', 6000, 'สมชาย ใจดี'],
  ['70-2281', '6W', 6000, 'สุรชัย พรหมมา'],
  ['71-0457', '10W', 15000, 'ธนากร มีชัย'],
  ['70-3312', '10W', 15000, null],
];
const veh = [];
for (const [i, [plate, c, kgCap, drv]] of VEH.entries()) {
  const x = await call('put', `/v1/vehicles/external/DEMO-PLAN-V${i + 1}`, {
    plate,
    plateProvince: 'TH-10',
    vehicleTypeId: vt(c),
    ownership: 'OWN',
    payloadKg: kgCap,
  });
  veh.push(x);
  if (drv && x)
    await call('put', `/v1/drivers/external/DEMO-PLAN-D${i + 1}`, {
      name: drv,
      phone: `081-555-${String(1000 + i)}`,
      employmentType: 'EMPLOYEE_SALARIED',
      licenceClass: 'T2',
      licenceExpiresOn: '2030-03-31',
      defaultVehicleId: x.id,
    });
}
const CUST = [
  'บจก. สยามพลาสติก',
  'บจก. ไทยสตีลไพพ์',
  'บจก. อีสเทิร์นซีฟู้ด',
  'บจก. สระบุรีซีเมนต์โปรดักส์',
  'บจก. เคมีภัณฑ์สากล',
  'บจก. แหลมทองอาหาร',
];
const SITES = [
  ['คลังกรุงเทพ (ตัวอย่าง)', 'กรุงเทพมหานคร'],
  ['โรงงานชลบุรี (ตัวอย่าง)', 'ชลบุรี'],
  ['คลังฉะเชิงเทรา (ตัวอย่าง)', 'ฉะเชิงเทรา'],
  ['คลังระยอง (ตัวอย่าง)', 'ระยอง'],
];
const site = [];
for (const [i, [n, prov]] of SITES.entries())
  site.push(
    await call('put', `/v1/customer-sites/external/DEMO-PLAN-L${i + 1}`, {
      name: n,
      kind: i ? 'DROPOFF' : 'PICKUP',
      address: { line1: '99 ถนนตัวอย่าง', district: 'เมือง', province: prov, postcode: '20000' },
    }),
  );
const W_KG = ['5200', '5400', '6800', '4200', '5800', '3600'];
const so = [];
for (const [i, n] of CUST.entries()) {
  const c = await call('put', `/v1/customers/external/DEMO-PLAN-C${i + 1}`, {
    legalName: n,
    billingCompanyId: cos.data[0].id,
  });
  so.push(
    await call('put', `/v1/orders/external/DEMO-PLAN-${i + 1}`, {
      customer: { id: c.id },
      requestedDate: bkk(i < 4 ? 0 : 1),
      vehicleTypeId: vt(i === 2 ? '10W' : '6W'),
      stops: [
        { type: 'PICKUP', siteId: site[0].id },
        { type: 'DELIVERY', siteId: site[1 + (i % 3)].id },
      ],
      lines: [{ description: 'สินค้าตัวอย่าง', qty: '5', unitId: ton, weightKg: W_KG[i] }],
    }),
  );
}
const board = await call('get', `/v1/planning/board?date=${bkk()}&days=7`);
const at = (h) => `${bkk()}T${h}:00+07:00`;
const PLAN = [
  [0, 0, '08:00', '12:00'],
  [1, 1, '09:00', '13:00'],
  [2, 1, '11:00', '14:00'], // ซ้อนเวลากับเที่ยวก่อนบนรถคันเดียว → แดง
];
for (const [i, vi, s, e] of PLAN) {
  const p = board.pool.find((x) => x.orderNo === so[i]?.soNo);
  if (!p || !veh[vi]) continue;
  await call('post', '/v1/trips', {
    tripDate: bkk(),
    deliveryOrderIds: p.deliveryOrders.map((d) => d.id),
    vehicleId: veh[vi].id,
    plannedStartAt: at(s),
    plannedEndAt: at(e),
  });
}

const c = {};
await W.goto('/plan');
await W.waitForTimeout(2000);
await W.getByRole('tab', { name: /^วันนี้/ }).click();
await W.waitForTimeout(1200);
c.day = await W.screenshot();
await W.getByRole('tab', { name: /^7 วัน/ }).click();
await W.waitForTimeout(1200);
c.week = await W.screenshot();

for (const tag of ['day', 'week']) {
  const M = await (await b.newContext({ viewport: { width: 2900, height: 960 } })).newPage();
  await M.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ (TMS v4) กระดานวางแผน · ${tag === 'day' ? 'วันนี้' : '7 วัน'}</div><img src="data:image/png;base64,${a[tag].toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web /plan)</div><img src="data:image/png;base64,${c[tag].toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st3-planning-${tag}-1440.png` });
  console.log(`wrote design/compare/st3-planning-${tag}-1440.png`);
}
await b.close();
srv.close();
