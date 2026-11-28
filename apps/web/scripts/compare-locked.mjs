// ภาพเทียบ "ต้นแบบ | ของจริง" หน้าโมดูลที่ไม่รวมในแพ็กเกจ (ต้นแบบ v4 `lkp` — P1-ST1-T02) ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้องมี web dev + API dev + seed · ใช้: node scripts/compare-locked.mjs (web อื่น: WEB=http://localhost:6323 node …)
// ต้นแบบ: สลับแพ็กเกจเดโมเป็น "เริ่มต้น" แล้วเปิด ตั้งค่า → นักพัฒนา / Open API · ของจริง: owner@demo-b.test (Starter) เปิด /settings/api
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

// ---------- ต้นแบบ ----------
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(`http://localhost:${port}/TMS%20v4.dc.html`);
await P.waitForTimeout(3000);
// ตัวเลือกแพ็กเกจเดโม (demoP) — select ที่มีตัวเลือก "เริ่มต้น"
const sel = P.locator('select').filter({ has: P.locator('option', { hasText: 'เริ่มต้น' }) });
await sel.first().selectOption({ label: 'เริ่มต้น' });
await P.waitForTimeout(500);
await P.getByText('ตั้งค่า', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(400);
await P.getByText('นักพัฒนา / Open API', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(1200);
const a = { page: await P.screenshot() };

// ---------- ของจริง ----------
const ctx = await b.newContext({ viewport: vp, locale: 'th-TH', baseURL: WEB });
await ctx.addCookies([
  {
    name: 'tms_td',
    value: 'demo-trusted-device-e2e-only-0000000000000:00000000-0000-4000-8000-0000000e0b01',
    url: `${WEB}/v1/auth`,
  },
]);
const W = await ctx.newPage();
const v = randomBytes(32).toString('base64url');
const r1 = await W.request.post('/v1/auth/login', {
  data: {
    email: 'owner@demo-b.test',
    password: 'demo-password-2569',
    codeChallenge: createHash('sha256').update(v).digest('base64url'),
  },
});
const { code } = await r1.json();
// แลก code → refresh cookie httpOnly ใน context นี้ (เหมือน fixture ของ E2E) แล้วหน้าเว็บ login เอง
await W.request.post('/v1/oauth/token', {
  data: { grantType: 'authorization_code', code, codeVerifier: v },
});
await W.goto('/settings/api');
await W.waitForTimeout(1500);
const c = { page: await W.screenshot() };

for (const tag of Object.keys(c)) {
  const M = await (await b.newContext({ viewport: { width: 2900, height: 960 } })).newPage();
  await M.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ (TMS v4)</div><img src="data:image/png;base64,${a[tag].toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web)</div><img src="data:image/png;base64,${c[tag].toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}p1-st1-t02-locked-${tag}-1440.png` });
  console.log(`wrote design/compare/p1-st1-t02-locked-${tag}-1440.png`);
}
await b.close();
srv.close();
