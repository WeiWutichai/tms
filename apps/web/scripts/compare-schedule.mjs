// ภาพเทียบ "ต้นแบบ | ของจริง" ของ ST3-T19 (ตารางรถ/คนขับรายวัน — ว่าง/ซ่อม/ลา + คลิกขวาใส่วันลา/โน้ต) — เครื่อง dev เท่านั้น
// ต้นแบบไม่มีหน้าตารางรถ/คนขับรายวัน → เทียบกับกระดานวางแผน (แท็บ 7 วัน / วันนี้) ที่ใช้เป็นที่วาง (spec/12 §3 DECISION)
// ของจริง: ช่องรถ × วัน = "ว่าง" / "ซ่อม" / "ลา · {คนขับ}" + โน้ต · คลิกขวา → เมนู → dialog ใส่วันลา
//   WEB=http://localhost:4420 node scripts/compare-schedule.mjs
import { chromium } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = process.env.WEB ?? 'http://localhost:4420';
const RUN = String(Date.now()).slice(-6);
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
const b = await chromium.launch();

async function pair(name, left, right, w, h, labels) {
  const M = await (await b.newContext({ viewport: { width: w * 2 + 60, height: h } })).newPage();
  await M.setContent(
    `<body style="margin:0;display:flex;align-items:flex-start;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">${labels[0]}</div><img src="data:image/png;base64,${left.toString('base64')}"></div><div><div style="padding:8px">${labels[1]}</div><img src="data:image/png;base64,${right.toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st3-schedule-${name}-1440.png`, fullPage: true });
  console.log(`wrote design/compare/st3-schedule-${name}-1440.png`);
}

const vp = { width: 1440, height: 900 };
// ---------- ต้นแบบ ----------
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(`http://localhost:${port}/TMS%20v4.dc.html`);
await P.waitForTimeout(3000);
await P.evaluate(() => (location.hash = 'plan'));
await P.waitForTimeout(1500);
const aToday = await P.screenshot();
await P.getByText('7 วัน', { exact: true }).first().click();
await P.waitForTimeout(900);
const aWeek = await P.screenshot();

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
const H = { Authorization: `Bearer ${tok.accessToken ?? tok.access_token}` };
const get = async (p) => (await W.request.get(p, { headers: H })).json();
const post = async (p, data) => (await W.request.post(p, { headers: H, data })).json();
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const plus = (n) =>
  new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const vt = (await get('/v1/vehicle-types?limit=50')).data.find((x) => x.code === '6W');
const names = ['สมชาย ขับดี', 'วิชัย ใจเย็น', 'ประยุทธ มั่นคง'];
const vs = [];
for (const [i, n] of names.entries()) {
  const veh = await post('/v1/vehicles', {
    plate: `8${i + 1}-${RUN.slice(-4)}`,
    plateProvince: 'TH-10',
    vehicleTypeId: vt.id,
    ownership: 'OWN',
    payloadKg: 6000,
  });
  const d = await post('/v1/drivers', {
    name: `${n} ${RUN.slice(-2)}`,
    phone: `08${i + 2}-${RUN.slice(0, 3)}-${RUN.slice(-4)}`,
    employmentType: 'EMPLOYEE_SALARIED',
    licenceClass: 'T2',
    licenceExpiresOn: '2030-03-31',
    defaultVehicleId: veh.id,
  });
  vs.push({ veh, d });
}
// คนขับคันแรกลาวันนี้–พรุ่งนี้ · โน้ตคันที่สอง · คันที่สามซ่อม
await post('/v1/schedule-entries', {
  kind: 'LEAVE',
  driverId: vs[0].d.id,
  startsOn: today,
  endsOn: plus(1),
  note: 'ลาป่วย',
});
await post('/v1/schedule-entries', {
  kind: 'NOTE',
  vehicleId: vs[1].veh.id,
  startsOn: plus(2),
  endsOn: plus(2),
  note: 'นัดเปลี่ยนยางช่วงบ่าย',
});
const v3 = await get(`/v1/vehicles/${vs[2].veh.id}`);
await W.request.post(`/v1/vehicles/${vs[2].veh.id}/status`, {
  headers: { ...H, 'If-Match': `"${v3.version}"` },
  data: { status: 'maintenance', reason: 'เข้าอู่เปลี่ยนคลัตช์ 3 วัน' },
});

await W.goto('/plan');
await W.waitForTimeout(1500);
const row = W.getByTestId(`plan-row-${vs[0].veh.plate}`);
await row.scrollIntoViewIfNeeded();
await W.waitForTimeout(400);
const bToday = await W.screenshot();
await W.getByRole('tab', { name: /^7 วัน/ }).click();
await W.waitForTimeout(1200);
await W.getByTestId(`plan-row-${vs[0].veh.plate}`).scrollIntoViewIfNeeded();
await W.waitForTimeout(400);
const bWeek = await W.screenshot();
await W.getByTestId(`plan-cell-${vs[1].veh.plate}-${plus(1)}`).click({ button: 'right' });
await W.waitForTimeout(400);
const bMenu = await W.screenshot();
await W.getByTestId('plan-ctx')
  .getByRole('menuitem', { name: /^ใส่วันลา/ })
  .click();
await W.getByRole('dialog', { name: 'ใส่วันลาคนขับ' }).getByLabel('เหตุผลการลา').fill('ลากิจ');
await W.waitForTimeout(400);
const bDialog = await W.screenshot();

await pair('today', aToday, bToday, 1440, 900, [
  'ต้นแบบ (TMS v4) — กระดานวางแผน แท็บวันนี้ (ไม่มีสถานะ ว่าง/ซ่อม/ลา ต่อแถว)',
  'ของจริง — แถวที่ไม่มีงาน: "ว่าง" / "ซ่อม" / "ลา · {คนขับ}" (docs/04 D2)',
]);
await pair('week', aWeek, bWeek, 1440, 900, [
  'ต้นแบบ — แท็บ 7 วัน (ช่องว่างไม่มีป้าย)',
  'ของจริง — ช่องรถ × วัน: ภาระงาน (การ์ด) / ว่าง / ซ่อม / ลา + โน้ต',
]);
await pair('menu', aWeek, bMenu, 1440, 900, [
  'ต้นแบบ — ไม่มีเมนูคลิกขวา',
  'ของจริง — คลิกขวาช่อง → ใส่วันลา / เพิ่มโน้ต (สไตล์เมนู tms-menu ของต้นแบบ)',
]);
await pair('dialog', aWeek, bDialog, 1440, 900, [
  'ต้นแบบ — ไม่มี dialog วันลา',
  'ของจริง — dialog ใส่วันลาคนขับ (กรอบ tms-dialog ชุดเดียวกับกระดาน)',
]);
await b.close();
srv.close();
