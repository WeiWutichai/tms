// ภาพเทียบ "ต้นแบบ | ของจริง" ของ ST3-T17 (จัดรถ แยกจาก ปล่อยเที่ยว + bulk) — เครื่อง dev เท่านั้น
// ต้นแบบ: drawer เที่ยวรถ (footer "ปล่อยเที่ยว") · drawer SO "รถ / คนขับ" → "จัดรถ" (select รถ + คนขับ) · แถบ bulk ของรายการ
// ของจริง: drawer เที่ยวรถ ส่วน "รถ / คนขับ" + footer "จัดรถ"/"ปล่อยเที่ยว" · กระดาน Shift+คลิกการ์ด → แถบ "เลือก N รายการ"
//   WEB=http://localhost:4420 node scripts/compare-assign.mjs
import { chromium } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = process.env.WEB ?? `http://localhost:${process.env.WEB_PORT ?? 4420}`;
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
  await M.screenshot({ path: `${out}st3-assign-${name}-1440.png`, fullPage: true });
  console.log(`wrote design/compare/st3-assign-${name}-1440.png`);
}

const vp = { width: 1440, height: 900 };
// ---------- ต้นแบบ ----------
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(`http://localhost:${port}/TMS%20v4.dc.html`);
await P.waitForTimeout(3000);
await P.evaluate(() => (location.hash = 'trips'));
await P.waitForTimeout(1500);
await P.getByText('DO-2611-00072', { exact: true })
  .first()
  .dragTo(P.getByText('TRP-2611-0053', { exact: true }).first());
