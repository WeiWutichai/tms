// ภาพเทียบ "ต้นแบบ | ของจริง" ของ ST3-T20 (ใบงานประจำวัน / ใบคุมรถ PDF) — เครื่อง dev เท่านั้น (ต้องมี pdftoppm จาก poppler)
// ต้นแบบ: drawer เที่ยวรถ (TMS v4) footer "พิมพ์ใบคุมรถ" → เปิด TMS Print.dc.html#trip · หน้า A4 ใบคุมรถ
// ของจริง: footer "พิมพ์ใบคุมรถ" (ดาวน์โหลด PDF) + "ส่งให้คนขับ" (dialog ลิงก์) · หน้าแรกของ PDF ที่ API สร้างจริง · ปุ่มหัวกระดาน
//   WEB=http://localhost:4620 node scripts/compare-trip-sheet.mjs
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
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
    `<body style="margin:0;display:flex;align-items:flex-start;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">${labels[0]}</div><img style="width:${w}px" src="data:image/png;base64,${left.toString('base64')}"></div><div><div style="padding:8px">${labels[1]}</div><img style="width:${w}px" src="data:image/png;base64,${right.toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st3-trip-sheet-${name}-1440.png`, fullPage: true });
  console.log(`wrote design/compare/st3-trip-sheet-${name}-1440.png`);
}

const vp = { width: 1440, height: 900 };
// ---------- ต้นแบบ ----------
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(`http://localhost:${port}/TMS%20v4.dc.html`);
await P.waitForTimeout(3000);
await P.evaluate(() => (location.hash = 'plan'));
await P.waitForTimeout(1500);
const aBoard = await P.screenshot();
await P.evaluate(() => (location.hash = 'trips'));
await P.waitForTimeout(1500);
await P.getByText('TRP-2611-0053', { exact: true }).first().click();
await P.waitForTimeout(900);
const aDrawer = await P.screenshot();
// หน้า A4 ใบคุมรถของต้นแบบ (doc-page a4 = 794 px)
const PP = await (
  await b.newContext({ viewport: { width: 1000, height: 1300 }, locale: 'th-TH' })
).newPage();
await PP.goto(`http://localhost:${port}/TMS%20Print.dc.html#trip`);
await PP.waitForTimeout(2500);
const aPage = await PP.locator('section#trip').screenshot();

// ---------- ของจริง ----------
const ctx = await b.newContext({
  viewport: vp,
  locale: 'th-TH',
  baseURL: WEB,
  acceptDownloads: true,
});
await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
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
const site = (name, contact) =>
  post('/v1/customer-sites', {
    name,
    kind: 'DROPOFF',
    address: { line1: '12/3 ม.5', province: 'ชลบุรี', postcode: '20000' },
    contact,
  });
const pA = await site('กรุงเทพ คลังต้นทาง', { name: 'คุณวิภา', phone: '02-118-4400' });
const qA = await site('ชลบุรี บจก. สยามพลาสติก', { name: 'คุณสมศักดิ์', phone: '081-234-5678' });
const qB = await site('ชลบุรี ศูนย์กระจายสินค้า', { name: 'คุณฐิติพร', phone: '038-111-222' });
const ton = (await get('/v1/units?limit=50')).data.find((u) => u.code === 'TON').id;
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const vt = (await get('/v1/vehicle-types?limit=50')).data.find((x) => x.code === '6W');
const so = (q, goods, h) =>
  post('/v1/orders', {
    customer: { id: cust.id },
    requestedDate: today,
    vehicleTypeId: vt.id,
    stops: [
      { type: 'PICKUP', siteId: pA.id },
      {
        type: 'DELIVERY',
        siteId: q,
        windowStart: `${today}T${h}:00:00+07:00`,
        windowEnd: `${today}T${Number(h) + 2}:00:00+07:00`,
      },
    ],
    lines: [{ description: goods, qty: '2.5', unitId: ton, weightKg: '2500' }],
  });
