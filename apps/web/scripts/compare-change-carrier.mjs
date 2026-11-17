// ภาพเทียบ "ต้นแบบ | ของจริง" ของ ST3-T25 (เปลี่ยนผู้รับเหมา) — เครื่อง dev เท่านั้น ที่ 1440 px
// ต้นแบบ TMS v4: drawer "จ่ายงานรถร่วม" รอตอบ/รับงาน (เมนู ⋯ ชุดตั้งต้น แก้ไข/คัดลอก/พิมพ์/ยกเลิกเอกสาร — ไม่มีเปลี่ยนผู้รับเหมา: spec/12 §3) · dialog เหตุผล (ยกเลิกเอกสาร)
// ของจริง: เมนู ⋯ "เปลี่ยนผู้รับเหมา" · dialog เหตุผล · drawer จ้างแบบเปลี่ยนราย (รับงานแล้ว) · แท็บกิจกรรมหลังเปลี่ยน
// ใช้ฐานแยก (ไม่ใช่ฐาน dev ที่คนอื่นใช้) — API + web ชี้ฐานนั้น:
//   WEB=http://localhost:4721 PLATFORM_DATABASE_URL=… node scripts/compare-change-carrier.mjs
import { chromium } from '@playwright/test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = process.env.WEB ?? 'http://localhost:4721';
const RUN = String(Date.now()).slice(-6);
const H = 3600_000;
const out = fileURLToPath(new URL('../../../design/compare/', import.meta.url));
const apiDir = fileURLToPath(new URL('../../api/', import.meta.url));
const protoDir = fileURLToPath(new URL('../../../design/prototype/', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const srv = createServer((req, res) => {
  const p = join(protoDir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(protoDir) || !existsSync(p)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
  createReadStream(p).pipe(res);
}).listen(0);
const proto = `http://localhost:${srv.address().port}/TMS%20v4.dc.html`;
const { PrismaClient } = createRequire(new URL('../../api/package.json', import.meta.url))(
  '@prisma/client',
);
const db = new PrismaClient({ datasources: { db: { url: process.env.PLATFORM_DATABASE_URL } } });
const b = await chromium.launch();
const vp = { width: 1440, height: 900 };
const vis = (p, text) => p.getByText(text, { exact: true }).filter({ visible: true }).first();

async function pair(name, left, right, labels) {
  const M = await (
    await b.newContext({ viewport: { width: 1440 * 2 + 60, height: 960 } })
  ).newPage();
  await M.setContent(
    `<body style="margin:0;display:flex;align-items:flex-start;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">${labels[0]}</div><img src="data:image/png;base64,${left.toString('base64')}"></div><div><div style="padding:8px">${labels[1]}</div><img src="data:image/png;base64,${right.toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st3-change-carrier-${name}-1440.png` });
  console.log(`wrote design/compare/st3-change-carrier-${name}-1440.png`);
}

function jurTax(n) {
  const base = `0105${String(n).padStart(8, '0')}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
  return base + String((11 - (sum % 11)) % 10);
}

// ---------- ต้นแบบ ----------
const P2 = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P2.goto(proto);
await P2.waitForTimeout(3000);
await vis(P2, 'จ่ายงานรถร่วม').click();
await P2.waitForTimeout(1000);
await P2.locator('tbody tr', { hasText: 'รอตอบ' }).first().click();
await P2.waitForTimeout(900);
await P2.locator('button[title="เพิ่มเติม"]').filter({ visible: true }).first().click();
await P2.waitForTimeout(400);
const aSum = await P2.screenshot();
await P2.keyboard.press('Escape');
await P2.waitForTimeout(400);
await P2.locator('tbody tr', { hasText: 'รับงาน' }).first().click();
await P2.waitForTimeout(900);
const aAcc = await P2.screenshot();
await vis(P2, 'กิจกรรม').click();
await P2.waitForTimeout(600);
const aLog = await P2.screenshot();
// dialog เหตุผลของต้นแบบ (vDialog — เมนู ⋯ "ยกเลิกเอกสาร" ของใบสั่งขาย)
const P3 = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P3.goto(proto);
await P3.waitForTimeout(3000);
let aDlg = aAcc;
try {
  await vis(P3, 'ใบส่งของ (DO)').click();
  await P3.waitForTimeout(1000);
  await P3.locator('tbody tr').first().click();
  await P3.waitForTimeout(900);
  await P3.locator('button[title="เพิ่มเติม"]').filter({ visible: true }).first().click();
  await P3.waitForTimeout(400);
  await vis(P3, 'ยกเลิกเอกสาร').click();
  await P3.waitForTimeout(700);
  aDlg = await P3.screenshot();
} catch (e) {
  console.warn('prototype dialog not captured:', e.message);
}

// ---------- ของจริง: ข้อมูลตัวอย่าง (สมมติ) ----------
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
const HDR = { Authorization: `Bearer ${tok.accessToken}` };
const get = async (path) => (await W.request.get(path, { headers: HDR })).json();
const post = async (path, data) => {
  const r = await W.request.post(path, {
    headers: { ...HDR, 'Idempotency-Key': randomUUID() },
    data,
  });
  if (r.status() >= 300) throw new Error(`${path} ${r.status()} ${await r.text()}`);
  return r.json();
};
const today = new Date(Date.now() + 7 * H).toISOString().slice(0, 10);
const day = (n) =>
  new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const company = (await get('/v1/companies?status=active&limit=1')).data[0].id;
const cust = await post('/v1/customers', {
  legalName: `บจก. เอ็นเอสเอฟ อินดัสทรีสมมติ ${RUN}`,
  billingCompanyId: company,
});
const addr = (p) => ({ line1: '1 ถนนทดสอบ', district: 'เมือง', province: p });
const a = await post('/v1/customer-sites', {
  name: `บางปู ${RUN}`,
  kind: 'PICKUP',
  address: addr('สมุทรปราการ'),
});
const bb = await post('/v1/customer-sites', {
  name: `ท่าเรือแหลมฉบัง ${RUN}`,
  kind: 'DROPOFF',
  address: addr('ชลบุรี'),
});
const ton = (await get('/v1/units?limit=50')).data.find((u) => u.code === 'TON').id;
const vt6 = (await get('/v1/vehicle-types?limit=50')).data.find((x) => x.code === '6W').id;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const carrier = async (i, name, rate) => {
  const c = await post('/v1/carriers', {
    legalName: name,
    entityType: 'JURISTIC',
    taxId: jurTax(Number(RUN) + 600 + i),
    paymentTermDays: 15,
  });
  const veh = await post('/v1/vehicles', {
    plate: `7${i}-${RUN.slice(-4)}`,
    plateProvince: 'TH-20',
    vehicleTypeId: vt6,
    ownership: 'SUBCONTRACT',
    carrierId: c.id,
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
      headers: { ...HDR, 'Content-Type': 'application/octet-stream' },
      data: PDF,
    });
    await post(`/v1/vehicles/${veh.id}/documents`, {
      docType,
      docNo: `${docType.slice(0, 3)}-${RUN}${i}`,
      ...(docType === 'INSURANCE'
        ? { issuer: 'บริษัท ประกันสมมติ จำกัด', insuranceClass: '1' }
        : {}),
      startsOn: day(-100),
      expiresOn: day(200),
      fileDocumentIds: [f.id],
    });
  }
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
  return { id: c.id, name };
};
const A = await carrier(1, `หจก. ทรัพย์สมบูรณ์ขนส่งสมมติ ${RUN}`, '5000');
const B = await carrier(2, `หจก. ศรีราชาโลจิสติกส์สมมติ ${RUN}`, '5400');
const PHONE = `08${String(40_000_000 + Number(RUN)).slice(-8)}`;
await post('/v1/drivers', {
  name: `สมชาย ใจดีสมมติ ${RUN}`,
  phone: PHONE,
  employmentType: 'CARRIER_DRIVER',
  carrierId: A.id,
  licenceClass: 'T2',
  licenceExpiresOn: day(300),
});
const so = await post('/v1/orders', {
  customer: { id: cust.id },
  requestedDate: today,
  vehicleTypeId: vt6,
  stops: [
    { type: 'PICKUP', siteId: a.id, windowStart: `${today}T07:00:00+07:00` },
    { type: 'DELIVERY', siteId: bb.id },
  ],
  lines: [{ description: 'ปูนซีเมนต์', qty: '5', unitId: ton, weightKg: '8600' }],
});
const doId = (await get(`/v1/delivery-orders?orderId=${so.id}`)).data[0].id;
const trip = await post('/v1/trips', { tripDate: today, deliveryOrderIds: [doId] });
await post(`/v1/trips/${trip.id}/offer`, { carrierId: A.id });

const openSub = async () => {
  await W.goto(`/plan?trip=${trip.id}`);
  await W.waitForTimeout(1800);
  const d = W.getByRole('dialog');
  await d.getByRole('button', { name: 'จ่ายงานรถร่วม' }).click();
  await d.getByText('จ่ายงานรถร่วม', { exact: true }).first().waitFor();
  await W.waitForTimeout(1200);
  return d;
};
// 1) รอตอบ: เมนู ⋯ "เปลี่ยนผู้รับเหมา"
let d = await openSub();
await d.getByRole('button', { name: 'เพิ่มเติม' }).click();
await W.waitForTimeout(400);
const cMenu = await W.screenshot();
await W.keyboard.press('Escape');

// 2) รถร่วมรับงานผ่านลิงก์ → รับงานแล้ว → dialog เหตุผล → drawer จ้างแบบเปลี่ยนราย
const l = await get(`/v1/trips/${trip.id}/offer-link`);
const tk = new URL(l.link.url).pathname.split('/').pop();
const acc = await W.request.post(`/v1/public/offers/${tk}/accept`, {
  data: { vehiclePlate: `71-${RUN.slice(-4)}`, driverName: 'สมชาย', driverPhone: PHONE },
});
if (acc.status() !== 200) throw new Error(`accept ${acc.status()} ${await acc.text()}`);
d = await openSub();
await d.getByRole('button', { name: 'เพิ่มเติม' }).click();
await W.waitForTimeout(300);
await W.getByRole('menuitem', { name: 'เปลี่ยนผู้รับเหมา' }).click();
await W.waitForTimeout(500);
await W.getByPlaceholder('เช่น รถของผู้รับเหมาเดิมเสียก่อนเข้ารับสินค้า').fill(
  'รถของผู้รับเหมาเดิมเสียก่อนเข้ารับสินค้า',
);
await W.waitForTimeout(300);
const cDlg = await W.screenshot();
await W.getByRole('button', { name: 'เลือกผู้รับเหมารายใหม่' }).click();
await W.waitForTimeout(1500);
const cHire = await W.screenshot();
await W.getByRole('dialog').getByRole('button', { name: 'ส่งข้อเสนอ' }).click();
await W.getByRole('status').filter({ hasText: 'เปลี่ยนผู้รับเหมาเป็น' }).waitFor();
await W.waitForTimeout(800);
// 3) หลังเปลี่ยน: กิจกรรม (รายเดิมรับงาน → ยกเลิกการจ้าง → ส่งข้อเสนอรายใหม่)
d = await openSub();
await d.getByRole('tab', { name: 'กิจกรรม' }).click();
// ต้องเห็นครบ: รายเดิมรับงาน → ยกเลิกการจ้าง → ส่งข้อเสนอรายใหม่ (review M1)
await d.getByText(/^ผู้รับเหมารับงาน · กรอกรถ /).waitFor();
await d.getByText('ยกเลิกการจ้าง', { exact: true }).waitFor();
await d.getByText(`ส่งข้อเสนอให้ ${B.name}`, { exact: true }).waitFor();
await W.waitForTimeout(500);
const cLog = await W.screenshot();
console.log('changed to', B.name);

await pair('menu', aSum, cMenu, [
  'ต้นแบบ (จ่ายงานรถร่วม · รอตอบ · เมนู ⋯ ชุดตั้งต้น)',
  'ของจริง (เมนู ⋯ "เปลี่ยนผู้รับเหมา" แทน "ยกเลิกเอกสาร")',
]);
await pair('reason', aDlg, cDlg, [
  'ต้นแบบ (dialog เหตุผล — ยกเลิกเอกสาร)',
  'ของจริง (dialog เหตุผลเปลี่ยนผู้รับเหมา — รับงานแล้ว)',
]);
await pair('hire', aAcc, cHire, [
  'ต้นแบบ (จ่ายงานรถร่วม · รับงาน)',
  'ของจริง (เลือกผู้รับเหมารายใหม่ — ไม่มีรายเดิม + คำเตือนยกเลิกการจ้าง)',
]);
await pair('log', aLog, cLog, [
  'ต้นแบบ (จ่ายงานรถร่วม · กิจกรรม)',
  'ของจริง (กิจกรรม: รับงาน → ยกเลิกการจ้าง → ส่งข้อเสนอรายใหม่)',
]);
await b.close();
await db.$disconnect();
srv.close();
