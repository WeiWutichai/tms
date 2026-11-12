// ภาพเทียบ "ต้นแบบ | ของจริง" ของหน้า Rate card ฝั่งขาซื้อ + drawer ผู้รับเหมา (ST2-T14) ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้องมี web dev + API dev ที่รันโค้ด ST2-T14 + seed · ใช้: node scripts/compare-rate-cards-buy.mjs
// (web อื่น: WEB=http://localhost:4820 node scripts/compare-rate-cards-buy.mjs)
// สร้างข้อมูลตัวอย่าง (สมมติ) ผ่าน API แบบ PUT external (รันซ้ำได้): สถานที่ เส้นทาง ผู้รับเหมา rate ขาซื้อ (อนุมัติบางรายการ)
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

const vp = { width: 1440, height: 900 };
const b = await chromium.launch();
const close = async (page) => {
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
};
const nav = async (P, group, item) => {
  const side = P.locator('nav, aside').first();
  const it = side.getByText(item, { exact: true }).filter({ visible: true });
  if (!(await it.count())) {
    await side.getByText(group, { exact: true }).filter({ visible: true }).first().click();
    await P.waitForTimeout(400);
  }
  await it.first().click();
  await P.waitForTimeout(1200);
};

// ---------- ต้นแบบ ----------
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(`http://localhost:${port}/TMS%20v4.dc.html`);
await P.waitForTimeout(3000);
await nav(P, 'ข้อมูลหลัก', 'Rate card');
await P.getByText('ขาซื้อ · รถร่วม').filter({ visible: true }).first().click();
await P.waitForTimeout(800);
const a = { list: await P.screenshot() };
await P.locator('tbody tr').nth(0).click(); // RC-B001 มีผล
await P.waitForTimeout(900);
a.drawer = await P.screenshot();
await close(P);
await P.locator('tbody tr').nth(6).click(); // RC-B007 รออนุมัติ
await P.waitForTimeout(900);
a.draft = await P.screenshot();
await close(P);
await nav(P, 'รถ', 'คนขับและผู้รับเหมา');
await P.getByText('ผู้รับเหมา', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(800);
await P.locator('tbody tr').nth(0).locator('td').last().click();
await P.waitForTimeout(500);
a.menu = await P.screenshot();
await close(P);
await P.locator('tbody tr').nth(0).click();
await P.waitForTimeout(900);
a.con = await P.screenshot();

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
  if (!r.ok()) throw new Error(`${path} ${r.status()} ${await r.text()}`);
  return r.json();
};

// เส้นทางตามข้อมูลตัวอย่างของต้นแบบ (this.R) — ชื่อสมมติ
const R = [
  ['กรุงเทพ', 'ชลบุรี', 95],
  ['กรุงเทพ', 'ระยอง', 180],
  ['บางปู', 'แหลมฉบัง', 110],
  ['อยุธยา', 'สระบุรี', 65],
  ['ลาดกระบัง', 'นครราชสีมา', 250],
];
// ชื่อที่หน้าเทียบขาขายสร้างแล้วใช้ externalId เดิม (กันชื่อซ้ำ) — ที่เหลือเป็น DEMO-RCB-LOC-n
const SELL_SITES = ['กรุงเทพ', 'ชลบุรี', 'ระยอง', 'บางปู', 'แหลมฉบัง', 'อยุธยา', 'สระบุรี'];
const EXTRA_SITES = ['ลาดกระบัง', 'นครราชสีมา'];
const siteId = {};
const site = async (name) =>
  (siteId[name] ??= (
    await put(
      SELL_SITES.includes(name)
        ? `/v1/customer-sites/external/DEMO-RC-LOC-${SELL_SITES.indexOf(name) + 1}`
        : `/v1/customer-sites/external/DEMO-RCB-LOC-${EXTRA_SITES.indexOf(name) + 1}`,
      { name, kind: 'DROPOFF', customerId: null, address: { line1: name } },
    )
  ).id);
for (const [i, [o, d, km]] of R.entries())
  await put(`/v1/routes/external/DEMO-RCB-RT-${i + 1}`, {
    originId: await site(o),
    destinationId: await site(d),
    distanceKm: km,
  }).catch((e) => (String(e).includes(' 409 ') ? null : Promise.reject(e)));
