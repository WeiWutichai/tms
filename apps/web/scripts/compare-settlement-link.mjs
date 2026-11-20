// ภาพเทียบ "ต้นแบบ | ของจริง" ของ ST6-T05 (รถร่วมตรวจใบสำคัญจ่ายผ่านลิงก์) — เครื่อง dev เท่านั้น
// หน้าลิงก์ (public) เทียบ TMS Subcon แท็บ "การเงิน" ที่ 390 + 1440 px
// ต้นแบบไม่มีหน้ารายการให้ตรวจ (มีแค่การ์ดงวด) — ชิ้นที่ใช้: การ์ดงวด/ใบสั่งงาน/เหตุผลที่ปฏิเสธ/รูปแบบส่ง POD (spec/12 §3)
// ต้องมี web dev (vite) เท่านั้น — ข้อมูลของหน้าลิงก์จำลองด้วย page.route (ข้อมูลสมมติ ชุดเดียวกับ unit test):
//   WEB=http://localhost:4723 node scripts/compare-settlement-link.mjs
import { chromium } from '@playwright/test';
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
const b = await chromium.launch();
const vis = (p, text) => p.getByText(text, { exact: true }).filter({ visible: true }).first();

const line = (o) => ({
  id: 'stln_1',
  lineNo: 1,
  lineType: 'FREIGHT',
  tripNo: 'TRP-6911-0004',
  tripDate: '2026-10-03',
  origin: 'บางปู',
  destination: 'แหลมฉบัง',
  description: 'ค่าจ้างรถร่วม',
  deductionType: null,
  reference: null,
  amount: '5600.00',
  review: null,
  ...o,
});
const VIEW = {
  company: 'ศรีไทยขนส่ง',
  carrierName: 'หจก. ศรีราชาโลจิสติกส์',
  status: 'SENT_TO_CARRIER',
  settlementNo: null,
  periodFrom: '2026-10-16',
  periodTo: '2026-10-31',
  carrierInvoiceNo: 'INV-SR-0042',
  tripCount: 3,
  grossAmount: '17412.00',
  deductionAmount: '2000.00',
  netAmount: '15412.00',
  canRespond: true,
  expiresAt: '2026-11-27T03:00:00.000Z',
  lines: [
    line({
      review: {
        response: 'ACCEPTED',
        reason: null,
        photoCount: 0,
        respondedAt: '2026-11-20T03:00:00.000Z',
      },
    }),
    line({
      id: 'stln_2',
      lineNo: 2,
      tripNo: 'TRP-6911-0007',
      origin: 'อยุธยา',
      destination: 'สระบุรี',
      amount: '4900.00',
    }),
    line({
      id: 'stln_3',
      lineNo: 3,
      tripNo: 'TRP-6911-0011',
      tripDate: '2026-10-08',
      amount: '6912.00',
    }),
    line({
      id: 'stln_4',
      lineNo: 4,
      lineType: 'DEDUCTION',
      tripNo: null,
      tripDate: null,
      origin: null,
      destination: null,
      deductionType: 'CASH_ADVANCE',
      description: 'เบิกค่าน้ำมันล่วงหน้า',
      reference: 'ADV-2610-0007',
      amount: '-2000.00',
    }),
  ],
};

async function pair(name, left, right, w, h, labels) {
  const M = await (await b.newContext({ viewport: { width: w * 2 + 60, height: h } })).newPage();
  await M.setContent(
    `<body style="margin:0;display:flex;align-items:flex-start;gap:20px;background:#333;font:16px sans-serif;color:#fff"><div><div style="padding:8px">${labels[0]}</div><img src="data:image/png;base64,${left.toString('base64')}"></div><div><div style="padding:8px">${labels[1]}</div><img src="data:image/png;base64,${right.toString('base64')}"></div></body>`,
  );
  await M.screenshot({ path: `${out}st6-settlement-link-${name}.png`, fullPage: true });
  console.log(`wrote design/compare/st6-settlement-link-${name}.png`);
}

