import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { afterAll, describe, expect, it } from 'vitest';
import {
  sampleInvoiceExempt,
  sampleInvoiceLong,
  sampleInvoiceMixed,
  sampleInvoiceSandbox,
  sampleInvoiceWithLogo,
  SAMPLE_LOGO_DATA_URI,
} from '../src/modules/invoices/invoice.sample';
import { sanitizeSvg } from '../src/modules/documents/svg-sanitize';
import {
  NON_VAT_ISSUER_WARNING,
  invoiceDocument,
  invoiceTotalRows,
} from '../src/modules/invoices/invoice.template';
import { SANDBOX_WATERMARK, branchText, dateRangeShort } from '../src/pdf/finance-document';
import { PdfRenderer } from '../src/pdf/pdf-renderer';

/**
 * ST5-T08 PDF ใบแจ้งหนี้ (D-54 บัญชีเบา — ใบแจ้งหนี้ ไม่ใช่ใบกำกับภาษี) — golden 3 แบบ: ยกเว้นล้วน / ปน / หลายหน้า
 * ภาพหน้าเอกสาร (fullPage) render ด้วย Chromium + Sarabun ชุดเดียวกับ PDF — แยก OS (test/golden/README.md)
 * อัปเดต: UPDATE_GOLDEN=1 pnpm --filter @tms/api exec vitest run test/invoice-pdf.test.ts แล้วเปิดภาพตรวจด้วยตาก่อน commit
 */
const golden = (name: string) =>
  join(__dirname, `golden/invoice-${name}-th.${process.platform}.png`);

