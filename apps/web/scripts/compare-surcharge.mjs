// ภาพเทียบ "ต้นแบบ | ของจริง" ค่าใช้จ่ายหน้างาน (ST4-T13) ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้นแบบ: drawer DO แท็บ "ค่าใช้จ่ายหน้างาน" · ของจริง: drawer เที่ยว แท็บ "ค่าใช้จ่ายหน้างาน" (ยังไม่มี drawer DO — spec/12 §3)
// ต้องมี web dev + API dev ที่รันโค้ด ST4-T13 + seed · ใช้: node scripts/compare-surcharge.mjs
// ข้อมูลตัวอย่าง (สมมติ): สร้างเที่ยว → ปล่อยรถ → บันทึก "ค่ารอคิว" 500 พร้อมรูป ผ่าน /v1 จริง
import { chromium } from '@playwright/test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = process.env.WEB ?? 'http://localhost:4420';
const out = fileURLToPath(new URL('../../../design/compare/', import.meta.url));
const protoDir = fileURLToPath(new URL('../../../design/prototype/', import.meta.url));
const RUN = String(Date.now()).slice(-5);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const srv = createServer((req, res) => {
  const p = join(protoDir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(protoDir) || !existsSync(p)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
  createReadStream(p).pipe(res);
}).listen(0);
const port = srv.address().port;
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);

const vp = { width: 1440, height: 900 };
const b = await chromium.launch();

// ---------- ต้นแบบ: drawer DO ที่ส่งแล้ว (มีค่าทางด่วนตัวอย่าง) → แท็บค่าใช้จ่ายหน้างาน ----------
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(`http://localhost:${port}/TMS%20v4.dc.html`);
await P.waitForTimeout(3000);
await P.evaluate(() => (location.hash = 'do'));
await P.waitForTimeout(1500);
await P.getByText('ส่งแล้ว', { exact: true }).filter({ visible: true }).nth(1).click();
await P.waitForTimeout(900);
await P.getByText('ค่าใช้จ่ายหน้างาน', { exact: true }).filter({ visible: true }).last().click();
await P.waitForTimeout(700);
const a = { list: await P.screenshot() };
await P.getByText('เพิ่มรายการ', { exact: true }).filter({ visible: true }).last().click();
await P.waitForTimeout(500);
a.add = await P.screenshot();

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
const H = { Authorization: `Bearer ${tok.accessToken}` };
const get = async (path) => (await W.request.get(path, { headers: H })).json();
const post = async (path, data, ok = true) => {
  const r = await W.request.post(path, {
    headers: { ...H, 'Idempotency-Key': randomUUID() },
    data,
  });
  if (ok && !r.ok()) throw new Error(`${path} ${r.status()} ${(await r.text()).slice(0, 300)}`);
  return { status: r.status(), body: await r.json() };
};
const company = (await get('/v1/companies?status=active&limit=1')).data[0].id;
const cust = (
  await post('/v1/customers', {
    legalName: `บจก. ไทยสตีลไพพ์ (ตัวอย่าง ${RUN})`,
    billingCompanyId: company,
  })
).body;
const addr = (p) => ({ line1: '99 ถนนตัวอย่าง', district: 'เมือง', province: p });
const sa = (
  await post('/v1/customer-sites', {
    name: `คลังบางนา (ตัวอย่าง ${RUN})`,
    kind: 'PICKUP',
    address: addr('สมุทรปราการ'),
  })
).body;
const sb = (
  await post('/v1/customer-sites', {
    name: `โรงงานชลบุรี (ตัวอย่าง ${RUN})`,
    kind: 'DROPOFF',
    address: addr('ชลบุรี'),
  })
).body;
const ton = (await get('/v1/units?limit=50')).data.find((u) => u.code === 'TON').id;
const vt6 = (await get('/v1/vehicle-types?limit=50')).data.find((x) => x.code === '6W').id;
const veh = (
  await post('/v1/vehicles', {
    plate: `6${RUN.slice(0, 1)}-${RUN.slice(1)}`,
    plateProvince: 'TH-10',
    vehicleTypeId: vt6,
    ownership: 'OWN',
    payloadKg: 6000,
  })
).body;
await post('/v1/drivers', {
  name: `สมชาย ใจดี ${RUN}`,
  phone: `082-${RUN.slice(0, 3)}-${RUN.slice(1)}`,
  employmentType: 'EMPLOYEE_SALARIED',
  licenceClass: 'T2',
  licenceExpiresOn: '2030-03-31',
  defaultVehicleId: veh.id,
});
const item = (
  await post('/v1/service-items', {
    name: `ค่ารอคิว (ตัวอย่าง ${RUN})`,
    calcUnit: 'PER_HOUR',
    defaultPrice: '200.00',
    vatType: 'VAT_7',
    whtRate: '3.00',
    side: 'BOTH',
    isSurcharge: true,
  })
).body;
const toll = (await get('/v1/service-items?limit=200&status=active')).data.find(
  (x) => x.code === 'TOLL',
);
const so = (
  await post('/v1/orders', {
    customer: { id: cust.id },
    requestedDate: today,
    vehicleTypeId: vt6,
    stops: [
      { type: 'PICKUP', siteId: sa.id },
      { type: 'DELIVERY', siteId: sb.id },
    ],
    lines: [{ description: 'ท่อเหล็ก', qty: '1', unitId: ton, weightKg: '1500' }],
  })
).body;
const doId = (await get(`/v1/delivery-orders?orderId=${so.id}`)).data[0].id;
const t0 = (
  await post('/v1/trips', { tripDate: today, deliveryOrderIds: [doId], vehicleId: veh.id })
).body;
let asg = await post(`/v1/trips/${t0.id}/assign`, { vehicleId: veh.id, dispatch: true }, false);
if (asg.status === 409 && asg.body.warnings)
  asg = await post(`/v1/trips/${t0.id}/assign`, {
    vehicleId: veh.id,
    dispatch: true,
    ruleKeys: asg.body.warnings.map((w) => w.key),
    overrideReason: 'ข้อมูลตัวอย่างภาพเทียบ ยืนยันคำเตือน',
  });