// ผู้รับเหมาสมมติ (ต้นแบบ SUB)
const jurTax = (n) => {
  const base = `0105${String(n).padStart(8, '0')}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
  return base + String((11 - (sum % 11)) % 10);
};
const SUBS = [
  'หจก. ทรัพย์สมบูรณ์ขนส่ง (ตัวอย่าง)',
  'บจก. เจริญยนต์ทรานสปอร์ต (ตัวอย่าง)',
  'หจก. ศรีราชาโลจิสติกส์ (ตัวอย่าง)',
  'หจก. ตัวอย่างรถร่วม',
];
const car = [];
for (const [i, legalName] of SUBS.entries())
  car.push(
    (
      await put(`/v1/carriers/external/DEMO-RCB-CAR-${i + 1}`, {
        legalName,
        entityType: 'JURISTIC',
        taxId: jurTax(880_100 + i),
      })
    ).id,
  );
const vts = (await (await W.request.get('/v1/vehicle-types?limit=50', { headers: H })).json()).data;
const vt = (c) => vts.find((x) => x.code === c).id;
const day = (n) => new Date(Date.now() + 7 * 3600_000 + n * 86_400_000).toISOString().slice(0, 10);
// ต้นแบบ rates ขาซื้อ: [ผู้รับเหมา, เส้นทาง, ประเภทรถ, สูตร, ราคา, ค่าเพิ่มต่อจุด, จุด, ตั้งแต่, ถึง, อนุมัติ]
const RATES = [
  [0, 0, '6W', 'PER_TRIP', '5100', '250', 2, -100, 265, true],
  [0, 1, '10W', 'PER_TRIP', '8900', '300', 2, -100, 265, true],
  [0, 4, '10W', 'PER_TRIP', '11800', null, 2, -100, 20, true],
  [1, 1, 'TRL', 'PER_TRIP', '16200', null, 2, -60, 300, true],
  [1, 3, '10W', 'PER_TRIP', '4300', '250', 2, -60, 300, true],
  [2, 2, '10W', 'PER_TRIP', '5800', '250', 2, -30, 330, true],
  [2, 2, 'REF6', 'PER_TRIP', '9200', '300', 2, 0, 365, false],
  [3, 0, '6W', 'PER_TRIP', '4800', null, 2, -400, -20, true],
];
for (const [i, [c, r, t, m, price, ex, n, from, to, ok]] of RATES.entries()) {
  const rc = await put(`/v1/rate-cards/external/DEMO-RCB-${i + 1}`, {
    side: 'BUY',
    carrierId: car[c],
    originId: await site(R[r][0]),
    destinationId: await site(R[r][1]),
    vehicleTypeId: vt(t),
    pricingModel: m,
    buyRate: price,
    buyExtraStopRate: ex,
    includedStops: n,
    validFrom: day(from),
    validTo: day(to),
  }).catch((e) => (String(e).includes(' 409 ') ? null : Promise.reject(e)));
  if (rc && ok && rc.status === 'draft')
    await W.request.post(`/v1/rate-cards/${rc.id}/approve`, {
      headers: H,
      data: { reason: 'อนุมัติตามราคาที่ตกลง (ตัวอย่าง)' },
    });
}

await W.goto('/master/rate-cards');
await W.waitForTimeout(1500);
await W.getByRole('tab', { name: /ขาซื้อ · รถร่วม/ }).click();
await W.waitForTimeout(1500);
const c = { list: await W.screenshot() };
await W.locator('tbody tr')
  .filter({ hasText: 'ทรัพย์สมบูรณ์' })
  .filter({ hasText: '5,100' })
  .first()
  .click();
await W.waitForTimeout(900);
c.drawer = await W.screenshot();
await close(W);
await W.locator('tbody tr').filter({ hasText: 'รออนุมัติ' }).first().click();
await W.waitForTimeout(900);
c.draft = await W.screenshot();
await close(W);
await W.getByRole('tab', { name: /ขาขาย · ลูกค้า/ }).click(); // คืนฝั่งเริ่มต้น (session)
await W.goto('/fleet/drivers?tab=con');
await W.waitForTimeout(1500);
const crow = W.locator('tbody tr').filter({ hasText: 'ทรัพย์สมบูรณ์' }).first();
await crow.getByRole('button', { name: 'การกระทำ' }).click();
await W.waitForTimeout(500);
c.menu = await W.screenshot();
await close(W);
await crow.click();
await W.waitForTimeout(1200);
c.con = await W.screenshot();

for (const tag of ['list', 'drawer', 'draft', 'menu', 'con']) {
  const M = await (await b.newContext({ viewport: { width: 2900, height: 960 } })).newPage();
  await M.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ (TMS v4)</div><img src="data:image/png;base64,${a[tag].toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web)</div><img src="data:image/png;base64,${c[tag].toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st2-buy-rate-cards-${tag}-1440.png` });
  console.log(`wrote design/compare/st2-buy-rate-cards-${tag}-1440.png`);
}
await b.close();
srv.close();
