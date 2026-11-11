// ภาพเทียบ "ต้นแบบ | ของจริง" ของหน้า ข้อมูลหลัก → เส้นทาง + ช่องโหลดของคลัง (ST2-T09) ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้นแบบ TMS v4 ไม่มีหน้าเส้นทาง [OPEN spec/12 §3] → ฝั่งซ้ายแสดงหน้าที่ใช้เป็นแบบ: ประเภทรถ (รายการ/drawer/ฟอร์ม)
// และ Rate card (คอลัมน์ "เส้นทาง" route chip) · ฟอร์มคลังเทียบกับฟอร์มสถานที่ของต้นแบบ
// ต้องมี web dev + API dev ที่รันโค้ด ST2-T09 + seed · ใช้: WEB=http://localhost:4720 node scripts/compare-routes.mjs
// สร้างข้อมูลตัวอย่าง (สมมติ) ใน demo-a ด้วย PUT …/external/DEMO-… — รันซ้ำได้ไม่เกิดแถวใหม่
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
  await page
    .locator('button[title="ปิด"]')
    .filter({ visible: true })
    .first()
    .click({ timeout: 1000 })
    .catch(() => {});
  await page.waitForTimeout(400);
};
// เมนูซ้าย (nav) เท่านั้น — กันคลิกหัวคอลัมน์ชื่อเดียวกันในตาราง (เช่น "ประเภทรถ" ของ rate card)
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

