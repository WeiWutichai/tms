// ภาพเทียบ "ต้นแบบ | ของจริง" ของ ST4-T11 (ตีกลับบางส่วน → ส่งซ้ำ / คืนคลัง) — เครื่อง dev เท่านั้น
// 1440: (dialog) TMS v4 dialog "ตีกลับบางส่วน" | dialog ของจริง (รายการคงเหลือ + การจัดการ ส่งซ้ำ/คืนคลัง + เหตุผล + รูป + โน้ต)
//       (docs) TMS v4 drawer DO (ป้าย/ปุ่ม "ตีกลับบางส่วน") | แท็บเอกสารแนบของเที่ยว (ป้าย + ปุ่ม + สรุปส่งซ้ำ/คืนคลัง)
// ต้องมี web + API (ข้อมูลตัวอย่างสร้างผ่าน /v1 — ข้อมูลสมมติ):
//   WEB=http://localhost:4420 node scripts/compare-return.mjs
import { chromium } from '@playwright/test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
const vis = (p, text) => p.getByText(text, { exact: true }).filter({ visible: true }).first();

async function pair(name, left, right, w, h, labels) {
  const M = await (await b.newContext({ viewport: { width: w * 2 + 60, height: h } })).newPage();
  await M.setContent(
    `<body style="margin:0;display:flex;align-items:flex-start;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">${labels[0]}</div><img src="data:image/png;base64,${left.toString('base64')}"></div><div><div style="padding:8px">${labels[1]}</div><img src="data:image/png;base64,${right.toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st4-return-${name}.png`, fullPage: true });
  console.log(`wrote design/compare/st4-return-${name}.png`);
}

// ---------- ของจริง: ข้อมูลตัวอย่าง ----------
const ctx = await b.newContext({
  viewport: { width: 1440, height: 900 },
  locale: 'th-TH',
  baseURL: WEB,
});
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
const get = async (path) => (await W.request.get(path, { headers: H })).json();
const post = async (path, data) => {
  const r = await W.request.post(path, {
    headers: { ...H, 'Idempotency-Key': randomUUID() },
    data,
  });
  if (r.status() >= 300) throw new Error(`${path} ${r.status()} ${await r.text()}`);
  return r.json();
};
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const day = (n) =>
  new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const company = (await get('/v1/companies?status=active&limit=1')).data[0].id;
const cust = await post('/v1/customers', {
  legalName: `บจก. เอ็นเอสเอฟ อินดัสทรีสมมติ ${RUN}`,
  billingCompanyId: company,
});
const addr = (p) => ({ line1: '1 ถนนทดสอบ', district: 'เมือง', province: p });
const a = await post('/v1/customer-sites', {
  name: `บางปู ${RUN}`,
  kind: 'PICKUP',
  address: addr('สมุทรปราการ'),
});
const bb = await post('/v1/customer-sites', {
  name: `ท่าเรือแหลมฉบัง ประตู 3 ${RUN}`,
  kind: 'DROPOFF',
  address: addr('ชลบุรี'),
});
const ton = (await get('/v1/units?limit=50')).data.find((u) => u.code === 'TON').id;
const vt6 = (await get('/v1/vehicle-types?limit=50')).data.find((x) => x.code === '6W').id;
const pngFile = (n) => ({
  name: `pod-${n}.png`,
  mimeType: 'image/png',
  buffer: Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(`photo-${n}-${RUN}`),
  ]),
});
const shot = (p) => p.screenshot();

// ---------- ของจริง 1440: เที่ยวของบริษัท (ส่งถึงแล้ว) + rate card ต่อตัน ----------
const vt = { width: 1440, height: 900 };
const own = await post('/v1/vehicles', {
  plate: `7${RUN.slice(0, 1)}-${RUN.slice(2)}`,
  plateProvince: 'TH-10',
  vehicleTypeId: vt6,
  ownership: 'OWN',
  payloadKg: 16000,
});
await post('/v1/drivers', {
  name: `สมศักดิ์ ขยัน ${RUN}`,
  phone: `089-${RUN.slice(0, 3)}-${RUN.slice(-4)}`,
  employmentType: 'EMPLOYEE_SALARIED',
  licenceClass: 'T2',
  licenceExpiresOn: day(300),
  defaultVehicleId: own.id,
});
const rc = await post('/v1/rate-cards', {
  customerId: cust.id,
  originId: a.id,
  destinationId: bb.id,
  vehicleTypeId: vt6,
  validFrom: day(-30),
  pricingModel: 'PER_TON',
  sellRate: '350',
  includedStops: 2,
});
await post(`/v1/rate-cards/${rc.id}/approve`, { reason: 'อนุมัติตามใบเสนอราคา' });
const so = await post('/v1/orders', {
  customer: { id: cust.id },
  requestedDate: today,
  vehicleTypeId: vt6,
  stops: [
    { type: 'PICKUP', siteId: a.id },
    { type: 'DELIVERY', siteId: bb.id },
  ],
  lines: [
    { description: 'ปูนซีเมนต์ 50 กก.', qty: '20', unitId: ton, weightKg: '20000' },
    { description: 'เหล็กเส้น 12 มม.', qty: '5', unitId: ton, weightKg: '5000' },
  ],
});
const dlv = (await get(`/v1/delivery-orders?orderId=${so.id}`)).data[0];
const t0 = await post('/v1/trips', {
  tripDate: today,
  deliveryOrderIds: [dlv.id],
  vehicleId: own.id,
});
const asg = await W.request.post(`/v1/trips/${t0.id}/assign`, {
  headers: { ...H, 'Idempotency-Key': randomUUID() },
  data: { vehicleId: own.id, dispatch: true },
});
if (asg.status() !== 200) {
  const w = await asg.json();
  await post(`/v1/trips/${t0.id}/assign`, {
    vehicleId: own.id,
    dispatch: true,
    ruleKeys: (w.warnings ?? []).map((x) => x.key),
    overrideReason: 'ภาพเทียบตีกลับ ยืนยันคำเตือน',
  });
}
const trip = await get(`/v1/trips/${t0.id}`);
let mm = 150;
for (const s of trip.stops)
  for (const [act, extra] of [
    ['arrive', {}],
    ['complete', { outcome: 'DELIVERED' }],
  ])
    await post(`/v1/stops/${s.id}/${act}`, {
      clientEventId: randomUUID(),
      occurredAt: new Date(Date.now() - (mm -= 20) * 60_000).toISOString(),
      ...extra,
    });


