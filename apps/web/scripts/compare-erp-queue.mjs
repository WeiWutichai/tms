// ภาพเทียบ "ต้นแบบ | ของจริง" หน้า "คิวเชื่อมระบบบัญชี" (PO #86 แท็บคิว + #94 ไม่อนุมัติ — 24 พ.ย. 2569) ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้องมี web dev (WEB_PORT) + API dev + seed + connector และคำสั่งที่ล้มเหลว/คำขออนุมัติแก้ของ tenant เดโม (สคริปต์ไม่สร้างให้)
// ใช้: node scripts/compare-erp-queue.mjs · OUT = โฟลเดอร์ปลายทางเพิ่ม (เช่น scratchpad) — เขียน design/compare/ เสมอ
// ภาพ: list = ตาราง (ต้นแบบแท็บทั้งหมด | จริงแท็บล้มเหลว) · drawer = รายการส่งไม่สำเร็จ · skip = dialog (ต้นแบบ askFix | จริง ข้ามพร้อมเหตุผล)
//       · appr = drawer รออนุมัติ (จริงมีปุ่ม "ไม่อนุมัติ")
// FAIL_NO / APPR_NO = เลขเอกสารของจริงที่จะเปิด · PROTO = URL ของต้นแบบ (http)
import { chromium } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = fileURLToPath(new URL('../../../design/compare/', import.meta.url));
// ตารางของต้นแบบโหลดผ่าน fetch — file:// ไม่แสดงแถว ให้เปิด design/prototype ผ่าน http (เช่น python3 -m http.server) แล้วตั้ง PROTO
const proto =
  process.env.PROTO ??
  'file://' + fileURLToPath(new URL('../../../design/prototype/TMS v4.dc.html', import.meta.url));
const WEB = process.env.WEB ?? `http://localhost:${process.env.WEB_PORT ?? 4420}`;
const FAIL_NO = process.env.FAIL_NO ?? 'INV-00000-2611-0005';
const APPR_NO = process.env.APPR_NO ?? 'INV-00000-2611-0011';
const vp = { width: 1440, height: 900 };
const b = await chromium.launch();
const clickText = (page, text) =>
  page.evaluate((t) => {
    const el = [...document.querySelectorAll('button, [role=button], a, div, span')]
      .reverse()
      .find((x) => x.textContent?.trim() === t);
    el?.click();
    return !!el;
  }, text);

// ---------- ต้นแบบ: โหมดตัวอย่าง "เชื่อม 1 ตัว" → บัญชี → คิวเชื่อมระบบบัญชี ----------
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(proto);
await P.waitForTimeout(2500);
if (!(await clickText(P, 'เชื่อม 1 ตัว'))) throw new Error('ไม่พบปุ่ม "เชื่อม 1 ตัว" ในต้นแบบ');
await P.waitForTimeout(1000);
if (!(await clickText(P, 'คิวเชื่อมระบบบัญชี'))) throw new Error('ไม่พบเมนูคิวเชื่อมระบบบัญชี');
await P.waitForTimeout(1200);
const pList = await P.screenshot();
await P.getByText('DO-2611-00044').first().click();
await P.waitForTimeout(900);
const pDrawer = await P.screenshot();
await P.keyboard.press('Escape');
await P.waitForTimeout(500);
await P.getByText('TMS-INV-2611-0009').first().click();
await P.waitForTimeout(900);
const pAppr = await P.screenshot();
await clickText(P, 'ขออนุมัติแก้');
await P.waitForTimeout(800);
const pDlg = await P.screenshot();

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
await W.request.post('/v1/oauth/token', {
  data: { grantType: 'authorization_code', code, codeVerifier: v },
});
await W.goto('/erp?tab=failed');
await W.locator('tbody tr').filter({ hasText: FAIL_NO }).waitFor({ timeout: 15000 });
await W.waitForTimeout(1200);
const wList = await W.screenshot();
await W.locator('tbody tr').filter({ hasText: FAIL_NO }).click();
await W.waitForTimeout(900);
const wDrawer = await W.screenshot();
await W.getByRole('button', { name: 'ข้ามพร้อมเหตุผล' }).click();
await W.waitForTimeout(700);
const wDlg = await W.screenshot();
await W.keyboard.press('Escape');
await W.waitForTimeout(300);
await W.keyboard.press('Escape');
await W.waitForTimeout(300);
await W.getByRole('tab', { name: /^รออนุมัติ/ }).click();
await W.locator('tbody tr').filter({ hasText: APPR_NO }).click();
await W.waitForTimeout(900);
const wAppr = await W.screenshot();

const M = await (await b.newContext({ viewport: { width: 2900, height: 960 } })).newPage();
for (const [tag, a, c] of [
  ['list', pList, wList],
  ['drawer', pDrawer, wDrawer],
  ['skip', pDlg, wDlg],
  ['appr', pAppr, wAppr],
]) {
  await M.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ (TMS v4)</div><img src="data:image/png;base64,${a.toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web)</div><img src="data:image/png;base64,${c.toString('base64')}"></div></body>`,
  );
  const f = `q86-erp-queue-${tag}-1440.png`;
  await M.screenshot({ path: `${out}${f}` });
  console.log(`wrote design/compare/${f}`);
  if (process.env.OUT) copyFileSync(`${out}${f}`, `${process.env.OUT}/${f}`);
}
await b.close();
