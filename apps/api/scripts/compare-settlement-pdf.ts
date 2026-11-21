/**
 * ภาพเทียบ "ต้นแบบ | ของจริง" ของ ST6-T04 (PDF ใบสำคัญจ่ายรถร่วม) — เครื่อง dev เท่านั้น
 * ต้นแบบ: TMS Print.dc.html #pv (ใบสำคัญจ่ายรถร่วม) · ของจริง: ใบตัวอย่าง 3 แบบ (render ด้วย PdfRenderer ชุดเดียวกับ PDF)
 *   pnpm --filter @tms/api exec node -r @swc-node/register scripts/compare-settlement-pdf.ts
 */
import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';
import {
  sampleSettlementDraft,
  sampleSettlementLong,
  sampleSettlementPaid,
} from '../src/modules/settlements/settlement-pdf.sample';
import { settlementVoucherDocument } from '../src/modules/settlements/settlement-pdf.template';
import { PdfRenderer } from '../src/pdf/pdf-renderer';

const root = join(__dirname, '../../..');
const out = join(root, 'design/compare/');
const protoDir = join(root, 'design/prototype/');
const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
};

async function main() {
  const srv = createServer((req, res) => {
    const p = join(protoDir, decodeURIComponent(new URL(req.url!, 'http://x').pathname));
    if (!p.startsWith(protoDir) || !existsSync(p)) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': MIME[extname(p)] ?? 'application/octet-stream' });
    createReadStream(p).pipe(res);
  }).listen(0);
  const port = (srv.address() as { port: number }).port;
  const b = await chromium.launch();
  const PP = await (
    await b.newContext({ viewport: { width: 1000, height: 1300 }, locale: 'th-TH' })
  ).newPage();
  await PP.goto(`http://localhost:${port}/TMS%20Print.dc.html#pv`);
  await PP.waitForTimeout(3000);
  const proto = await PP.locator('section#pv').screenshot();

  const r = new PdfRenderer();
  const shot = (m: Parameters<typeof settlementVoucherDocument>[0]) =>
    r.withPage(settlementVoucherDocument(m), (p) =>
      p.locator('section.page').first().screenshot({ type: 'png' }),
    );
  const real = {
    paid: await shot(sampleSettlementPaid()),
    draft: await shot(sampleSettlementDraft()),
    long: await shot(sampleSettlementLong()),
  };
  await r.onModuleDestroy();

  const pair = async (name: string, left: Buffer, right: Buffer, labels: [string, string]) => {
    const w = 794;
    const M = await (await b.newContext({ viewport: { width: 1440, height: 1200 } })).newPage();
    await M.setContent(
      `<body style="margin:0;display:flex;justify-content:center;align-items:flex-start;gap:20px;background:#333;font:16px sans-serif;color:#fff;padding:0 6px">${[
        [labels[0], left],
        [labels[1], right],
      ]
        .map(
          ([l, img]) =>
            `<div><div style="padding:8px">${l}</div><img style="width:${(1440 - 40) / 2 - 6}px;max-width:${w}px;background:#fff" src="data:image/png;base64,${(img as Buffer).toString('base64')}"></div>`,
        )
        .join('')}</body>`,
    );
    await M.screenshot({ path: `${out}st6-settlement-pdf-${name}-1440.png`, fullPage: true });
    console.log(`wrote design/compare/st6-settlement-pdf-${name}-1440.png`);
  };
  await pair('paid', proto, real.paid, [
    'ต้นแบบ (TMS Print#pv) — ใบสำคัญจ่ายรถร่วม',
    'ของจริง — จ่ายแล้ว (ยอดเดียวกับต้นแบบ · WHT ประมาณการ *)',
  ]);
  await pair('draft', proto, real.draft, [
    'ต้นแบบ (TMS Print#pv)',
    'ของจริง — ร่าง (ลายน้ำ, WHT 1% + 3%, หักหลายชนิด, บุคคลธรรมดา)',
  ]);
  await pair('long', proto, real.long, [
    'ต้นแบบ (TMS Print#pv)',
    'ของจริง — หลายหน้า หน้า 1 (ค.ศ., อนุมัติแล้ว ยังไม่จ่าย)',
  ]);
  await b.close();
  srv.close();
}

void main();
