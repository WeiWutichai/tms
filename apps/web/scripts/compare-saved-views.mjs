// ภาพเทียบ "ต้นแบบ | ของจริง" ของปุ่ม/เมนู "มุมมอง: …" (ST9-T11 saved views) ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้องมี web dev + API dev ที่รันโค้ด ST9-T11 + seed · ใช้: node scripts/compare-saved-views.mjs
// (web อื่น: WEB=http://localhost:4663 node scripts/compare-saved-views.mjs)
// ภาพ: row = แถวมุมมองเหนือตาราง (เมนูปิด, มุมมองที่บันทึกไว้ถูกเลือก) · menu = เมนูเปิด
//      dialog = กล่องบันทึกมุมมองใหม่ (ต้นแบบไม่มี — เทียบกับหน้าเดียวกันในต้นแบบ)
import { chromium } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
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
const vp = { width: 1440, height: 900 };
const b = await chromium.launch();

// ---------- ต้นแบบ: หน้าใบสั่งขนส่ง (SO) ----------
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(`http://localhost:${port}/TMS%20v4.dc.html`);
await P.waitForTimeout(3000);
await P.getByText('ใบสั่งขนส่ง (SO)', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(1200);
const a = { row: await P.screenshot() };
await P.getByRole('button', { name: /^มุมมอง:/ })
  .first()
  .click();
await P.waitForTimeout(500);
a.menu = await P.screenshot();
a.dialog = a.row;

// ---------- ของจริง: /so ----------
const ctx = await b.newContext({ viewport: vp, locale: 'th-TH', baseURL: WEB });
const W = await ctx.newPage();
const v = randomBytes(32).toString('base64url');
const r1 = await W.request.post('/v1/auth/login', {
  data: {
    email: 'planner@demo-a.test',
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
// มุมมองตัวอย่าง (สมมติ) ของผู้ใช้นี้ — สร้างซ้ำได้ (ชื่อซ้ำ = 409 ข้าม)
for (const [name, state, isDefault] of [
  ['ของฉันวันนี้', { tab: 'all', overdue: false, doneToday: false, q: '', st: '', source: '' }, false],
  ['รอกำหนดเส้นทาง', { tab: 'route', overdue: false, doneToday: false, q: '', st: '', source: '' }, false],
])
  await W.request.post('/v1/saved-views', {
    headers: H,
    data: { page: 'orders', name, state, hiddenColumns: null, isDefault },
  });
const c = {};
await W.goto('/so');
await W.evaluate(() => sessionStorage.clear());
await W.reload();
await W.waitForTimeout(2000);
await W.getByRole('button', { name: /^มุมมอง:/ }).click();
await W.getByRole('menuitemradio', { name: 'ของฉันวันนี้' }).click();
await W.waitForTimeout(800);
c.row = await W.screenshot();
await W.getByRole('button', { name: /^มุมมอง:/ }).click();
await W.waitForTimeout(400);
c.menu = await W.screenshot();
await W.getByRole('menuitem', { name: 'บันทึกเป็นมุมมองใหม่…' }).click();
await W.waitForTimeout(400);
c.dialog = await W.screenshot();

const LABEL = {
  row: ['ใบสั่งขนส่ง · แถว "มุมมอง: ของฉันวันนี้"', 'ใบสั่งขนส่ง · มุมมองที่บันทึกไว้ถูกเลือก'],
  menu: ['ใบสั่งขนส่ง · เมนู "มุมมอง:"', 'ใบสั่งขนส่ง · เมนูมุมมอง + คำสั่งบันทึก/เปลี่ยนชื่อ/ค่าเริ่มต้น/ลบ'],
  dialog: ['ใบสั่งขนส่ง (ต้นแบบไม่มีกล่องบันทึกมุมมอง)', 'กล่อง "บันทึกมุมมอง" (แบบกล่องบันทึกเทมเพลต)'],
};
for (const tag of ['row', 'menu', 'dialog']) {
  const M = await (await b.newContext({ viewport: { width: 2900, height: 960 } })).newPage();
  await M.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ (TMS v4) ${LABEL[tag][0]}</div><img src="data:image/png;base64,${a[tag].toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web /so) · ${LABEL[tag][1]}</div><img src="data:image/png;base64,${c[tag].toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st9-saved-views-${tag}-1440.png` });
  console.log(`wrote design/compare/st9-saved-views-${tag}-1440.png`);
}
await b.close();
srv.close();
