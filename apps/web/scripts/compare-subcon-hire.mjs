// ภาพเทียบ "ต้นแบบ | ของจริง" ของ ST3-T22 (จ้างรถร่วม) — เครื่อง dev เท่านั้น
// ต้นแบบ: TMS v4 จ่ายงานรถร่วม → แถวแรก → drawer "จ่ายงานรถร่วม" (แท็บ ส่งข้อเสนอ / ใบสั่งงาน)
// ของจริง: ใบสั่งขนส่ง → drawer SO → เที่ยวรถ → "ส่งต่อรถร่วม" → เลือกรายที่ไม่ใช่ถูกสุด + เหตุผล / แท็บใบสั่งงาน
// ต้องมี web + API (ข้อมูลตัวอย่างสร้างผ่าน /v1 — ข้อมูลสมมติ):
//   WEB=http://localhost:4420 node scripts/compare-subcon-hire.mjs
import { chromium } from '@playwright/test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = process.env.WEB ?? `http://localhost:${process.env.WEB_PORT ?? 4420}`;
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
const vis = (p, text) => p.getByText(text, { exact: true }).filter({ visible: true }).first();

async function pair(name, left, right, w, h, labels) {
  const M = await (await b.newContext({ viewport: { width: w * 2 + 60, height: h } })).newPage();
  await M.setContent(
    `<body style="margin:0;display:flex;align-items:flex-start;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">${labels[0]}</div><img src="data:image/png;base64,${left.toString('base64')}"></div><div><div style="padding:8px">${labels[1]}</div><img src="data:image/png;base64,${right.toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st3-subcon-hire-${name}.png`, fullPage: true });
  console.log(`wrote design/compare/st3-subcon-hire-${name}.png`);
}