// ต้นแบบ 1440 — drawer DO (ปุ่ม "ตีกลับบางส่วน") แล้ว dialog
const P = await (await b.newContext({ viewport: vt, locale: 'th-TH' })).newPage();
await P.goto(`http://localhost:${port}/TMS%20v4.dc.html`);
await P.waitForTimeout(3000);
await P.evaluate(() => (location.hash = 'do'));
await P.waitForTimeout(1500);
let rt = null;
for (let i = 0; i < 6 && !rt; i++) {
  await P.locator('text=/^DO-2611-\\d+$/').nth(i).click();
  await P.waitForTimeout(900);
  const x = P.getByText('ตีกลับบางส่วน', { exact: true }).filter({ visible: true });
  if (await x.count()) rt = x.last();
  else await P.keyboard.press('Escape');
}
const aDocs = await shot(P);
await rt.click();
await P.waitForTimeout(600);
await P.locator('label', { hasText: 'ล็อต A' }).filter({ visible: true }).first().click();
await P.waitForTimeout(300);
const aDlg = await shot(P);

// ของจริง 1440 — บันทึกหลักฐานส่ง (ส่งจริง 10/20 + เหตุผล) แล้วเปิด dialog
await W.setViewportSize(vt);
await W.goto('/so');
await W.waitForTimeout(1500);
await W.getByRole('row', { name: new RegExp(so.soNo) }).click();
await W.waitForTimeout(800);
await W.getByRole('dialog').getByRole('button', { name: trip.tripNo }).click();
await W.waitForTimeout(1000);
await W.getByRole('tab', { name: 'เอกสารแนบ' }).click();
await W.waitForTimeout(1200);
await W.getByLabel('อัปโหลดรูป').setInputFiles(pngFile(1));
await W.getByText(/รูปที่ 1 · /).waitFor();
const sec = W.getByTestId('actual-qty');
await sec.getByLabel('จำนวนที่ส่งจริง ปูนซีเมนต์ 50 กก.').fill('10');
await sec.getByRole('combobox').selectOption({ label: 'จำนวนไม่ครบ' });
await sec.getByPlaceholder(/กล่องบุบ/).fill('ถุงแตก 200 ถุง ผู้รับไม่รับ');
await W.getByRole('button', { name: 'บันทึกหลักฐานส่ง' }).click();
const btn = W.getByTestId('do-return').getByRole('button', { name: 'ตีกลับบางส่วน' });
await btn.waitFor();
await btn.scrollIntoViewIfNeeded();
await W.waitForTimeout(500);
const cDocs = await shot(W);
await btn.click();
const dlg = W.getByTestId('return-dialog');
await dlg.getByRole('checkbox').first().check();
await dlg.getByPlaceholder(/กล่องบุบ/).fill('ถุงแตก 200 ถุง ลูกค้าขอรอบหน้า');
await W.waitForTimeout(400);
const cDlg = await shot(W);
await dlg.getByRole('button', { name: 'บันทึกตีกลับ' }).click();
await W.getByTestId('do-return').getByText(/ส่งซ้ำแล้ว/).waitFor();
await W.getByTestId('do-return').scrollIntoViewIfNeeded();
await W.waitForTimeout(800);
const cAfter = await shot(W);

await pair('dialog-1440', aDlg, cDlg, 1440, 960, [
  'ต้นแบบ (TMS v4) dialog "ตีกลับบางส่วน"',
  'ของจริง — + "การจัดการ" ส่งซ้ำ/คืนคลัง · จำนวน = ปฏิเสธคงเหลือ · รูป = รูปหลักฐานส่ง (DECISION spec/12 §3)',
]);
await pair('docs-1440', aDocs, cDocs, 1440, 960, [
  'ต้นแบบ (TMS v4) drawer DO — ปุ่ม "ตีกลับบางส่วน"',
  'ของจริง — แท็บเอกสารแนบของเที่ยว: ป้าย + ปุ่ม "ตีกลับบางส่วน" (ยังไม่มี drawer DO #24)',
]);
await pair('after-1440', aDocs, cAfter, 1440, 960, [
  'ต้นแบบ (TMS v4) drawer DO',
  'ของจริง — หลังส่งซ้ำ: สรุป "ส่งซ้ำแล้ว · คืนคลังแล้ว" ปุ่มหาย (ไม่มีในต้นแบบ — spec/12 §3)',
]);
await b.close();
srv.close();
