// ภาพเทียบ "ต้นแบบ | ของจริง" ของ geocode สถานที่ (ST2-T03) ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้องมี web dev (4420) + API dev (4410) + worker (`pnpm --filter @tms/api dev:worker`) ที่รันโค้ด ST2-T03 + seed
// ใช้: node scripts/compare-geocode.mjs (web อื่น: WEB=http://localhost:4620 node scripts/compare-geocode.mjs)
// สร้างสถานที่ตัวอย่าง (สมมติ) ใน demo-a ด้วย PUT /v1/customer-sites/external/DEMO-GEO-… แล้วรอ worker geocode (provider จำลอง)
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
const a = {};
// drawer จุดที่ยังไม่ปักหมุด (ต้นแบบไม่มีสถานะรอยืนยัน/หาไม่พบ — ใช้จุด "ยังไม่ปักหมุด" เทียบ)
const unpinned = P.locator('tbody tr').filter({ hasText: 'ยังไม่ปักหมุด' }).first();
if (await unpinned.count()) {
  await unpinned.click();
  await P.waitForTimeout(900);
  a.review = await P.screenshot();
  a.failed = a.review;
  await P.keyboard.press('Escape');
  await P.locator('button[title="ปิด"]')
    .filter({ visible: true })
    .first()
    .click()
    .catch(() => {});
  await P.waitForTimeout(400);
}
a.list = await P.screenshot();
await P.getByText('เพิ่มสถานที่', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(900);
const pdlg = P.locator('textarea').filter({ visible: true }).first();
await pdlg.fill('99 ถ.สุขุมวิท ต.ศรีราชา อ.ศรีราชา จ.ชลบุรี 20110').catch(() => {});
await P.getByText('ประมาณจากที่อยู่', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(900);
a.estimate = await P.screenshot();

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

// สถานที่ตัวอย่าง (สมมติ) ไม่มีพิกัด — ที่อยู่จริง (ได้พิกัดเสนอ) และที่อยู่มั่ว (FAILED)
const GEO = [
  ['คลังตัวอย่าง ศรีราชา (รอยืนยัน)', '99 ถ.ตัวอย่าง ต.ศรีราชา อ.ศรีราชา จ.ชลบุรี 20110'],
  ['จุดส่งตัวอย่าง (ที่อยู่ไม่ชัด)', 'หลังตลาดเก่า ซอยไม่มีชื่อ'],
];
const ids = [];
for (const [i, [name, line1]] of GEO.entries()) {
  // ส่ง lat/lng เป็น null → ล้างพิกัดเดิม (ถ้าเคยยืนยันจากการรันก่อน) แล้ว geocode ใหม่
  const res = await W.request.put(`/v1/customer-sites/external/DEMO-GEO-${i + 1}`, {
    headers: H,
    data: { name, kind: 'DROPOFF', address: { line1 }, lat: null, lng: null },
  });
  if (!res.ok()) console.error('seed site failed', res.status(), await res.text());
  ids.push((await res.json()).id);
}
// รอ worker geocode
for (let n = 0; n < 30; n++) {
  const s = await Promise.all(
    ids.map(async (id) => (await W.request.get(`/v1/customer-sites/${id}`, { headers: H })).json()),
  );
  if (s[0].geocodeProposal && s[1].geocodeStatus === 'FAILED') break;
  if (n === 29) console.error('worker did not geocode — run pnpm --filter @tms/api dev:worker');
  await W.waitForTimeout(1000);
}
const c = {};
await W.goto('/master/locations');
await W.waitForTimeout(1500);
c.list = await W.screenshot();
await W.getByRole('row', { name: new RegExp(GEO[0][0].replace(/[()]/g, '.')) }).click();
await W.waitForTimeout(900);
c.review = await W.screenshot();
await W.keyboard.press('Escape');
await W.waitForTimeout(300);
await W.getByRole('row', { name: new RegExp(GEO[1][0].replace(/[()]/g, '.')) }).click();
await W.waitForTimeout(900);
c.failed = await W.screenshot();
await W.keyboard.press('Escape');
await W.waitForTimeout(300);
await W.getByRole('button', { name: 'เพิ่มสถานที่' }).click();
await W.waitForTimeout(700);
const d = W.getByRole('dialog');
await d.getByLabel('ที่อยู่').fill('99 ถ.สุขุมวิท ต.ศรีราชา อ.ศรีราชา จ.ชลบุรี 20110');
await d.getByRole('button', { name: 'ประมาณจากที่อยู่' }).click();
await W.waitForTimeout(900);
c.estimate = await W.screenshot();

for (const tag of ['list', 'estimate', 'review', 'failed']) {
  const M = await (await b.newContext({ viewport: { width: 2900, height: 960 } })).newPage();
  const left = a[tag] ?? a.list;
  const note =
    tag === 'review' || tag === 'failed' ? ' — ไม่มีสถานะนี้ (แสดงจุด "ยังไม่ปักหมุด")' : '';
  await M.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ (TMS v4)${note}</div><img src="data:image/png;base64,${left.toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web)</div><img src="data:image/png;base64,${c[tag].toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st2-geocode-${tag}-1440.png` });
  console.log(`wrote design/compare/st2-geocode-${tag}-1440.png`);
}
await b.close();
srv.close();