function matchGolden(file: string, shot: Buffer) {
  if (process.env.UPDATE_GOLDEN === '1' || !existsSync(file)) {
    writeFileSync(file, shot);
    if (process.env.UPDATE_GOLDEN !== '1')
      throw new Error(`created golden ${file} — inspect it, then re-run`);
    return;
  }
  const a = PNG.sync.read(readFileSync(file));
  const b = PNG.sync.read(shot);
  expect([b.width, b.height]).toEqual([a.width, a.height]);
  const diff = pixelmatch(a.data, b.data, undefined, a.width, a.height, { threshold: 0.1 });
  expect(diff / (a.width * a.height)).toBeLessThan(0.001);
}
const pageCount = (pdf: Buffer) =>
  (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;

interface PageInfo {
  n: number;
  text: string;
  foot: string[];
  cont: string[];
  rows: number[];
  over: boolean;
  sigBottom: number;
}
const INFO = `(() => {
  const pages = [...document.querySelectorAll('section.page')];
  const last = pages[pages.length - 1];
  const sig = last.querySelector('.sig');
  return {
    n: pages.length,
    text: document.body.innerText,
    foot: pages.map((p) => p.querySelector('.foot').textContent),
    cont: pages.slice(1).map((p) => p.querySelector('.cont')?.textContent ?? ''),
    rows: pages.map((p) => p.querySelectorAll('tbody tr').length),
    over: pages.some((p) => p.scrollHeight > p.clientHeight + 1),
    sigBottom: sig ? last.getBoundingClientRect().bottom - sig.getBoundingClientRect().bottom : -1,
  };
})()`;

describe('ใบแจ้งหนี้ PDF (ST5-T08)', () => {
  const r = new PdfRenderer();
  afterAll(() => r.onModuleDestroy());
  const info = (doc: ReturnType<typeof invoiceDocument>) =>
    r.withPage(doc, (page) => page.evaluate(INFO) as Promise<PageInfo>);

  it('ยกเว้นล้วน (ออกแล้ว · พ.ศ.): หัวผู้ออก/ลูกค้า + สาขา, เส้นรวมไม่มีบรรทัด VAT, WHT ที่คาดว่าจะถูกหัก, ครบกำหนด · golden', async () => {
    const m = sampleInvoiceExempt();
    const doc = invoiceDocument(m);
    const pdf = await r.pdf(doc);
    const raw = pdf.toString('latin1');
    expect(raw).toMatch(/FontName\s*\/[A-Z]{6}\+Sarabun/);
    expect(raw).toMatch(/MediaBox\s*\[\s*0 0 59[45]\.\d+ 84[12]\.\d+/);
    expect(pageCount(pdf)).toBe(1);
    const i = await info(doc);
    expect(i.n).toBe(1);
    expect(i.text).not.toContain('ใบกำกับภาษี');
    expect(i.text).toContain('ใบแจ้งหนี้');
    expect(i.text).toContain('INVOICE');
    expect(i.text).toContain('INV-2611-0013');
    expect(i.text).toContain('ต้นฉบับ / Original');
    expect(i.text).toContain('บริษัท ศรีไทยขนส่ง จำกัด (สำนักงานใหญ่)');
    expect(i.text).toContain('บริษัท สยามพลาสติก จำกัด (สำนักงานใหญ่)');
    expect(i.text).toContain('เลขประจำตัวผู้เสียภาษี 0105556078912');
    expect(i.text).toContain('วันที่ 3 พ.ย. 2569');
    expect(i.text).toMatch(/ครบกำหนด\s*3 ธ.ค. 2569/);
    expect(i.text).toMatch(/งวด\s*16 ต.ค. – 3 พ.ย. 2569/);
    expect(i.text).toMatch(/เลขที่ PO\s*—/);
    expect(i.text).toContain('DO-2611-00026 · 71-5678 กทม.');
    expect(invoiceTotalRows(m).map((t) => [t.label, t.value])).toEqual([
      ['รวมค่าขนส่ง (ยกเว้น VAT) / Freight (VAT exempt)', '24,300.00'],
      ['รวมทั้งสิ้น / Grand total', '24,300.00'],
      ['หัก ณ ที่จ่าย 1%*', '243.00'],
      ['ยอดชำระสุทธิ*', '24,057.00'],
    ]);
    expect(i.text).not.toContain('VAT 7%');
    expect(i.text).toContain('สองหมื่นสี่พันสามร้อยบาทถ้วน');
    expect(i.text).toContain('ยอดประมาณการ');
    expect(i.foot).toEqual(['INV-2611-0013 · หน้า 1/1']);
    expect(i.over).toBe(false);
    expect(i.sigBottom).toBeGreaterThanOrEqual(40); // ลายเซ็นชิดล่าง (ต้นแบบ margin-top:auto) ไม่ทับท้ายหน้า
    expect(i.sigBottom).toBeLessThan(80);
    matchGolden(
      golden('exempt'),
      await r.withPage(doc, (p) => p.screenshot({ fullPage: true, type: 'png' })),
    );
  }, 90_000);

  it('ปน ยกเว้น + 7% (ร่าง): ลายน้ำ "ร่าง" ไม่มีเลข · ลูกค้า "สาขาที่ 00001" · PO · ส่วนลด · ยอดตรงต้นแบบ #inv · golden', async () => {
    const m = sampleInvoiceMixed();
    const doc = invoiceDocument(m);
    const i = await info(doc);
    expect(i.n).toBe(1);
    expect(i.text).not.toContain('ใบกำกับภาษี');
    expect(i.text).toContain('ร่าง · ยังไม่มีเลขที่');
    expect(i.text).not.toContain('ต้นฉบับ');
    expect(i.text).toContain('บริษัท เอ็นเอสเอฟ อินดัสทรี จำกัด (สาขาที่ 00001)');
    expect(i.text).toMatch(/เลขที่ PO\s*PO-NSF-26-0458/);
    expect(i.text).toMatch(/งวด\s*16–31 ต.ค. 2569/);
    expect(i.text).toContain('ส่วนลด 400.00');
    expect(i.foot).toEqual(['ร่าง · หน้า 1/1']);
    expect(invoiceTotalRows(m).map((t) => [t.label, t.value])).toEqual([
      ['รวมค่าขนส่ง (ยกเว้น VAT) / Freight (VAT exempt)', '57,600.00'],
      ['ฐาน VAT 7% / Taxable amount', '2,000.00'],
      ['ภาษีมูลค่าเพิ่ม 7%* / VAT 7%*', '140.00'],
      ['รวมทั้งสิ้น / Grand total', '59,740.00'],
      ['หัก ณ ที่จ่าย 1%*', '596.00'],
      ['ยอดชำระสุทธิ*', '59,144.00'],
    ]);
    expect(i.text).toContain('ห้าหมื่นเก้าพันเจ็ดร้อยสี่สิบบาทถ้วน');
    expect(i.text).toContain('โอนเข้าบัญชีบริษัทตามที่แจ้งไว้');
    const wm = await r.withPage(
      doc,
      (p) => p.evaluate(`document.querySelectorAll('section.page .wm').length`) as Promise<number>,
    );
    expect(wm).toBe(1);
    expect(i.over).toBe(false);
    matchGolden(
      golden('mixed'),
      await r.withPage(doc, (p) => p.screenshot({ fullPage: true, type: 'png' })),
    );
  }, 90_000);

  it('หลายหน้า (ค.ศ. · สำเนา · WHT 1% + 3%): หัวย่อ "(ต่อ)" + หัวตารางซ้ำ, "หน้า x/y", เส้นรวม/ลายเซ็นหน้าสุดท้าย · golden', async () => {
    const m = sampleInvoiceLong();
    const doc = invoiceDocument(m);
    const i = await info(doc);
    expect(i.n).toBeGreaterThanOrEqual(2);
    expect(i.text).not.toContain('ใบกำกับภาษี');
    expect(i.text).toContain('สำเนา / Copy');
    expect(i.text).toContain('วันที่ 30 พ.ย. 2026');
    expect(i.text).toMatch(/ครบกำหนด\s*30 ธ.ค. 2026/);
    expect(i.foot).toEqual(
      Array.from({ length: i.n }, (_, k) => `INV-2611-0027 · หน้า ${k + 1}/${i.n}`),
    );
    for (const c of i.cont) expect(c).toContain('ใบแจ้งหนี้ INV-2611-0027 (ต่อ)');
    expect(i.rows.reduce((a, b) => a + b, 0)).toBe(36);
    expect(i.rows[0]).toBeGreaterThan(0);
    expect(i.over).toBe(false);
    const rows = invoiceTotalRows(m).map((t) => t.label);
    expect(rows).toContain('หัก ณ ที่จ่าย 1%*');
    expect(rows).toContain('หัก ณ ที่จ่าย 3%*');
    const pdf = await r.pdf(doc);
    expect(pageCount(pdf)).toBe(i.n);
    matchGolden(
      golden('long'),
      await r.withPage(doc, (p) => p.screenshot({ fullPage: true, type: 'png' })),
    );
  }, 90_000);

  it('D-61 sandbox: เลข TEST- + ลายน้ำ "ตัวอย่าง — ใช้ไม่ได้จริง" ทุกหน้า (บรรทัดเดียว อยู่ในหน้า) · ใบ live/ร่าง ไม่มีลายน้ำนี้', async () => {
    const doc = invoiceDocument(sampleInvoiceSandbox());
    const i = await info(doc);
    expect(i.n).toBeGreaterThanOrEqual(2);
    expect(i.foot[0]).toBe(`TEST-INV-00000-2611-0001 · หน้า 1/${i.n}`);
    expect(i.text).toContain('ต้นฉบับ / Original');
    expect(i.text).not.toContain('ใบกำกับภาษี');
    expect(i.over).toBe(false);
    const WM = `(() => [...document.querySelectorAll('section.page')].map((p) => {
      const w = p.querySelector('.wm'); if (!w) return null;
      const pr = p.getBoundingClientRect(), r = w.getBoundingClientRect();
      return { text: w.textContent, h: w.scrollHeight, inside: r.left >= pr.left - 1 && r.right <= pr.right + 1 };
    }))()`;
    const wm = (await r.withPage(doc, (p) => p.evaluate(WM))) as ({
      text: string;
      h: number;
      inside: boolean;
    } | null)[];
    expect(wm).toHaveLength(i.n);
    for (const w of wm) {
      expect(w?.text).toBe(SANDBOX_WATERMARK);
      expect(w!.inside).toBe(true);
      expect(w!.h).toBeLessThan(110); // ไม่ตัดขึ้นบรรทัดใหม่ (52px × line-height 1.6 ≈ 83)
    }
    // ใบ live (ออกแล้ว) ไม่มีลายน้ำ · ร่างยังเป็น "ร่าง"
    for (const [m, want] of [
      [sampleInvoiceExempt(), []],
      [sampleInvoiceMixed(), ['ร่าง']],
      [{ ...sampleInvoiceMixed(), sandbox: true }, ['ร่าง']],
    ] as const) {
      const got = (await r.withPage(invoiceDocument(m), (p) =>
        p.evaluate(`[...document.querySelectorAll('section.page .wm')].map((w) => w.textContent)`),
      )) as string[];
      expect(got).toEqual(want);
    }
    if (process.env.D61_SHOT)
      writeFileSync(
        process.env.D61_SHOT,
        await r.withPage(doc, (p) => p.screenshot({ fullPage: true, type: 'png' })),
      );
  }, 90_000);

  it('ผู้ออกไม่จด VAT → "รวมทั้งสิ้น" อย่างเดียว (BIL-190) · escape ข้อความผู้ใช้ · สาขา/ช่วงวันที่', () => {
    const m = sampleInvoiceExempt();
    m.issuer = { ...m.issuer, vatRegistered: false };
    expect(invoiceTotalRows(m).map((t) => t.label)).toEqual([
      'รวมทั้งสิ้น / Grand total',
      'หัก ณ ที่จ่าย 1%*',
      'ยอดชำระสุทธิ*',
    ]);
    m.lines[0]!.description = '<script>alert(1)</script>';
    m.note = '<b>x</b>';
    const { body } = invoiceDocument(m);
    expect(body).not.toContain('<script>alert');
    expect(body).toContain('&lt;script&gt;');
    expect(body).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(branchText('00000')).toBe('สำนักงานใหญ่');
    expect(branchText('00001')).toBe('สาขาที่ 00001');
    expect(branchText(null)).toBe('');
    expect(dateRangeShort('2026-12-20', '2027-01-05', 'BE')).toBe('20 ธ.ค. 2569 – 5 ม.ค. 2570');
    expect(dateRangeShort('2026-11-03', '2026-11-03', 'CE')).toBe('3 พ.ย. 2026');
  });

  it('review M1: บรรทัดเดียวมี DO 400 ใบ → แยกเป็นแถว "(ต่อ)" ข้ามหน้า ไม่มีหน้ายืด · จำนวนหน้า PDF = "หน้า x/y"', async () => {
    const m = sampleInvoiceLong();
    m.lines[3]!.deliveryOrders = Array.from({ length: 400 }, (_, k) => ({
      doNo: `DO-2611-${String(1000 + k).padStart(5, '0')}`,
      plate: '70-1234 กทม.',
    }));
    const doc = invoiceDocument(m);
    const i = await info(doc);
    const grow = await r.withPage(
      doc,
      (p) => p.evaluate(`document.querySelectorAll('section.page.grow').length`) as Promise<number>,
    );
    expect(grow).toBe(0);
    expect(i.over).toBe(false);
    expect(i.n).toBeGreaterThanOrEqual(4);
    expect(i.foot).toEqual(
      Array.from({ length: i.n }, (_, k) => `INV-2611-0027 · หน้า ${k + 1}/${i.n}`),
    );
    for (const c of i.cont) expect(c).toContain('(ต่อ)');
    // DO ครบ 400 ใบ ไม่ซ้ำ ไม่ตก · ยอดเงินของบรรทัดพิมพ์ครั้งเดียว
    const dos = (i.text.match(/DO-2611-01\d{3}/g) ?? []).length;
    expect(dos).toBe(400);
    expect(i.text).toContain('(ต่อ)');
    const pdf = await r.pdf(doc);
    expect(pageCount(pdf)).toBe(i.n);
  }, 120_000);

  it('review M2: ผู้ออกไม่จด VAT แต่มีบรรทัด 7% → แสดงเส้น VAT (ไม่ซ่อนส่วนต่าง) + คำเตือนบนร่าง · ยอดกระทบกันได้', async () => {
    const m = sampleInvoiceMixed();
    m.issuer = { ...m.issuer, vatRegistered: false };
    const rows = invoiceTotalRows(m);
    const val = (l: string) => rows.find((t) => t.label.startsWith(l))!.value;
    const n = (v: string) => Number(v.replace(/,/g, ''));
    expect(n(val('รวมค่าขนส่ง')) + n(val('ฐาน VAT 7%')) + n(val('ภาษีมูลค่าเพิ่ม'))).toBe(
      n(val('รวมทั้งสิ้น')),
    );
    const items = m.lines.reduce((a, l) => a + Number(l.amount), 0);
    expect(items + n(val('ภาษีมูลค่าเพิ่ม'))).toBe(n(val('รวมทั้งสิ้น')));
    const i = await info(invoiceDocument(m));
    expect(i.text).toContain(NON_VAT_ISSUER_WARNING);
    expect(i.text).toContain('ภาษีมูลค่าเพิ่ม 7%*');
    // ใบออกแล้วไม่มีคำเตือน (ST5-T09 บล็อกก่อนออก)
    expect(invoiceDocument({ ...m, invoiceNo: 'INV-1', copy: 'ORIGINAL' }).body).not.toContain(
      NON_VAT_ISSUER_WARNING,
    );
    // ไม่จด VAT + ยกเว้นล้วน → รวมทั้งสิ้นอย่างเดียว (BIL-190) ไม่มีคำเตือน
    const ex = sampleInvoiceExempt();
    ex.issuer = { ...ex.issuer, vatRegistered: false };
    expect(invoiceDocument({ ...ex, invoiceNo: null }).body).not.toContain(NON_VAT_ISSUER_WARNING);
  }, 60_000);

  it('review L1: ข้อความยาวไม่มีช่องว่าง (ที่อยู่ 300 ตัว / รายการ 120 ตัว) ตัดบรรทัด ไม่ล้นหน้า ไม่ทับคอลัมน์เงิน', async () => {
    const m = sampleInvoiceMixed();
    m.customer = { ...m.customer, address: 'ก'.repeat(150) + 'A'.repeat(150) };
    m.lines[0]!.description = 'X'.repeat(120);
    const doc = invoiceDocument(m);
    const g = await r.withPage(
      doc,
      (p) =>
        p.evaluate(`(() => {
      const pg = document.querySelector('section.page').getBoundingClientRect();
      const boxes = [...document.querySelectorAll('.head > div:last-child > div')].map((b) => b.getBoundingClientRect());
      const row = document.querySelector('tbody tr');
      const desc = row.cells[1].querySelector('.desc').getBoundingClientRect();
      const amt = row.cells[5].getBoundingClientRect();
      const rightMax = Math.max(...[...document.querySelectorAll('section.page .in *')].map((e) => e.getBoundingClientRect().right));
      return { pgRight: pg.right, boxRight: boxes[1].right, descRight: desc.right, amtLeft: amt.left, rightMax };
    })()`) as Promise<{
          pgRight: number;
          boxRight: number;
          descRight: number;
          amtLeft: number;
          rightMax: number;
        }>,
    );
    expect(g.boxRight).toBeLessThanOrEqual(g.pgRight - 40);
    expect(g.descRight).toBeLessThanOrEqual(g.amtLeft);
    expect(g.rightMax).toBeLessThanOrEqual(g.pgRight);
    const i = await info(doc);
    expect(i.over).toBe(false);
  }, 60_000);

  it('P1-ST6-T04 โลโก้องค์กร: รูปแทนกล่องตัวย่อ 44 px ที่หัวเอกสาร (ตำแหน่ง/ขนาดเดิม) · ไม่มีโลโก้ = HTML เดิม (PDF ที่ออกแล้ว hash ไม่เปลี่ยน — ST9-T15) · golden', async () => {
    const base = sampleInvoiceExempt();
    // ไม่มีโลโก้ / null = HTML เดียวกันทุกไบต์ (ใบที่ออกก่อนมีโลโก้ render ซ้ำได้ผลเดิม)
    expect(invoiceDocument({ ...base, logo: null }).body).toBe(invoiceDocument(base).body);
    expect(invoiceDocument(base).body).not.toContain('class="logo"');
    // โลโก้ตัวอย่างผ่านตัวล้าง SVG แล้วเหมือนเดิม
    expect(
      sanitizeSvg(Buffer.from(SAMPLE_LOGO_DATA_URI.split(',')[1]!, 'base64').toString('utf8')),
    ).not.toBeNull();
    const m = sampleInvoiceWithLogo();
    const doc = invoiceDocument(m);
    expect(doc.body).toContain(`<img src="${SAMPLE_LOGO_DATA_URI}"`);
    // ค่าโลโก้ที่ไม่ใช่ data URI ของ PNG/SVG = ไม่ฝัง (กันอ้างของภายนอก) → กล่องตัวย่อ
    const bad = invoiceDocument({ ...base, logo: 'https://evil.example/logo.png' }).body;
    expect(bad).not.toContain('evil.example');
    expect(bad).toBe(invoiceDocument(base).body);
    const box = await r.withPage(doc, (page) =>
      page.evaluate(`(() => {
        const img = document.querySelector('.head .logo img');
        const r = img.getBoundingClientRect();
        return { w: r.width, h: r.height, loaded: img.complete && img.naturalWidth > 0 };
      })()`),
    );
    expect(box).toMatchObject({ loaded: true });
    expect((box as { w: number }).w).toBeLessThanOrEqual(44);
    const pdf = await r.pdf(doc);
    expect(pageCount(pdf)).toBe(1);
    matchGolden(
      golden('logo'),
      await r.withPage(doc, (p) => p.screenshot({ fullPage: true, type: 'png' })),
    );
  }, 90_000);
});
