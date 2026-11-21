/**
 * ภาพเทียบ "ต้นแบบ | ของจริง" ของ ST5-T11 (PDF ใบวางบิล) — เครื่อง dev เท่านั้น
 * ต้นแบบ: TMS Print.dc.html #bill · ของจริง: ใบวางบิลตัวอย่าง (ออกแล้ว 3 ใบแจ้งหนี้ / ร่างหลายหน้า หน้า 1) — แม่แบบกลาง finance-document
 *   pnpm --filter @tms/api exec node -r @swc-node/register scripts/compare-billing-note-pdf.ts
 */
import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';
import {
  sampleBillingNote,
  sampleBillingNoteLong,
} from '../src/modules/billing-notes/billing-note.sample';
import { billingNoteDocument } from '../src/modules/billing-notes/billing-note.template';
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
  await PP.goto(`http://localhost:${port}/TMS%20Print.dc.html#bill`);
  await PP.waitForTimeout(3000);
  const proto = { bill: await PP.locator('section#bill').screenshot() };

  const r = new PdfRenderer();
  const shot = (m: Parameters<typeof billingNoteDocument>[0]) =>
    r.withPage(billingNoteDocument(m), (p) =>
      p.locator('section.page').first().screenshot({ type: 'png' }),
    );
  const real = {
    issued: await shot(sampleBillingNote()),
    long: await shot(sampleBillingNoteLong()),
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
    await M.screenshot({ path: `${out}st5-t11-pdf-${name}-1440.png`, fullPage: true });
    console.log(`wrote design/compare/st5-t11-pdf-${name}-1440.png`);
  };
  await pair('issued', proto.bill, real.issued, [
    'ต้นแบบ (TMS Print#bill) — ใบวางบิล (ตาราง DO)',
    'ของจริง — ใบวางบิลออกแล้ว 3 ใบแจ้งหนี้ (ตารางใบแจ้งหนี้ตาม docs/spec)',
  ]);
  await pair('long', proto.bill, real.long, [
    'ต้นแบบ (TMS Print#bill)',
    'ของจริง — ร่างหลายหน้า หน้า 1 (ค.ศ., สาขาที่ 00001, ลายน้ำ "ร่าง")',
  ]);
  await b.close();
  srv.close();
}

void main();