/** เลขนิติบุคคล (checksum ถูก) — ข้อมูลสมมติ */
function jurTax(n) {
  const base = `0105${String(n).padStart(8, '0')}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
  return base + String((11 - (sum % 11)) % 10);
}

const vp = { width: 1440, height: 900 };
// ---------- ต้นแบบ ----------
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(`http://localhost:${port}/TMS%20v4.dc.html`);
await P.waitForTimeout(3000);
await vis(P, 'จ่ายงานรถร่วม').click();
await P.waitForTimeout(1000);
await P.locator('tbody tr').nth(0).click();
await P.waitForTimeout(900);
const aSum = await P.screenshot();
await vis(P, 'ใบสั่งงาน').click();
await P.waitForTimeout(600);
const aWo = await P.screenshot();

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
const get = async (path) => (await W.request.get(path, { headers: H })).json();
const post = async (path, data) => {
  const r = await W.request.post(path, {
    headers: { ...H, 'Idempotency-Key': randomUUID() },
    data,
  });
  if (r.status() >= 300) throw new Error(`${path} ${r.status()} ${await r.text()}`);
  return r.json();
};
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const company = (await get('/v1/companies?status=active&limit=1')).data[0].id;
const cust = await post('/v1/customers', {
  legalName: `บริษัท ปูนไทยสมมติ ${RUN}`,
  billingCompanyId: company,
});
const addr = (p) => ({ line1: '1 ถนนทดสอบ', district: 'เมือง', province: p });
const a = await post('/v1/customer-sites', {
  name: `คลังบางนา ${RUN}`,
  kind: 'PICKUP',
  address: addr('สมุทรปราการ'),
});
const bb = await post('/v1/customer-sites', {
  name: `ร้านชลบุรี ${RUN}`,
  kind: 'DROPOFF',
  address: addr('ชลบุรี'),
});
const ton = (await get('/v1/units?limit=50')).data.find((u) => u.code === 'TON').id;
const vt6 = (await get('/v1/vehicle-types?limit=50')).data.find((x) => x.code === '6W').id;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const day = (n) =>
  new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** รถ 6 ล้อของรถร่วม + ประกัน/พ.ร.บ. ครบ (จ้างได้จริง — กฎเอกสารบังคับ) */
const fleet = async (carrierId, n) => {
  const v = await post('/v1/vehicles', {
    plate: `9${n % 10}-${RUN.slice(-4)}`,
    plateProvince: 'TH-10',
    vehicleTypeId: vt6,
    ownership: 'SUBCONTRACT',
    carrierId,
  });
  for (const docType of ['INSURANCE', 'COMPULSORY_ACT']) {
    const f = await post('/v1/documents', {
      kind: 'VEHICLE_DOC',
      mime: 'application/pdf',
      bytes: PDF.length,
      filename: `${docType}.pdf`,
    });
    const u = new URL(f.uploadUrl);
    await W.request.put(u.pathname + u.search, {
      headers: { ...H, 'Content-Type': 'application/octet-stream' },
      data: PDF,
    });
    await post(`/v1/vehicles/${v.id}/documents`, {
      docType,
      docNo: `${docType.slice(0, 3)}-${RUN}-${n}`,
      ...(docType === 'INSURANCE'
        ? { issuer: 'บริษัท ประกันสมมติ จำกัด', insuranceClass: '1' }
        : {}),
      startsOn: day(-100),
      expiresOn: day(200),
      fileDocumentIds: [f.id],
    });
  }
};
const carrier = async (name, n, rate) => {
  const c = await post('/v1/carriers', {
    legalName: name,
    entityType: 'JURISTIC',
    taxId: jurTax(Number(RUN) + n),
  });
  await fleet(c.id, n);
  const rc = await post('/v1/rate-cards', {
    side: 'BUY',
    carrierId: c.id,
    originId: a.id,
    destinationId: bb.id,
    vehicleTypeId: vt6,
    pricingModel: 'PER_TRIP',
    buyRate: rate,
    validFrom: today,
  });
  await post(`/v1/rate-cards/${rc.id}/approve`, { reason: 'อนุมัติตามราคาที่ตกลง' });
  return c.id;
};
await carrier(`หจก. สมบูรณ์ทรานสปอร์ตสมมติ ${RUN}`, 801, '4200');
const dear = await carrier(`หจก. ทรัพย์สมบูรณ์ขนส่งสมมติ ${RUN}`, 802, '4600');
const so = await post('/v1/orders', {
  customer: { id: cust.id },
  requestedDate: today,
  vehicleTypeId: vt6,
  stops: [
    { type: 'PICKUP', siteId: a.id },
    { type: 'DELIVERY', siteId: bb.id },
  ],
  lines: [{ description: 'ปูนซีเมนต์', qty: '5', unitId: ton, weightKg: '5000' }],
});
const doId = (await get(`/v1/delivery-orders?orderId=${so.id}`)).data[0].id;
const trip = await post('/v1/trips', { tripDate: today, deliveryOrderIds: [doId] });

await W.goto('/so');
await W.waitForTimeout(1500);
await W.getByRole('row', { name: new RegExp(so.soNo) }).click();
await W.waitForTimeout(800);
await W.getByRole('dialog').getByRole('button', { name: trip.tripNo }).click();
await W.waitForTimeout(900);
await W.getByRole('dialog').getByRole('button', { name: 'ส่งต่อรถร่วม' }).click();
await W.waitForTimeout(1200);
const d = W.getByRole('dialog');
const cDefault = await W.screenshot();
await d.getByRole('combobox', { name: 'ผู้รับเหมา' }).selectOption(dear);
await d
  .getByRole('textbox', { name: 'เหตุผลที่เลือกรายนี้' })
  .fill('รายที่ถูกกว่ารถไม่ว่างช่วงเช้า');
await W.waitForTimeout(400);
const cReason = await W.screenshot();
await d.getByRole('tab', { name: 'ใบสั่งงาน' }).click();
await W.waitForTimeout(500);
const cWo = await W.screenshot();

await pair('sum-1440', aSum, cDefault, 1440, 960, [
  'ต้นแบบ (TMS v4 · จ่ายงานรถร่วม · แท็บส่งข้อเสนอ)',
  'ของจริง (เที่ยวรถ → ส่งต่อรถร่วม · ค่าเริ่มต้น = รายที่ถูกสุด)',
]);
await pair('reason-1440', aSum, cReason, 1440, 960, [
  'ต้นแบบ (TMS v4 · ไม่มีช่องเหตุผล)',
  'ของจริง (เลือกรายที่ไม่ใช่ถูกสุด → เหตุผลที่เลือกรายนี้ — spec/12 §3 DECISION)',
]);
await pair('wo-1440', aWo, cWo, 1440, 960, [
  'ต้นแบบ (TMS v4 · แท็บใบสั่งงาน)',
  'ของจริง (แท็บใบสั่งงาน · ยังไม่มีลิงก์จนกว่า ST3-T23)',
]);
await b.close();
srv.close();
