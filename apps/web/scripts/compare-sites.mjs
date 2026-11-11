// ภาพเทียบ "ต้นแบบ | ของจริง" ของหน้า ข้อมูลหลัก → สถานที่ / จุดรับส่ง (ST2-T02) ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้องมี web dev (4420) + API dev (4410) ที่รันโค้ด ST2-T02 + seed · ใช้: node scripts/compare-sites.mjs
// (web อื่น: WEB=http://localhost:4620 node scripts/compare-sites.mjs)
// สร้างข้อมูลตัวอย่าง (สมมติ) ใน demo-a ด้วย PUT /v1/customers|customer-sites/external/DEMO-… — รันซ้ำได้ไม่เกิดแถวใหม่
import { chromium } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = process.env.WEB ?? 'http://localhost:4420';
const out = fileURLToPath(new URL('../../../design/compare/', import.meta.url));
const protoDir = fileURLToPath(new URL('../../../design/prototype/', import.meta.url));

// ต้นแบบต้องเปิดผ่าน http (file:// ตารางว่าง)
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const srv = createServer((req, res) => {
  const p = join(protoDir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(protoDir) || !existsSync(p)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
  createReadStream(p).pipe(res);
}).listen(0);
const port = srv.address().port;

/** เลขผู้เสียภาษีสมมติที่ checksum ถูก */
function taxId(n) {
  const base = `09999${String(n).padStart(7, '0')}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
  return base + String((11 - (sum % 11)) % 10);
}
/** สถานที่ตัวอย่าง (สมมติ): [ชื่อ, ประเภท, ลูกค้า (index ของ CUS หรือ null = บริษัทเอง), ที่อยู่, lat, lng, รัศมี, รถสูงสุด, ผู้ติดต่อ, เบอร์] */
const CUS = ['บจก. ตัวอย่างพลาสติก', 'บมจ. ตัวอย่างเครื่องดื่ม', 'บจก. ตัวอย่างอุตสาหกรรม'];
const SITES = [
  [
    'คลังสินค้าตัวอย่าง บางนา',
    'PICKUP',
    null,
    '88/1 ถ.ตัวอย่าง ต.ตัวอย่าง อ.บางพลี จ.สมุทรปราการ',
    13.6416,
    100.6911,
    300,
    'TRAILER',
    'คุณสมชาย',
    '02-000-0101',
  ],
  [
    'โรงงานตัวอย่างพลาสติก ชลบุรี',
    'DROPOFF',
    0,
    '99 นิคมตัวอย่าง ต.ตัวอย่าง อ.เมือง จ.ชลบุรี',
    13.417,
    101.001,
    250,
    '10W',
    'คุณวิไล',
    '02-000-0102',
  ],
  [
    'ศูนย์กระจายสินค้าตัวอย่าง',
    'WAREHOUSE',
    1,
    '45 ถ.ตัวอย่าง ต.ตัวอย่าง อ.บางเสาธง จ.สมุทรปราการ',
    13.5902,
    100.8034,
    400,
    'SEMI_TRAILER',
    'คุณปรีชา',
    '02-000-0103',
  ],
  [
    'โรงงานตัวอย่างอุตสาหกรรม แหลมฉบัง',
    'DROPOFF',
    2,
    '12 ท่าเรือตัวอย่าง ต.ตัวอย่าง อ.ศรีราชา จ.ชลบุรี',
    13.0827,
    100.883,
    500,
    '10W',
    'คุณนภา',
    '02-000-0104',
  ],
  [
    'คลังตัวอย่าง ระยอง',
    'DROPOFF',
    0,
    '7 นิคมตัวอย่าง ต.ตัวอย่าง อ.เมือง จ.ระยอง',
    12.7144,
    101.1612,
    300,
    '6W',
    'คุณวิชัย',
    '02-000-0105',
  ],
  [
    'สาขาตัวอย่าง อยุธยา',
    'DROPOFF',
    1,
    '5 ถ.ตัวอย่าง ต.ตัวอย่าง อ.วังน้อย จ.พระนครศรีอยุธยา',
    null,
    null,
    200,
    '6W',
    'คุณสมศรี',
    '02-000-0106',
  ],
];

const vp = { width: 1440, height: 900 };
const b = await chromium.launch();

// ---------- ต้นแบบ ----------
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(`http://localhost:${port}/TMS%20v4.dc.html`);
await P.waitForTimeout(3000);
await P.getByText('ข้อมูลหลัก', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(400);
await P.getByText('สถานที่ / จุดรับส่ง', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(1200);
const a = { list: await P.screenshot() };
await P.locator('tbody tr').nth(1).click();
await P.waitForTimeout(900);
a.drawer = await P.screenshot();
await P.keyboard.press('Escape');
await P.locator('button[title="ปิด"]')
  .filter({ visible: true })
  .first()
  .click()
  .catch(() => {});
await P.waitForTimeout(500);
await P.getByText('เพิ่มสถานที่', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(900);
a.create = await P.screenshot();
await P.keyboard.press('Escape');
await P.locator('button[title="ปิด"]')
  .filter({ visible: true })
  .first()
  .click()
  .catch(() => {});
await P.waitForTimeout(400);
await P.getByText('ลูกค้า', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(1000);
await P.locator('tbody tr').nth(1).click();
await P.waitForTimeout(900);
await P.getByText('ที่อยู่ส่ง', { exact: true }).filter({ visible: true }).last().click();
await P.waitForTimeout(900);
a.custaddr = await P.screenshot();

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
const custIds = [];
for (const [i, name] of CUS.entries()) {
  const r = await W.request.put(`/v1/customers/external/DEMO-CUS-${i + 1}`, {
    headers: H,
    data: { legalName: name, taxId: taxId(i + 1), branchCode: '00000' },
  });
  if (!r.ok()) console.error('seed customer failed', r.status(), await r.text());
  custIds.push((await r.json()).id);
}
for (const [i, [name, kind, ci, addr, lat, lng, r, mx, ct, ph]] of SITES.entries()) {
  const res = await W.request.put(`/v1/customer-sites/external/DEMO-LOC-${i + 1}`, {
    headers: H,
    data: {
      name,
      kind,
      customerId: ci === null ? null : custIds[ci],
      address: { line1: addr },
      lat,
      lng,
      geofenceRadiusM: r,
      maxVehicleClass: mx,
      openTime: '08:00',
      closeTime: '17:00',
      contact: { name: ct, phone: ph },
    },
  });
  if (!res.ok()) console.error('seed site failed', res.status(), await res.text());
}
await W.goto('/master/locations');
await W.waitForTimeout(1500);
const c = { list: await W.screenshot() };
await W.locator('tbody tr').nth(1).click();
await W.waitForTimeout(900);
c.drawer = await W.screenshot();
await W.getByRole('tab', { name: 'กิจกรรม' }).click();
await W.waitForTimeout(800);
c.act = await W.screenshot();
await W.keyboard.press('Escape');
await W.waitForTimeout(300);
await W.getByRole('button', { name: 'เพิ่มสถานที่' }).click();
await W.waitForTimeout(900);
c.create = await W.screenshot();
await W.keyboard.press('Escape');
await W.goto('/master/customers');
await W.waitForTimeout(1500);
await W.getByRole('row', { name: new RegExp(CUS[0]) }).click();
await W.waitForTimeout(900);
await W.getByRole('tab', { name: 'ที่อยู่ส่ง' }).click();
await W.waitForTimeout(900);
c.custaddr = await W.screenshot();

for (const tag of ['list', 'drawer', 'create', 'act', 'custaddr']) {
  const M = await (await b.newContext({ viewport: { width: 2900, height: 960 } })).newPage();
  const left = a[tag] ?? a.drawer;
  await M.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ (TMS v4)${a[tag] ? '' : ' — ไม่มีแท็บนี้ (แสดง drawer ทั่วไป)'}</div><img src="data:image/png;base64,${left.toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web)</div><img src="data:image/png;base64,${c[tag].toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st2-sites-${tag}-1440.png` });
  console.log(`wrote design/compare/st2-sites-${tag}-1440.png`);
}
await b.close();
srv.close();
