// ภาพเทียบ "ต้นแบบ | ของจริง" การ์ดอายุลูกหนี้ (ST5-T22) ที่ 1440 px — เครื่อง dev เท่านั้น
// ภาพของจริงมาจาก E2E `e2e/aging.spec.ts` (apps/web/test-results/st5-t22-*-actual-1440.png)
// สคริปต์นี้ถ่ายต้นแบบ (TMS v4 → รับชำระ / กดช่วง "31–60 วัน") แล้วต่อเป็นภาพคู่ใน design/compare
// ใช้: node scripts/compare-aging.mjs
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
await P.getByText('รับชำระ', { exact: true }).filter({ visible: true }).first().click();
await P.waitForTimeout(1200);
writeFileSync(`${out}st5-t22-pay-aging-proto-1440.png`, await P.screenshot());
await P.getByRole('button', { name: /31–60 วัน/ })
  .filter({ visible: true })
  .first()
  .click();
await P.waitForTimeout(800);
writeFileSync(`${out}st5-t22-pay-aging-filter-proto-1440.png`, await P.screenshot());

for (const name of ['pay-aging', 'pay-aging-filter']) {
  const a = `${out}st5-t22-${name}-proto-1440.png`;
  const src = fileURLToPath(
    new URL(`../test-results/st5-t22-${name}-actual-1440.png`, import.meta.url),
  );
  if (!existsSync(src)) continue;
  const c = `${out}st5-t22-${name}-actual-1440.png`;
  writeFileSync(c, readFileSync(src));
  const img = (f) => `data:image/png;base64,${readFileSync(f).toString('base64')}`;
  const page = await (await b.newContext({ viewport: { width: 2900, height: 900 } })).newPage();
  await page.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#fff;align-items:flex-start">
       <img src="${img(a)}" style="width:1440px"><img src="${img(c)}" style="width:1440px"></body>`,
  );
  await page.waitForTimeout(300);
  writeFileSync(`${out}st5-t22-${name}-1440.png`, await page.screenshot({ fullPage: true }));
}
await b.close();
srv.close();
