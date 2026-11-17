// ภาพเทียบ "ต้นแบบ | ของจริง" ของ ST4-T10 (ยอดส่งจริง + เหตุผลปฏิเสธรับ + วางบิลตามยอดจริง) — เครื่อง dev เท่านั้น
// 1440: (pod) TMS v4 dialog "ตีกลับบางส่วน" | หลักฐานส่งในแท็บเอกสารแนบของเที่ยว (จำนวนที่ส่งจริง + เหตุผล)
//       (customer) drawer ลูกค้า แท็บเงื่อนไข · (order) drawer ใบสั่ง ส่วนราคา + ยอดวางบิลตามยอดส่งจริง
// 390 + 1440: (link) TMS Subcon "ส่ง POD" | ลิงก์รถร่วม ส่วน "จำนวนที่ส่งจริง" (แถว −/+ ตาม TMS Driver App M4) + เหตุผล
// ต้องมี web + API ที่ PUBLIC_WEB_BASE_URL = WEB (ข้อมูลตัวอย่างสร้างผ่าน /v1 — ข้อมูลสมมติ):
//   WEB=http://localhost:4420 node scripts/compare-actual-qty.mjs
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
  await M.screenshot({ path: `${out}st4-actual-qty-${name}.png`, fullPage: true });
  console.log(`wrote design/compare/st4-actual-qty-${name}.png`);
}

