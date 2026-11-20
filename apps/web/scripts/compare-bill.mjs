// ภาพเทียบ "ต้นแบบ | ของจริง" หน้า บัญชี → วางบิลและใบแจ้งหนี้ (ST5-T07) ที่ 1440 px — เครื่อง dev เท่านั้น
// ภาพของจริงมาจาก E2E `e2e/invoice-draft.spec.ts` (apps/web/test-results/st5-t07-*-actual-1440.png — E2E ไม่เขียนทับ design/compare)
// สคริปต์นี้ถ่ายต้นแบบ แล้วคัดลอกภาพของจริงมาต่อเป็นภาพคู่ใน design/compare (ตั้งใจรันเอง)
// ใช้: node scripts/compare-bill.mjs
import { chromium } from '@playwright/test';
import { createReadStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
await P.goto(`http://localhost:${port}/TMS%20v4.dc.html`);
await P.waitForTimeout(3000);
await P.getByText('วางบิลและใบแจ้งหนี้', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(1200);
const rows = P.locator('tbody tr');
await rows.nth(0).click();
await rows.nth(1).click();
await P.waitForTimeout(500);
writeFileSync(`${out}st5-t07-bill-proto-1440.png`, await P.screenshot({ fullPage: true }));
// drawer ร่าง: แถว "ร่าง" ในตารางใบแจ้งหนี้
await P.getByText('ร่าง', { exact: true }).filter({ visible: true }).last().click();
await P.waitForTimeout(600);
await P.locator('tbody tr').filter({ hasText: 'TMS-INV' }).first().click();
await P.waitForTimeout(900);
writeFileSync(`${out}st5-t07-drawer-proto-1440.png`, await P.screenshot());

// ต่อภาพ ต้นแบบ | ของจริง
const pair = async (name) => {
  const a = `${out}st5-t07-${name}-proto-1440.png`;
  const src = fileURLToPath(
    new URL(`../test-results/st5-t07-${name}-actual-1440.png`, import.meta.url),
  );
  if (!existsSync(src)) return;
  const c = `${out}st5-t07-${name}-actual-1440.png`;
  writeFileSync(c, readFileSync(src));
  const img = (f) => `data:image/png;base64,${readFileSync(f).toString('base64')}`;
  const page = await (await b.newContext({ viewport: { width: 2900, height: 900 } })).newPage();
  await page.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#fff;align-items:flex-start">
       <img src="${img(a)}" style="width:1440px"><img src="${img(c)}" style="width:1440px"></body>`,
  );
  await page.waitForTimeout(300);
  writeFileSync(`${out}st5-t07-${name}-1440.png`, await page.screenshot({ fullPage: true }));
};
await pair('bill');
await pair('drawer');
await b.close();
srv.close();
