// ภาพเทียบ "ต้นแบบ | ของจริง" ของ ST3-T10 (ยกเลิกใบสั่งขนส่ง + รับ/ไม่รับการเปลี่ยนแปลงจากต้นทางหลังวางแผน) — เครื่อง dev เท่านั้น
// ต้นแบบ: TMS v4 drawer SO → ⋯ → ยกเลิกเอกสาร (askCancelDoc) · คิวเชื่อมระบบบัญชี → panel เทียบ TMS กับ {ERP} + dialog ขออนุมัติแก้ (diff)
// ของจริง: /so → drawer → ⋯ → ยกเลิกเอกสาร · ใบจาก connector ที่ต้นทางแก้หลังวางแผน → ตารางเทียบ + dialog "ใช้ค่า TMS"
// ต้องมี web + API ที่ชี้ฐานเดียวกับ apps/web/e2e/.env.e2e (ใช้ PLATFORM_DATABASE_URL จำลองชุดที่ connector เก็บไว้ — ข้อมูลสมมติ):
//   WEB=http://localhost:4420 node scripts/compare-order-cancel-diff.mjs
import { chromium } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = process.env.WEB ?? 'http://localhost:4420';
const RUN = String(Date.now()).slice(-6);
const out = fileURLToPath(new URL('../../../design/compare/', import.meta.url));
const protoDir = fileURLToPath(new URL('../../../design/prototype/', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const env = Object.fromEntries(
  readFileSync(new URL('../e2e/.env.e2e', import.meta.url), 'utf8')
    .split('\n')
    .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
const { PrismaClient } = createRequire(new URL('../../api/package.json', import.meta.url))(
  '@prisma/client',
);
const db = new PrismaClient({ datasources: { db: { url: env.PLATFORM_DATABASE_URL } } });
const srv = createServer((req, res) => {
  const p = join(protoDir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(protoDir) || !existsSync(p)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
  createReadStream(p).pipe(res);
}).listen(0);
const port = srv.address().port;
const b = await chromium.launch();
const vis = (p, text) => p.getByText(text, { exact: true }).filter({ visible: true }).first();
const hex = (pub) => {
  const h = pub.split('_')[1];
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

async function pair(name, left, right, w, h, labels) {
  const M = await (await b.newContext({ viewport: { width: w * 2 + 60, height: h } })).newPage();
  await M.setContent(
    `<body style="margin:0;display:flex;align-items:flex-start;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">${labels[0]}</div><img src="data:image/png;base64,${left.toString('base64')}"></div><div><div style="padding:8px">${labels[1]}</div><img src="data:image/png;base64,${right.toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st3-order-cancel-diff-${name}.png`, fullPage: true });
  console.log(`wrote design/compare/st3-order-cancel-diff-${name}.png`);
}

const vp = { width: 1440, height: 900 };
// ---------- ต้นแบบ ----------
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(`http://localhost:${port}/TMS%20v4.dc.html`);
await P.waitForTimeout(3000);
await vis(P, 'ใบสั่งขนส่ง (SO)').click();
await P.waitForTimeout(1000);
await P.locator('tbody tr').nth(0).click();
await P.waitForTimeout(900);
const aDrawer = await P.screenshot();
await P.locator('aside button:has(lu-i[n="ellipsis"])').first().click();
await P.waitForTimeout(400);
await vis(P, 'ยกเลิกเอกสาร').click();
await P.waitForTimeout(600);
const aCancel = await P.screenshot();
await P.keyboard.press('Escape');
await P.keyboard.press('Escape');
await P.waitForTimeout(400);
// เมนูนี้แสดงเมื่อเชื่อม ERP แล้ว — เปิดด้วย hash ของหน้า
await P.evaluate(() => (location.hash = 'erp'));
await P.waitForTimeout(1200);
await P.locator('tbody tr', { hasText: 'ไม่ตรง' }).first().click();
await P.waitForTimeout(900);
const aErp = await P.screenshot();
await vis(P, 'ขออนุมัติแก้').click();
await P.waitForTimeout(600);
const aErpDlg = await P.screenshot();

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
const company = (await get('/v1/companies?status=active&limit=1')).data[0].id;
const cust = await post('/v1/customers', {
  legalName: `บจก. ปูนไทยสมมติ ${RUN}`,
  billingCompanyId: company,
});
const A = await post('/v1/customer-sites', {
  name: `คลังสินค้า บางนา ${RUN}`,
  kind: 'PICKUP',
  address: { line1: 'บางนา' },
});
const B = await post('/v1/customer-sites', {
  name: `ร้านวัสดุ ชลบุรี ${RUN}`,
  kind: 'DROPOFF',
  address: { line1: 'ชลบุรี' },
});
const C = await post('/v1/customer-sites', {
  name: `ร้านวัสดุ ระยอง ${RUN}`,
  kind: 'DROPOFF',
  address: { line1: 'ระยอง' },
});
const ton = (await get('/v1/units?limit=50')).data.find((u) => u.code === 'TON').id;
const day = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const body = {
  customer: { id: cust.id },
  customerRef: `PO-${RUN}`,
  requestedDate: day,
  stops: [
    { type: 'PICKUP', siteId: A.id, windowStart: `${day}T08:00:00+07:00` },
    { type: 'DELIVERY', siteId: B.id, windowEnd: `${day}T16:00:00+07:00` },
  ],
  lines: [{ description: 'ปูนซีเมนต์ถุง', qty: '12', unitId: ton, weightKg: '12000' }],
};
const o1 = await post('/v1/orders', body);
const o2 = await post('/v1/orders', body);
const dos = await get(`/v1/delivery-orders?orderId=${o2.id}`);
await post('/v1/trips', { tripDate: day, deliveryOrderIds: [dos.data[0].id] });
// จำลองใบจาก connector KRS ที่ต้นทางแก้ปลายทาง + เวลาส่ง หลังวางแผน (สิ่งที่ upsertOrder เก็บไว้)
const id2 = hex(o2.id);
const cur = await db.salesOrder.findUnique({ where: { id: id2 } });
const changes = [
  {
    group: 'stops',
    field: 'stops[1].siteId',
    before: `ร้านวัสดุ ชลบุรี ${RUN}`,
    after: 'ร้านวัสดุ ระยอง (ต้นทาง)',
    kind: 'text',
  },
  {
    group: 'stops.window',
    field: 'stops[1].windowEnd',
    before: `${day}T09:00:00.000Z`,
    after: `${day}T11:00:00.000Z`,
    kind: 'datetime',
  },
];
await db.salesOrder.update({
  where: { id: id2 },
  data: {
    source: 'CONNECTOR',
    sourceConnector: 'krs',
    externalId: `KRS-SO-${RUN}`,
    sourceChangedAfterPlan: true,
    sourceDiff: changes,
    version: { increment: 1 },
  },
});
await db.orderSourceChange.create({
  data: {
    tenantId: cur.tenantId,
    salesOrderId: id2,
    source: 'CONNECTOR',
    sourceConnector: 'krs',
    orderStatus: 'PLANNED',
    baseVersion: cur.version,
    // ข้อมูลที่ connector ส่งมา (uuid) — ปลายทางเปลี่ยนเป็น C + เวลาส่งถึง 18:00 · diff ในหน้าคำนวณตอนอ่าน
    input: {
      source: { source: 'CONNECTOR', connector: 'krs' },
      externalId: `KRS-SO-${RUN}`,
      draft: false,
      customer: { id: hex(cust.id), externalId: null, text: null },
      billingCompanyId: null,
      customerRef: `PO-${RUN}`,
      requestedDate: day,
      vehicleTypeId: null,
      stops: [
        {
          type: 'PICKUP',
          siteId: hex(A.id),
          siteText: '',
          windowStart: `${day}T08:00:00+07:00`,
          windowEnd: null,
        },
        {
          type: 'DELIVERY',
          siteId: hex(C.id),
          siteText: '',
          windowStart: null,
          windowEnd: `${day}T18:00:00+07:00`,
        },
      ],
      lines: [{ description: 'ปูนซีเมนต์ถุง', qty: '12', unitId: hex(ton), weightKg: '12000' }],
      sourceIssues: [],
    },
    inputHash: `cmp-${RUN}`,
    changes,
  },
});

await W.goto('/so');
await W.waitForTimeout(1500);
await W.getByRole('row', { name: new RegExp(o1.soNo) }).click();
await W.waitForTimeout(900);
const cDrawer = await W.screenshot();
await W.getByRole('button', { name: 'เพิ่มเติม' }).click();
await W.waitForTimeout(300);
await W.getByRole('menuitem', { name: 'ยกเลิกเอกสาร' }).click();
await W.waitForTimeout(500);
const cCancel = await W.screenshot();
await W.keyboard.press('Escape');
await W.keyboard.press('Escape');
await W.waitForTimeout(400);
await W.goto('/so');
await W.waitForTimeout(1500);
await W.getByRole('row', { name: new RegExp(o2.soNo) }).click();
await W.waitForTimeout(900);
const cDiff = await W.screenshot();
await W.getByRole('button', { name: 'ใช้ค่า TMS' }).click();
await W.waitForTimeout(500);
const cKeep = await W.screenshot();

await pair('menu-1440', aDrawer, cDrawer, 1440, 960, [
  'ต้นแบบ (TMS v4 · drawer SO)',
  'ของจริง (drawer SO — เมนู ⋯ มี "ยกเลิกเอกสาร")',
]);
await pair('cancel-1440', aCancel, cCancel, 1440, 960, [
  'ต้นแบบ (askCancelDoc: ยกเลิก SO-… · สถานะ เดิม → ยกเลิก · เหตุผล)',
  'ของจริง (ยกเลิกใบสั่งขนส่ง)',
]);
await pair('diff-1440', aErp, cDiff, 1440, 960, [
  'ต้นแบบ (ไม่มีหน้าจอนี้ — ใช้แบบ panel "เทียบข้อมูล TMS กับ {ERP}" ของคิวเชื่อมระบบบัญชี)',
  'ของจริง (SO ที่ต้นทางแก้หลังวางแผน — [OPEN] spec/12 §3)',
]);
await pair('keep-1440', aErpDlg, cKeep, 1440, 960, [
  'ต้นแบบ (dialog ขออนุมัติแก้ — diff + เหตุผล)',
  'ของจริง (dialog ใช้ค่า TMS — diff + เหตุผล)',
]);
await b.close();
await db.$disconnect();
srv.close();
