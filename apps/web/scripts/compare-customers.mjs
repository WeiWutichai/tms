// ภาพเทียบ "ต้นแบบ | ของจริง" ของหน้า ข้อมูลหลัก → ลูกค้า (ST2-T01) ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้องมี web dev (4420) + API dev (4410) ที่รันโค้ด ST2-T01 + seed · ใช้: node scripts/compare-customers.mjs
// (web อื่น: WEB=http://localhost:4620 node scripts/compare-customers.mjs)
// สร้างลูกค้าตัวอย่าง (สมมติ) ใน demo-a ด้วย PUT /v1/customers/external/DEMO-CUS-n — รันซ้ำได้ไม่เกิดแถวใหม่
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
const SAMPLE = [
  ['บจก. ตัวอย่างพลาสติก', 'MONTHLY', 30, 'คุณสมชาย', '02-000-0001'],
  ['บมจ. ตัวอย่างเครื่องดื่ม', 'WEEKLY', 60, 'คุณสมหญิง', '02-000-0002'],
  ['บจก. ตัวอย่างอุตสาหกรรม', 'PER_DO', 30, 'คุณวิชัย', '02-000-0003'],
  ['บจก. ตัวอย่างท่อเหล็ก', 'MONTHLY', 45, 'คุณนภา', '02-000-0004'],
  ['บจก. ตัวอย่างอาหารทะเล', 'PER_DO', 15, 'คุณปรีชา', '02-000-0005'],
];

const vp = { width: 1440, height: 900 };
const b = await chromium.launch();

// ---------- ต้นแบบ ----------
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(`http://localhost:${port}/TMS%20v4.dc.html`);
await P.waitForTimeout(3000);
await P.getByText('ข้อมูลหลัก', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(400);
await P.getByText('ลูกค้า', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(1200);
const a = { list: await P.screenshot() };
await P.locator('tbody tr').nth(1).click();
await P.waitForTimeout(900);
a.drawer = await P.screenshot();
await P.getByText('เงื่อนไข', { exact: true }).filter({ visible: true }).last().click();
await P.waitForTimeout(600);
a.cond = await P.screenshot();
await P.keyboard.press('Escape');
await P.locator('aside button[title="ปิด"], button[title="ปิด"]').filter({ visible: true }).first().click().catch(() => {});
await P.waitForTimeout(500);
await P.getByText('เพิ่มลูกค้า', { exact: true }).filter({ visible: true }).first().click();
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
for (const [i, [name, cycle, credit, contact, phone]] of SAMPLE.entries()) {
  const r = await W.request.put(`/v1/customers/external/DEMO-CUS-${i + 1}`, {
    headers: { Authorization: `Bearer ${tok.accessToken}` },
    data: {
      legalName: name,
      taxId: taxId(i + 1),
      branchCode: '00000',
      billingCycle: cycle,
      creditTermDays: credit,
      billingAddress: { line1: `${i + 1}/1 ถนนตัวอย่าง แขวงตัวอย่าง เขตตัวอย่าง กรุงเทพมหานคร 10000` },
      contacts: [{ name: contact, phone, isPrimary: true }],
    },
  });
  if (!r.ok()) console.error('seed customer failed', r.status(), await r.text());
}
await W.goto('/master/customers');
await W.waitForTimeout(1500);
const c = { list: await W.screenshot() };
await W.locator('tbody tr').nth(1).click();
await W.waitForTimeout(900);
c.drawer = await W.screenshot();
await W.getByRole('tab', { name: 'เงื่อนไข' }).click();
await W.waitForTimeout(500);
c.cond = await W.screenshot();
await W.getByRole('tab', { name: 'กิจกรรม' }).click();
await W.waitForTimeout(800);
c.act = await W.screenshot();
await W.keyboard.press('Escape');
await W.waitForTimeout(300);
await W.getByRole('button', { name: 'เพิ่มลูกค้า' }).click();
await W.waitForTimeout(900);
c.create = await W.screenshot();

for (const tag of ['list', 'drawer', 'cond', 'create', 'act']) {
  const M = await (await b.newContext({ viewport: { width: 2900, height: 960 } })).newPage();
  const left = a[tag] ?? a.drawer;
  await M.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ (TMS v4)${a[tag] ? '' : ' — ไม่มีแท็บนี้ (แสดง drawer ทั่วไป)'}</div><img src="data:image/png;base64,${left.toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web /master/customers)</div><img src="data:image/png;base64,${c[tag].toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st2-customers-${tag}-1440.png` });
  console.log(`wrote design/compare/st2-customers-${tag}-1440.png`);
}
await b.close();
srv.close();
