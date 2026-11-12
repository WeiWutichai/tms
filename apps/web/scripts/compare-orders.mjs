// ภาพเทียบ "ต้นแบบ | ของจริง" ของหน้า ปฏิบัติการ → ใบสั่งขนส่ง (SO) (ST3-T02) ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้องมี web dev (4420) + API dev (4410) ที่รันโค้ด ST3-T02 + seed · ใช้: node scripts/compare-orders.mjs
// (web อื่น: WEB=http://localhost:5420 node scripts/compare-orders.mjs)
// ข้อมูลตัวอย่าง (สมมติ) ใน demo-a: ลูกค้า/สถานที่/rate card ด้วย PUT .../external/DEMO-SO-*, ใบสั่งด้วย PUT /v1/orders/external/DEMO-SO-n
// — รันซ้ำได้ไม่เกิดแถวใหม่ (ใบที่สร้างจากฟอร์ม/คัดลอกในสคริปต์เกิดใหม่ทุกครั้ง)
import { chromium } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = process.env.WEB ?? 'http://localhost:4420';
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

function taxId(n) {
  const base = `09998${String(n).padStart(7, '0')}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
  return base + String((11 - (sum % 11)) % 10);
}
const bkk = (d = 0) =>
  new Date(Date.now() + 7 * 3600_000 + d * 86_400_000).toISOString().slice(0, 10);

const vp = { width: 1440, height: 900 };
const b = await chromium.launch();

// ---------- ต้นแบบ ----------
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
const protoHome = async () => {
  await P.goto(`http://localhost:${port}/TMS%20v4.dc.html`);
  await P.waitForTimeout(3000);
  await P.getByText('ใบสั่งขนส่ง (SO)', { exact: true }).filter({ visible: true }).first().click();
  await P.waitForTimeout(1200);
};
await protoHome();
const a = { list: await P.screenshot() };
await P.locator('tbody tr').nth(0).click();
await P.waitForTimeout(900);
a.drawer = await P.screenshot();
await P.locator('button[title="เพิ่มเติม"]').filter({ visible: true }).first().click();
await P.waitForTimeout(400);
a.menu = await P.screenshot();
await P.getByText('คัดลอกเป็นใบใหม่', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(900);
a.copy = await P.screenshot();
await protoHome();
await P.getByText('สร้าง SO', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(900);
a.create = await P.screenshot();

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
const put = async (path, data) => {
  const r = await W.request.put(path, { headers: H, data });
  if (!r.ok()) console.error('seed failed', path, r.status(), (await r.text()).slice(0, 300));
  return r.ok() ? r.json() : null;
};
const ADDR = (p) => ({
  line1: '99 ถนนตัวอย่าง',
  district: 'เมือง',
  province: p,
  postcode: '20000',
});
// demo-a มีหลายนิติบุคคล → ลูกค้าตัวอย่างออกบิลในนามนิติบุคคลแรก (routing ST1-T16)
const cos = await (
  await W.request.get('/v1/companies?status=active&limit=50', { headers: H })
).json();
const cust = [];
for (const [i, n] of [
  'บจก. ตัวอย่างพลาสติก',
  'บมจ. ตัวอย่างเครื่องดื่ม',
  'บจก. ตัวอย่างซีเมนต์',
].entries())
  cust.push(
    await put(`/v1/customers/external/DEMO-SO-C${i + 1}`, {
      legalName: n,
      taxId: taxId(i + 1),
      branchCode: '00000',
      billingCompanyId: cos.data[0].id,
    }),
  );
const site = [];
for (const [i, [n, p]] of [
  ['คลังสินค้าบางนา', 'สมุทรปราการ'],
  ['โรงงานตัวอย่าง ชลบุรี', 'ชลบุรี'],
  ['คลังบางปู', 'สมุทรปราการ'],
  ['ท่าเรือแหลมฉบัง', 'ชลบุรี'],
  ['โรงงานสระบุรี', 'สระบุรี'],
].entries())
  site.push(
    await put(`/v1/customer-sites/external/DEMO-SO-L${i + 1}`, {
      name: n,
      kind: i % 2 ? 'DROPOFF' : 'PICKUP',
      address: ADDR(p),
    }),
  );
const vts = await (await W.request.get('/v1/vehicle-types?limit=50', { headers: H })).json();
const vt = (c) => vts.data.find((x) => x.code === c)?.id ?? vts.data[0].id;
const units = await (await W.request.get('/v1/units?limit=50', { headers: H })).json();
const ton = units.data.find((u) => u.code === 'TON')?.id ?? units.data[0].id;
// rate card ขาขาย 1 เส้นทาง (ให้มีราคาใน drawer) — สร้างครั้งแรกเท่านั้น
const rcs = await (
  await W.request.get(`/v1/rate-cards?limit=50&customerId=${cust[0].id}`, { headers: H })
).json();
if (!rcs.data?.length) {
  const r = await W.request.post('/v1/rate-cards', {
    headers: H,
    data: {
      customerId: cust[0].id,
      originId: site[0].id,
      destinationId: site[1].id,
      vehicleTypeId: vt('6W'),
      validFrom: bkk(-30),
      pricingModel: 'PER_TRIP',
      sellRate: '4500',
      includedStops: 2,
    },
  });
  if (r.ok())
    await W.request.post(`/v1/rate-cards/${(await r.json()).id}/approve`, {
      headers: H,
      data: { reason: 'อนุมัติตามใบเสนอราคา (ตัวอย่าง)' },
    });
  else console.error('rate card', r.status(), (await r.text()).slice(0, 300));
}
const ORD = [
  [0, 0, 1, 0, '6W', '4200', 'PO-45861'],
  [1, 2, 3, 0, '10W', '12800', 'PO-45868'],
  [2, 4, 1, 1, '6W', '8600', null],
  [0, 0, 1, -1, '6W', '3500', 'PO-45882'],
  [1, 2, 3, 1, '10W', '9400', 'PO-45889'],
];
for (const [i, [c, o, d, day, t, w, po]] of ORD.entries())
  await put(`/v1/orders/external/DEMO-SO-${i + 1}`, {
    customer: { id: cust[c].id },
    customerRef: po,
    requestedDate: bkk(day),
    vehicleTypeId: vt(t),
    stops: [
      {
        type: 'PICKUP',
        siteId: site[o].id,
        windowStart: `${bkk(day)}T07:00:00+07:00`,
        windowEnd: `${bkk(day)}T09:00:00+07:00`,
      },
      {
        type: 'DELIVERY',
        siteId: site[d].id,
        windowStart: `${bkk(day)}T13:00:00+07:00`,
        windowEnd: `${bkk(day)}T16:00:00+07:00`,
      },
    ],
    lines: [
      { description: 'สินค้าตัวอย่าง', qty: String(Number(w) / 1000), unitId: ton, weightKg: w },
    ],
  });
// ใบค้าง: ปลายทางยังจับคู่ไม่ได้ / ลูกค้าไม่รู้จัก
await put('/v1/orders/external/DEMO-SO-6', {
  customer: { id: cust[2].id },
  requestedDate: bkk(1),
  vehicleTypeId: vt('6W'),
  stops: [
    { type: 'PICKUP', siteId: site[4].id },
    { type: 'DELIVERY', siteText: 'ร้านวัสดุก่อสร้างตัวอย่าง อ.เมือง' },
  ],
});
await put('/v1/orders/external/DEMO-SO-7', {
  customer: { externalId: 'X-77', name: 'EASTERN SAMPLE CO.,LTD.' },
  billingCompanyId: cos.data[0].id,
  requestedDate: bkk(1),
  vehicleTypeId: vt('6W'),
  stops: [
    { type: 'PICKUP', siteId: site[2].id },
    { type: 'DELIVERY', siteId: site[3].id },
  ],
});

await W.goto('/so');
await W.waitForTimeout(1800);
const c = { list: await W.screenshot() };
if (process.env.DEBUG_SHOT) await W.screenshot({ path: process.env.DEBUG_SHOT });
await W.locator('tbody tr').getByText('บจก. ตัวอย่างพลาสติก').first().click();
await W.waitForTimeout(1200);
c.drawer = await W.screenshot();
await W.getByRole('button', { name: 'เพิ่มเติม' }).click();
await W.waitForTimeout(300);
c.menu = await W.screenshot();
await W.getByRole('menuitem', { name: 'คัดลอกเป็นใบใหม่' }).click();
await W.waitForTimeout(1200);
c.copy = await W.screenshot();
await W.keyboard.press('Escape');
await W.waitForTimeout(400);
await W.keyboard.press('Escape');
await W.waitForTimeout(300);
await W.getByRole('button', { name: 'สร้าง SO' }).click();
await W.waitForTimeout(1200);
c.create = await W.screenshot();
await W.keyboard.press('Escape');
await W.waitForTimeout(300);
await W.getByRole('button', { name: 'สร้างจากเทมเพลต' }).click();
await W.waitForTimeout(1000);
c.templates = await W.screenshot();

for (const tag of ['list', 'drawer', 'menu', 'copy', 'create', 'templates']) {
  const M = await (await b.newContext({ viewport: { width: 2900, height: 960 } })).newPage();
  const left = a[tag] ?? a.create;
  await M.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ (TMS v4)${a[tag] ? '' : ' — ไม่มีหน้าจอนี้ (แสดงฟอร์มสร้าง SO ที่ใช้เป็นแบบ)'}</div><img src="data:image/png;base64,${left.toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web /so)</div><img src="data:image/png;base64,${c[tag].toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st3-order-${tag}-1440.png` });
  console.log(`wrote design/compare/st3-order-${tag}-1440.png`);
}
await b.close();
srv.close();
