// ภาพเทียบ "ต้นแบบ | ของจริง" ของ ST3-T21 (ส่งลิงก์ทาง LINE/SMS + คัดลอกลิงก์) — เครื่อง dev เท่านั้น
// ต้นแบบ: TMS v4 จ่ายงานรถร่วม → ข้อเสนอ (footer "คัดลอกลิงก์" + "ส่งผ่าน LINE", แถว log "ส่งข้อเสนอให้ … ผ่าน LINE")
// ของจริง: ผู้รับเหมา → แท็บเอกสารแนบ → สร้างลิงก์ → ส่งผ่าน LINE (ผู้ให้บริการ mock) → ประวัติการส่ง
// ต้องมี web + API + worker dev (LINE_PROVIDER/SMS_PROVIDER ไม่ตั้ง = mock) + seed:
//   WEB=http://localhost:4420 node scripts/compare-line-send.mjs
import { chromium } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = process.env.WEB ?? 'http://localhost:4420';
const CARRIER = 'หจก. ส่งไวสมมติ (LINE)';
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
  await M.screenshot({ path: `${out}st3-line-send-${name}.png`, fullPage: true });
  console.log(`wrote design/compare/st3-line-send-${name}.png`);
}

/** เลขผู้เสียภาษี 13 หลักที่ checksum ถูก (ข้อมูลสมมติ) */
function taxId(seed) {
  const d = String(1000000000000 + seed)
    .slice(1, 13)
    .split('')
    .map(Number);
  const sum = d.reduce((s, x, i) => s + x * (13 - i), 0);
  return d.join('') + String((11 - (sum % 11)) % 10);
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
const aOffer = await P.screenshot();

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
const auth = { Authorization: `Bearer ${tok.accessToken ?? tok.access_token}` };
// ผู้รับเหมาตัวอย่างที่มี LINE userId (สมมติ) + เบอร์มือถือ — ส่งผ่าน mock เท่านั้น
const list = await (
  await W.request.get(`/v1/carriers?q=${encodeURIComponent('ส่งไวสมมติ')}`, { headers: auth })
).json();
if (!list.data?.length)
  await W.request.post('/v1/carriers', {
    headers: { ...auth, 'Idempotency-Key': `cmp-line-${Date.now()}` },
    data: {
      legalName: CARRIER,
      entityType: 'INDIVIDUAL',
      taxId: taxId(Date.now() % 1e9),
      phone: '081-234-5678',
      lineContact: `U${'4f2a9c1e'.repeat(4)}`,
    },
  });
await W.goto('/fleet/drivers');
await W.waitForTimeout(1500);
await W.locator('button', { hasText: /^ผู้รับเหมา/ })
  .first()
  .click();
await W.waitForTimeout(1200);
await W.locator('tbody tr', { hasText: CARRIER }).first().click();
await W.waitForTimeout(900);
await W.getByRole('tab', { name: 'เอกสารแนบ' }).click();
await W.waitForTimeout(800);
await W.getByRole('button', { name: 'สร้างลิงก์' }).click();
await W.waitForTimeout(900);
const cIssued = await W.screenshot();
await W.getByRole('button', { name: 'ส่งผ่าน LINE' }).click();
await W.waitForTimeout(700);
const cQueued = await W.screenshot();
await W.waitForTimeout(4500); // worker ส่ง (mock) → โหลดซ้ำทุก 3 วิ
const cSent = await W.screenshot();
await pair('issued-1440', aOffer, cIssued, 1440, 960, [
  'ต้นแบบ (TMS v4 · จ่ายงานรถร่วม · ข้อเสนอ: คัดลอกลิงก์ + ส่งผ่าน LINE)',
  'ของจริง (ผู้รับเหมา · เอกสารแนบ · สร้างลิงก์แล้ว)',
]);
await pair('queued-1440', aOffer, cQueued, 1440, 960, [
  'ต้นแบบ (TMS v4)',
  'ของจริง (กดส่งผ่าน LINE → รอส่ง)',
]);
await pair('sent-1440', aOffer, cSent, 1440, 960, [
  'ต้นแบบ (TMS v4 · log "ส่งข้อเสนอ … ผ่าน LINE · สำเร็จ")',
  'ของจริง (worker ส่งแล้ว → สำเร็จ)',
]);
await b.close();
srv.close();
