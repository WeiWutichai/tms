// ภาพเทียบ "ต้นแบบ | ของจริง" ใบวางบิล (ST5-T11) ที่ 1440 px — เครื่อง dev เท่านั้น
// ของจริงมาจาก E2E `e2e/billing-note.spec.ts` (apps/web/test-results/st5-t11-*-actual-1440.png)
// ต้นแบบไม่มีหน้าจอใบวางบิลแยก → เทียบกับต้นแบบที่ใช้เป็นแบบ: ตาราง/แท็บของหน้า bill (list), drawer ใบแจ้งหนี้ที่ออกแล้ว (drawer/issued),
// การ์ด "สร้างใบวางบิล" (form — ฟอร์มมาตรฐาน FormDrawer) [DECISION spec/12 §3 — ST5-T11]
// ใช้: node scripts/compare-billing-note.mjs
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
writeFileSync(`${out}st5-t11-form-proto-1440.png`, await P.screenshot());
await P.mouse.move(800, 600);
await P.mouse.wheel(0, 1500);
await P.waitForTimeout(500);
writeFileSync(`${out}st5-t11-list-proto-1440.png`, await P.screenshot());
await P.locator('tbody tr')
  .filter({ hasText: 'TMS-INV' })
  .first()
  .click({ force: true, timeout: 10000 });
await P.waitForTimeout(900);
writeFileSync(`${out}st5-t11-drawer-proto-1440.png`, await P.screenshot());
await P.keyboard.press('Escape');
await P.waitForTimeout(400);
await P.locator('tbody tr')
  .filter({ hasText: 'TMS-INV' })
  .filter({ hasText: 'ออกแล้ว' })
  .first()
  .click({ force: true, timeout: 10000 });
await P.waitForTimeout(900);
writeFileSync(`${out}st5-t11-issued-proto-1440.png`, await P.screenshot());

for (const name of ['form', 'drawer', 'issued', 'list']) {
  const a = `${out}st5-t11-${name}-proto-1440.png`;
  const src = fileURLToPath(
    new URL(`../test-results/st5-t11-${name}-actual-1440.png`, import.meta.url),
  );
  if (!existsSync(src)) continue;
  const c = `${out}st5-t11-${name}-actual-1440.png`;
  writeFileSync(c, readFileSync(src));
  const img = (f) => `data:image/png;base64,${readFileSync(f).toString('base64')}`;
  const page = await (await b.newContext({ viewport: { width: 2900, height: 900 } })).newPage();
  await page.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#fff;align-items:flex-start">
       <img src="${img(a)}" style="width:1440px"><img src="${img(c)}" style="width:1440px"></body>`,
  );
  await page.waitForTimeout(300);
  writeFileSync(`${out}st5-t11-${name}-1440.png`, await page.screenshot({ fullPage: true }));
}
await b.close();
srv.close();
