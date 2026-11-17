// ภาพเทียบ "ต้นแบบ | ของจริง" ของ ST3-T16 (Multi-drop: drawer เที่ยวรถ — จุดรับ/ส่งตามลำดับ เลื่อนขึ้น/ลง) — เครื่อง dev เท่านั้น
// ต้นแบบ: TMS v4 เที่ยวรถ / ใบคุมรถ → ลาก DO 2 ใบเข้าเที่ยว → คลิกเลขเที่ยว (vPanel kind 'trp')
// ของจริง: /so → drawer SO → "รถ / คนขับ" เลขเที่ยว → drawer เที่ยวรถ (ข้อมูลสมมติ สร้างผ่าน /v1)
//   WEB=http://localhost:4420 node scripts/compare-multidrop.mjs
import { chromium } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
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
  await M.screenshot({ path: `${out}st3-multidrop-${name}-1440.png`, fullPage: true });
  console.log(`wrote design/compare/st3-multidrop-${name}-1440.png`);
}

const vp = { width: 1440, height: 900 };
// ---------- ต้นแบบ ----------
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(`http://localhost:${port}/TMS%20v4.dc.html`);
await P.waitForTimeout(3000);
await P.evaluate(() => (location.hash = 'trips'));
await P.waitForTimeout(1500);
for (const no of ['DO-2611-00072', 'DO-2611-00074']) {
  await P.getByText(no, { exact: true })
    .first()
    .dragTo(P.getByText('TRP-2611-0053', { exact: true }).first());
  await P.waitForTimeout(500);
}
await P.getByText('TRP-2611-0053', { exact: true }).first().click();
await P.waitForTimeout(900);
const aDrawer = await P.screenshot();
await P.locator('aside button[title="เลื่อนขึ้น"]').nth(2).click();
await P.waitForTimeout(500);
const aMoved = await P.screenshot();

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
const H = { Authorization: `Bearer ${tok.accessToken ?? tok.access_token}` };
const get = async (p) => (await W.request.get(p, { headers: H })).json();
const post = async (p, data) => (await W.request.post(p, { headers: H, data })).json();
const company = (await get('/v1/companies?status=active&limit=1')).data[0].id;
const cust = await post('/v1/customers', {
  legalName: `บจก. สยามพลาสติกสมมติ ${RUN}`,
  billingCompanyId: company,
});
const site = (name, lat, lng) =>
  post('/v1/customer-sites', {
    name: `${name} ${RUN}`,
    kind: 'DROPOFF',
    address: { line1: name },
    lat,
    lng,
  });
const pA = await site('คลังสินค้า บางนา', 13.6683, 100.6045);
const qA = await site('ร้านวัสดุ ชลบุรี', 13.3611, 100.9847);
const qB = await site('ร้านวัสดุ ระยอง', 12.6814, 101.2816);
const ton = (await get('/v1/units?limit=50')).data.find((u) => u.code === 'TON').id;
const day = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const so = (q, hh) =>
  post('/v1/orders', {
    customer: { id: cust.id },
    requestedDate: day,
    stops: [
      { type: 'PICKUP', siteId: pA.id, windowStart: `${day}T08:00:00+07:00` },
      {
        type: 'DELIVERY',
        siteId: q.id,
        windowStart: `${day}T${hh}:00:00+07:00`,
        windowEnd: `${day}T${hh}:59:00+07:00`,
      },
    ],
    lines: [{ description: 'เม็ดพลาสติก', qty: '4', unitId: ton, weightKg: '3800' }],
  });
const o1 = await so(qA, '10');
const o2 = await so(qB, '13');
const doOf = async (o) => (await get(`/v1/delivery-orders?orderId=${o.id}`)).data[0].id;
const vt =
  (await get('/v1/vehicle-types?limit=50')).data.find((x) => x.code === '10W') ??
  (await get('/v1/vehicle-types?limit=50')).data[0];
const veh = await post('/v1/vehicles', {
  plate: `81-${RUN.slice(-4)}`,
  plateProvince: 'TH-10',
  vehicleTypeId: vt.id,
  ownership: 'OWN',
});
await post('/v1/trips', {
  tripDate: day,
  deliveryOrderIds: [await doOf(o1), await doOf(o2)],
  vehicleId: veh.id,
});
await W.goto('/so');
await W.getByRole('row', { name: new RegExp(o1.soNo) }).click();
await W.waitForTimeout(800);
const tripLink = W.getByRole('dialog').getByRole('button', { name: /^TRP-/ });
await tripLink.click();
await W.waitForTimeout(900);
const bDrawer = await W.screenshot();
const rows = W.getByTestId('trip-stop');
await rows.nth(2).getByRole('button', { name: 'เลื่อนขึ้น' }).click();
await W.waitForTimeout(900);
const bMoved = await W.screenshot();
await rows.nth(1).getByRole('button', { name: 'เลื่อนขึ้น' }).click();
await W.waitForTimeout(500);
const bReject = await W.screenshot();

await pair('drawer', aDrawer, bDrawer, 1440, 960, ['ต้นแบบ (TMS v4)', 'ของจริง']);
await pair('moved', aMoved, bMoved, 1440, 960, ['ต้นแบบ — เลื่อนขึ้น', 'ของจริง — เลื่อนขึ้น']);
await pair('reject', aMoved, bReject, 1440, 960, [
  'ต้นแบบ (ไม่มีสถานะปฏิเสธ — ต้นแบบเลื่อนได้ทุกแบบ)',
  'ของจริง — ส่งก่อนรับ ถูกปฏิเสธพร้อมข้อความ',
]);
await b.close();
srv.close();
