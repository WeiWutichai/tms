// ภาพเทียบ "ต้นแบบ | ของจริง" ของ ST4-T08 (ลิงก์รถร่วม ส่วนสถานะ) — เครื่อง dev เท่านั้น
// ต้นแบบ TMS Subcon แท็บ "ส่ง POD" (ค้นเลข DO → การ์ด DO / ไม่พบ) + แท็บ "งาน" (รับงานแล้ว) ที่ 390 + 1440 px
// ของจริง /link/pod/{token}: ค้น DO → การ์ด DO + แถวจุดรับ/ส่ง + ปุ่ม "ถึงจุดรับ" / หลังกด "ออกจากจุดรับ" / ไม่พบ / แท็บงาน
// ต้องมี web + API ที่ PUBLIC_WEB_BASE_URL = WEB (ข้อมูลตัวอย่างสร้างผ่าน /v1 — ข้อมูลสมมติ):
//   WEB=http://localhost:4420 node scripts/compare-subcon-status.mjs
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
  await M.screenshot({ path: `${out}st4-subcon-status-${name}.png`, fullPage: true });
  console.log(`wrote design/compare/st4-subcon-status-${name}.png`);
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
const rc = await post('/v1/rate-cards', {
  side: 'BUY',
  carrierId: car.id,
  originId: a.id,
  destinationId: bb.id,
  vehicleTypeId: vt6,
  pricingModel: 'PER_TRIP',
  buyRate: '5600',
  validFrom: today,
});
await post(`/v1/rate-cards/${rc.id}/approve`, { reason: 'อนุมัติตามราคาที่ตกลง' });
const so = await post('/v1/orders', {
  customer: { id: cust.id },
  requestedDate: today,
  vehicleTypeId: vt6,
  stops: [
    { type: 'PICKUP', siteId: a.id, windowStart: `${today}T07:00:00+07:00` },
    { type: 'DELIVERY', siteId: bb.id },
  ],
  lines: [{ description: 'ปูนซีเมนต์', qty: '5', unitId: ton, weightKg: '8600' }],
});
const dlv = (await get(`/v1/delivery-orders?orderId=${so.id}`)).data[0];
const trip = await post('/v1/trips', { tripDate: today, deliveryOrderIds: [dlv.id] });
await post(`/v1/trips/${trip.id}/offer`, { carrierId: car.id });
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

for (const vp of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  const w = vp.width;
  const h = vp.height + 160;
  // ต้นแบบ
  const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
  await P.goto(`http://localhost:${port}/TMS%20Subcon.dc.html`);
  await P.waitForTimeout(2500);
  await vis(P, 'ส่ง POD').click();
  await P.waitForTimeout(300);
  const aEmpty = await P.screenshot({ fullPage: true });
  const q = P.getByPlaceholder('เช่น DO-2611-00069').filter({ visible: true });
  await q.fill('DO-2611-00069');
  await P.waitForTimeout(300);
  const aFound = await P.screenshot({ fullPage: true });
  await q.fill('DO-2611-99999');
  await P.waitForTimeout(300);
  const aNf = await P.screenshot({ fullPage: true });
  await vis(P, 'งาน').click();
  await vis(P, 'รับงาน').click();
  const ins = P.getByRole('textbox').filter({ visible: true });
  await ins.nth(0).fill('74-5521 ชบ.');
  await ins.nth(1).fill('สมชาย ใจดี');
  await vis(P, 'ยืนยันรับงาน').click();
  await P.waitForTimeout(3400);
  const aJob = await P.screenshot({ fullPage: true });

  // ของจริง (ไม่ login)
  const C = await (await b.newContext({ viewport: vp, locale: 'th-TH', baseURL: WEB })).newPage();
  await C.goto(podPath);
  await C.waitForTimeout(1500);
  const cEmpty = await C.screenshot({ fullPage: true });
  await C.getByTestId('pdl-q').fill(dlv.doNo);
  await C.waitForTimeout(1200);
  const cFound = await C.screenshot({ fullPage: true });
  let cLeft = cFound;
  if (w === 390) {
    await C.getByRole('button', { name: 'ถึงจุดรับ' }).click();
    await C.waitForTimeout(4500); // ให้ toast หาย
    cLeft = await C.screenshot({ fullPage: true });
  } else {
    await C.reload();
    await C.waitForTimeout(1200);
    await C.getByTestId('pdl-q').fill(dlv.doNo);
    await C.waitForTimeout(1200);
    cLeft = await C.screenshot({ fullPage: true });
  }
  await C.getByTestId('pdl-q').fill('DO-2611-99999');
  await C.waitForTimeout(1200);
  const cNf = await C.screenshot({ fullPage: true });
  await C.getByRole('tab', { name: 'งาน' }).click();
  await C.waitForTimeout(500);
  const cJob = await C.screenshot({ fullPage: true });

  await pair(`empty-${w}`, aEmpty, cEmpty, w, h, [
    'ต้นแบบ (TMS Subcon · ส่ง POD)',
    'ของจริง (/link/pod)',
  ]);
  await pair(`found-${w}`, aFound, cFound, w, h, [
    'ต้นแบบ (พบ DO → รูป/ส่ง POD)',
    'ของจริง (พบ DO → จุดรับ/ส่ง + ถึงจุดรับ; รูป/ลายเซ็น = ST4-T09)',
  ]);
  await pair(`arrived-${w}`, aFound, cLeft, w, h, [
    'ต้นแบบ (ไม่มีปุ่มสถานะ — spec/04 S4)',
    'ของจริง (ถึงจุดรับแล้ว → ออกจากจุดรับ)',
  ]);
  await pair(`notfound-${w}`, aNf, cNf, w, h, ['ต้นแบบ (ไม่พบเลข DO)', 'ของจริง']);
  await pair(`job-${w}`, aJob, cJob, w, h, ['ต้นแบบ (งาน · รับงานแล้ว)', 'ของจริง (แท็บงาน)']);
}
await b.close();
srv.close();
