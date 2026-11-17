// ภาพเทียบ "ต้นแบบ | ของจริง" นัดส่งใหม่อัตโนมัติ (ST4-T12) ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้องมี web dev + API dev ที่รันโค้ด ST4-T12 + seed · ใช้: node scripts/compare-reschedule.mjs
// (port อื่น: WEB=http://localhost:4430 node scripts/compare-reschedule.mjs)
// ข้อมูลตัวอย่าง (สมมติ): เที่ยวปล่อยรถ → ปิดจุดส่ง "ของยังอยู่บนรถ" + ลูกค้าปิดทำการ → DO ส่งซ้ำพรุ่งนี้ (ไทม์ไลน์ + กระดาน)
// แล้วตั้ง dispatch.maxAutoReschedules = 0 ชั่วคราว → อีกใบขึ้นใบค้าง "นัดส่งใหม่ครบแล้ว" (คืนค่า 2 ท้ายสคริปต์)
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
await P.keyboard.press('Escape');
await P.waitForTimeout(500);
await P.getByText('กระดานวางแผน', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(1500);
a.pool = await P.screenshot();
await P.getByText('ใบสั่งขนส่ง (SO)', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(1500);
a.hold = await P.screenshot();

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
let seq = 0;
const bkk = (min) => {
  const d = new Date(Date.now() - min * 60_000 + 7 * 3600_000).toISOString();
  return `${d.slice(0, 16)}:00+07:00`;
};
/** เที่ยวปล่อยรถแล้ว (จุดรับปิด + ถึงจุดส่ง) → ปิดจุดส่ง "ของยังอยู่บนรถ" + ลูกค้าปิดทำการ */
async function failed() {
  const RUN2 = `${RUN}${++seq}`;
  const cust = (
    await post('/v1/customers', {
      legalName: `บจก. ไทยสตีลไพพ์ (ตัวอย่าง ${RUN2})`,
      billingCompanyId: company,
    })
  ).body;
  const addr = (p) => ({ line1: '99 ถนนตัวอย่าง', district: 'เมือง', province: p });
  const sa = (
    await post('/v1/customer-sites', {
      name: `คลังบางนา (ตัวอย่าง ${RUN2})`,
      kind: 'PICKUP',
      address: addr('สมุทรปราการ'),
    })
  ).body;
  const sb = (
    await post('/v1/customer-sites', {
      name: `โรงงานชลบุรี (ตัวอย่าง ${RUN2})`,
      kind: 'DROPOFF',
      address: addr('ชลบุรี'),
    })
  ).body;
  const ton = (await get('/v1/units?limit=50')).data.find((u) => u.code === 'TON').id;
  const vt6 = (await get('/v1/vehicle-types?limit=50')).data.find((x) => x.code === '6W').id;
  const veh = (
    await post('/v1/vehicles', {
      plate: `7${RUN2.slice(0, 1)}-${RUN2.slice(2)}`,
      plateProvince: 'TH-10',
      vehicleTypeId: vt6,
      ownership: 'OWN',
      payloadKg: 6000,
    })
  ).body;
  await post('/v1/drivers', {
    name: `สมชาย ใจดี ${RUN2}`,
    phone: `081-${RUN2.slice(0, 3)}-${RUN2.slice(2)}`,
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
  const [pickup, drop] = trip.stops;
  await post(`/v1/stops/${pickup.id}/arrive`, {
    clientEventId: randomUUID(),
    occurredAt: bkk(150),
  });
  await post(`/v1/stops/${pickup.id}/complete`, {
    clientEventId: randomUUID(),
    occurredAt: bkk(120),
    outcome: 'DELIVERED',
  });
  await post(`/v1/stops/${drop.id}/arrive`, { clientEventId: randomUUID(), occurredAt: bkk(60) });
  const rsn = (await get('/v1/reason-codes?category=DELIVERY_FAILED&limit=100')).data.find(
    (r) => r.code === 'SHOP_CLOSED',
  );
  await post(`/v1/stops/${drop.id}/complete`, {
    clientEventId: randomUUID(),
    occurredAt: bkk(45),
    outcome: 'UNDELIVERED_RETAIN',
    reasonCodeId: rsn.id,
    note: 'ร้านปิด โทรไม่รับสาย ของยังอยู่บนรถ',
  });
  return { so, trip };
}
const one = await failed();
await W.goto('/so');
await W.waitForTimeout(1500);
await W.getByRole('row', { name: new RegExp(one.so.soNo) }).click();
await W.waitForTimeout(800);
await W.getByRole('dialog').getByRole('button', { name: one.trip.tripNo }).click();
await W.waitForTimeout(1000);
await W.getByRole('tab', { name: 'ไทม์ไลน์' }).click();
await W.waitForTimeout(1200);
const c = { timeline: await W.screenshot() };
await W.keyboard.press('Escape');
await W.goto('/plan');
await W.waitForTimeout(2000);
await W.getByTestId(`plan-pool-${one.so.soNo}`).scrollIntoViewIfNeeded();
c.pool = await W.screenshot();
const patch = async (n) => {
  const r = await W.request.patch('/v1/settings', {
    headers: H,
    data: { values: { 'dispatch.maxAutoReschedules': n } },
  });
  if (!r.ok()) throw new Error(`settings ${r.status()}`);
};
await patch(0);
try {
  await failed();
} finally {
  await patch(2);
}
await W.goto('/so/hold');
await W.waitForTimeout(2000);
c.hold = await W.screenshot();
const LABEL = {
  timeline:
    'ต้นแบบ (TMS v4) drawer เที่ยวรถ — แท็บไทม์ไลน์ (ไม่มีบรรทัดนัดส่งใหม่: spec/12 §3 DECISION ST4-T12)',
  pool: 'ต้นแบบ (TMS v4) กระดานวางแผน — การ์ด SO รอจัด (ไม่มีป้าย "ส่งซ้ำ": spec/12 §3 DECISION ST4-T12)',
  hold: 'ต้นแบบไม่มีหน้าใบค้าง — ใช้โครงหน้า SO (spec/12 §3 DECISION ST3-T07) · ป้าย "นัดส่งใหม่ครบแล้ว"',
};
for (const tag of ['timeline', 'pool', 'hold']) {
  const M = await (await b.newContext({ viewport: { width: 2900, height: 960 } })).newPage();
  await M.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">${LABEL[tag]}</div><img src="data:image/png;base64,${a[tag].toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web)</div><img src="data:image/png;base64,${c[tag].toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st4-reschedule-${tag}-1440.png` });
  console.log(`wrote design/compare/st4-reschedule-${tag}-1440.png`);
}
await b.close();
srv.close();