if (asg.status >= 300)
  throw new Error(`dispatch ${asg.status} ${JSON.stringify(asg.body).slice(0, 300)}`);
const trip = await get(`/v1/trips/${t0.id}`);
// รูปใบเสร็จ + บรรทัด: ค่ารอคิว (เก็บลูกค้า) 500 และ ค่าทางด่วน (ต้นทุน) 180
async function receipt() {
  const d = (
    await post('/v1/documents', {
      kind: 'RECEIPT',
      mime: 'image/png',
      bytes: PNG.length,
      filename: 'receipt.png',
    })
  ).body;
  const up = new URL(d.uploadUrl);
  await W.request.put(up.pathname + up.search, {
    data: PNG,
    headers: { 'content-type': 'application/octet-stream' },
  });
  return d;
}
const doc = await receipt();
await post(`/v1/trips/${t0.id}/field-charges`, {
  side: 'SELL',
  serviceItemId: item.id,
  deliveryOrderId: doId,
  sellUnitPrice: '500.00',
  evidenceDocumentId: doc.id,
});
await post(`/v1/trips/${t0.id}/field-charges`, {
  side: 'BUY',
  serviceItemId: toll.id,
  costAmount: '180.00',
  evidenceDocumentId: (await receipt()).id,
});

await W.goto('/so');
await W.waitForTimeout(1500);
await W.getByRole('row', { name: new RegExp(so.soNo) }).click();
await W.waitForTimeout(800);
await W.getByRole('dialog').getByRole('button', { name: trip.tripNo }).click();
await W.waitForTimeout(1000);
await W.getByRole('tab', { name: 'ค่าใช้จ่ายหน้างาน' }).click();
await W.waitForTimeout(1200);
const c = { list: await W.screenshot() };
await W.getByRole('button', { name: 'เพิ่มรายการ' }).click();
await W.waitForTimeout(600);
c.add = await W.screenshot();

const LABEL = {
  list: 'ต้นแบบ (TMS v4) drawer DO — แท็บ "ค่าใช้จ่ายหน้างาน" (ของจริงอยู่ใน drawer เที่ยว — spec/12 §3 DECISION ST4-T13)',
  add: 'ต้นแบบ: "เพิ่มรายการ" = แถว select + ยอด (ของจริงเพิ่ม ฝั่ง/รูปใบเสร็จ/บันทึก — spec/12 §3 DECISION ST4-T13)',
};
for (const tag of ['list', 'add']) {
  const M = await (await b.newContext({ viewport: { width: 2900, height: 960 } })).newPage();
  await M.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">${LABEL[tag]}</div><img src="data:image/png;base64,${a[tag].toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web drawer เที่ยวรถ)</div><img src="data:image/png;base64,${c[tag].toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st4-surcharge-${tag}-1440.png` });
  console.log(`wrote design/compare/st4-surcharge-${tag}-1440.png`);
}
await b.close();
srv.close();
