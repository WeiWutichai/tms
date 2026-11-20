/**
 * ภาพเทียบ "ต้นแบบ | ของจริง" ของ ST5-T08 (PDF ใบแจ้งหนี้) — เครื่อง dev เท่านั้น
 * ต้นแบบ: TMS Print.dc.html #inv (ใบเสร็จ/ใบกำกับภาษี — แบบรายการ) และ #bill (ใบวางบิล — กล่องงวด/ครบกำหนด)
 * ของจริง: หน้าแรกของใบแจ้งหนี้ตัวอย่าง 3 แบบ (render ด้วย PdfRenderer ชุดเดียวกับ PDF)
 *   pnpm --filter @tms/api exec node -r @swc-node/register scripts/compare-invoice-pdf.ts
 */
import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';
import {
  sampleInvoiceExempt,
  sampleInvoiceLong,
  sampleInvoiceMixed,
} from '../src/modules/invoices/invoice.sample';
import { invoiceDocument } from '../src/modules/invoices/invoice.template';
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
  await PP.goto(`http://localhost:${port}/TMS%20Print.dc.html#inv`);
  await PP.waitForTimeout(3000);
  const proto = {
    inv: await PP.locator('section#inv').screenshot(),
    bill: await PP.locator('section#bill').screenshot(),
  };

  const r = new PdfRenderer();
  const shot = (m: Parameters<typeof invoiceDocument>[0]) =>
    r.withPage(invoiceDocument(m), (p) =>
      p.locator('section.page').first().screenshot({ type: 'png' }),
    );
  const real = {
    exempt: await shot(sampleInvoiceExempt()),
    mixed: await shot(sampleInvoiceMixed()),
    long: await shot(sampleInvoiceLong()),
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
    await M.screenshot({ path: `${out}st5-invoice-pdf-${name}-1440.png`, fullPage: true });
    console.log(`wrote design/compare/st5-invoice-pdf-${name}-1440.png`);
  };
  await pair('mixed', proto.inv, real.mixed, [
    'ต้นแบบ (TMS Print#inv) — ใบเสร็จ/ใบกำกับภาษี (แบบรายการ)',
    'ของจริง — ใบแจ้งหนี้ ร่าง (ยกเว้น + 7%, สาขาที่ 00001, PO, ส่วนลด)',
  ]);
  await pair('exempt', proto.bill, real.exempt, [
    'ต้นแบบ (TMS Print#bill) — กล่องงวด/เครดิต/ครบกำหนด',
    'ของจริง — ใบแจ้งหนี้ออกแล้ว ยกเว้นล้วน (ต้นฉบับ, ไม่มีบรรทัด VAT)',
  ]);
  await pair('long', proto.inv, real.long, [
    'ต้นแบบ (TMS Print#inv)',
    'ของจริง — หลายหน้า หน้า 1 (ค.ศ., สำเนา) — หัวย่อ "(ต่อ)" ในหน้าถัดไป',
  ]);
  await b.close();
  srv.close();
}

void main();
