// ภาพเทียบ "ต้นแบบ | ของจริง" ของ Filter รถที่รับได้สองทาง (ST3-T15) ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้องมี web dev (4420) + API dev (4410) ที่รันโค้ด ST3-T15 + seed · ใช้: node scripts/compare-eligible.mjs
// ข้อมูลตัวอย่าง (สมมติ) DEMO-PLAN-E* — รถห้องเย็น/รถธรรมดา + SO ห้องเย็น
// ภาพ: order = ต้นแบบลาก SO วางบนแถวรถ (ขอบเขียว/แดง) | ของจริงคลิก SO → ทุกแถวขอบเขียว/ส้ม/แดง ที่ไม่ผ่านจาง ·
// vehicle = คลิกรถ → การ์ด SO ที่รถรับได้ · move = "ย้ายไปรถอื่น"
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
await P.getByRole('button', { name: /^วันนี้/ })
  .first()
  .click();
await P.waitForTimeout(800);
await P.evaluate(() => window.scrollTo(0, 260));
await P.waitForTimeout(300);
const a = {};
a.vehicle = await P.screenshot();
// ลากการ์ด SO แรกค้างไว้บนแถวรถแถวแรก (ขอบเขียว/แดงของต้นแบบเกิดตอนลากผ่าน)
{
  const card = P.locator('[draggable="true"]').first();
  const ca = await card.boundingBox().catch(() => null);
  if (ca) {
    await P.mouse.move(ca.x + ca.width / 2, ca.y + ca.height / 2);
    await P.mouse.down();
    await P.mouse.move(ca.x + ca.width / 2 + 10, ca.y + ca.height / 2 + 10, { steps: 3 });
    await P.mouse.move(ca.x + 700, ca.y + 60, { steps: 12 });
    await P.waitForTimeout(500);
    a.order = await P.screenshot();
    await P.mouse.up();
  } else {
    console.error('prototype: ไม่พบการ์ด SO');
    a.order = a.vehicle;
  }
}
await P.waitForTimeout(500);
const mv = P.getByRole('button', { name: 'ย้ายไปรถอื่น' }).first();
await mv.scrollIntoViewIfNeeded().catch(() => console.error('prototype: ไม่พบ ย้ายไปรถอื่น'));
await P.waitForTimeout(300);
a.move = await P.screenshot();

