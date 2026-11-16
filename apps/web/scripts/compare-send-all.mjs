// ภาพเทียบ "ต้นแบบ | ของจริง" ของ ST3-T18 (Send all — ส่งแผนทั้งวัน + ปฏิทินขึ้นเขียว) — เครื่อง dev เท่านั้น
// ต้นแบบ: กระดานวางแผน ปุ่มหัวหน้า "ส่งแผนให้คนขับ" (กดแล้ว toast) · แท็บ 7 วัน (หัววัน)
// ของจริง: ปุ่มเดียวกัน → dialog เลือกวัน + checkbox "ส่งงานทั้งวันของทุกรถ" · ส่งครบ → หัววันในมุมมอง 7 วันเป็นสีเขียว
//   WEB=http://localhost:4420 node scripts/compare-send-all.mjs
import { chromium } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = process.env.WEB ?? 'http://localhost:4420';
const RUN = String(Date.now()).slice(-6);
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

async function pair(name, left, right, w, h, labels) {
  const M = await (await b.newContext({ viewport: { width: w * 2 + 60, height: h } })).newPage();
  await M.setContent(
    `<body style="margin:0;display:flex;align-items:flex-start;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">${labels[0]}</div><img src="data:image/png;base64,${left.toString('base64')}"></div><div><div style="padding:8px">${labels[1]}</div><img src="data:image/png;base64,${right.toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st3-send-all-${name}-1440.png`, fullPage: true });
  console.log(`wrote design/compare/st3-send-all-${name}-1440.png`);
}

const vp = { width: 1440, height: 900 };
// ---------- ต้นแบบ ----------
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(`http://localhost:${port}/TMS%20v4.dc.html`);
await P.waitForTimeout(3000);
await P.evaluate(() => (location.hash = 'plan'));
await P.waitForTimeout(1500);
const aBoard = await P.screenshot();
await P.getByRole('button', { name: 'ส่งแผนให้คนขับ' }).first().click();
await P.waitForTimeout(500);
const aSent = await P.screenshot();
await P.getByText('7 วัน', { exact: true }).first().click();
await P.waitForTimeout(900);
const aWeek = await P.screenshot();

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
const H = { Authorization: `Bearer ${tok.accessToken ?? tok.access_token}` };
const get = async (p) => (await W.request.get(p, { headers: H })).json();
const post = async (p, data) => (await W.request.post(p, { headers: H, data })).json();
const company = (await get('/v1/companies?status=active&limit=1')).data[0].id;
const cust = await post('/v1/customers', {
  legalName: `บจก. สยามพลาสติกสมมติ ${RUN}`,
  billingCompanyId: company,
});
const site = (name) =>
  post('/v1/customer-sites', { name: `${name} ${RUN}`, kind: 'DROPOFF', address: { line1: name } });
const pA = await site('คลังสินค้า บางนา');
const qA = await site('ร้านวัสดุ ชลบุรี');
const ton = (await get('/v1/units?limit=50')).data.find((u) => u.code === 'TON').id;
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
// วัน +6 (ช่องท้ายของมุมมอง 7 วัน) — ไม่ปนกับเที่ยวเดโมของวันนี้
const day = new Date(Date.parse(`${today}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
const vt = (await get('/v1/vehicle-types?limit=50')).data.find((x) => x.code === '6W');
const so = () =>
  post('/v1/orders', {
    customer: { id: cust.id },
    requestedDate: day,
    vehicleTypeId: vt.id,
    stops: [
      { type: 'PICKUP', siteId: pA.id },
      { type: 'DELIVERY', siteId: qA.id },
    ],
    lines: [{ description: 'เม็ดพลาสติก', qty: '2', unitId: ton, weightKg: '1800' }],
  });
const doOf = async (o) => (await get(`/v1/delivery-orders?orderId=${o.id}`)).data[0].id;
const at = (h) => `${day}T${h}:00:00+07:00`;
for (const n of [1, 2, 3]) {
  const veh = await post('/v1/vehicles', {
    plate: `9${n}-${RUN.slice(-4)}`,
    plateProvince: 'TH-10',
    vehicleTypeId: vt.id,
    ownership: 'OWN',
    payloadKg: 6000,
  });
  await post('/v1/drivers', {
    name: `สมชาย ขับดี ${n}${RUN.slice(-2)}`,
    phone: `08${n + 5}-${RUN.slice(0, 3)}-${RUN.slice(-4)}`,
    employmentType: 'EMPLOYEE_SALARIED',
    licenceClass: 'T2',
    licenceExpiresOn: '2030-03-31',
    defaultVehicleId: veh.id,
  });
  const t = await post('/v1/trips', {
    tripDate: day,
    deliveryOrderIds: [await doOf(await so())],
    vehicleId: veh.id,
    plannedStartAt: at(String(7 + n).padStart(2, '0')),
    plannedEndAt: at(String(9 + n).padStart(2, '0')),
  });
  const pend = t.warnings.filter((w) => !w.confirmed && w.severity !== 'info');
  if (pend.length)
    await post(`/v1/trips/${t.id}/confirm-rules`, {
      ruleKeys: pend.map((w) => w.key),
      overrideReason: 'ลูกค้ายืนยันให้ส่งตามแผนวันนั้น',
    });
}
await W.goto('/plan');
await W.getByRole('tab', { name: /^7 วัน/ }).click();
await W.waitForTimeout(1500);
const bBoard = await W.screenshot();
await W.getByRole('button', { name: 'ส่งแผนให้คนขับ' }).click();
const dlg = W.getByRole('dialog', { name: 'ส่งแผนให้คนขับ' });
await dlg.getByRole('combobox', { name: 'วันที่' }).selectOption(day);
await W.waitForTimeout(600);
const bDialog = await W.screenshot();
await dlg.getByRole('button', { name: /^ส่งแผน \d+ เที่ยว$/ }).click();
await W.waitForTimeout(1500);
const fail = W.getByRole('dialog', { name: /ทำไม่สำเร็จ/ });
if (await fail.isVisible()) {
  console.log('บางเที่ยวของวันนั้นส่งไม่ได้ (ข้อมูลเดโมเดิม) — ปิด dialog');
  await fail.getByRole('button', { name: 'ปิด', exact: true }).last().click();
}
await W.getByTestId(`week-day-${day}`).scrollIntoViewIfNeeded();
await W.waitForTimeout(600);
const bWeek = await W.screenshot();

await pair('button', aBoard, bBoard, 1440, 900, [
  'ต้นแบบ (TMS v4) — กระดานวางแผน ปุ่มหัวหน้า "ส่งแผนให้คนขับ"',
  'ของจริง — ปุ่มเดียวกัน (สิทธิ์ trips:dispatch)',
]);
await pair('dialog', aSent, bDialog, 1440, 900, [
  'ต้นแบบ — กดแล้ว toast ทันที (ไม่มี dialog)',
  'ของจริง — dialog เลือกวัน + checkbox "ส่งงานทั้งวันของทุกรถ" (docs/04 D2)',
]);
await pair('week', aWeek, bWeek, 1440, 900, [
  'ต้นแบบ — แท็บ 7 วัน (หัววัน ไม่มีสถานะส่ง)',
  'ของจริง — ส่งครบ → หัววันเป็นสีเขียว ✓ (#E7F3EC / #17733F)',
]);
await b.close();
srv.close();
