// ภาพเทียบ "ต้นแบบ | ของจริง" ของ ST3-T24 (หมดเวลาข้อเสนองานรถร่วม) — เครื่อง dev เท่านั้น ที่ 1440 px
// ต้นแบบ TMS v4: กระดิ่ง (toast) · drawer "จ่ายงานรถร่วม" สถานะรอตอบ (ต้นแบบไม่มีสถานะหมดเวลา/ปุ่มส่งรายถัดไป — spec/12 §3)
// ของจริง: กระดิ่ง "รถร่วมยังไม่ตอบรับงาน" · drawer รอตอบที่ครบ N ชม. · drawer จ้างรายถัดไป · เที่ยวที่ข้อเสนอหมดอายุ
// "เลื่อนเวลา" = ถอยเวลาเสนอ/หมดอายุในฐาน แล้วรัน worker จริงจนงานเสร็จ — ใช้ฐานแยก (ไม่ใช่ฐาน dev ที่คนอื่นใช้):
//   WEB=http://localhost:4721 API_DIR=../api DATABASE_URL=… APP_DATABASE_URL=… PLATFORM_DATABASE_URL=… \
//   node scripts/compare-offer-timeout.mjs
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = process.env.WEB ?? 'http://localhost:4721';
const RUN = String(Date.now()).slice(-6);
const H = 3600_000;
const out = fileURLToPath(new URL('../../../design/compare/', import.meta.url));
const apiDir = fileURLToPath(new URL('../../api/', import.meta.url));
const protoDir = fileURLToPath(new URL('../../../design/prototype/', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const srv = createServer((req, res) => {
  const p = join(protoDir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(protoDir) || !existsSync(p)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
  createReadStream(p).pipe(res);
}).listen(0);
const proto = `http://localhost:${srv.address().port}/TMS%20v4.dc.html`;
const { PrismaClient } = createRequire(new URL('../../api/package.json', import.meta.url))(
  '@prisma/client',
);
const db = new PrismaClient({ datasources: { db: { url: process.env.PLATFORM_DATABASE_URL } } });
const b = await chromium.launch();
const vp = { width: 1440, height: 900 };
const vis = (p, text) => p.getByText(text, { exact: true }).filter({ visible: true }).first();

async function pair(name, left, right, labels) {
  const M = await (
    await b.newContext({ viewport: { width: 1440 * 2 + 60, height: 960 } })
  ).newPage();
  await M.setContent(
    `<body style="margin:0;display:flex;align-items:flex-start;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">${labels[0]}</div><img src="data:image/png;base64,${left.toString('base64')}"></div><div><div style="padding:8px">${labels[1]}</div><img src="data:image/png;base64,${right.toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st3-offer-timeout-${name}-1440.png` });
  console.log(`wrote design/compare/st3-offer-timeout-${name}-1440.png`);
}

function jurTax(n) {
  const base = `0105${String(n).padStart(8, '0')}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
  return base + String((11 - (sum % 11)) % 10);
}

async function runWorker(done) {
  const p = spawn('node', ['-r', '@swc-node/register', 'src/worker.ts'], {
    cwd: apiDir,
    env: { ...process.env, NODE_ENV: 'development', SWC_NODE_PROJECT: 'tsconfig.json' },
    stdio: 'ignore',
  });
  try {
    for (let i = 0; i < 90; i++) {
      if (await done()) return;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('worker did not finish in 90s');
  } finally {
    p.kill('SIGTERM');
  }
}

// ---------- ต้นแบบ ----------
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(proto);
await P.waitForTimeout(2500);
await P.locator('button:has(lu-i[n="bell"])').filter({ visible: true }).first().click();
await P.waitForTimeout(500);
const aBell = await P.screenshot();
const P2 = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P2.goto(proto);
await P2.waitForTimeout(3000);
await vis(P2, 'จ่ายงานรถร่วม').click();
await P2.waitForTimeout(1000);
await P2.locator('tbody tr', { hasText: 'รอตอบ' }).first().click();
await P2.waitForTimeout(900);
const aSum = await P2.screenshot();

// ---------- ของจริง: ข้อมูลตัวอย่าง (สมมติ) ----------
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
const HDR = { Authorization: `Bearer ${tok.accessToken}` };
const get = async (path) => (await W.request.get(path, { headers: HDR })).json();
const post = async (path, data) => {
  const r = await W.request.post(path, {
    headers: { ...HDR, 'Idempotency-Key': randomUUID() },
    data,
  });
  if (r.status() >= 300) throw new Error(`${path} ${r.status()} ${await r.text()}`);
  return r.json();
};
const today = new Date(Date.now() + 7 * H).toISOString().slice(0, 10);
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
  name: `ท่าเรือแหลมฉบัง ${RUN}`,
  kind: 'DROPOFF',
  address: addr('ชลบุรี'),
});
const ton = (await get('/v1/units?limit=50')).data.find((u) => u.code === 'TON').id;
const vt6 = (await get('/v1/vehicle-types?limit=50')).data.find((x) => x.code === '6W').id;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const carrier = async (i, name, rate) => {
  const c = await post('/v1/carriers', {
    legalName: name,
    entityType: 'JURISTIC',
    taxId: jurTax(Number(RUN) + 600 + i),
    paymentTermDays: 15,
  });
  const veh = await post('/v1/vehicles', {
    plate: `7${i}-${RUN.slice(-4)}`,
    plateProvince: 'TH-20',
    vehicleTypeId: vt6,
    ownership: 'SUBCONTRACT',
    carrierId: c.id,
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
      headers: { ...HDR, 'Content-Type': 'application/octet-stream' },
      data: PDF,
    });
    await post(`/v1/vehicles/${veh.id}/documents`, {
      docType,
      docNo: `${docType.slice(0, 3)}-${RUN}${i}`,
      ...(docType === 'INSURANCE'
        ? { issuer: 'บริษัท ประกันสมมติ จำกัด', insuranceClass: '1' }
        : {}),
      startsOn: day(-100),
      expiresOn: day(200),
      fileDocumentIds: [f.id],
    });
  }
  const rc = await post('/v1/rate-cards', {
    side: 'BUY',
    carrierId: c.id,
    originId: a.id,
    destinationId: bb.id,
    vehicleTypeId: vt6,
    pricingModel: 'PER_TRIP',
    buyRate: rate,
    validFrom: today,
  });
  await post(`/v1/rate-cards/${rc.id}/approve`, { reason: 'อนุมัติตามราคาที่ตกลง' });
  return { id: c.id, name };
};
const A = await carrier(1, `หจก. ทรัพย์สมบูรณ์ขนส่งสมมติ ${RUN}`, '5000');
await carrier(2, `หจก. ศรีราชาโลจิสติกส์สมมติ ${RUN}`, '5400');
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
  await post(`/v1/trips/${trip.id}/offer`, { carrierId: A.id });
  return { so, trip };
};
const T1 = await offered();
const T2 = await offered();
const offerOf = (tripNo) =>
  db.subconOffer.findFirstOrThrow({ where: { trip: { tripNo } }, orderBy: { createdAt: 'desc' } });
// เลื่อนเวลา: T1 ส่งไปแล้ว 3 ชม. (ครบเวลาตอบ 2 ชม.) · T2 ส่งไปแล้ว 49 ชม. (ลิงก์หมดอายุ)
const o1 = await offerOf(T1.trip.tripNo);
const back1 = new Date(Date.now() - 3 * H);
await db.subconOffer.update({
  where: { id: o1.id },
  data: { offeredAt: back1, responseDueAt: new Date(back1.getTime() + 2 * H) },
});
const o2 = await offerOf(T2.trip.tripNo);
const back2 = new Date(Date.now() - 49 * H);
await db.subconOffer.update({
  where: { id: o2.id },
  data: {
    offeredAt: back2,
    responseDueAt: new Date(back2.getTime() + 2 * H),
    expiresAt: new Date(back2.getTime() + 48 * H),
  },
});
await db.notification.updateMany({
  where: { recipientId: '00000000-0000-4000-8000-0000000e0a01', readAt: null },
  data: { readAt: new Date(), status: 'READ' },
});
await runWorker(
  async () =>
    (await offerOf(T2.trip.tripNo)).status === 'EXPIRED' &&
    !!(await offerOf(T1.trip.tripNo)).timeoutNotifiedAt,
);
// เหลือเฉพาะแจ้ง "ไม่ตอบรับ" ของ T1 ที่ยังไม่อ่าน (ภาพกระดิ่ง)
await db.notification.updateMany({
  where: { templateCode: 'subcon_offer.expired', readAt: null },
  data: { readAt: new Date(), status: 'READ' },
});

await W.goto('/');
await W.waitForTimeout(1500);
await W.getByRole('banner')
  .getByRole('button', { name: /การแจ้งเตือน/ })
  .click();
await W.waitForTimeout(800);
const cBell = await W.screenshot();

const openTrip = async (so, trip) => {
  await W.goto('/so');
  await W.waitForTimeout(1500);
  await W.getByRole('row', { name: new RegExp(so.soNo) }).click();
  await W.waitForTimeout(800);
  await W.getByRole('dialog').getByRole('button', { name: trip.tripNo }).click();
  await W.waitForTimeout(900);
  return W.getByRole('dialog');
};
let d = await openTrip(T1.so, T1.trip);
await d.getByRole('button', { name: 'จ่ายงานรถร่วม' }).click();
await W.waitForTimeout(1200);
const cTimeout = await W.screenshot();
await d.getByRole('button', { name: 'ส่งรายถัดไป' }).click();
await W.waitForTimeout(1500);
const cNext = await W.screenshot();
d = await openTrip(T2.so, T2.trip);
const cExpired = await W.screenshot();

await pair('bell', aBell, cBell, [
  'ต้นแบบ (TMS v4 · กระดิ่ง)',
  'ของจริง (แจ้ง "รถร่วมยังไม่ตอบรับงาน")',
]);
await pair('drawer', aSum, cTimeout, [
  'ต้นแบบ (จ่ายงานรถร่วม · รอตอบ)',
  'ของจริง (รอตอบ ครบ 2 ชม. — ข้อความหมดเวลา + ปุ่ม "ส่งรายถัดไป")',
]);
await pair('next', aSum, cNext, [
  'ต้นแบบ (จ่ายงานรถร่วม)',
  'ของจริง (ส่งรายถัดไป — รายถัดไปที่ถูกสุด + คำเตือนยกเลิกข้อเสนอเดิม)',
]);
await pair('expired', aSum, cExpired, [
  'ต้นแบบ (จ่ายงานรถร่วม)',
  'ของจริง (เที่ยวที่ข้อเสนอหมดอายุ — กลับรอจัด · ปุ่ม "ส่งรายถัดไป")',
]);
await b.close();
await db.$disconnect();
srv.close();
