// ภาพเทียบ "ต้นแบบ | ของจริง" ของหน้า รถ → คนขับและผู้รับเหมา แท็บคนขับ (ST2-T08) ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้องมี web dev + API dev ที่รันโค้ด ST2-T08 + seed · ใช้: node scripts/compare-drivers.mjs
// (web อื่น: WEB=http://localhost:4620 node scripts/compare-drivers.mjs) · PROTO_ONLY=<dir> = ถ่ายเฉพาะต้นแบบ
// ข้อมูลตัวอย่าง (สมมติ ตามต้นแบบ — ชื่อ/ใบขับขี่/วันหมด/เบอร์) ใส่ผ่าน PUT /v1/drivers/external/DEMO-D0xx — ส่งซ้ำได้ ไม่สร้างแถวซ้ำ
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
// แท็บใน drawer ต้นแบบมีชั้นโปร่งทับ (คลิกผ่าน Playwright ไม่ได้) → กดด้วย DOM
const ptab = (label) =>
  P.evaluate((l) => {
    const bs = [...document.querySelectorAll('button')].filter(
      (b) => b.textContent.trim() === l && b.offsetParent,
    );
    bs[bs.length - 1]?.click();
  }, label);
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(`http://localhost:${port}/TMS%20v4.dc.html`);
await P.waitForTimeout(3000);
await P.getByText('คนขับและผู้รับเหมา', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(1000);
const a = { list: await P.screenshot() };
// แถวที่ 5 (อนุชา — ใบขับขี่หมดแล้ว) ให้เห็นกล่องเตือนใน drawer
await P.locator('tbody tr').nth(4).click();
await P.waitForTimeout(900);
a.drawer = await P.screenshot();
await ptab('คะแนนการขับขี่');
await P.waitForTimeout(400);
a.score = await P.screenshot();
await ptab('เอกสารแนบ');
await P.waitForTimeout(400);
a.docs = await P.screenshot();
await ptab('กิจกรรม');
await P.waitForTimeout(400);
a.act = await P.screenshot();
await close(P);
await P.getByText('เพิ่มคนขับ', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(900);
a.create = await P.screenshot();

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
const auth = { authorization: `Bearer ${tok.accessToken ?? tok.access_token}` };
// รถบริษัทที่มีอยู่ (จาก compare-vehicles) → รถประจำของ 4 คนแรก
const own = await (
  await W.request.get('/v1/vehicles', {
    headers: auth,
    params: { ownership: 'OWN', status: 'ready,maintenance,parked', limit: 20 },
  })
).json();
const plates = (own.data ?? []).filter((x) => x.unitRole !== 'TRAILER').map((x) => x.id);
// ข้อมูลตัวอย่างตามต้นแบบ (DR + LEX) — ชื่อ/เบอร์สมมติ
const DR = [
  ['สมชาย ใจดี', 'T2'],
  ['วิชัย แสงทอง', 'T2'],
  ['ประเสริฐ บุญมา', 'T3'],
  ['สุรชัย พรหมมา', 'T2'],
  ['อนุชา ศรีสุข', 'T3'],
  ['ธนากร มีชัย', 'T2'],
  ['กิตติ ทองคำ', 'T3'],
  ['สมศักดิ์ วงศ์ไทย', 'T2'],
  ['ณัฐพล รุ่งเรือง', 'T3'],
  ['บุญเลิศ คงดี', 'T4'],
];
const LEX = [400, 120, 25, 300, -3, 210, 90, 15, 500, 330];
const day = (n) => {
  const d = new Date(Date.now() + 7 * 3600_000 + n * 86_400_000);
  return d.toISOString().slice(0, 10);
};
for (let i = 0; i < DR.length; i++) {
  const ext = `DEMO-D${String(i + 1).padStart(3, '0')}`;
  const r = await W.request.put(`/v1/drivers/external/${ext}`, {
    headers: auth,
    data: {
      code: `DRV-${String(i + 1).padStart(4, '0')}`,
      name: DR[i][0],
      phone: `08${1 + (i % 9)}-${200 + i * 37}-${4500 + i * 7}`,
      employmentType: i < 6 ? 'EMPLOYEE_SALARIED' : 'EMPLOYEE_PER_TRIP',
      licenceClass: DR[i][1],
      licenceExpiresOn: day(LEX[i]),
      ...(i < 4 && plates[i] ? { defaultVehicleId: plates[i] } : {}),
    },
  });
  if (!r.ok()) throw new Error(`seed ${ext}: ${r.status()} ${await r.text()}`);
}
await W.goto('/fleet/drivers');
await W.waitForTimeout(1800);
const c = { list: await W.screenshot() };
await W.locator('tbody tr', { hasText: 'อนุชา ศรีสุข' }).click();
await W.waitForTimeout(900);
c.drawer = await W.screenshot();
await W.getByRole('tab', { name: 'คะแนนการขับขี่' }).click();
await W.waitForTimeout(400);
c.score = await W.screenshot();
await W.getByRole('tab', { name: 'เอกสารแนบ' }).click();
await W.waitForTimeout(400);
c.docs = await W.screenshot();
await W.getByRole('tab', { name: 'กิจกรรม' }).click();
await W.waitForTimeout(800);
c.act = await W.screenshot();
await W.keyboard.press('Escape');
await W.waitForTimeout(300);
await W.getByRole('button', { name: 'เพิ่มคนขับ' }).click();
await W.waitForTimeout(900);
c.create = await W.screenshot();
// ฟอร์มว่างกดบันทึก → ขอบแดง + "กรอกข้อมูลให้ครบ N ช่อง"
await W.getByRole('dialog').getByRole('button', { name: 'บันทึก' }).click();
await W.waitForTimeout(400);
c.invalid = await W.screenshot();
a.invalid = a.create;

for (const tag of ['list', 'drawer', 'score', 'docs', 'act', 'create', 'invalid']) {
  const M = await (await b.newContext({ viewport: { width: 2900, height: 960 } })).newPage();
  const left = a[tag];
  await M.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ (TMS v4)</div><img src="data:image/png;base64,${left.toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web)</div><img src="data:image/png;base64,${c[tag].toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st2-drivers-${tag}-1440.png` });
  console.log(`wrote design/compare/st2-drivers-${tag}-1440.png`);
}
await b.close();
srv.close();