for (const vp of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  // ต้นแบบ: แท็บ "การเงิน" (การ์ดรอรับเงิน + การ์ดงวด) / แท็บ "งาน" ฟอร์มปฏิเสธ (ชิ้นที่ใช้ทำฟอร์มโต้แย้ง)
  const P = await (await b.newContext({ viewport: vp, locale: 'th-TH' })).newPage();
  await P.goto(`http://localhost:${port}/TMS%20Subcon.dc.html`);
  await P.waitForTimeout(2500);
  await vis(P, 'การเงิน').click();
  await P.waitForTimeout(300);
  const aPay = await P.screenshot({ fullPage: true });
  await vis(P, 'งาน').click();
  await vis(P, 'ปฏิเสธ').click();
  await vis(P, 'ราคาไม่คุ้มต้นทุน').click();
  await P.waitForTimeout(300);
  const aDec = await P.screenshot({ fullPage: true });

  // ของจริง: ข้อมูลจำลองผ่าน page.route (ไม่ต้องมี API)
  const ctx = await b.newContext({
    viewport: vp,
    locale: 'th-TH',
    baseURL: WEB,
    timezoneId: 'Asia/Bangkok',
  });
  let view = structuredClone(VIEW);
  await ctx.route('**/v1/public/settlements/**', async (route) => {
    const req = route.request();
    if (req.method() === 'GET')
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(view),
      });
    const id = /lines\/([^/]+)\/review/.exec(req.url())?.[1];
    const body = req.postDataJSON();
    const l = view.lines.find((x) => x.id === id);
    l.review = {
      response: body.response,
      reason: body.reason ?? null,
      photoCount: (body.photoDocumentIds ?? []).length,
      respondedAt: new Date().toISOString(),
    };
    return route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ line: l }),
    });
  });
  const W = await ctx.newPage();
  await W.goto('/link/settlement/ml1.demo');
  await W.waitForTimeout(1500);
  const cList = await W.screenshot({ fullPage: true });
  await W.getByTestId('stl-dispute-2').click();
  await W.getByTestId('stl-why').fill('ค่ารอไม่ตรง รอ 3 ชม. ที่ท่าเรือ');
  await W.waitForTimeout(300);
  const cForm = await W.screenshot({ fullPage: true });
  await W.getByTestId('stl-dispute-ok').click();
  await W.waitForTimeout(400);
  const cDone = await W.screenshot({ fullPage: true });
  view = {
    ...structuredClone(VIEW),
    status: 'APPROVED',
    settlementNo: 'SA-2611-0013',
    canRespond: false,
  };
  await W.reload();
  await W.waitForTimeout(1200);
  const cAppr = await W.screenshot({ fullPage: true });

  const h = vp.height + 600;
  await pair(`list-${vp.width}`, aPay, cList, vp.width, h, [
    'ต้นแบบ (TMS Subcon · การเงิน)',
    'ของจริง (ใบที่ส่งให้ตรวจ)',
  ]);
  await pair(`dispute-${vp.width}`, aDec, cForm, vp.width, h, [
    'ต้นแบบ (TMS Subcon · เหตุผลที่ปฏิเสธ)',
    'ของจริง (ฟอร์มโต้แย้ง)',
  ]);
  if (vp.width === 390) {
    await pair('flagged-390', aPay, cDone, vp.width, h, [
      'ต้นแบบ (TMS Subcon · การเงิน)',
      'ของจริง (โต้แย้งแล้ว — ติดธง)',
    ]);
    await pair('approved-390', aPay, cAppr, vp.width, h, [
      'ต้นแบบ (TMS Subcon · การเงิน — อนุมัติแล้ว · รอจ่าย)',
      'ของจริง (อนุมัติแล้ว — ดูอย่างเดียว)',
    ]);
  }
}
await b.close();
srv.close();
