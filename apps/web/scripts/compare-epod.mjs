// ภาพเทียบ "ต้นแบบ | ของจริง" ePOD ผ่านเว็บ (ST4-T07) ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้องมี web dev + API dev ที่รันโค้ด ST4-T07 + seed · ใช้: node scripts/compare-epod.mjs
// (port อื่น: WEB=http://localhost:4605 node scripts/compare-epod.mjs)
// ข้อมูลตัวอย่าง (สมมติ): สร้างเที่ยว → ปล่อยรถ → ปิดจุดรับ/ส่งย้อนเวลา → อัปโหลดรูป 2 ใบ + บันทึกหลักฐาน (ยังไม่มีลายเซ็น)
import { chromium } from '@playwright/test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

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

/** PNG สีเดียว w×h (ไฟล์รูปจริงสำหรับอัปโหลด — server ตรวจ magic bytes) */
function png(w, h, rgb) {
  const crcT = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (b) => {
    let c = -1;
    for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).map((_, i) => rgb[i % 3])]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

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
await P.getByText('เอกสารแนบ', { exact: true }).filter({ visible: true }).last().click();
await P.waitForTimeout(700);
const a = { docs: await P.screenshot() };
// drawer DO แท็บ "หลักฐานส่ง" (ระบบยังไม่มี drawer DO — ใช้หน้าตานี้ในแท็บเอกสารของเที่ยว)
await P.keyboard.press('Escape');
await P.evaluate(() => (location.hash = 'do'));
await P.waitForTimeout(1500);
await P.locator('text=/^DO-2611-\\d+$/').first().click();
await P.waitForTimeout(900);
await P.getByText('หลักฐานส่ง', { exact: true }).filter({ visible: true }).last().click();
await P.waitForTimeout(700);
a.pod = await P.screenshot();
a.sign = a.pod;

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
const cust = (
  await post('/v1/customers', {
    legalName: `บจก. ไทยสตีลไพพ์ (ตัวอย่าง ${RUN})`,
    billingCompanyId: company,
  })
).body;
const addr = (p) => ({ line1: '99 ถนนตัวอย่าง', district: 'เมือง', province: p });
const sa = (
  await post('/v1/customer-sites', {
    name: `คลังบางนา (ตัวอย่าง ${RUN})`,
    kind: 'PICKUP',
    address: addr('สมุทรปราการ'),
  })
).body;
const sb = (
  await post('/v1/customer-sites', {
    name: `โรงงานชลบุรี (ตัวอย่าง ${RUN})`,
    kind: 'DROPOFF',
    address: addr('ชลบุรี'),
  })
).body;
const ton = (await get('/v1/units?limit=50')).data.find((u) => u.code === 'TON').id;
const vt6 = (await get('/v1/vehicle-types?limit=50')).data.find((x) => x.code === '6W').id;
const veh = (
  await post('/v1/vehicles', {
    plate: `7${RUN.slice(0, 1)}-${RUN.slice(1)}`,
    plateProvince: 'TH-10',
    vehicleTypeId: vt6,
    ownership: 'OWN',
    payloadKg: 16000,
  })
).body;
await post('/v1/drivers', {
  name: `สมชาย ใจดี ${RUN}`,
  phone: `081-${RUN.slice(0, 3)}-${RUN.slice(1)}`,
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
    lines: [{ description: 'ท่อเหล็ก', qty: '1', unitId: ton, weightKg: '15000' }],
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
const bkk = (min) => {
  const d = new Date(Date.now() - min * 60_000 + 7 * 3600_000).toISOString();
  return `${d.slice(0, 16)}:00+07:00`;
};
for (const [s, m] of [
  [pickup, 150],
  [drop, 40],
]) {
  await post(`/v1/stops/${s.id}/arrive`, { clientEventId: randomUUID(), occurredAt: bkk(m) });
  await post(`/v1/stops/${s.id}/complete`, {
    clientEventId: randomUUID(),
    occurredAt: bkk(m - 20),
    outcome: 'DELIVERED',
  });
}
// รูป 2 ใบ (อัปโหลดจริงผ่าน /v1/documents) + บันทึกหลักฐานฉบับแรก (ยังไม่มีลายเซ็น)
const photos = [];
for (const [i, rgb] of [
  [1, [180, 190, 170]],
  [2, [150, 170, 200]],
]) {
  const data = png(64, 48, rgb);
  const d = (
    await post('/v1/documents', {
      kind: 'POD_PHOTO',
      mime: 'image/png',
      bytes: data.length,
      filename: `pod-${i}.png`,
    })
  ).body;
  const u = new URL(d.uploadUrl);
  const up = await W.request.put(u.pathname + u.search, {
    headers: { 'Content-Type': 'application/octet-stream' },
    data,
  });
  if (!up.ok()) throw new Error(`upload ${up.status()} ${await up.text()}`);
  photos.push(d.id);
}

await W.goto('/so');
await W.waitForTimeout(1500);
await W.getByRole('row', { name: new RegExp(so.soNo) }).click();
await W.waitForTimeout(800);
await W.getByRole('dialog').getByRole('button', { name: trip.tripNo }).click();
await W.waitForTimeout(1000);
await W.getByRole('tab', { name: 'เอกสารแนบ' }).click();
await W.waitForTimeout(1500);
const c = { docs: await W.screenshot() };
// บันทึกฉบับแรกด้วย API แล้วเปิดใหม่ (รูป 2 ใบ + น้ำหนัก + ผู้รับ)
const pr = await W.request.put(`/v1/delivery-orders/${doId}/pod`, {
  headers: { ...H, 'If-Match': '"0"' },
  data: {
    photoDocumentIds: photos,
    weighedKg: '14940',
    receiverName: 'สมศรี ใจงาม',
    receiverRelation: 'SELF',
  },
});
if (!pr.ok()) throw new Error(`pod ${pr.status()} ${await pr.text()}`);
await W.getByRole('tab', { name: 'ไทม์ไลน์' }).click();
await W.waitForTimeout(600);
await W.getByRole('tab', { name: 'เอกสารแนบ' }).click();
await W.waitForTimeout(1500);
c.pod = await W.screenshot();
await W.getByRole('button', { name: 'เก็บลายเซ็นผู้รับ' }).click();
await W.waitForTimeout(500);
const pad = await W.getByTestId('sig-pad').boundingBox();
await W.mouse.move(pad.x + 60, pad.y + 100);
await W.mouse.down();
for (let i = 0; i <= 30; i++)
  await W.mouse.move(pad.x + 60 + i * 10, pad.y + 90 + Math.sin(i / 3) * 30);
await W.mouse.up();
await W.waitForTimeout(400);
c.sign = await W.screenshot();

const LABEL = {
  docs: 'ต้นแบบ (TMS v4) drawer เที่ยวรถ — แท็บ "เอกสารแนบ"',
  pod: 'ต้นแบบ (TMS v4) drawer DO — แท็บ "หลักฐานส่ง" (ของจริงอยู่ในแท็บเอกสารของเที่ยว — DECISION spec/12 §3)',
  sign: 'ต้นแบบ TMS v4 ไม่มีแผ่นเซ็น — ใช้แผ่นเซ็นของ TMS Driver App M4 ในกรอบ vDialog (DECISION spec/12 §3)',
};
for (const tag of ['docs', 'pod', 'sign']) {
  const M = await (await b.newContext({ viewport: { width: 2900, height: 960 } })).newPage();
  await M.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">${LABEL[tag]}</div><img src="data:image/png;base64,${a[tag].toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web drawer เที่ยวรถ แท็บเอกสารแนบ)</div><img src="data:image/png;base64,${c[tag].toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st4-epod-${tag}-1440.png` });
  console.log(`wrote design/compare/st4-epod-${tag}-1440.png`);
}
await b.close();
srv.close();
