// ภาพเทียบ "ต้นแบบ | ของจริง" ของหน้า ข้อมูลหลัก → Rate card (ST2-T13 ขาขาย) ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้องมี web dev + API dev ที่รันโค้ด ST2-T13 + seed · ใช้: node scripts/compare-rate-cards.mjs
// (web อื่น: WEB=http://localhost:4820 node scripts/compare-rate-cards.mjs)
// สร้างข้อมูลตัวอย่าง (สมมติ) ผ่าน API แบบ PUT external (รันซ้ำได้): สถานที่ เส้นทาง ลูกค้า rate (อนุมัติบางรายการ)
import { chromium } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, writeFileSync } from 'node:fs';
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
const a = { list: await P.screenshot() };
await P.locator('tbody tr').nth(0).click(); // RC-S001 มีผล
await P.waitForTimeout(900);
a.drawer = await P.screenshot();
await close(P);
await P.locator('tbody tr').nth(6).click(); // RC-S007 รออนุมัติ
await P.waitForTimeout(900);
a.draft = await P.screenshot();
await close(P);
await nav(P, 'ข้อมูลหลัก', 'ลูกค้า');
await P.locator('tbody tr').nth(0).click();
await P.waitForTimeout(900);
await P.getByText('Rate card', { exact: true }).filter({ visible: true }).last().click();
await P.waitForTimeout(500);
a.cust = await P.screenshot();

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

// สถานที่/เส้นทางตามข้อมูลตัวอย่างของต้นแบบ (this.R) — ชื่อสมมติ
const SITES = ['กรุงเทพ', 'ชลบุรี', 'ระยอง', 'บางปู', 'แหลมฉบัง', 'อยุธยา', 'สระบุรี'];
const site = [];
for (const [i, name] of SITES.entries())
  site.push(
    (
      await put(`/v1/customer-sites/external/DEMO-RC-LOC-${i + 1}`, {
        name,
        kind: 'DROPOFF',
        customerId: null,
        address: { line1: name },
      })
    ).id,
  );
const ROUTES = [
  [0, 1, 95],
  [0, 2, 180],
  [3, 4, 110],
  [5, 6, 65],
];
for (const [i, [o, d, km]] of ROUTES.entries())
  await put(`/v1/routes/external/DEMO-RC-RT-${i + 1}`, {
    originId: site[o],
    destinationId: site[d],
    distanceKm: km,
  });
// ลูกค้าสมมติ
const CUSTS = [
  'บจก. สยามพลาสติก (ตัวอย่าง)',
  'บจก. ตัวอย่างเครื่องดื่มโลจิสติกส์',
  'บจก. ตัวอย่างอินดัสทรี',
  'บจก. ตัวอย่างไพพ์',
];
const cust = [];
for (const [i, legalName] of CUSTS.entries())
  cust.push((await put(`/v1/customers/external/DEMO-RC-CUS-${i + 1}`, { legalName })).id);
const vts = (await (await W.request.get('/v1/vehicle-types?limit=50', { headers: H })).json()).data;
const vt = (c) => vts.find((x) => x.code === c).id;
const day = (n) => new Date(Date.now() + 7 * 3600_000 + n * 86_400_000).toISOString().slice(0, 10);
// [ลูกค้า, เส้นทาง, ประเภทรถ, สูตร, ราคา, ค่าเพิ่มต่อจุด, จุด, ตั้งแต่, ถึง, อนุมัติ]
const RATES = [
  [0, 0, '6W', 'PER_TRIP', '6500', '300', 2, -120, 245, true],
  [0, 1, '10W', 'PER_TRIP', '10400', '350', 2, -120, 245, true],
  [1, 1, '10W', 'PER_TRIP', '14200', '400', 3, -300, 18, true],
  [1, 2, '10W', 'PER_KM', '95', null, 2, -60, 300, true],
  [2, 2, '6W', 'PER_TRIP', '7200', '300', 2, -200, 25, true],
  [3, 3, 'TRL', 'PER_TON', '420', null, 2, -90, 270, true],
  [2, 0, '6W', 'PER_TRIP', '16800', '500', 2, 0, 365, false],
  [1, 3, '10W', 'PER_TRIP', '10400', '350', 2, -400, -10, true],
];
for (const [i, [c, r, t, m, price, ex, n, from, to, ok]] of RATES.entries()) {
  const [o, d] = ROUTES[r];
  const rc = await put(`/v1/rate-cards/external/DEMO-RC-${i + 1}`, {
    customerId: cust[c],
    originId: site[o],
    destinationId: site[d],
    vehicleTypeId: vt(t),
    pricingModel: m,
    sellRate: price,
    sellExtraStopRate: ex,
    includedStops: n,
    validFrom: day(from),
    validTo: day(to),
  }).catch((e) => (String(e).includes(' 409 ') ? null : Promise.reject(e)));
  if (rc && ok && rc.status === 'draft')
    await W.request.post(`/v1/rate-cards/${rc.id}/approve`, {
      headers: H,
      data: { reason: 'อนุมัติตามใบเสนอราคา (ตัวอย่าง)' },
    });
}

await W.goto('/master/rate-cards');
await W.waitForTimeout(1800);
const c = { list: await W.screenshot() };
await W.locator('tbody tr')
  .filter({ hasText: 'สยามพลาสติก' })
  .filter({ hasText: '6,500' })
  .first()
  .click();
await W.waitForTimeout(900);
c.drawer = await W.screenshot();
await close(W);
await W.locator('tbody tr').filter({ hasText: 'รออนุมัติ' }).first().click();
await W.waitForTimeout(900);
c.draft = await W.screenshot();
await W.getByRole('tab', { name: 'กิจกรรม' }).click();
await W.waitForTimeout(800);
c.act = await W.screenshot();
await close(W);
await W.goto('/master/customers');
await W.waitForTimeout(1500);
await W.locator('tbody tr').filter({ hasText: 'สยามพลาสติก' }).first().click();
await W.waitForTimeout(900);
await W.getByRole('tab', { name: 'Rate card' }).click();
await W.waitForTimeout(800);
c.cust = await W.screenshot();

for (const tag of ['list', 'drawer', 'draft', 'act', 'cust']) {
  const M = await (await b.newContext({ viewport: { width: 2900, height: 960 } })).newPage();
  const left = a[tag] ?? a.drawer;
  await M.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ (TMS v4)${a[tag] ? '' : ' — ไม่มีแท็บนี้ (แสดง drawer ทั่วไป)'}</div><img src="data:image/png;base64,${left.toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web)</div><img src="data:image/png;base64,${c[tag].toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st2-rate-cards-${tag}-1440.png` });
  console.log(`wrote design/compare/st2-rate-cards-${tag}-1440.png`);
}
writeFileSync('/dev/null', '');
await b.close();
srv.close();
