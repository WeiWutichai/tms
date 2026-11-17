// ภาพเทียบ "ต้นแบบ | ของจริง" ของ ST4-T14 (หน้าติดตามของผู้รับ) — เครื่อง dev เท่านั้น
// ต้นแบบ TMS Tracking.dc.html (กำลังส่ง / ส่งแล้ว ?do=DO-2611-00062) ที่ 390 + 1440 px
// ของจริง /t/{token}: ลิงก์ต่อ DO (กำลังส่ง / ส่งแล้ว + POD) + ลิงก์ของลูกค้า (การ์ดค้นหา — ต้นแบบไม่มี)
// ต้องมี web + API ที่ PUBLIC_WEB_BASE_URL = WEB (ข้อมูลตัวอย่างสร้างผ่าน /v1 — ข้อมูลสมมติ):
//   WEB=http://localhost:4420 node scripts/compare-tracking.mjs
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

async function pair(name, left, right, w, h, labels) {
  const M = await (await b.newContext({ viewport: { width: w * 2 + 60, height: h } })).newPage();
  await M.setContent(
    `<body style="margin:0;display:flex;align-items:flex-start;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">${labels[0]}</div><img src="data:image/png;base64,${left.toString('base64')}"></div><div><div style="padding:8px">${labels[1]}</div><img src="data:image/png;base64,${right.toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st4-tracking-${name}.png`, fullPage: true });
  console.log(`wrote design/compare/st4-tracking-${name}.png`);
}

// ---------- ของจริง: ข้อมูลตัวอย่าง ----------
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, baseURL: WEB });
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
const call = async (method, path, data) => {
  const r = await W.request.fetch(path, {
    method,
    headers: { ...H, 'Idempotency-Key': randomUUID() },
    data,
  });
  if (r.status() >= 300) throw new Error(`${path} ${r.status()} ${await r.text()}`);
  return r.json();
};
const post = (path, data) => call('POST', path, data);
await call('PATCH', '/v1/settings', {
  values: { 'tracking.contactPhone': '02-118-4400', 'tracking.showPod': true },
});
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const company = (await get('/v1/companies?status=active&limit=1')).data[0].id;
const cust = await post('/v1/customers', {
  legalName: `บจก. สยามพลาสติกสมมติ ${RUN}`,
  billingCompanyId: company,
});
const addr = (p) => ({ line1: '1 ถนนทดสอบ', district: 'เมือง', province: p });
const a = await post('/v1/customer-sites', {
  name: `คลังบางนา ${RUN}`,
  kind: 'PICKUP',
  address: addr('กรุงเทพมหานคร'),
});
const bb = await post('/v1/customer-sites', {
  name: `โรงงานอมตะนคร ${RUN}`,
  kind: 'DROPOFF',
  address: addr('ชลบุรี'),
  contact: { name: 'คุณวิไล', phone: '081-234-4507' },
});
const bag = (await get('/v1/units?limit=50')).data.find((u) => u.code === 'BAG') ??
  (await get('/v1/units?limit=50')).data.find((u) => u.code === 'TON');
const vt6 = (await get('/v1/vehicle-types?limit=50')).data.find((x) => x.code === '6W').id;

/** SO → DO → เที่ยว (รถบริษัท) ปล่อยรถ → รับของ (→ ส่งแล้ว) · คืน { doId, stops } */
async function job(n, po, delivered) {
  const veh = await post('/v1/vehicles', {
    plate: `7${n}-${RUN.slice(-4)}`,
    plateProvince: 'TH-10',
    vehicleTypeId: vt6,
    ownership: 'OWN',
    payloadKg: 6000,
  });
  await post('/v1/drivers', {
    name: `สมชาย ใจดีสมมติ ${n}${RUN}`,
    phone: `08${n}-${RUN.slice(0, 3)}-${RUN.slice(-4)}`,
    employmentType: 'EMPLOYEE_SALARIED',
    licenceClass: 'T2',
    licenceExpiresOn: '2030-03-31',
    defaultVehicleId: veh.id,
  });
  const so = await post('/v1/orders', {
    customer: { id: cust.id },
    customerRef: po,
    requestedDate: today,
    vehicleTypeId: vt6,
    stops: [
      { type: 'PICKUP', siteId: a.id },
      {
        type: 'DELIVERY',
        siteId: bb.id,
        windowStart: `${today}T10:30:00+07:00`,
        windowEnd: `${today}T11:00:00+07:00`,
      },
    ],
    lines: [
      { description: 'เม็ดพลาสติก PP เกรด 1102K', qty: '120', unitId: bag.id, weightKg: '3000' },
      { description: 'เม็ดพลาสติก HDPE', qty: '80', unitId: bag.id, weightKg: '2000' },
    ],
  });
  const d = (await get(`/v1/delivery-orders?orderId=${so.id}`)).data[0];
  const t0 = await post('/v1/trips', { tripDate: today, deliveryOrderIds: [d.id], vehicleId: veh.id });
  const asg = await W.request.post(`/v1/trips/${t0.id}/assign`, {
    headers: { ...H, 'Idempotency-Key': randomUUID() },
    data: { vehicleId: veh.id, dispatch: true },
  });
  if (asg.status() !== 200) {
    const w = await asg.json();
    await post(`/v1/trips/${t0.id}/assign`, {
      vehicleId: veh.id,
      dispatch: true,
      ruleKeys: (w.warnings ?? []).map((x) => x.key),
      overrideReason: 'ภาพเทียบหน้าติดตาม',
    });
  }
  const trip = await get(`/v1/trips/${t0.id}`);
  const [pickup, drop] = [...trip.stops].sort((x, y) => x.sequence - y.sequence);
  const ev = (stop, action, min, extra = {}) =>
    post(`/v1/stops/${stop}/${action}`, {
      clientEventId: randomUUID(),
      occurredAt: new Date(Date.now() - min * 60_000).toISOString(),
      ...extra,
    });
  await ev(pickup.id, 'arrive', 120);
  await ev(pickup.id, 'complete', 100, { outcome: 'DELIVERED' });
  if (delivered) {
    await ev(drop.id, 'arrive', 30);
    await ev(drop.id, 'complete', 20, { outcome: 'DELIVERED' });
  }
  return d.id;
}

