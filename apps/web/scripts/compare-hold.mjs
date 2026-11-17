// ภาพเทียบ "ต้นแบบ | ของจริง" ของหน้า ปฏิบัติการ → ใบค้าง (ST3-T07) ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้องมี web dev (4420) + API dev (4410) ที่รันโค้ด ST3-T07 + seed · ใช้: node scripts/compare-hold.mjs
// (web อื่น: WEB=http://localhost:4820 node scripts/compare-hold.mjs · เขียนสำเนาเพิ่ม: OUT2=/path/)
// ต้นแบบไม่มีหน้าใบค้าง ([DECISION — ย้อนได้] spec/12 §3, PO 16 พ.ย. 2569) → ฝั่งซ้ายเป็นหน้าที่ใช้เป็นแบบ: รายการ SO,
// drawer SO ที่ยังไม่จับคู่ลูกค้า (กล่องเลือกลูกค้า + ปุ่ม "จับคู่ลูกค้า"), popover "เปลี่ยนสถานที่", ราคา "ไม่พบ rate card",
// "กำหนดราคาเอง" (ช่องราคา — sox.setManual/mp)
// ข้อมูลตัวอย่าง (สมมติ) ใน demo-a ด้วย PUT .../external/DEMO-HOLD-* — รันซ้ำได้ไม่เกิดแถวใหม่
import { chromium } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = process.env.WEB ?? `http://localhost:${process.env.WEB_PORT ?? 4420}`;
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
  const base = `09997${String(n).padStart(7, '0')}`;
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
await P.goto(`http://localhost:${port}/TMS%20v4.dc.html`);
await P.waitForTimeout(3000);
await P.getByText('ใบสั่งขนส่ง (SO)', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(1200);
const a = { list: await P.screenshot() };
await P.locator('tbody tr').filter({ hasText: 'SO-2611-0127' }).first().click();
await P.waitForTimeout(900);
a.match = await P.screenshot();
await P.keyboard.press('Escape');
await P.waitForTimeout(500);
await P.locator('tbody tr').filter({ hasText: 'SO-2611-0123' }).first().click();
await P.waitForTimeout(900);
await P.getByText('เปลี่ยนสถานที่', { exact: true }).filter({ visible: true }).nth(1).click();
await P.waitForTimeout(600);
a.site = await P.screenshot();
await P.getByText('ราคา', { exact: true })
  .filter({ visible: true })
  .first()
  .scrollIntoViewIfNeeded();
await P.waitForTimeout(400);
a.rate = await P.screenshot();
// ใบที่ไม่พบ rate card ในข้อมูลตัวอย่างของต้นแบบ — ไล่เปิดแถวจนเจอปุ่ม "กำหนดราคาเอง"
const manualBtn = P.getByRole('button', { name: 'กำหนดราคาเอง' }).filter({ visible: true });
for (let i = 0; i < 25 && !(await manualBtn.count()); i++) {
  await P.keyboard.press('Escape');
  await P.waitForTimeout(300);
  const row = P.locator('tbody tr').nth(i);
  if (!(await row.count())) break;
  await row.click();
  await P.waitForTimeout(600);
}
if (await manualBtn.count()) {
  await manualBtn.first().scrollIntoViewIfNeeded();
  a.rate = await P.screenshot();
  await manualBtn.first().click();
  await P.waitForTimeout(500);
}
a.manual = await P.screenshot();

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
const cos = await (
  await W.request.get('/v1/companies?status=active&limit=50', { headers: H })
).json();
const cust = [];
for (const [i, n] of ['บจก. ตัวอย่างอาหารทะเล', 'บจก. ตัวอย่างท่อเหล็ก'].entries())
  cust.push(
    await put(`/v1/customers/external/DEMO-HOLD-C${i + 1}`, {
      legalName: n,
      taxId: taxId(i + 1),
      branchCode: '00000',
      billingCompanyId: cos.data[0].id,
    }),
  );
const site = [];
for (const [i, [n, p, c]] of [
  ['คลังสินค้าลาดกระบัง', 'กรุงเทพมหานคร', null],
  ['ห้องเย็นมหาชัย', 'สมุทรสาคร', 0],
  ['โรงงานท่อเหล็ก บางพลี', 'สมุทรปราการ', 1],
].entries())
  site.push(
    await put(`/v1/customer-sites/external/DEMO-HOLD-L${i + 1}`, {
      name: n,
      kind: i ? 'DROPOFF' : 'PICKUP',
      address: ADDR(p),
      ...(c !== null ? { customerId: cust[c].id } : {}),
    }),
  );
const vts = await (await W.request.get('/v1/vehicle-types?limit=50', { headers: H })).json();
const vt = (c) => vts.data.find((x) => x.code === c)?.id ?? vts.data[0].id;
const order = (i, body) =>
  put(`/v1/orders/external/DEMO-HOLD-${i}`, {
    requestedDate: bkk(i % 2),
    vehicleTypeId: vt('6W'),
    billingCompanyId: cos.data[0].id,
    lines: [{ description: 'สินค้าตัวอย่าง', qty: '10', unit: 'พาเลท', weightKg: '3500' }],
    ...body,
  });
// ลูกค้าไม่รู้จัก (CUSTOMER_UNMAPPED)
await order(1, {
  customer: { externalId: 'X-3301', name: 'EASTERN SEAFOOD SAMPLE CO.,LTD.' },
  stops: [
    { type: 'PICKUP', siteId: site[0].id },
    { type: 'DELIVERY', siteText: 'ห้องเย็น มหาชัย' },
  ],
});
// ปลายทางยังจับคู่ไม่ได้ (LOCATION_UNMAPPED → "รอกำหนดเส้นทาง" — ฐาน dev ที่เคยเรียน alias แล้วจะจับคู่ได้เอง; ภาพ popover ใช้ใบที่ 1)
await order(2, {
  customer: { id: cust[1].id },
  stops: [
    { type: 'PICKUP', siteId: site[0].id },
    { type: 'DELIVERY', siteText: 'โรงงานท่อเหล็ก (บางพลี)' },
  ],
});
// ไม่มี rate card (RATE_MISSING)
await order(3, {
  customer: { id: cust[0].id },
  stops: [
    { type: 'PICKUP', siteId: site[0].id },
    { type: 'DELIVERY', siteId: site[1].id },
  ],
});
await order(4, {
  customer: { id: cust[1].id },
  stops: [
    { type: 'PICKUP', siteId: site[0].id },
    { type: 'DELIVERY', siteId: site[2].id },
  ],
});

await W.goto('/so/hold');
await W.waitForTimeout(1800);
const c = { list: await W.screenshot() };
await W.locator('tbody tr').filter({ hasText: 'EASTERN SEAFOOD SAMPLE' }).first().click();
await W.waitForTimeout(1200);
c.match = await W.screenshot();
await W.keyboard.press('Escape');
await W.waitForTimeout(500);
await W.locator('tbody tr').filter({ hasText: 'EASTERN SEAFOOD SAMPLE' }).first().click();
await W.waitForTimeout(1200);
const pick = W.locator('aside.tms-drawer').getByRole('button', { name: 'เลือกสถานที่' }).first();
await pick.click();
await W.waitForTimeout(900);
c.site = await W.screenshot();
await W.keyboard.press('Escape');
await W.waitForTimeout(300);
await W.keyboard.press('Escape');
await W.waitForTimeout(500);
await W.locator('tbody tr')
  .filter({ hasText: 'บจก. ตัวอย่างอาหารทะเล' })
  .filter({ hasText: 'ยังไม่มีราคาขาย' })
  .first()
  .click();
await W.waitForTimeout(1200);
await W.locator('aside.tms-drawer').getByText('ราคา', { exact: true }).scrollIntoViewIfNeeded();
await W.waitForTimeout(400);
c.rate = await W.screenshot();
await W.locator('aside.tms-drawer').getByRole('button', { name: 'กำหนดราคาเอง' }).click();
await W.waitForTimeout(500);
c.manual = await W.screenshot();

const LEFT = {
  list: 'ต้นแบบไม่มีหน้าใบค้าง — รายการ SO ที่ใช้เป็นแบบ',
  match: 'drawer SO ยังไม่จับคู่ลูกค้า',
  site: 'drawer SO "เปลี่ยนสถานที่"',
  rate: 'drawer SO ราคา (ไม่พบ rate card)',
  manual: 'drawer SO "กำหนดราคาเอง" (ช่องราคา)',
};
for (const tag of ['list', 'match', 'site', 'rate', 'manual']) {
  const M = await (await b.newContext({ viewport: { width: 2900, height: 960 } })).newPage();
  await M.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ (TMS v4) — ${LEFT[tag]}</div><img src="data:image/png;base64,${a[tag].toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web /so/hold)</div><img src="data:image/png;base64,${c[tag].toString('base64')}"></div></body>`,
  );
  const f = `st3-hold-${tag}-1440.png`;
  await M.screenshot({ path: `${out}${f}` });
  if (process.env.OUT2) {
    mkdirSync(process.env.OUT2, { recursive: true });
    copyFileSync(`${out}${f}`, join(process.env.OUT2, f));
  }
  console.log(`wrote design/compare/${f}`);
}
await b.close();
srv.close();
