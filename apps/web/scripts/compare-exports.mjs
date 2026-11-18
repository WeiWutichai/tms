// ภาพเทียบ "ต้นแบบ | ของจริง" ของการส่งออกตามตัวกรอง (ST9-T10) ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้องมี web dev + API dev + worker (`pnpm --filter @tms/api dev:worker`) ที่รันโค้ด ST9-T10 + seed · ใช้: node scripts/compare-exports.mjs
// (web อื่น: WEB=http://localhost:4693 node scripts/compare-exports.mjs)
// ต้นแบบ: แผง "ตัวเลือกตาราง" → "ส่งออก CSV" (T.exportCsv) + toast "ส่งออก N รายการเป็น CSV แล้ว"
// ต้นแบบไม่มีหน้าลิงก์ไฟล์ส่งออก ([DECISION] spec/12 §3) → ฝั่งซ้ายเป็นหน้าว่างแบบเต็มหน้าที่ใช้เป็นแบบ (หน้าที่ยังไม่เปิดใช้)
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
await P.getByText('ใบสั่งขนส่ง (SO)', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(1200);
await P.getByRole('button', { name: 'ตัวเลือก' }).filter({ visible: true }).first().click();
await P.waitForTimeout(600);
const a = { panel: await P.screenshot() };
await P.getByRole('button', { name: 'ส่งออก CSV' }).filter({ visible: true }).first().click();
await P.waitForTimeout(600);
a.toast = await P.screenshot();
a.page = a.toast;

// ---------- ของจริง ----------
const ctx = await b.newContext({
  viewport: vp,
  locale: 'th-TH',
  baseURL: WEB,
  acceptDownloads: true,
});
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
const H = { Authorization: `Bearer ${tok.accessToken}` };
await W.goto('/so');
await W.waitForTimeout(1800);
await W.getByRole('button', { name: 'ตัวเลือก', exact: true }).click();
await W.waitForTimeout(500);
const c = { panel: await W.screenshot() };
await W.getByRole('button', { name: 'ส่งออก CSV' }).click();
await W.getByRole('status').first().waitFor({ timeout: 15000 });
await W.waitForTimeout(300);
c.toast = await W.screenshot();
// งานล่าสุดของผู้ใช้ — เปิดหน้าลิงก์จากแจ้งเตือน
const notes = await (await W.request.get('/v1/me/notifications?limit=20', { headers: H })).json();
const link = notes.data?.find((n) => n.link?.includes('/exports/'))?.link;
if (link) {
  await W.goto(new URL(link, WEB).pathname);
  await W.waitForTimeout(1500);
}
c.page = await W.screenshot();

const LEFT = {
  panel: 'แผงตัวเลือกตาราง (ส่งออก CSV)',
  toast: 'กด "ส่งออก CSV" → toast',
  page: 'ไม่มีหน้าลิงก์ไฟล์ส่งออก (ใช้ toast/หน้าว่างแบบเต็มหน้า)',
};
const RIGHT = {
  panel: '/so แผงตัวเลือก',
  toast: '/so ส่งออก (งานเบื้องหลัง) → toast',
  page: '/exports/{jobId} ลิงก์จากแจ้งเตือน',
};
for (const tag of ['panel', 'toast', 'page']) {
  const M = await (await b.newContext({ viewport: { width: 2900, height: 960 } })).newPage();
  await M.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ (TMS v4) — ${LEFT[tag]}</div><img src="data:image/png;base64,${a[tag].toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web ${RIGHT[tag]})</div><img src="data:image/png;base64,${c[tag].toString('base64')}"></div></body>`,
  );
  const f = `st9-t10-export-${tag}-1440.png`;
  await M.screenshot({ path: `${out}${f}` });
  console.log(`wrote design/compare/${f}`);
}
await b.close();
srv.close();