await P.waitForTimeout(500);
await P.getByText('TRP-2611-0053', { exact: true }).first().click();
await P.waitForTimeout(900);
const aDrawer = await P.screenshot();
await P.locator('aside').getByRole('button', { name: 'ปล่อยเที่ยว' }).click();
await P.waitForTimeout(400);
const aReleased = await P.screenshot();
// drawer SO ที่ยังไม่จัดรถ → ลิงก์ "จัดรถ" → select รถ + คนขับ
await P.evaluate(() => (location.hash = 'so'));
await P.waitForTimeout(1500);
await P.locator('tbody tr').filter({ hasText: 'รับคำสั่งแล้ว' }).first().click();
await P.waitForTimeout(900);
await P.locator('aside').getByRole('button', { name: 'จัดรถ', exact: true }).first().click();
await P.waitForTimeout(600);
const aPick = await P.screenshot();
await P.keyboard.press('Escape');
await P.waitForTimeout(400);
await P.evaluate(() => (location.hash = 'dash'));
await P.waitForTimeout(600);
await P.evaluate(() => (location.hash = 'so'));
await P.waitForTimeout(1200);
const boxes = P.locator('tbody input[type=checkbox]');
await boxes.nth(0).check();
await boxes.nth(1).check();
await P.waitForTimeout(400);
const aBulk = await P.screenshot();

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
const day = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
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
const mk = async (n, withDriver) => {
  const veh = await post('/v1/vehicles', {
    plate: `8${n}-${RUN.slice(-4)}`,
    plateProvince: 'TH-10',
    vehicleTypeId: vt.id,
    ownership: 'OWN',
    payloadKg: 6000,
  });
  if (withDriver)
    await post('/v1/drivers', {
      name: `สมชาย ขับดี ${n}${RUN.slice(-2)}`,
      phone: `08${n}-${RUN.slice(0, 3)}-${RUN.slice(-4)}`,
      employmentType: 'EMPLOYEE_SALARIED',
      licenceClass: 'T2',
      licenceExpiresOn: '2030-03-31',
      defaultVehicleId: veh.id,
    });
  return veh;
};
const at = (h) => `${day}T${h}:00:00+07:00`;
const v1 = await mk(1, true);
const v2 = await mk(2, true);
const v3 = await mk(3, false);
const o1 = await so();
const t1 = await post('/v1/trips', {
  tripDate: day,
  deliveryOrderIds: [await doOf(o1), await doOf(await so())],
  vehicleId: v1.id,
  plannedStartAt: at('08'),
  plannedEndAt: at('10'),
});
const t2 = await post('/v1/trips', {
  tripDate: day,
  deliveryOrderIds: [await doOf(await so())],
  vehicleId: v2.id,
  plannedStartAt: at('09'),
  plannedEndAt: at('11'),
});
const t3 = await post('/v1/trips', {
  tripDate: day,
  deliveryOrderIds: [await doOf(await so())],
  vehicleId: v3.id,
  plannedStartAt: at('09'),
  plannedEndAt: at('11'),
});
await W.goto('/so');
await W.getByRole('row', { name: new RegExp(o1.soNo) }).click();
await W.waitForTimeout(800);
await W.getByRole('dialog').getByRole('button', { name: t1.tripNo }).click();
await W.waitForTimeout(900);
const bDrawer = await W.screenshot();
await W.getByTestId('trip-assign').getByRole('button', { name: 'จัดรถ' }).click();
await W.waitForTimeout(900);
const bPick = await W.screenshot();
await W.getByRole('dialog').getByRole('button', { name: 'ปล่อยเที่ยว' }).click();
await W.waitForTimeout(900);
const warn = W.getByRole('dialog', { name: 'ยืนยันคำเตือนก่อนปล่อยเที่ยว' });
if (await warn.isVisible()) {
  await warn.getByRole('textbox').fill('ลูกค้ายืนยันให้ส่งตามแผนวันนี้');
  await warn.getByRole('button', { name: 'ยืนยันและบันทึก log' }).click();
  await W.waitForTimeout(900);
}
const bReleased = await W.screenshot();
await W.goto('/plan');
await W.getByRole('tab', { name: /^วันนี้/ }).click();
await W.waitForTimeout(1200);
for (const t of [t2, t3]) {
  const c = W.getByTestId(`plan-trip-${t.tripNo}`).locator('.tms-plan-card');
  await c.scrollIntoViewIfNeeded();
  await c.click({ modifiers: ['Shift'] });
}
await W.getByTestId('plan-bulk').scrollIntoViewIfNeeded();
await W.mouse.move(5, 5);
await W.waitForTimeout(500);
const bBulk = await W.screenshot();
await W.getByTestId('plan-bulk').getByRole('button', { name: 'ปล่อยเที่ยว' }).click();
await W.waitForTimeout(1200);
const bFail = await W.screenshot();

await pair('drawer', aDrawer, bDrawer, 1440, 960, [
  'ต้นแบบ (TMS v4) — drawer เที่ยวรถ footer "ปล่อยเที่ยว"',
  'ของจริง — ส่วน "รถ / คนขับ" + footer "จัดรถ" / "ปล่อยเที่ยว"',
]);
await pair('form', aPick, bPick, 1440, 960, [
  'ต้นแบบ — drawer SO "จัดรถ" (select รถ + คนขับ)',
  'ของจริง — drawer เที่ยวรถ "จัดรถ" (+ คนขับสำรอง)',
]);
await pair('released', aReleased, bReleased, 1440, 960, [
  'ต้นแบบ — ปล่อยเที่ยว (toast)',
  'ของจริง — ปล่อยเที่ยว (toast, DO ทุกใบ DISPATCHED)',
]);
await pair('bulk', aBulk, bBulk, 1440, 960, [
  'ต้นแบบ — แถบ bulk ของรายการ ("เลือก N รายการ")',
  'ของจริง — กระดาน Shift+คลิกการ์ด → แถบ "เลือก N รายการ"',
]);
await pair('bulkfail', aReleased, bFail, 1440, 960, [
  'ต้นแบบ (ไม่มี — ปล่อยได้ทุกเที่ยว)',
  'ของจริง — ผลต่อรายการ: ทำไม่สำเร็จ 1 เที่ยว',
]);
await b.close();
srv.close();