const transitDo = await job(1, `PO-45861-${RUN}`, false);
const doneDo = await job(2, `PO-45120-${RUN}`, true);
// หลักฐานส่ง (รูป + ลายเซ็น) ของใบที่ส่งแล้ว — รูป PNG สมมติ
const S = await (await b.newContext({ viewport: { width: 200, height: 200 } })).newPage();
await S.setContent('<body style="margin:0;background:linear-gradient(135deg,#C8D3E0,#8FA3BB)"></body>');
const PNG = await S.screenshot({ clip: { x: 0, y: 0, width: 200, height: 200 } });
async function upload(kind) {
  const f = await post('/v1/documents', {
    kind,
    mime: 'image/png',
    bytes: PNG.length,
    filename: `${kind}.png`,
  });
  const u = new URL(f.uploadUrl);
  await W.request.put(u.pathname + u.search, {
    headers: { ...H, 'Content-Type': 'application/octet-stream' },
    data: PNG,
  });
  return f.id;
}
await call('PUT', `/v1/delivery-orders/${doneDo}/pod`, {
  photoDocumentIds: [await upload('POD_PHOTO'), await upload('POD_PHOTO')],
  signatureDocumentId: await upload('POD_SIGNATURE'),
  receiverName: 'คุณสมศรี',
});
const pathOf = (u) => new URL(u).pathname;
const transitPath = pathOf((await post(`/v1/delivery-orders/${transitDo}/tracking-link`, {})).url);
const donePath = pathOf((await post(`/v1/delivery-orders/${doneDo}/tracking-link`, {})).url);
const searchPath = pathOf((await post(`/v1/customers/${cust.id}/tracking-link`, {})).url);

for (const vp of [
  { width: 390, height: 900 },
  { width: 1440, height: 900 },
]) {
  const w = vp.width;
  const h = vp.height + 160;
  const shot = async (url, wait = 2500) => {
    const p = await (
      await b.newContext({ viewport: vp, locale: 'th-TH', timezoneId: 'Asia/Bangkok' })
    ).newPage();
    await p.goto(url);
    await p.waitForTimeout(wait);
    return p.screenshot({ fullPage: true });
  };
  const aTransit = await shot(`http://localhost:${port}/TMS%20Tracking.dc.html`, 4000);
  const aDone = await shot(`http://localhost:${port}/TMS%20Tracking.dc.html?do=DO-2611-00062`, 4000);
  const cTransit = await shot(`${WEB}${transitPath}`);
  const cDone = await shot(`${WEB}${donePath}`);
  const cSearch = await shot(`${WEB}${searchPath}`);
  await pair(`transit-${w}`, aTransit, cTransit, w, h, [
    'ต้นแบบ (กำลังส่ง)',
    'ของจริง (ลิงก์ต่อ DO · กำลังส่ง — ไม่มีแผนที่/ชื่อคนขับ)',
  ]);
  await pair(`delivered-${w}`, aDone, cDone, w, h, [
    'ต้นแบบ (ส่งแล้ว)',
    'ของจริง (ส่งแล้ว + หลักฐานการส่ง)',
  ]);
  await pair(`search-${w}`, aTransit, cSearch, w, h, [
    'ต้นแบบ (ไม่มีหน้าค้นหา)',
    'ของจริง (ลิงก์ของลูกค้า — การ์ดค้นหา)',
  ]);
}
await b.close();
srv.close();