const o1 = await so(qA.id, 'เม็ดพลาสติก HDPE', '09');
const o2 = await so(qB.id, 'ปูนซีเมนต์ถุง', '13');
const doOf = async (o) => (await get(`/v1/delivery-orders?orderId=${o.id}`)).data[0].id;
const veh = await post('/v1/vehicles', {
  plate: `70-${RUN.slice(-4)}`,
  plateProvince: 'TH-10',
  vehicleTypeId: vt.id,
  ownership: 'OWN',
  payloadKg: 6000,
});
const drv = await post('/v1/drivers', {
  name: `สมชาย ใจดี ${RUN.slice(-2)}`,
  phone: `089-${RUN.slice(0, 3)}-${RUN.slice(-4)}`,
  employmentType: 'EMPLOYEE_SALARIED',
  licenceClass: 'T2',
  licenceExpiresOn: '2030-03-31',
  defaultVehicleId: veh.id,
});
const t = await post('/v1/trips', {
  tripDate: today,
  deliveryOrderIds: [await doOf(o1), await doOf(o2)],
  vehicleId: veh.id,
});
const pend = t.warnings.filter((w) => !w.confirmed && w.severity !== 'info');
await post(`/v1/trips/${t.id}/assign`, {
  vehicleId: veh.id,
  driverId: drv.id,
  ...(pend.length
    ? { ruleKeys: pend.map((w) => w.key), overrideReason: 'ลูกค้ายืนยันให้ส่งตามแผน' }
    : {}),
});

await W.goto('/plan');
await W.waitForTimeout(1500);
const bBoard = await W.screenshot();
await W.goto('/so');
await W.getByRole('row', { name: new RegExp(o1.soNo) }).click();
await W.getByRole('dialog').getByRole('button', { name: t.tripNo }).click();
await W.waitForTimeout(800);
const [dl] = await Promise.all([
  W.waitForEvent('download'),
  W.getByRole('button', { name: 'พิมพ์ใบคุมรถ' }).click(),
]);
await W.waitForTimeout(500);
const bDrawer = await W.screenshot();
await W.getByRole('button', { name: 'ส่งให้คนขับ' }).click();
await W.waitForTimeout(600);
const bShare = await W.screenshot();

// หน้าแรกของ PDF จริง → PNG ความกว้าง 794 px (เท่าหน้า A4 ของต้นแบบ)
const dir = mkdtempSync(join(tmpdir(), 'tms-sheet-'));
const pdfPath = join(dir, 'sheet.pdf');
writeFileSync(pdfPath, readFileSync(await dl.path()));
execFileSync('pdftoppm', [
  '-png',
  '-r',
  '96',
  '-f',
  '1',
  '-l',
  '1',
  '-singlefile',
  pdfPath,
  join(dir, 'p'),
]);
const bPage = readFileSync(join(dir, 'p.png'));

await pair('drawer', aDrawer, bDrawer, 1440, 900, [
  'ต้นแบบ (TMS v4) — drawer เที่ยวรถ footer "พิมพ์ใบคุมรถ"',
  'ของจริง — "พิมพ์ใบคุมรถ" (ดาวน์โหลด PDF + toast) + "ส่งให้คนขับ" (trips:dispatch)',
]);
await pair('share', aDrawer, bShare, 1440, 900, [
  'ต้นแบบ — ไม่มี "ส่งให้คนขับ" (docs/04 D2 "PDF/LINE ใบคุมรถให้คนขับ")',
  'ของจริง — dialog ลิงก์เปิด PDF ไม่ต้อง login + คัดลอก (LINE/SMS ถึงคนขับ = ST4)',
]);
await pair('board', aBoard, bBoard, 1440, 900, [
  'ต้นแบบ — กระดานวางแผน (หัวหน้ามีแค่ "ส่งแผนให้คนขับ")',
  'ของจริง — + "พิมพ์ใบคุมรถ" = ใบงานประจำวันของวันที่แสดง',
]);
await pair('pdf', aPage, bPage, 794, 1123, [
  'ต้นแบบ (TMS Print#trip) — หน้า A4 ใบคุมรถ',
  'ของจริง — หน้าแรกของ PDF ที่ API สร้าง (+ เวลานัด ที่อยู่ ผู้ติดต่อ สินค้า)',
]);
await b.close();
srv.close();
