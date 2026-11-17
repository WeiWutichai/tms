// ภาพเทียบ "ต้นแบบ | ของจริง" ของ ST3-T23 (ลิงก์ข้อเสนองานรถร่วม) — เครื่อง dev เท่านั้น
// หน้าลิงก์ (public, ไม่ login): ต้นแบบ TMS Subcon แท็บ "งาน" ที่ 390 + 1440 px — ใบสั่งงาน / ฟอร์มรับงาน / รับงานแล้ว /
// เหตุผลปฏิเสธ / ปฏิเสธแล้ว · ผู้จัดรถ: TMS v4 drawer "จ่ายงานรถร่วม" (รอตอบ · ใบสั่งงาน + ลิงก์ · กิจกรรม · รับงานแล้ว) ที่ 1440 px
// ต้องมี web + API ที่ PUBLIC_WEB_BASE_URL = WEB (ข้อมูลตัวอย่างสร้างผ่าน /v1 — ข้อมูลสมมติ):
//   WEB=http://localhost:4420 node scripts/compare-offer-link.mjs
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
  await M.screenshot({ path: `${out}st3-offer-link-${name}.png`, fullPage: true });
  console.log(`wrote design/compare/st3-offer-link-${name}.png`);
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
const offered = async () => {
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
  const doId = (await get(`/v1/delivery-orders?orderId=${so.id}`)).data[0].id;
  const trip = await post('/v1/trips', { tripDate: today, deliveryOrderIds: [doId] });
  await post(`/v1/trips/${trip.id}/offer`, { carrierId: car.id });
  const l = await get(`/v1/trips/${trip.id}/offer-link`);
  return { so, trip, path: new URL(l.link.url).pathname };
};
const T1 = await offered();
const T2 = await offered();
const T3 = await offered();

// ---------- หน้าลิงก์ (390 + 1440) ----------
for (const vp of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
  await P.goto(`http://localhost:${port}/TMS%20Subcon.dc.html`);
  await P.waitForTimeout(2500);
  const aJob = await P.screenshot({ fullPage: true });
  await vis(P, 'รับงาน').click();
  await P.waitForTimeout(300);
  const aForm = await P.screenshot({ fullPage: true });
  const ins = P.getByRole('textbox').filter({ visible: true });
  await ins.nth(0).fill('74-5521 ชบ.');
  await ins.nth(1).fill('สมชาย ใจดี');
  await ins.nth(2).fill('081-234-5678');
  await vis(P, 'ยืนยันรับงาน').click();
  await P.waitForTimeout(300);
  const aAcc = await P.screenshot({ fullPage: true });
  await P.reload();
  await P.waitForTimeout(2500);
  await vis(P, 'ปฏิเสธ').click();
  await vis(P, 'ราคาไม่คุ้มต้นทุน').click();
  await P.waitForTimeout(300);
  const aDec = await P.screenshot({ fullPage: true });
  await vis(P, 'ยืนยันปฏิเสธ').click();
  await P.waitForTimeout(300);
  const aDecd = await P.screenshot({ fullPage: true });

  const pub = await (await b.newContext({ viewport: vp, locale: 'th-TH', baseURL: WEB })).newPage();
  const first = vp.width === 390;
  await pub.goto(first ? T1.path : T3.path);
  await pub.waitForTimeout(1500);
  const cJob = await pub.screenshot({ fullPage: true });
  await pub.getByRole('button', { name: 'รับงาน' }).click();
  await pub.waitForTimeout(300);
  const cForm = await pub.screenshot({ fullPage: true });
  let cAcc = cForm;
  if (first) {
    await pub.getByPlaceholder('เช่น 74-5521 ชบ.').fill(`${PLATE} ชบ.`);
    await pub.getByPlaceholder('ชื่อ-นามสกุล').fill('สมชาย ใจดี');
    await pub.getByPlaceholder('08x-xxx-xxxx').fill(PHONE);
    await pub.getByRole('button', { name: 'ยืนยันรับงาน' }).click();
    await pub.waitForTimeout(800);
    cAcc = await pub.screenshot({ fullPage: true });
  } else {
    await pub.goto(T1.path);
    await pub.waitForTimeout(1200);
    cAcc = await pub.screenshot({ fullPage: true });
  }
  const pub2 = await (
    await b.newContext({ viewport: vp, locale: 'th-TH', baseURL: WEB })
  ).newPage();
  await pub2.goto(first ? T2.path : T3.path);
  await pub2.waitForTimeout(1500);
  await pub2.getByRole('button', { name: 'ปฏิเสธ' }).click();
  await pub2.getByRole('button', { name: 'ราคาไม่คุ้มต้นทุน' }).click();
  await pub2.waitForTimeout(300);
  const cDec = await pub2.screenshot({ fullPage: true });
  if (first) {
    await pub2.getByRole('button', { name: 'ยืนยันปฏิเสธ' }).click();
    await pub2.waitForTimeout(800);
  } else {
    await pub2.goto(T2.path);
    await pub2.waitForTimeout(1200);
  }
  const cDecd = await pub2.screenshot({ fullPage: true });

  const h = vp.height + 160;
  const w = vp.width;
  await pair(`job-${w}`, aJob, cJob, w, h, ['ต้นแบบ (TMS Subcon · งาน)', 'ของจริง (/link/offer)']);
  await pair(`form-${w}`, aForm, cForm, w, h, [
    'ต้นแบบ (ฟอร์มรับงาน)',
    'ของจริง (ฟอร์มรับงาน + เบอร์คนขับ)',
  ]);
  await pair(`accepted-${w}`, aAcc, cAcc, w, h, ['ต้นแบบ (รับงานแล้ว)', 'ของจริง (รับงานแล้ว)']);
  await pair(`decline-${w}`, aDec, cDec, w, h, ['ต้นแบบ (เหตุผลที่ปฏิเสธ)', 'ของจริง']);
  await pair(`rejected-${w}`, aDecd, cDecd, w, h, ['ต้นแบบ (ปฏิเสธงานแล้ว)', 'ของจริง']);
}

