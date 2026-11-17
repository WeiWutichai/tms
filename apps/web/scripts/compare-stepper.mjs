// ภาพเทียบ "ต้นแบบ | ของจริง" แท็บไทม์ไลน์ของ drawer เที่ยวรถ (ST4-T04 stepper) ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้องมี web dev + API dev ที่รันโค้ด ST4-T04 + seed · ใช้: node scripts/compare-stepper.mjs
// (port อื่น: WEB=http://localhost:4430 node scripts/compare-stepper.mjs)
// ข้อมูลตัวอย่าง (สมมติ): สร้างเที่ยว → ปล่อยรถ → บันทึกถึงจุด/ปิดงานจุดรับย้อนเวลา ผ่าน /v1 จริง
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

// ---------- ต้นแบบ ----------
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(`http://localhost:${port}/TMS%20v4.dc.html`);
await P.waitForTimeout(3000);
await P.evaluate(() => (location.hash = 'trips'));
await P.waitForTimeout(1500);
await P.getByText('TRP-2611-0041', { exact: true }).first().click();
await P.waitForTimeout(900);
await P.getByText('ไทม์ไลน์', { exact: true }).filter({ visible: true }).last().click();
await P.waitForTimeout(700);
const a = { timeline: await P.screenshot() };
a.dialog = a.timeline;

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
// เที่ยวที่ปล่อยรถแล้ว 1 เที่ยว (จุดรับ + จุดส่ง) — ทางเดียวกับ e2e/stop-event-flags.spec.ts
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
    plate: `7${RUN.slice(0, 1)}-${RUN.slice(1)}`,
    plateProvince: 'TH-10',
    vehicleTypeId: vt6,
    ownership: 'OWN',
    payloadKg: 6000,
  })
).body;
await post('/v1/drivers', {
  name: `สมชาย ใจดี ${RUN}`,
  phone: `081-${RUN.slice(0, 3)}-${RUN.slice(1)}`,
  employmentType: 'EMPLOYEE_SALARIED',
  licenceClass: 'T2',
  licenceExpiresOn: '2030-03-31',
  defaultVehicleId: veh.id,
});
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
const [pickup] = trip.stops;
const bkk = (min) => {
  const d = new Date(Date.now() - min * 60_000 + 7 * 3600_000).toISOString();
  return `${d.slice(0, 16)}:00+07:00`;
};
// จุดรับ: ถึง → ปิดงาน (ย้อนเวลา) แทนคนขับ
await post(`/v1/stops/${pickup.id}/arrive`, { clientEventId: randomUUID(), occurredAt: bkk(150) });
await post(`/v1/stops/${pickup.id}/complete`, {
  clientEventId: randomUUID(),
  occurredAt: bkk(120),
  outcome: 'DELIVERED',
});

await W.goto('/so');
await W.waitForTimeout(1500);
await W.getByRole('row', { name: new RegExp(so.soNo) }).click();
await W.waitForTimeout(800);
await W.getByRole('dialog').getByRole('button', { name: trip.tripNo }).click();
await W.waitForTimeout(1000);
await W.getByRole('tab', { name: 'ไทม์ไลน์' }).click();
await W.waitForTimeout(1200);
const c = { timeline: await W.screenshot() };
await W.getByTestId('trip-step').nth(1).getByRole('button', { name: 'ปิดงาน' }).click();
await W.waitForTimeout(800);
c.dialog = await W.screenshot();

const LABEL = {
  timeline: 'ต้นแบบ (TMS v4) drawer เที่ยวรถ — แท็บไทม์ไลน์ "ความคืบหน้าเที่ยว"',
  dialog: 'ต้นแบบไม่มีปุ่ม/dialog บันทึกแทนคนขับ (spec/12 §3 DECISION ST4-T04 — กรอบ vDialog เดิม)',
};
for (const tag of ['timeline', 'dialog']) {
  const M = await (await b.newContext({ viewport: { width: 2900, height: 960 } })).newPage();
  await M.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">${LABEL[tag]}</div><img src="data:image/png;base64,${a[tag].toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web drawer เที่ยวรถ)</div><img src="data:image/png;base64,${c[tag].toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st4-stepper-${tag}-1440.png` });
  console.log(`wrote design/compare/st4-stepper-${tag}-1440.png`);
}
await b.close();
srv.close();
