// ภาพเทียบ "ต้นแบบ | ของจริง" ของหน้า ข้อมูลหลัก → สินค้าและหน่วย (ST2-T10) ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้องมี web dev + API dev ที่รันโค้ด ST2-T10 + seed · ใช้: WEB=http://localhost:4820 node scripts/compare-products.mjs
// สร้างสินค้าตัวอย่าง (สมมติ — ชื่อ/ตัวเลขตามข้อมูลตัวอย่างของต้นแบบ PR) ใน demo-a ด้วย PUT /v1/products/external/DEMO-PRD-…
// รันซ้ำได้ไม่เกิดแถวใหม่ · หน่วยมาจากค่าเริ่มต้นของ tenant (bootstrap ขั้น units)
import { chromium } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, writeFileSync } from 'node:fs';
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

const vp = { width: 1440, height: 900 };
const b = await chromium.launch();
const close = async (page) => {
  await page.keyboard.press('Escape');
  await page
    .locator('button[title="ปิด"]')
    .filter({ visible: true })
    .first()
    .click({ timeout: 1000 })
    .catch(() => {});
  await page.waitForTimeout(400);
};

// ---------- ต้นแบบ ----------
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(`http://localhost:${port}/TMS%20v4.dc.html`);
await P.waitForTimeout(3000);
await P.getByText('ข้อมูลหลัก', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(400);
await P.getByText('สินค้าและหน่วย', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(1200);
const a = { list: await P.screenshot() };
await P.locator('tbody tr').nth(4).click();
await P.waitForTimeout(900);
a.drawer = await P.screenshot();
await close(P);
await P.getByText('เพิ่มสินค้า', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(900);
a.create = await P.screenshot();
await P.getByText('เพิ่มสินค้า', { exact: true }).filter({ visible: true }).last().click();
await P.waitForTimeout(400);
a.invalid = await P.screenshot();

if (process.env.PROTO_ONLY) {
  for (const [k, v] of Object.entries(a))
    writeFileSync(`${process.env.PROTO_ONLY}/proto-${k}.png`, v);
  await b.close();
  srv.close();
  process.exit(0);
}

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

// สินค้าตัวอย่าง (สมมติ) ตามต้นแบบ PR: [ชื่อ, หน่วย, น้ำหนัก, ปริมาตร, พิเศษ] — "ถัง" ไม่อยู่ในหน่วยเริ่มต้น → ใช้ "ชิ้น"
const PR = [
  ['เม็ดพลาสติก PP', 'BAG', 25, 0.04, {}],
  ['เครื่องดื่มบรรจุขวด', 'PLT', 980, 1.44, {}],
  ['ชิ้นส่วนยานยนต์', 'BOX', 18, 0.06, { fragile: true }],
  ['เหล็กแผ่นรีดร้อน', 'TON', null, 0.13, {}],
  ['ผลิตภัณฑ์นม', 'PLT', 720, 1.2, { tempControlled: true, tempMinC: 2, tempMaxC: 8 }],
  ['ปูนซีเมนต์ถุง', 'BAG', 50, 0.035, {}],
  [
    'สารเคมีอุตสาหกรรม (UN1993)',
    'PCS',
    210,
    0.25,
    { hazardous: true, unNumber: '1993', hazardClass: '3' },
  ],
  ['กระจกอาคาร', 'PCS', 65, 0.09, { fragile: true }],
  ['อาหารแช่แข็ง', 'BOX', 12, 0.03, { tempControlled: true, tempMinC: 2, tempMaxC: 8 }],
  ['ตู้คอนเทนเนอร์สินค้าทั่วไป', 'PCS', 18000, 33, {}],
];
for (const [i, [name, unit, w, vol, sp]] of PR.entries()) {
  const r = await W.request.put(`/v1/products/external/DEMO-PRD-${i + 1}`, {
    headers: H,
    data: {
      code: `P-${String(i + 1).padStart(4, '0')}`,
      name,
      unitId: `code:${unit}`,
      ...(w === null ? {} : { weightPerUnitKg: w }),
      volumePerUnitCbm: vol,
      ...sp,
    },
  });
  if (!r.ok()) console.error('seed product failed', r.status(), await r.text());
}

await W.goto('/master/products');
await W.waitForTimeout(1500);
const c = { list: await W.screenshot() };
await W.locator('tbody tr').nth(4).click();
await W.waitForTimeout(900);
c.drawer = await W.screenshot();
await W.getByRole('tab', { name: 'กิจกรรม' }).click();
await W.waitForTimeout(800);
c.act = await W.screenshot();
await W.keyboard.press('Escape');
await W.waitForTimeout(300);
await W.getByRole('button', { name: 'เพิ่มสินค้า' }).click();
await W.waitForTimeout(900);
c.create = await W.screenshot();
await W.getByRole('dialog').getByRole('button', { name: 'เพิ่มสินค้า' }).click();
await W.waitForTimeout(400);
c.invalid = await W.screenshot();
await W.keyboard.press('Escape');
await W.waitForTimeout(300);
await W.getByRole('button', { name: 'จัดการหน่วย' }).click();
await W.waitForTimeout(900);
c.units = await W.screenshot();

for (const tag of ['list', 'drawer', 'create', 'invalid', 'act', 'units']) {
  const M = await (await b.newContext({ viewport: { width: 2900, height: 960 } })).newPage();
  const left = a[tag] ?? a.list;
  await M.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ (TMS v4)${a[tag] ? '' : ' — ไม่มีหน้าจอนี้ (แสดงรายการ)'}</div><img src="data:image/png;base64,${left.toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web)</div><img src="data:image/png;base64,${c[tag].toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st2-products-${tag}-1440.png` });
  console.log(`wrote design/compare/st2-products-${tag}-1440.png`);
}
await b.close();
srv.close();