// ---------- ผู้จัดรถ: drawer "จ่ายงานรถร่วม" (1440) ----------
const vp = { width: 1440, height: 900 };
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(`http://localhost:${port}/TMS%20v4.dc.html`);
await P.waitForTimeout(3000);
await vis(P, 'จ่ายงานรถร่วม').click();
await P.waitForTimeout(1000);
await P.locator('tbody tr', { hasText: 'รอตอบ' }).first().click();
await P.waitForTimeout(900);
const aSum = await P.screenshot();
await vis(P, 'ใบสั่งงาน').click();
await P.waitForTimeout(500);
const aWo = await P.screenshot();
await vis(P, 'กิจกรรม').click();
await P.waitForTimeout(500);
const aLog = await P.screenshot();
await P.keyboard.press('Escape');
await P.waitForTimeout(500);
await P.locator('tbody tr', { hasText: 'รับงาน' }).first().click();
await P.waitForTimeout(900);
const aAcc = await P.screenshot();

const open = async (so, trip) => {
  await W.goto('/so');
  await W.waitForTimeout(1500);
  await W.getByRole('row', { name: new RegExp(so.soNo) }).click();
  await W.waitForTimeout(800);
  await W.getByRole('dialog').getByRole('button', { name: trip.tripNo }).click();
  await W.waitForTimeout(900);
  await W.getByRole('dialog').getByRole('button', { name: 'จ่ายงานรถร่วม' }).click();
  await W.waitForTimeout(1200);
  return W.getByRole('dialog');
};
let d = await open(T3.so, T3.trip);
const cSum = await W.screenshot();
await d.getByRole('tab', { name: 'ใบสั่งงาน' }).click();
await W.waitForTimeout(500);
const cWo = await W.screenshot();
await d.getByRole('tab', { name: 'กิจกรรม' }).click();
await W.waitForTimeout(500);
const cLog0 = await W.screenshot();
d = await open(T1.so, T1.trip);
const cAcc = await W.screenshot();
await d.getByRole('tab', { name: 'กิจกรรม' }).click();
await W.waitForTimeout(500);
const cLog = await W.screenshot();
await pair('admin-offered-1440', aSum, cSum, 1440, 960, [
  'ต้นแบบ (TMS v4 · จ่ายงานรถร่วม · รอตอบ)',
  'ของจริง (รอตอบ — ราคา/ผู้รับเหมาอ่านอย่างเดียว · คัดลอกลิงก์ · ส่งผ่าน LINE)',
]);
await pair('admin-wo-1440', aWo, cWo, 1440, 960, [
  'ต้นแบบ (ใบสั่งงาน + ลิงก์ใบสั่งงาน)',
  'ของจริง',
]);
await pair('admin-log-1440', aLog, cLog0, 1440, 960, ['ต้นแบบ (กิจกรรม)', 'ของจริง (รอตอบ)']);
await pair('admin-accepted-1440', aAcc, cAcc, 1440, 960, [
  'ต้นแบบ (รับงานแล้ว)',
  'ของจริง (รับงานผ่านลิงก์)',
]);
await pair('admin-acclog-1440', aLog, cLog, 1440, 960, [
  'ต้นแบบ (กิจกรรม)',
  'ของจริง (ส่งข้อเสนอ → เปิดลิงก์ → รับงาน)',
]);
await b.close();
srv.close();