/** เลขนิติบุคคล (checksum ถูก) — ข้อมูลสมมติ */
function jurTax(n) {
  const base = `0105${String(n).padStart(8, '0')}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
  return base + String((11 - (sum % 11)) % 10);
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
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const CAR = `หจก. ศรีราชาโลจิสติกส์สมมติ ${RUN}`;
const car = await post('/v1/carriers', {
  legalName: CAR,
  entityType: 'JURISTIC',
  taxId: jurTax(Number(RUN) + 901),
  paymentTermDays: 15,
});
const PLATE = `74-${RUN.slice(-4)}`;
const veh = await post('/v1/vehicles', {
  plate: PLATE,
  plateProvince: 'TH-20',
  vehicleTypeId: vt6,
  ownership: 'SUBCONTRACT',
  carrierId: car.id,
});
for (const docType of ['INSURANCE', 'COMPULSORY_ACT']) {
  const f = await post('/v1/documents', {
    kind: 'VEHICLE_DOC',
    mime: 'application/pdf',
    bytes: PDF.length,
    filename: `${docType}.pdf`,
  });
  const u = new URL(f.uploadUrl);
  await W.request.put(u.pathname + u.search, {
    headers: { ...H, 'Content-Type': 'application/octet-stream' },
    data: PDF,
  });
  await post(`/v1/vehicles/${veh.id}/documents`, {
    docType,
    docNo: `${docType.slice(0, 3)}-${RUN}`,
    ...(docType === 'INSURANCE' ? { issuer: 'บริษัท ประกันสมมติ จำกัด', insuranceClass: '1' } : {}),
    startsOn: day(-100),
    expiresOn: day(200),
    fileDocumentIds: [f.id],
  });
}
const PHONE = `08${RUN.slice(-4)}${RUN.slice(-4)}`;
await post('/v1/drivers', {
  name: `สมชาย ใจดี ${RUN}`,
  phone: PHONE,
  employmentType: 'CARRIER_DRIVER',
  carrierId: car.id,
  licenceClass: 'T2',
  licenceExpiresOn: day(300),
});

/** SO → เที่ยว → จ้างรถร่วม → รับงาน → ปล่อยรถ → (ผ่านลิงก์) ถึงจุดรับ/ออก/ถึงจุดส่ง — คืน path ลิงก์งาน + เลข DO */
async function atDrop() {
  const so = await post('/v1/orders', {
    customer: { id: cust.id },
    requestedDate: today,
    vehicleTypeId: vt6,
    stops: [
      { type: 'PICKUP', siteId: a.id, windowStart: `${today}T07:00:00+07:00` },
      { type: 'DELIVERY', siteId: bb.id },
    ],
    lines: [
      { description: 'ปูนซีเมนต์ 50 กก.', qty: '5', unitId: ton, weightKg: '5000' },
      { description: 'เหล็กเส้น 12 มม.', qty: '3', unitId: ton, weightKg: '3000' },
    ],
  });
  const dlv = (await get(`/v1/delivery-orders?orderId=${so.id}`)).data[0];
  const trip = await post('/v1/trips', { tripDate: today, deliveryOrderIds: [dlv.id] });
  await post(`/v1/trips/${trip.id}/offer`, {
    carrierId: car.id,
    cost: '5600',
    selectionReason: 'ตกลงราคาทางโทรศัพท์แล้ว',
  });
  const offerTok = new URL((await get(`/v1/trips/${trip.id}/offer-link`)).link.url).pathname
    .split('/')
    .pop();
  const acc = await W.request.post(`/v1/public/offers/${offerTok}/accept`, {
    data: { vehiclePlate: `${PLATE} ชบ.`, driverName: `สมชาย ใจดี ${RUN}`, driverPhone: PHONE },
  });
  if (acc.status() !== 200) throw new Error(`accept ${acc.status()} ${await acc.text()}`);
  const podPath = new URL((await get(`/v1/trips/${trip.id}/offer-link`)).podLink.url).pathname;
  const dsp = await W.request.post(`/v1/trips/${trip.id}/dispatch`, { headers: H, data: {} });
  if (dsp.status() !== 200) {
    const w = await dsp.json();
    await post(`/v1/trips/${trip.id}/dispatch`, {
      ruleKeys: (w.warnings ?? []).map((x) => x.key),
      overrideReason: 'ภาพเทียบลิงก์รถร่วม',
    });
  }
  const tk = podPath.split('/').pop();
  const m = (await (await W.request.get(`/v1/public/pod/${tk}?doNo=${dlv.doNo}`)).json()).match;
  const ago = (min) =>
    `${new Date(Date.now() - min * 60_000 + 7 * 3600_000).toISOString().slice(0, 19)}+07:00`;
  const ev = async (stopId, type, min, extra = {}) => {
    const r = await W.request.post(`/v1/public/pod/${tk}/stops/${stopId}/events`, {
      data: { type, clientEventId: randomUUID(), occurredAt: ago(min), ...extra },
    });
    if (r.status() >= 300) throw new Error(`${type} ${r.status()} ${await r.text()}`);
  };
  await ev(m.pickup.id, 'ARRIVE', 40);
  await ev(m.pickup.id, 'COMPLETE', 35, { outcome: 'DELIVERED' });
  await ev(m.delivery.id, 'DEPART', 35);
  await ev(m.delivery.id, 'ARRIVE', 5);
  return { podPath, doNo: dlv.doNo };
}

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
    overrideReason: 'ภาพเทียบยอดส่งจริง ยืนยันคำเตือน',
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

// ต้นแบบ 1440
const P = await (await b.newContext({ viewport: vt, locale: 'th-TH' })).newPage();
await P.goto(`http://localhost:${port}/TMS%20v4.dc.html`);
await P.waitForTimeout(3000);
await P.evaluate(() => (location.hash = 'do'));
await P.waitForTimeout(1500);
await P.locator('text=/^DO-2611-\\d+$/').first().click();
await P.waitForTimeout(900);
const rt = P.getByText('ตีกลับบางส่วน', { exact: true }).filter({ visible: true });
if (await rt.count()) await rt.last().click();
else {
  // DO แรกไม่ใช่ "ส่งแล้ว/ระหว่างส่ง" — ลองแถวถัดไป
  await P.keyboard.press('Escape');
  await P.locator('text=/^DO-2611-\\d+$/').nth(1).click();
  await P.waitForTimeout(900);
  await P.getByText('ตีกลับบางส่วน', { exact: true }).filter({ visible: true }).last().click();
}
await P.waitForTimeout(600);
await P.locator('label', { hasText: 'ล็อต A' }).filter({ visible: true }).first().click();
await P.waitForTimeout(300);
const aPod = await shot(P);
await P.goto(`http://localhost:${port}/TMS%20v4.dc.html`);
await P.waitForTimeout(3000);
await P.getByText('ข้อมูลหลัก', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(400);
await P.getByText('ลูกค้า', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(1200);
await P.locator('tbody tr').nth(1).click();
await P.waitForTimeout(900);
await P.getByText('เงื่อนไข', { exact: true }).filter({ visible: true }).last().click();
await P.waitForTimeout(600);
const aCust = await shot(P);
await P.goto(`http://localhost:${port}/TMS%20v4.dc.html`);
await P.waitForTimeout(3000);
await P.getByText('ใบสั่งขนส่ง (SO)', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(1200);
await P.locator('tbody tr').nth(0).click();
await P.waitForTimeout(900);
const aOrder = await shot(P);

// ของจริง 1440 — หลักฐานส่ง: รูป + ส่งจริง 18/20 + เหตุผล + โน้ต (ยังไม่บันทึก)
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
await sec.getByLabel('จำนวนที่ส่งจริง ปูนซีเมนต์ 50 กก.').fill('18');
await sec.getByRole('combobox').selectOption({ label: 'จำนวนไม่ครบ' });
await sec.getByPlaceholder(/กล่องบุบ/).fill('ถุงแตก 40 ถุง ผู้รับไม่รับ');
await sec.scrollIntoViewIfNeeded();
await W.waitForTimeout(400);
const cPod = await shot(W);
await W.getByRole('button', { name: 'บันทึกหลักฐานส่ง' }).click();
await W.getByTestId('do-pod')
  .getByText('POD ครบ')
  .waitFor()
  .catch(() => {});
await W.waitForTimeout(800);

// ลูกค้า แท็บเงื่อนไข → ตามยอดส่งจริง
await W.goto('/master/customers');
await W.waitForTimeout(1500);
await W.getByPlaceholder('ค้นหา').nth(1).fill(`อินดัสทรีสมมติ ${RUN}`);
await W.waitForTimeout(1200);
await W.getByRole('row', { name: new RegExp(`อินดัสทรีสมมติ ${RUN}`) })
  .last()
  .click();
await W.waitForTimeout(800);
await W.getByRole('tab', { name: 'เงื่อนไข' }).click();
await W.getByRole('radio', { name: 'ตามยอดส่งจริง' }).click();
await W.waitForTimeout(400);
const cCust = await shot(W);
await W.getByRole('button', { name: 'บันทึก' }).click();
await W.waitForTimeout(1200);

// ใบสั่ง: ยอดวางบิลตามยอดส่งจริง
await W.goto('/so');
await W.waitForTimeout(1500);
await W.getByRole('row', { name: new RegExp(so.soNo) }).click();
await W.waitForTimeout(1000);
await W.getByTestId('bill-actual').scrollIntoViewIfNeeded();
await W.waitForTimeout(400);
const cOrder = await shot(W);

await pair('pod-1440', aPod, cPod, 1440, 960, [
  'ต้นแบบ (TMS v4) dialog "ตีกลับบางส่วน" — รายการ + เหตุผล + โน้ต',
  'ของจริง หลักฐานส่ง (แท็บเอกสารแนบของเที่ยว) — จำนวนที่ส่งจริง + เหตุผล + โน้ต (DECISION spec/12 §3)',
]);
await pair('customer-1440', aCust, cCust, 1440, 960, [
  'ต้นแบบ (TMS v4) drawer ลูกค้า แท็บเงื่อนไข — ไม่มีช่องวางบิลตามปริมาณ',
  'ของจริง — เพิ่ม "วางบิลตามปริมาณ: ตามใบสั่ง / ตามยอดส่งจริง" (DECISION spec/12 §3)',
]);
await pair('order-1440', aOrder, cOrder, 1440, 960, [
  'ต้นแบบ (TMS v4) drawer ใบสั่ง ส่วนราคา',
  'ของจริง — ยอดประมาณตามยอดส่งจริง (preview — กติกาเงิน OPEN spec/12 §3)',
]);

// ---------- ลิงก์รถร่วม 390 + 1440 ----------
for (const vp of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  const w = vp.width;
  const { podPath, doNo } = await atDrop();
  const PP = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
  await PP.goto(`http://localhost:${port}/TMS%20Subcon.dc.html`);
  await PP.waitForTimeout(2500);
  await vis(PP, 'ส่ง POD').click();
  await PP.waitForTimeout(300);
  await PP.getByPlaceholder('เช่น DO-2611-00069').filter({ visible: true }).fill('DO-2611-00069');
  await vis(PP, '+ เพิ่มรูป').click();
  await PP.waitForTimeout(300);
  const aLink = await PP.screenshot({ fullPage: true });
  const C = await (
    await b.newContext({ viewport: vp, locale: 'th-TH', baseURL: WEB, hasTouch: w === 390 })
  ).newPage();
  await C.goto(podPath);
  await C.waitForTimeout(1500);
  await C.getByTestId('pdl-q').fill(doNo);
  await C.waitForTimeout(1500);
  await C.getByTestId('pdl-photo-input').setInputFiles([pngFile(1)]);
  await C.getByText('รูปที่ 1', { exact: false }).waitFor();
  await C.getByRole('button', { name: 'ลด ปูนซีเมนต์ 50 กก.' }).click();
  await C.getByRole('button', { name: 'จำนวนไม่ครบ' }).click();
  await C.waitForTimeout(300);
  const cLink = await C.screenshot({ fullPage: true });
  await pair(`link-${w}`, aLink, cLink, w, vp.height + 600, [
    'ต้นแบบ TMS Subcon "ส่ง POD" (ไม่มียอดส่งจริง)',
    'ของจริง — จำนวนที่ส่งจริง (TMS Driver App M4) + เหตุผล (DECISION spec/12 §3)',
  ]);
}
await b.close();
srv.close();
