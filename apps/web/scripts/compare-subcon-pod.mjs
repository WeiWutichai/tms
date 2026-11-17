// ภาพเทียบ "ต้นแบบ | ของจริง" ของ ST4-T09 (ลิงก์รถร่วม ส่วน POD) — เครื่อง dev เท่านั้น
// ต้นแบบ TMS Subcon แท็บ "ส่ง POD": พบ DO → รูป grid + "+ เพิ่มรูป" → "ส่ง POD" → รายการ "ส่งแล้ว" / DO ที่ส่งแล้ว
// ของจริง /link/pod/{token} ที่ถึงจุดส่งแล้ว: ฟอร์ม POD (รูป + แผ่นเซ็น) → รูป 2 ใบ + ลายเซ็น → ส่ง → "ส่งแล้ว"
// ต้องมี web + API ที่ PUBLIC_WEB_BASE_URL = WEB (ข้อมูลตัวอย่างสร้างผ่าน /v1 — ข้อมูลสมมติ):
//   WEB=http://localhost:4420 node scripts/compare-subcon-pod.mjs
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
  await M.screenshot({ path: `${out}st4-subcon-pod-${name}.png`, fullPage: true });
  console.log(`wrote design/compare/st4-subcon-pod-${name}.png`);
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
    lines: [{ description: 'ปูนซีเมนต์', qty: '5', unitId: ton, weightKg: '8600' }],
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

const png = (n) => ({
  name: `pod-${n}.png`,
  mimeType: 'image/png',
  buffer: Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(`photo-${n}-${RUN}`),
  ]),
});

for (const vp of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  const w = vp.width;
  const h = vp.height + 400;
  const { podPath, doNo } = await atDrop();
  // ต้นแบบ
  const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
  await P.goto(`http://localhost:${port}/TMS%20Subcon.dc.html`);
  await P.waitForTimeout(2500);
  await vis(P, 'ส่ง POD').click();
  await P.waitForTimeout(300);
  const q = P.getByPlaceholder('เช่น DO-2611-00069').filter({ visible: true });
  await q.fill('DO-2611-00069');
  await P.waitForTimeout(300);
  const aForm = await P.screenshot({ fullPage: true });
  await vis(P, '+ เพิ่มรูป').click();
  await vis(P, '+ เพิ่มรูป').click();
  await P.waitForTimeout(300);
  const aPhotos = await P.screenshot({ fullPage: true });
  await P.getByRole('button', { name: 'ส่ง POD' }).filter({ visible: true }).last().click();
  await P.waitForTimeout(3400);
  const aSent = await P.screenshot({ fullPage: true });
  await q.fill('DO-2611-00069');
  await P.waitForTimeout(300);
  const aSentDo = await P.screenshot({ fullPage: true });

  // ของจริง (ไม่ login)
  const C = await (
    await b.newContext({ viewport: vp, locale: 'th-TH', baseURL: WEB, hasTouch: w === 390 })
  ).newPage();
  await C.goto(podPath);
  await C.waitForTimeout(1500);
  await C.getByTestId('pdl-q').fill(doNo);
  await C.waitForTimeout(1500);
  const cForm = await C.screenshot({ fullPage: true });
  await C.getByTestId('pdl-photo-input').setInputFiles([png(1), png(2)]);
  await C.getByText('รูปที่ 2', { exact: false }).waitFor();
  await C.getByTestId('pdl-sig').scrollIntoViewIfNeeded();
  const box = await C.getByTestId('pdl-sig').boundingBox();
  await C.mouse.move(box.x + 40, box.y + 100);
  await C.mouse.down();
  for (let i = 1; i <= 12; i++)
    await C.mouse.move(box.x + 40 + i * 22, box.y + 100 - Math.sin(i / 2) * 40);
  await C.mouse.up();
  await C.getByRole('button', { name: 'ล้าง' }).waitFor();
  await C.waitForTimeout(300);
  const cPhotos = await C.screenshot({ fullPage: true });
  await C.getByTestId('pdl-pod-submit').click();
  await C.getByTestId('pdl-sent').waitFor();
  await C.waitForTimeout(3400);
  const cSent = await C.screenshot({ fullPage: true });
  await C.getByTestId('pdl-q').fill(doNo);
  await C.waitForTimeout(1500);
  const cSentDo = await C.screenshot({ fullPage: true });

  await pair(`form-${w}`, aForm, cForm, w, h, [
    'ต้นแบบ (พบ DO → รูป/ส่ง POD)',
    'ของจริง (ถึงจุดส่ง → รูป + ลายเซ็นผู้รับ + ส่ง POD)',
  ]);
  await pair(`photos-${w}`, aPhotos, cPhotos, w, h, [
    'ต้นแบบ (รูป 2 ใบ)',
    'ของจริง (รูป 2 ใบ + ลายเซ็น)',
  ]);
  await pair(`sent-${w}`, aSent, cSent, w, h, ['ต้นแบบ (ส่งแล้ว)', 'ของจริง (ส่งแล้ว)']);
  await pair(`sentdo-${w}`, aSentDo, cSentDo, w, h, [
    'ต้นแบบ (ค้น DO ที่ส่งแล้ว)',
    'ของจริง (การ์ด DO + ส่ง POD ของ DO นี้แล้ว)',
  ]);
}
await b.close();
srv.close();
