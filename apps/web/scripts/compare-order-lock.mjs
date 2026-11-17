// ภาพเทียบ "ต้นแบบ | ของจริง" ของล็อกการแก้ใบสั่งขนส่ง (ST3-T08) ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้องมี web dev (4420) + API dev (4410) ที่รันโค้ด ST3-T08 + seed · ใช้: node scripts/compare-order-lock.mjs
// (web อื่น: WEB=http://localhost:5720 node scripts/compare-order-lock.mjs)
// ต้นแบบไม่มีป้าย "กำลังแก้ไขโดย …" → ฝั่งต้นแบบแสดง drawer SO (ป้ายใช้แถบล็อก P.inv.locked ของ drawer ใบแจ้งหนี้)
// ข้อมูลตัวอย่าง (สมมติ): PUT /v1/orders/external/DEMO-SO-LOCK — A = ผู้วางแผน เปิดแก้, B = ผู้จัดการ เห็นป้าย/ปลดล็อก
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
const bkk = (d = 0) =>
  new Date(Date.now() + 7 * 3600_000 + d * 86_400_000).toISOString().slice(0, 10);

const vp = { width: 1440, height: 900 };
const b = await chromium.launch();

// ---------- ต้นแบบ ----------
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
const go = async (label) => {
  await P.goto(`http://localhost:${port}/TMS%20v4.dc.html`);
  await P.waitForTimeout(3000);
  await P.getByText(label, { exact: true }).filter({ visible: true }).first().click();
  await P.waitForTimeout(1200);
};
await go('ใบสั่งขนส่ง (SO)');
await P.locator('tbody tr').nth(0).click();
await P.waitForTimeout(900);
const a = { drawer: await P.screenshot() };

// ---------- ของจริง ----------
async function login(email, id) {
  const ctx = await b.newContext({ viewport: vp, locale: 'th-TH', baseURL: WEB });
  if (id)
    await ctx.addCookies([
      {
        name: 'tms_td',
        value: `demo-trusted-device-e2e-only-0000000000000:${id}`,
        url: `${WEB}/v1/auth`,
      },
    ]);
  const W = await ctx.newPage();
  const v = randomBytes(32).toString('base64url');
  const r1 = await W.request.post('/v1/auth/login', {
    data: {
      email,
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
  return { W, H: { Authorization: `Bearer ${tok.accessToken}` } };
}
const A = await login('planner@demo-a.test');
const B = await login('manager@demo-a.test');
const put = async (path, data) => {
  const r = await A.W.request.put(path, { headers: A.H, data });
  if (!r.ok()) console.error('seed failed', path, r.status(), (await r.text()).slice(0, 300));
  return r.ok() ? r.json() : null;
};
const cos = await (
  await A.W.request.get('/v1/companies?status=active&limit=50', { headers: A.H })
).json();
const cust = await put('/v1/customers/external/DEMO-SO-LOCK-C', {
  legalName: 'บจก. ตัวอย่างล็อกงาน',
  billingCompanyId: cos.data[0].id,
});
const site = [];
for (const [i, n] of ['คลังสินค้าบางนา (ตัวอย่าง)', 'โรงงานชลบุรี (ตัวอย่าง)'].entries())
  site.push(
    await put(`/v1/customer-sites/external/DEMO-SO-LOCK-L${i + 1}`, {
      name: n,
      kind: i ? 'DROPOFF' : 'PICKUP',
      address: {
        line1: '99 ถนนตัวอย่าง',
        district: 'เมือง',
        province: 'ชลบุรี',
        postcode: '20000',
      },
    }),
  );
const vts = await (await A.W.request.get('/v1/vehicle-types?limit=50', { headers: A.H })).json();
const so = await put('/v1/orders/external/DEMO-SO-LOCK', {
  customer: { id: cust.id },
  customerRef: 'PO-77120',
  requestedDate: bkk(1),
  vehicleTypeId: vts.data.find((x) => x.code === '6W')?.id ?? vts.data[0].id,
  stops: [
    { type: 'PICKUP', siteId: site[0].id, windowStart: `${bkk(1)}T07:00:00+07:00` },
    { type: 'DELIVERY', siteId: site[1].id, windowEnd: `${bkk(1)}T16:00:00+07:00` },
  ],
});
await A.W.request.post(`/v1/orders/${so.id}/unlock`, { headers: A.H, data: {} });
await B.W.request.post(`/v1/orders/${so.id}/unlock`, {
  headers: B.H,
  data: { reason: 'ล้างล็อกก่อนถ่ายภาพเทียบ (สคริปต์)' },
});

const openSo = async (W) => {
  await W.goto('/so');
  await W.waitForTimeout(1500);
  await W.getByRole('row', { name: new RegExp(so.soNo) }).click();
  await W.waitForTimeout(1200);
};
// A เปิดฟอร์มแก้ (ได้ล็อก)
await openSo(A.W);
await A.W.getByRole('button', { name: 'เพิ่มเติม' }).click();
await A.W.getByRole('menuitem', { name: 'แก้ไข', exact: true }).click();
await A.W.waitForTimeout(1500);
// B เห็นป้าย "กำลังแก้ไขโดย …" + ปุ่มปลดล็อก
await openSo(B.W);
const c = { drawer: await B.W.screenshot() };
await B.W.getByRole('button', { name: 'ปลดล็อก' }).click();
await B.W.waitForTimeout(600);
await B.W.getByLabel(/เหตุผลที่ปลดล็อก/).fill('ผู้แก้ไม่อยู่ ต้องแก้วันรับของด่วน');
c.dialog = await B.W.screenshot();
await B.W.getByRole('dialog').getByRole('button', { name: 'ปลดล็อก' }).last().click();
await B.W.waitForTimeout(1200);
await B.W.getByRole('button', { name: 'เพิ่มเติม' }).click();
await B.W.getByRole('menuitem', { name: 'แก้ไข', exact: true }).click();
await B.W.waitForTimeout(1500);
// A กดบันทึก → ฟอร์มอ่านอย่างเดียว + ป้ายชื่อ B
await A.W.getByLabel('เลข PO ลูกค้า').fill('PO-77121');
await A.W.getByRole('button', { name: 'บันทึกการแก้ไข' }).click();
await A.W.waitForTimeout(1500);
c.form = await A.W.screenshot();
await B.W.getByRole('dialog').getByRole('button', { name: 'ยกเลิก' }).click();
await B.W.waitForTimeout(800);

const LEFT = {
  drawer: [
    'drawer',
    'ต้นแบบ (TMS v4) drawer SO — ไม่มีป้ายนี้ (ใช้แถบล็อก "ออกแล้ว · แก้ไขไม่ได้" ของใบแจ้งหนี้) [OPEN spec/12]',
  ],
  dialog: ['drawer', 'ต้นแบบ (TMS v4) — ไม่มี dialog ปลดล็อก: drawer SO'],
  form: ['drawer', 'ต้นแบบ (TMS v4) drawer SO — ไม่มีฟอร์มแก้แบบล็อก [OPEN spec/12]'],
};
for (const tag of ['drawer', 'dialog', 'form']) {
  const M = await (await b.newContext({ viewport: { width: 2900, height: 960 } })).newPage();
  const [k, label] = LEFT[tag];
  await M.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">${label}</div><img src="data:image/png;base64,${a[k].toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web /so)</div><img src="data:image/png;base64,${c[tag].toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st3-order-lock-${tag}-1440.png` });
  console.log(`wrote design/compare/st3-order-lock-${tag}-1440.png`);
}
await b.close();
srv.close();