// ---------- ของจริง ----------
const login = async (email) => {
  const ctx = await b.newContext({ viewport: vp, locale: 'th-TH', baseURL: WEB });
  const W = await ctx.newPage();
  const v = randomBytes(32).toString('base64url');
  const r1 = await W.request.post('/v1/auth/login', {
    data: {
      email,
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
  return { W, H: { Authorization: `Bearer ${tok.accessToken}` } };
};
const { W, H } = await login('planner@demo-a.test');
const call = async (method, path, data, h = H, page = W) => {
  const r = await page.request[method](path, {
    headers: { ...h, 'Idempotency-Key': randomUUID() },
    data,
  });
  if (!r.ok()) console.error('seed failed', path, r.status(), (await r.text()).slice(0, 300));
  return r.ok() ? r.json() : null;
};
const cos = await call('get', '/v1/companies?status=active&limit=50');
const vts = (await call('get', '/v1/vehicle-types?limit=50')).data;
const vt = (c) => vts.find((x) => x.code === c)?.id ?? vts[0].id;
const ton = (await call('get', '/v1/units?limit=50')).data.find((u) => u.code === 'TON').id;
const vput = (ext, plate, code, payloadKg) =>
  call('put', `/v1/vehicles/external/${ext}`, {
    plate,
    plateProvince: 'TH-10',
    vehicleTypeId: vt(code),
    ownership: 'OWN',
    payloadKg,
  });
const cold = await vput('DEMO-PLAN-E1', '70-4401', 'REF6', 5000);
await vput('DEMO-PLAN-E2', '70-4402', 'REF6', 3000);
const dry = await call('get', '/v1/vehicles?limit=200').then(
  (r) => r.data.find((x) => x.plate === '70-2281') ?? null,
);
const s1 = await call('put', '/v1/customer-sites/external/DEMO-PLAN-L1', {
  name: 'คลังกรุงเทพ (ตัวอย่าง)',
  kind: 'PICKUP',
  address: {
    line1: '99 ถนนตัวอย่าง',
    district: 'เมือง',
    province: 'กรุงเทพมหานคร',
    postcode: '10200',
  },
});
const s2 = await call('put', '/v1/customer-sites/external/DEMO-PLAN-L2', {
  name: 'โรงงานชลบุรี (ตัวอย่าง)',
  kind: 'DROPOFF',
  address: { line1: '99 ถนนตัวอย่าง', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' },
});
const c1 = await call('put', '/v1/customers/external/DEMO-PLAN-C4', {
  legalName: 'บจก. ห้องเย็นตัวอย่าง',
  billingCompanyId: cos.data[0].id,
});
const order = (ext, code, weightKg) =>
  call('put', `/v1/orders/external/${ext}`, {
    customer: { id: c1.id },
    requestedDate: bkk(),
    vehicleTypeId: vt(code),
    stops: [
      { type: 'PICKUP', siteId: s1.id },
      { type: 'DELIVERY', siteId: s2.id },
    ],
    lines: [{ description: 'นมพาสเจอไรซ์ (ตัวอย่าง)', qty: '4', unitId: ton, weightKg }],
  });
const so = await order('DEMO-PLAN-E1', 'REF6', '4000');
await order('DEMO-PLAN-E2', '6W', '2000');
const so3 = await order('DEMO-PLAN-E3', 'REF6', '3500');
// เที่ยวห้องเย็นบนรถธรรมดา (ติดเงื่อนไข) ไว้ภาพ "ย้ายไปรถอื่น"
{
  const b0 = await call('get', `/v1/planning/board?date=${bkk()}&days=1`);
  const p3 = b0.pool.find((x) => x.orderNo === so3?.soNo);
  const target = dry ?? cold;
  if (p3 && target)
    await call('post', '/v1/trips', {
      tripDate: bkk(),
      deliveryOrderIds: p3.deliveryOrders.map((d) => d.id),
      vehicleId: target.id,
      plannedStartAt: `${bkk()}T14:00:00+07:00`,
      plannedEndAt: `${bkk()}T17:00:00+07:00`,
    });
}
const c = {};
await W.goto('/plan');
await W.waitForTimeout(2000);
await W.getByRole('tab', { name: /^วันนี้/ }).click();
await W.waitForTimeout(1200);
await W.evaluate(() => window.scrollTo(0, 260));
await W.getByTestId(`plan-pool-${so?.soNo}`).getByText(/→/).click();
await W.waitForTimeout(1200);
c.order = await W.screenshot();
await W.keyboard.press('Escape');
await W.getByTestId('plan-veh-70-4402').click();
await W.waitForTimeout(1200);
c.vehicle = await W.screenshot();
await W.keyboard.press('Escape');
await W.getByRole('tab', { name: /^7 วัน/ }).click();
await W.waitForTimeout(1200);
const card = W.getByTestId(/^plan-trip-/)
  .filter({ hasText: so3?.soNo ?? '' })
  .first();
await card.scrollIntoViewIfNeeded().catch(() => {});
await card.click().catch(() => console.error('real: ไม่พบเที่ยว'));
await W.waitForTimeout(500);
c.move = await W.screenshot();

const LABEL = {
  order: [
    'ลาก SO ผ่านแถวรถ → ขอบเขียว = วางได้ / ขอบแดง = วางไม่ได้ (เฉพาะแถวที่ชี้)',
    'คลิก SO ห้องเย็น → ทุกแถว: เขียว = รับได้ · ส้ม = คำเตือน · แดง = ห้ามจ่ายงาน · ที่ไม่ผ่านจาง',
  ],
  vehicle: [
    'กระดาน (ต้นแบบไม่มีการเลือกรถ)',
    'คลิกรถ (ห้องเย็น 3,000 กก.) → การ์ด SO ที่รับได้ขอบเขียว · ไม่ได้จาง',
  ],
  move: ['"ต้องย้ายรถ · ย้ายไปรถอื่น"', 'popover การ์ดเที่ยวติดเงื่อนไข → "ย้ายไปรถอื่น"'],
};
for (const tag of Object.keys(LABEL)) {
  const X = await (await b.newContext({ viewport: { width: 2900, height: 960 } })).newPage();
  await X.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ (TMS v4) ${LABEL[tag][0]}</div><img src="data:image/png;base64,${a[tag].toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web /plan) · ${LABEL[tag][1]}</div><img src="data:image/png;base64,${c[tag].toString('base64')}"></div></body>`,
  );
  await X.screenshot({ path: `${out}st3-eligible-${tag}-1440.png` });
  console.log(`wrote design/compare/st3-eligible-${tag}-1440.png`);
}
await b.close();
srv.close();
