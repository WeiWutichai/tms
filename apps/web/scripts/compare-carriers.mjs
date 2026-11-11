// ภาพเทียบ "ต้นแบบ | ของจริง" ของหน้า รถ → คนขับและผู้รับเหมา แท็บผู้รับเหมา (ST2-T05) ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้องมี web dev + API dev ที่รันโค้ด ST2-T05 + seed · ใช้: node scripts/compare-carriers.mjs
// (web อื่น: WEB=http://localhost:4620 node scripts/compare-carriers.mjs) · PROTO_ONLY=<dir> = ถ่ายเฉพาะต้นแบบ
// ข้อมูลตัวอย่าง (สมมติ ตามต้นแบบ) ใส่ผ่าน PUT /v1/carriers/external/DEMO-S0x — ส่งซ้ำได้ ไม่สร้างแถวซ้ำ
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
await P.getByText('คนขับและผู้รับเหมา', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(800);
await P.getByText('ผู้รับเหมา', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(1000);
const a = { list: await P.screenshot() };
await P.locator('tbody tr').nth(0).click();
await P.waitForTimeout(900);
a.drawer = await P.screenshot();
await P.getByText('เอกสารแนบ', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(400);
a.docs = await P.screenshot();
await P.getByText('กิจกรรม', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(400);
a.act = await P.screenshot();
await close(P);
await P.getByText('เพิ่มผู้รับเหมา', { exact: true }).filter({ visible: true }).first().click();
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
// แลก token = ได้ cookie ต่ออายุ (หน้าเว็บ login ต่อเองจาก cookie)
const tok = await (
  await W.request.post('/v1/oauth/token', {
    data: { grantType: 'authorization_code', code, codeVerifier: v },
  })
).json();
// ข้อมูลตัวอย่าง (สมมติ) ตามต้นแบบ — เลขผู้เสียภาษี/บัตรเป็นเลขสมมติที่ checksum ถูก
const tax = (base12) => {
  let s = 0;
  for (let i = 0; i < 12; i++) s += Number(base12[i]) * (13 - i);
  return base12 + String((11 - (s % 11)) % 10);
};
const SAMPLE = [
  [
    'DEMO-S01',
    'หจก. ทรัพย์สมบูรณ์ขนส่ง',
    'JURISTIC',
    tax('010355601234'),
    '@sapsomboon',
    '1234567891',
  ],
  [
    'DEMO-S02',
    'บจก. เจริญยนต์ทรานสปอร์ต',
    'JURISTIC',
    tax('010555908765'),
    '@charoenyont',
    '2234567892',
  ],
  [
    'DEMO-S03',
    'หจก. ศรีราชาโลจิสติกส์',
    'JURISTIC',
    tax('020356100432'),
    '@sriracha-lgs',
    '3234567893',
  ],
  ['DEMO-S04', 'นายประยูร แสงเดือน', 'INDIVIDUAL', tax('310050012345'), '@prayoon', '4234567894'],
];
for (const [ext, legalName, entityType, taxId, lineContact, accountNo] of SAMPLE) {
  const r = await W.request.put(`/v1/carriers/external/${ext}`, {
    headers: { authorization: `Bearer ${tok.accessToken ?? tok.access_token}` },
    data: {
      legalName,
      entityType,
      taxId,
      lineContact,
      bankAccount: { bankCode: 'KBANK', accountNo, accountName: legalName },
    },
  });
  if (!r.ok()) throw new Error(`seed ${ext}: ${r.status()} ${await r.text()}`);
}
await W.goto('/fleet/drivers');
await W.waitForTimeout(1500);
const c = { list: await W.screenshot() };
await W.locator('tbody tr').nth(0).click();
await W.waitForTimeout(900);
c.drawer = await W.screenshot();
await W.getByRole('tab', { name: 'เอกสารแนบ' }).click();
await W.waitForTimeout(400);
c.docs = await W.screenshot();
await W.getByRole('tab', { name: 'กิจกรรม' }).click();
await W.waitForTimeout(800);
c.act = await W.screenshot();
await W.keyboard.press('Escape');
await W.waitForTimeout(300);
await W.getByRole('button', { name: 'เพิ่มผู้รับเหมา' }).click();
await W.waitForTimeout(900);
c.create = await W.screenshot();
// ฟอร์มว่างกดบันทึก → ขอบแดง + "กรอกข้อมูลให้ครบ N ช่อง"
await W.getByRole('dialog').getByRole('button', { name: 'บันทึก' }).click();
await W.waitForTimeout(400);
c.invalid = await W.screenshot();
a.invalid = a.create;

for (const tag of ['list', 'drawer', 'docs', 'act', 'create', 'invalid']) {
  const M = await (await b.newContext({ viewport: { width: 2900, height: 960 } })).newPage();
  const left = a[tag];
  await M.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ (TMS v4)</div><img src="data:image/png;base64,${left.toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web)</div><img src="data:image/png;base64,${c[tag].toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st2-carriers-${tag}-1440.png` });
  console.log(`wrote design/compare/st2-carriers-${tag}-1440.png`);
}
await b.close();
srv.close();
