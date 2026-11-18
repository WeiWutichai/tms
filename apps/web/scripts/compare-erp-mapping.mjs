// ภาพเทียบ "ต้นแบบ | ของจริง" ของ ตั้งค่า → การเชื่อมต่อ → ตาราง mapping ค่าบริการ ↔ รหัสสินค้า ERP (ST7-T18)
// ต้องมี web dev + API dev + seed (dev/staging ที่เปิด DemoProvider) · ใช้: WEB=http://localhost:4420 node scripts/compare-erp-mapping.mjs
// owner (ข้าม 2FA ด้วย cookie อุปกรณ์ของ seed — ข้อมูลเดโมเท่านั้น) · สร้าง connector demo ชั่วคราวแล้วยกเลิกเมื่อจบ
import { chromium } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const WEB = process.env.WEB ?? `http://localhost:${process.env.WEB_PORT ?? 4420}`;
const out = fileURLToPath(new URL('../../../design/compare/', import.meta.url));
const proto =
  'file://' + fileURLToPath(new URL('../../../design/prototype/TMS v4.dc.html', import.meta.url));
const vp = { width: 1440, height: 1000 };
const b = await chromium.launch();

// ต้นแบบ: ตั้งค่า → การเชื่อมต่อ (โหมดตัวอย่าง "เชื่อม 1 ตัว" = KRS เพื่อให้การ์ด "ตั้งค่า KRS" แสดง)
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(proto);
await P.waitForTimeout(2500);
for (const el of await P.getByText('ตั้งค่า', { exact: true }).filter({ visible: true }).all()) {
  await el.click();
  await P.waitForTimeout(600);
  if (await P.getByText('นิติบุคคลและสาขา', { exact: true }).filter({ visible: true }).count())
    break;
}
await P.getByText('การเชื่อมต่อ', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(800);
const one = P.getByText('เชื่อม 1 ตัว', { exact: true }).filter({ visible: true });
if (await one.count()) await one.first().click();
await P.waitForTimeout(800);
const protoCard = P.getByText('จับคู่ประเภทค่าใช้จ่าย', { exact: false }).filter({ visible: true });
await protoCard.first().scrollIntoViewIfNeeded();
await P.waitForTimeout(400);

// ของจริง
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
const auth = { Authorization: `Bearer ${tok.accessToken}` };
const con = await (
  await W.request.post('/v1/connectors', {
    headers: auth,
    data: { adapterKey: 'demo', credentials: { apiKey: 'demo-compare' } },
  })
).json();
if (!con.id) throw new Error(JSON.stringify(con));
try {
  await W.request.post(`/v1/connectors/${con.id}/resume`, { headers: auth, data: {} });
  await W.request.post(`/v1/connectors/${con.id}/master-codes/sync`, {
    headers: auth,
    data: { kinds: ['ITEM'] },
  });
  const rows = (
    await (await W.request.get(`/v1/connectors/${con.id}/mappings`, { headers: auth })).json()
  ).data;
  const demo = ['SV-FRT-01', 'SV-WAIT', 'SV-LABOR', 'SV-OVN'];
  for (const [i, r] of rows.slice(0, demo.length).entries())
    await W.request.put(`/v1/connectors/${con.id}/mappings/${r.serviceItem.id}`, {
      headers: auth,
      data: { itemCode: demo[i] },
    });
  await W.goto(`/settings?sec=conn&connector=${con.id}`);
  await W.getByText('จับคู่ประเภทค่าใช้จ่าย', { exact: false }).waitFor({ timeout: 60000 });
  await W.waitForTimeout(800);

  const M = await (await b.newContext({ viewport: { width: 2900, height: 1060 } })).newPage();
  const a = await P.screenshot();
  const c = await W.screenshot();
  await M.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ (TMS v4)</div><img src="data:image/png;base64,${a.toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web)</div><img src="data:image/png;base64,${c.toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st7-t18-erp-mapping-1440.png` });
  console.log('wrote design/compare/st7-t18-erp-mapping-1440.png');
} finally {
  await W.request.post(`/v1/connectors/${con.id}/disconnect`, {
    headers: auth,
    data: { reason: 'จบการถ่ายภาพเทียบต้นแบบ' },
  });
  await b.close();
}
