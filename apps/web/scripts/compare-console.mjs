// ภาพเทียบ "ต้นแบบ | ของจริง" ของ Platform Console (ST1-T24) ที่ 1440 px — เครื่อง dev เท่านั้น
// ต้องมี web dev (4420) + API dev (4410) ที่รันโค้ด ST1-T24 + seed (ผู้ใช้ทีมงาน super-admin@platform.test)
// ใช้: node scripts/compare-console.mjs   (web อื่น: WEB=http://localhost:4620 node scripts/compare-console.mjs)
import { chromium } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = process.env.WEB ?? 'http://localhost:4420';
const out = fileURLToPath(new URL('../../../design/compare/', import.meta.url));
const protoDir = fileURLToPath(new URL('../../../design/prototype/', import.meta.url));

// ต้นแบบต้องเปิดผ่าน http (runtime ของ .dc.html ใช้ fetch — file:// ตารางว่าง)
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const srv = createServer((req, res) => {
  const p = join(protoDir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(protoDir) || !existsSync(p)) return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
  createReadStream(p).pipe(res);
}).listen(0);
const port = srv.address().port;

/** RFC 6238 (secret TOTP ของผู้ใช้เดโมใน seed — dev เท่านั้น) */
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

const vp = { width: 1440, height: 900 };
const b = await chromium.launch();
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(`http://localhost:${port}/TMS%20Platform%20Console.dc.html#ten`);
await P.waitForTimeout(3000);
const a0 = await P.screenshot();
await P.locator('tbody tr').nth(1).click();
await P.waitForTimeout(800);
const a1 = await P.screenshot();

const W = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await W.goto(`${WEB}/console/login`);
await W.getByLabel('อีเมล').fill('super-admin@platform.test');
await W.getByLabel('รหัสผ่าน').fill('demo-password-2569');
await W.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
// รหัสใช้ซ้ำไม่ได้ (กัน replay) — รันติดกันในช่วง 30 วินาทีเดียวกันให้ลองรหัสช่วงถัดไป
for (const off of [0, 1]) {
  await W.getByLabel('รหัส 6 หลัก').fill(totp('JBSWY3DPEHPK3PXP', off));
  await W.getByRole('button', { name: 'ยืนยัน' }).click();
  await W.waitForTimeout(1200);
  if (W.url().includes('/console/tenants')) break;
}
await W.waitForTimeout(800);
const c0 = await W.screenshot();
await W.locator('tbody tr', { hasText: 'ตัวอย่างขนส่ง (DEMO)' }).click();
await W.waitForTimeout(1000);
const c1 = await W.screenshot();

for (const [tag, a, c] of [
  ['list', a0, c0],
  ['detail', a1, c1],
]) {
  const M = await (await b.newContext({ viewport: { width: 2900, height: 960 } })).newPage();
  await M.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">ต้นแบบ (TMS Platform Console)</div><img src="data:image/png;base64,${a.toString('base64')}"></div><div><div style="padding:8px">ของจริง (apps/web /console)</div><img src="data:image/png;base64,${c.toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st1-console-${tag}-1440.png` });
  console.log(`wrote design/compare/st1-console-${tag}-1440.png`);
}
await b.close();
srv.close();
