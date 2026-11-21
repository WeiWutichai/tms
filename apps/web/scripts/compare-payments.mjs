// ภาพเทียบ "ต้นแบบ | ของจริง" หน้า "รับชำระ" + drawer รับชำระ + drawer ใบแจ้งหนี้ (ST5-T13) ที่ 1440 px — เครื่อง dev เท่านั้น
// ภาพของจริงมาจาก E2E `e2e/payments.spec.ts` (apps/web/test-results/st5-t13-*-actual-1440.png)
// สคริปต์นี้ถ่ายต้นแบบ (TMS v4 → บัญชี → รับชำระ) แล้วต่อเป็นภาพคู่ใน design/compare (ตั้งใจรันเอง)
// ใช้: node scripts/compare-payments.mjs
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
writeFileSync(`${out}st5-t13-pay-page-proto-1440.png`, await P.screenshot());
// drawer รับชำระของใบที่ "ออกแล้ว"
await P.locator('tbody tr').filter({ hasText: 'ออกแล้ว' }).first().click();
await P.waitForTimeout(900);
writeFileSync(`${out}st5-t13-pay-drawer-proto-1440.png`, await P.screenshot());
// เลือก "เช็ค" (ต้นแบบมีแค่เลขที่เช็คในช่องเลขอ้างอิง)
await P.locator('select').filter({ hasText: 'เช็ค' }).first().selectOption({ label: 'เช็ค' });
await P.waitForTimeout(400);
writeFileSync(`${out}st5-t13-pay-cheque-proto-1440.png`, await P.screenshot());
// บันทึก → ชำระแล้ว (ต้นแบบ: ประวัติ + footer ไม่มีปุ่มบันทึก)
await P.getByRole('button', { name: 'บันทึกรับชำระ' }).last().click();
await P.waitForTimeout(900);
writeFileSync(`${out}st5-t13-pay-paid-proto-1440.png`, await P.screenshot());
// drawer ใบแจ้งหนี้ของใบเดียวกัน (ส่วน "รับชำระแล้ว")
await P.getByRole('button', { name: 'ดูใบแจ้งหนี้' }).last().click();
await P.waitForTimeout(900);
writeFileSync(`${out}st5-t13-inv-drawer-proto-1440.png`, await P.screenshot());

for (const name of ['pay-page', 'pay-drawer', 'pay-cheque', 'pay-paid', 'inv-drawer']) {
  const a = `${out}st5-t13-${name}-proto-1440.png`;
  const src = fileURLToPath(
    new URL(`../test-results/st5-t13-${name}-actual-1440.png`, import.meta.url),
  );
  if (!existsSync(src)) continue;
  const c = `${out}st5-t13-${name}-actual-1440.png`;
  writeFileSync(c, readFileSync(src));
  const img = (f) => `data:image/png;base64,${readFileSync(f).toString('base64')}`;
  const page = await (await b.newContext({ viewport: { width: 2900, height: 900 } })).newPage();
  await page.setContent(
    `<body style="margin:0;display:flex;gap:20px;background:#fff;align-items:flex-start">
       <img src="${img(a)}" style="width:1440px"><img src="${img(c)}" style="width:1440px"></body>`,
  );
  await page.waitForTimeout(300);
  writeFileSync(`${out}st5-t13-${name}-1440.png`, await page.screenshot({ fullPage: true }));
}
await b.close();
srv.close();
