// ภาพเทียบ "ต้นแบบ | ของจริง" ของ ตั้งค่า → เหตุผล (ST2-T12; CLAUDE.md: ทุก PR ที่มี UI ต้องแนบ) — ใช้กับเครื่อง dev เท่านั้น
// ต้องมี web dev + API dev + seed · ใช้: WEB=http://localhost:4420 node scripts/compare-reasons.mjs
// owner ใช้ cookie อุปกรณ์ที่จำไว้จาก seed (ข้าม 2FA) — ข้อมูลเดโมเท่านั้น
import { chromium } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const WEB = process.env.WEB ?? 'http://localhost:4420';
const out = fileURLToPath(new URL('../../../design/compare/', import.meta.url));
const proto = 'file://' + fileURLToPath(new URL('../../../design/prototype/TMS v4.dc.html', import.meta.url));
const vp = { width: 1440, height: 1000 };
const b = await chromium.launch();

const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(proto);
await P.waitForTimeout(2500);
for (const el of await P.getByText('ตั้งค่า', { exact: true }).filter({ visible: true }).all()) {
  await el.click();
  await P.waitForTimeout(600);
  if (await P.getByText('นิติบุคคลและสาขา', { exact: true }).filter({ visible: true }).count()) break;
}
await P.getByText('เหตุผล', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(500);

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
await W.request.post('/v1/oauth/token', { data: { grantType: 'authorization_code', code, codeVerifier: v } });
await W.goto('/settings?sec=reason');
await W.waitForTimeout(1500);

async function pair(name, a, c) {
  const M = await (await b.newContext({ viewport: { width: 2900, height: 1060 } })).newPage();
  await M.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ (TMS v4)</div><img src="data:image/png;base64,${a.toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web)</div><img src="data:image/png;base64,${c.toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st2-reasons-${name}-1440.png` });
  console.log(`wrote design/compare/st2-reasons-${name}-1440.png`);
}

// 1) ตาราง
await pair('list', await P.screenshot(), await W.screenshot());
// 2) เพิ่มเหตุผล — ต้นแบบเพิ่มแถว "เหตุผลใหม่" ท้ายตาราง · ของจริงเปิดฟอร์ม drawer [OPEN spec/12 §3]
await P.getByText('เพิ่มเหตุผล', { exact: true }).first().click();
await P.waitForTimeout(400);
await P.mouse.wheel(0, 2000);
await P.waitForTimeout(300);
await W.getByRole('button', { name: 'เพิ่มเหตุผล' }).first().click();
await W.waitForTimeout(600);
await pair('create', await P.screenshot(), await W.screenshot());
// 3) ฟอร์มแก้ไขรหัสระบบ (ของจริงเท่านั้น — ต้นแบบไม่มี)
await W.keyboard.press('Escape');
await W.getByRole('button', { name: 'ยังไม่ได้จับคู่ลูกค้า' }).click();
await W.waitForTimeout(600);
await pair('edit', await P.screenshot(), await W.screenshot());
await b.close();
