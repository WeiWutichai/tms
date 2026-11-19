// ภาพเทียบ "ต้นแบบ | ของจริง" ST7-T20 (ตั้งค่า → การเชื่อมต่อ + Platform Console → Connector ระบบบัญชี) ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้องมี web dev + API dev (ตาม .env ของ lane) + seed · ใช้: WEB_PORT=4753 node scripts/compare-connectors.mjs
// ทิ้ง connector demo ที่สร้างไว้ด้วยการยกเลิกการเชื่อมตอนจบ
import { chromium } from '@playwright/test';
import { createHash, createHmac, randomBytes } from 'node:crypto';
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

function totp(secret, offset = 0) {
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let val = 0;
  const key = [];
  for (const c of secret) {
    val = (val << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      key.push((val >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
  const h = createHmac('sha1', Buffer.from(key)).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

const vp = { width: 1440, height: 1000 };
const b = await chromium.launch();
const shots = [];

// ---------- ต้นแบบ TMS v4: ตั้งค่า → การเชื่อมต่อ ----------
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(`http://localhost:${port}/TMS%20v4.dc.html`);
await P.waitForTimeout(3000);
for (const el of await P.getByText('ตั้งค่า', { exact: true }).filter({ visible: true }).all()) {
  await el.click();
  await P.waitForTimeout(600);
  if (await P.getByText('การเชื่อมต่อ', { exact: true }).filter({ visible: true }).count()) break;
}
await P.getByText('การเชื่อมต่อ', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(800);
const a0 = await P.screenshot();
await P.getByRole('button', { name: 'เชื่อมต่อ', exact: true }).first().click();
await P.waitForTimeout(800);
const a1 = await P.screenshot({ fullPage: true });

// ---------- ของจริง: owner ของบริษัทเดโม ----------
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
await W.goto('/settings?sec=conn');
await W.waitForTimeout(1500);
const c0 = await W.screenshot();
await W.getByRole('group', { name: 'ERP จำลอง (Demo)' })
  .getByRole('button', { name: 'เชื่อมต่อ' })
  .click();
await W.getByLabel('apiKey').fill('demo-compare-key-0001');
await W.getByRole('dialog').getByRole('button', { name: 'เชื่อมต่อ' }).click();
await W.waitForTimeout(2000);
const c1 = await W.screenshot({ fullPage: true });
shots.push(['tenant-none', a0, c0], ['tenant-connected', a1, c1]);

// ---------- Platform Console ----------
const C = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await C.goto(`http://localhost:${port}/TMS%20Platform%20Console.dc.html#use`);
await C.waitForTimeout(3000);
await C.getByText('การใช้งาน API และ AI', { exact: true }).first().click();
await C.waitForTimeout(800);
const a2 = await C.screenshot();
await C.locator('tbody tr').first().click();
await C.waitForTimeout(800);
const a3 = await C.screenshot();

const K = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await K.goto(`${WEB}/console/login`);
await K.getByLabel('อีเมล').fill('super-admin@platform.test');
await K.getByLabel('รหัสผ่าน').fill('demo-password-2569');
await K.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
for (const off of [0, 1]) {
  await K.getByLabel('รหัส 6 หลัก').fill(totp('JBSWY3DPEHPK3PXP', off));
  await K.getByRole('button', { name: 'ยืนยัน' }).click();
  await K.waitForTimeout(1200);
  if (K.url().includes('/console/tenants')) break;
}
await K.getByRole('button', { name: 'Connector ระบบบัญชี' }).click();
await K.waitForTimeout(1200);
const c2 = await K.screenshot();
await K.locator('tbody tr').first().click();
await K.waitForTimeout(1200);
const c3 = await K.screenshot();
await K.getByRole('button', { name: 'เปิด connector' })
  .click()
  .catch(() => undefined);
shots.push(['console-list', a2, c2], ['console-drawer', a3, c3]);

for (const [tag, a, c] of shots) {
  const M = await (await b.newContext({ viewport: { width: 2900, height: 1060 } })).newPage();
  await M.setContent(
    `<body style="margin:0;display:flex;gap:20px;align-items:flex-start;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ</div><img src="data:image/png;base64,${a.toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web)</div><img src="data:image/png;base64,${c.toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st7-t20-${tag}-1440.png`, fullPage: true });
  console.log(`wrote design/compare/st7-t20-${tag}-1440.png`);
}

// เก็บกวาด: ยกเลิกการเชื่อม demo ที่สร้าง
const list = await (await W.request.get('/v1/connectors', { headers: auth })).json();
for (const c of list.data ?? [])
  await W.request.post(`/v1/connectors/${c.id}/disconnect`, {
    headers: auth,
    data: { reason: 'เก็บกวาดหลังถ่ายภาพเทียบ' },
  });
await b.close();
srv.close();