// ---------- ต้นแบบ (หน้าที่ใช้เป็นแบบ) ----------
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(`http://localhost:${port}/TMS%20v4.dc.html`);
await P.waitForTimeout(3000);
await nav(P, 'ข้อมูลหลัก', 'Rate card');
const a = { list: await P.screenshot() };
await nav(P, 'ข้อมูลหลัก', 'ประเภทรถ');
await P.locator('tbody tr').nth(1).click();
await P.waitForTimeout(900);
a.drawer = await P.screenshot();
await close(P);
await P.getByText('เพิ่มประเภทรถ', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(900);
a.create = await P.screenshot();
await P.getByText('เพิ่มประเภทรถ', { exact: true }).filter({ visible: true }).last().click();
await P.waitForTimeout(400);
a.invalid = await P.screenshot();
await close(P);
await nav(P, 'ข้อมูลหลัก', 'สถานที่ / จุดรับส่ง');
await P.getByText('เพิ่มสถานที่', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(900);
await P.locator('.tms-fdrawer, [role=dialog], aside')
  .last()
  .evaluate((el) => {
    const s = [...el.querySelectorAll('*')].find((x) => x.scrollHeight > x.clientHeight + 20);
    if (s) s.scrollTop = s.scrollHeight;
  });
await P.waitForTimeout(300);
a.depot = await P.screenshot();

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

// สถานที่ตัวอย่าง (สมมติ) — ชื่อ/พิกัดตามข้อมูลตัวอย่างของต้นแบบ (this.R / this.PLC)
const SITES = [
  ['คลังสินค้าบางนา (ศรีไทยขนส่ง)', 'WAREHOUSE', 13.6416, 100.6911, 12],
  ['โรงงานชลบุรี', 'DROPOFF', 13.3611, 100.9847, null],
  ['นิคมอุตสาหกรรมระยอง', 'DROPOFF', 12.6814, 101.2816, null],
  ['ลานตู้บางปู', 'PICKUP', 13.517, 100.656, null],
  ['ท่าเรือแหลมฉบัง', 'DROPOFF', 13.0827, 100.883, null],
  ['คลังสินค้าอยุธยา (วังน้อย)', 'WAREHOUSE', 14.3532, 100.5689, 6],
  ['ศูนย์กระจายสินค้าสระบุรี', 'DROPOFF', 14.5289, 100.9101, null],
];
const ids = [];
for (const [i, [name, kind, lat, lng, dock]] of SITES.entries()) {
  const r = await W.request.put(`/v1/customer-sites/external/DEMO-RT-LOC-${i + 1}`, {
    headers: H,
    data: {
      name,
      kind,
      customerId: null,
      address: { line1: name },
      lat,
      lng,
      openTime: '06:00',
      closeTime: '20:00',
      dockCount: dock,
    },
  });
  if (!r.ok()) console.error('seed site failed', r.status(), await r.text());
  ids.push((await r.json()).id);
}
// เส้นทางตามต้นแบบ R: กรุงเทพ→ชลบุรี 95, →ระยอง 180, บางปู→แหลมฉบัง 110, อยุธยา→สระบุรี 65
const ROUTES = [
  [0, 1, 95, 120, '60'],
  [0, 2, 180, 210, '115'],
  [3, 4, 110, 100, '75'],
  [5, 6, 65, 70, null],
  [1, 0, 95, 125, '60'],
];
for (const [i, [o, d, km, min, toll]] of ROUTES.entries()) {
  const r = await W.request.put(`/v1/routes/external/DEMO-RT-${i + 1}`, {
    headers: H,
    data: {
      originId: ids[o],
      destinationId: ids[d],
      distanceKm: km,
      standardMinutes: min,
      tollAmount: toll,
    },
  });
  if (!r.ok()) console.error('seed route failed', r.status(), await r.text());
}

await W.goto('/master/routes');
await W.waitForTimeout(1500);
const c = { list: await W.screenshot() };
await W.locator('tbody tr').nth(0).click();
await W.waitForTimeout(900);
c.drawer = await W.screenshot();
await W.getByRole('tab', { name: 'กิจกรรม' }).click();
await W.waitForTimeout(800);
c.act = await W.screenshot();
await W.keyboard.press('Escape');
await W.waitForTimeout(300);
await W.getByRole('button', { name: 'เพิ่มเส้นทาง' }).click();
await W.waitForTimeout(900);
c.create = await W.screenshot();
await W.getByRole('dialog').getByRole('button', { name: 'เพิ่มเส้นทาง' }).click();
await W.waitForTimeout(400);
c.invalid = await W.screenshot();
await W.keyboard.press('Escape');
await W.waitForTimeout(300);
// คลัง: ฟอร์มแก้ไขสถานที่ชนิดคลัง เลื่อนถึง "ข้อมูลเพิ่มเติม" (ช่องโหลด)
await W.goto('/master/locations');
await W.waitForTimeout(1500);
await W.getByRole('columnheader').getByPlaceholder('ค้นหา').first().fill('คลังสินค้าบางนา');
await W.waitForTimeout(1200);
await W.locator('tbody tr').first().click();
await W.waitForTimeout(900);
await W.getByRole('dialog').getByRole('button', { name: 'เพิ่มเติม' }).click();
await W.getByRole('menuitem', { name: 'แก้ไข' }).click();
await W.waitForTimeout(900);
await W.getByLabel('ช่องโหลด').scrollIntoViewIfNeeded();
await W.waitForTimeout(300);
c.depot = await W.screenshot();

const LABEL = {
  list: 'Rate card (คอลัมน์เส้นทาง)',
  drawer: 'ประเภทรถ — drawer',
  act: 'ประเภทรถ — drawer',
  create: 'ประเภทรถ — ฟอร์มเพิ่ม',
  invalid: 'ประเภทรถ — ฟอร์มว่างกดเพิ่ม',
  depot: 'สถานที่ — ฟอร์มเพิ่ม (ล่างสุด)',
};
for (const tag of ['list', 'drawer', 'act', 'create', 'invalid', 'depot']) {
  const M = await (await b.newContext({ viewport: { width: 2900, height: 960 } })).newPage();
  const left = a[tag] ?? a.drawer;
  await M.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ (TMS v4) — ไม่มีหน้าเส้นทาง · แบบที่ใช้: ${LABEL[tag]}</div><img src="data:image/png;base64,${left.toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web)</div><img src="data:image/png;base64,${c[tag].toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st2-routes-${tag}-1440.png` });
  console.log(`wrote design/compare/st2-routes-${tag}-1440.png`);
}
await b.close();
srv.close();
