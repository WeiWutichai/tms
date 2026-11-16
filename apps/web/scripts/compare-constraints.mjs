// ภาพเทียบ "ต้นแบบ | ของจริง" ของกฎตอนจัดรถบนกระดานวางแผน (ST3-T14) ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้องมี web dev (4420) + API dev (4410) ที่รันโค้ด ST3-T14 + seed · ใช้: node scripts/compare-constraints.mjs
// ข้อมูลตัวอย่าง (สมมติ) ชุดเดียวกับ compare-board-views.mjs (DEMO-PLAN-*) + SO น้ำหนักเกิน (DEMO-PLAN-K1)
// ภาพ: warning = การ์ด "น้ำหนักเกิน · ขออนุมัติ" (ส้ม) · ack = dialog ยืนยันพร้อมเหตุผล ·
// blocked = "ห้ามจ่ายงาน · …" มุมผู้วางแผน (ยกเว้นไม่ได้) · override = มุมผู้จัดการ (กรอกเหตุผลแล้ว)
import { chromium } from '@playwright/test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
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
const bkk = (d = 0) =>
  new Date(Date.now() + 7 * 3600_000 + d * 86_400_000).toISOString().slice(0, 10);

const vp = { width: 1440, height: 900 };
const b = await chromium.launch();

// ---------- ต้นแบบ ----------
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(`http://localhost:${port}/TMS%20v4.dc.html`);
await P.waitForTimeout(3000);
await P.getByText('กระดานวางแผน', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(1500);
await P.getByRole('button', { name: /^วันนี้/ })
  .first()
  .click();
await P.waitForTimeout(800);
const a = {};
const pill = P.getByRole('button', { name: /· ขออนุมัติ$/ }).first();
await pill.scrollIntoViewIfNeeded().catch(() => {});
a.warning = await P.screenshot();
await pill.click().catch(() => console.error('prototype: ไม่พบปุ่ม · ขออนุมัติ'));
await P.waitForTimeout(600);
a.ack = await P.screenshot();
await P.keyboard.press('Escape');
await P.getByRole('button', { name: 'ยกเลิก' })
  .first()
  .click()
  .catch(() => {});
await P.waitForTimeout(400);
const why = P.locator('button[title="ดูสาเหตุ"]').first();
await why.scrollIntoViewIfNeeded().catch(() => {});
await why.click().catch(() => console.error('prototype: ไม่พบปุ่มดูสาเหตุ'));
await P.waitForTimeout(600);
a.blocked = await P.screenshot();
await P.getByRole('button', { name: 'ผู้จัดการ', exact: true })
  .first()
  .click()
  .catch(() => {});
await P.locator('textarea[placeholder="เหตุผลการยกเว้น (บังคับ)"]')
  .fill('รถร่วมส่งกรมธรรม์ใหม่แล้ว')
  .catch(() => {});
await P.waitForTimeout(400);
a.override = await P.screenshot();

// ---------- ของจริง ----------
const login = async (email) => {
  const ctx = await b.newContext({ viewport: vp, locale: 'th-TH', baseURL: WEB });
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
};
const { W, H } = await login('planner@demo-a.test');
const call = async (method, path, data, h = H, page = W) => {
  const r = await page.request[method](path, {
    headers: { ...h, 'Idempotency-Key': randomUUID() },
    data,
  });
  if (!r.ok()) console.error('seed failed', path, r.status(), (await r.text()).slice(0, 300));
  return r.ok() ? r.json() : null;
};
const cos = await call('get', '/v1/companies?status=active&limit=50');
const vts = (await call('get', '/v1/vehicle-types?limit=50')).data;
const vt = (c) => vts.find((x) => x.code === c)?.id ?? vts[0].id;
const ton = (await call('get', '/v1/units?limit=50')).data.find((u) => u.code === 'TON').id;
const veh = await call('put', '/v1/vehicles/external/DEMO-PLAN-V2', {
  plate: '70-2281',
  plateProvince: 'TH-10',
  vehicleTypeId: vt('6W'),
  ownership: 'OWN',
  payloadKg: 6000,
});
const carrier = await call('put', '/v1/carriers/external/DEMO-PLAN-CR1', {
  legalName: 'หจก. ขนส่งตัวอย่างรถร่วม',
  entityType: 'JURISTIC',
  taxId: '0105561000011',
});
await call('put', '/v1/vehicles/external/DEMO-PLAN-V5', {
  plate: '65-0912',
  plateProvince: 'TH-10',
  vehicleTypeId: vt('6W'),
  ownership: 'SUBCONTRACT',
  carrierId: carrier.id,
  payloadKg: 6000,
});
const s1 = await call('put', '/v1/customer-sites/external/DEMO-PLAN-L1', {
  name: 'คลังกรุงเทพ (ตัวอย่าง)',
  kind: 'PICKUP',
  address: {
    line1: '99 ถนนตัวอย่าง',
    district: 'เมือง',
    province: 'กรุงเทพมหานคร',
    postcode: '10200',
  },
});
const s2 = await call('put', '/v1/customer-sites/external/DEMO-PLAN-L2', {
  name: 'โรงงานชลบุรี (ตัวอย่าง)',
  kind: 'DROPOFF',
  address: { line1: '99 ถนนตัวอย่าง', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' },
});
const c1 = await call('put', '/v1/customers/external/DEMO-PLAN-C3', {
  legalName: 'บจก. อีสเทิร์นซีฟู้ด',
  billingCompanyId: cos.data[0].id,
});
const so = await call('put', '/v1/orders/external/DEMO-PLAN-K1', {
  customer: { id: c1.id },
  requestedDate: bkk(),
  vehicleTypeId: vt('6W'),
  stops: [
    { type: 'PICKUP', siteId: s1.id },
    { type: 'DELIVERY', siteId: s2.id },
  ],
  lines: [{ description: 'สินค้าตัวอย่าง', qty: '5', unitId: ton, weightKg: '6800' }],
});
const board = await call('get', `/v1/planning/board?date=${bkk()}&days=1`);
const p = board.pool.find((x) => x.orderNo === so?.soNo);
if (p && veh)
  await call('post', '/v1/trips', {
    tripDate: bkk(),
    deliveryOrderIds: p.deliveryOrders.map((d) => d.id),
    vehicleId: veh.id,
    plannedStartAt: `${bkk()}T14:00:00+07:00`,
    plannedEndAt: `${bkk()}T18:00:00+07:00`,
  });
const c = {};
await W.goto('/plan');
await W.waitForTimeout(2000);
await W.getByRole('tab', { name: /^วันนี้/ }).click();
await W.waitForTimeout(1200);
const ask = W.getByTestId(/^plan-ask-/).first();
await ask.scrollIntoViewIfNeeded().catch(() => {});
c.warning = await W.screenshot();
await ask.click().catch(() => console.error('real: ไม่พบปุ่ม · ขออนุมัติ'));
await W.waitForTimeout(500);
c.ack = await W.screenshot();
await W.keyboard.press('Escape');
await W.waitForTimeout(300);
const row = W.getByTestId('plan-row-65-0912');
await row.scrollIntoViewIfNeeded();
await row.getByRole('button', { name: 'ดูสาเหตุ' }).click();
await W.waitForTimeout(500);
c.blocked = await W.screenshot();
const M = await login('manager@demo-a.test');
await M.W.goto('/plan');
await M.W.waitForTimeout(2000);
await M.W.getByRole('tab', { name: /^วันนี้/ }).click();
await M.W.waitForTimeout(1200);
const mrow = M.W.getByTestId('plan-row-65-0912');
await mrow.scrollIntoViewIfNeeded();
await mrow.getByRole('button', { name: 'ดูสาเหตุ' }).click();
await M.W.getByTestId('plan-blocked-dialog')
  .getByRole('textbox')
  .fill('รถร่วมส่งกรมธรรม์ใหม่แล้ว รอบันทึกในระบบ');
await M.W.waitForTimeout(400);
c.override = await M.W.screenshot();

const LABEL = {
  warning: [
    'กระดานวางแผน · การ์ด "น้ำหนักเกิน · ขออนุมัติ"',
    'การ์ด "{กฎ} · ขออนุมัติ" (คำเตือนรอยืนยัน — D-07)',
  ],
  ack: ['dialog "ขออนุมัติจากผู้จัดการ"', 'dialog ยืนยันพร้อมเหตุผล (D-07: ผู้วางแผนยืนยันเอง)'],
  blocked: ['"ห้ามจ่ายงาน" · ผู้วางแผน', '"ห้ามจ่ายงาน" · ผู้วางแผน (ยกเว้นไม่ได้)'],
  override: ['"ห้ามจ่ายงาน" · ผู้จัดการ', '"ห้ามจ่ายงาน" · ผู้จัดการ (trips:override)'],
};
for (const tag of Object.keys(LABEL)) {
  const X = await (await b.newContext({ viewport: { width: 2900, height: 960 } })).newPage();
  await X.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ (TMS v4) ${LABEL[tag][0]}</div><img src="data:image/png;base64,${a[tag].toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web /plan) · ${LABEL[tag][1]}</div><img src="data:image/png;base64,${c[tag].toString('base64')}"></div></body>`,
  );
  await X.screenshot({ path: `${out}st3-constraints-${tag}-1440.png` });
  console.log(`wrote design/compare/st3-constraints-${tag}-1440.png`);
}
await b.close();
srv.close();
