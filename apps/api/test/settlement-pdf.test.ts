import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { afterAll, describe, expect, it } from 'vitest';
import {
  sampleSettlementDraft,
  sampleSettlementLong,
  sampleSettlementPaid,
  sampleSettlementSandbox,
} from '../src/modules/settlements/settlement-pdf.sample';
import {
  WHT_ESTIMATE_NOTE,
  settlementTotalRows,
  settlementVoucherDocument,
} from '../src/modules/settlements/settlement-pdf.template';
import { invoiceDocument } from '../src/modules/invoices/invoice.template';
import { sampleInvoiceExempt } from '../src/modules/invoices/invoice.sample';
import { SANDBOX_WATERMARK } from '../src/pdf/finance-document';
import { PdfRenderer } from '../src/pdf/pdf-renderer';

/**
 * ST6-T04 PDF ใบสำคัญจ่ายรถร่วม (ไม่ใช่เอกสารภาษี · WHT ประมาณการ D-54/D-58) — golden 3 แบบ: จ่ายแล้ว (= ต้นแบบ #pv) / ร่าง 1%+3% / หลายหน้า
 * แม่แบบการเงินร่วมกับใบแจ้งหนี้ (ST5-T08) + PdfRenderer ตัวเดียว — แยก OS (test/golden/README.md)
 * อัปเดต: UPDATE_GOLDEN=1 pnpm --filter @tms/api exec vitest run test/settlement-pdf.test.ts แล้วเปิดภาพตรวจด้วยตาก่อน commit
 */
const golden = (name: string) =>
  join(__dirname, `golden/settlement-${name}-th.${process.platform}.png`);

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
  totals: string[];
  sigBottom: number;
}
const INFO = `(() => {
  const pages = [...document.querySelectorAll('section.page')];
  const last = pages[pages.length - 1];
  const sig = last.querySelector('.sig');
  const grid = last.querySelector('.end > div:first-child > div');
  return {
    n: pages.length,
    text: document.body.innerText,
    foot: pages.map((p) => p.querySelector('.foot').textContent),
    cont: pages.slice(1).map((p) => p.querySelector('.cont')?.textContent ?? ''),
    rows: pages.map((p) => p.querySelectorAll('tbody tr').length),
    over: pages.some((p) => p.scrollHeight > p.clientHeight + 1),
    totals: grid ? [...grid.children].map((c) => c.textContent) : [],
    sigBottom: sig ? last.getBoundingClientRect().bottom - sig.getBoundingClientRect().bottom : -1,
  };
})()`;

describe('ใบสำคัญจ่าย PDF (ST6-T04)', () => {
  const r = new PdfRenderer();
  afterAll(() => r.onModuleDestroy());
  const info = (doc: ReturnType<typeof settlementVoucherDocument>) =>
    r.withPage(doc, (page) => page.evaluate(INFO) as Promise<PageInfo>);

  it('จ่ายแล้ว (พ.ศ.): ยอดเท่าต้นแบบ #pv — ยอดซื้อรวม/หัก ณ ที่จ่าย 1%*/เงินเบิก/จ่ายสุทธิ · วิธีจ่าย + เลขอ้างอิง · golden', async () => {
    const m = sampleSettlementPaid();
    const doc = settlementVoucherDocument(m);
    const pdf = await r.pdf(doc);
    const raw = pdf.toString('latin1');
    expect(raw).toMatch(/FontName\s*\/[A-Z]{6}\+Sarabun/);
    expect(raw).toMatch(/MediaBox\s*\[\s*0 0 59[45]\.\d+ 84[12]\.\d+/);
    expect(pageCount(pdf)).toBe(1);
    const i = await info(doc);
    expect(i.n).toBe(1);
    expect(i.text).not.toContain('ใบกำกับภาษี');
    expect(i.text).not.toContain('50 ทวิ');
    expect(i.text).toContain('ใบสำคัญจ่าย');
    expect(i.text).toContain('PAYMENT VOUCHER');
    expect(i.text).toContain('บริษัท ศรีไทยขนส่ง จำกัด (สำนักงานใหญ่)');
    expect(i.text).toContain('เลขประจำตัวผู้เสียภาษี 0105556078912');
    expect(i.text).toContain('จ่ายให้ / Pay to');
    expect(i.text).toContain('ห้างหุ้นส่วนจำกัด ทรัพย์สมบูรณ์ขนส่ง');
    expect(i.text).toContain('เลขประจำตัวผู้เสียภาษี 0103556012345');
    expect(i.text).toContain('คนขับ ไพโรจน์ สายทอง');
    expect(i.text).toContain('วันที่ 29 ต.ค. 2569');
    expect(i.text).toMatch(/Settlement\s*SA-2610-0008/);
    expect(i.text).toMatch(/งวด\s*1–15 ต.ค. 2569/);
    expect(i.text).toMatch(/จ่ายโดย\s*โอนเงิน/);
    expect(i.text).toMatch(/เลขอ้างอิง\s*KBANK-2610-8841/);
    expect(i.text).toMatch(/TRP-2610-0300\s*4 ต.ค. 2569\s*กรุงเทพ – ชลบุรี\s*5,100.00\s*180.00/);
    expect(i.totals).toEqual([
      'ยอดซื้อรวม / Subtotal',
      '15,550.00',
      'หัก ณ ที่จ่าย 1%* / WHT 1%*',
      '−155.50',
      'หักเงินเบิกล่วงหน้า / Less advance',
      '−2,000.00',
      'จ่ายสุทธิ / Net paid',
      '13,394.50',
    ]);
    expect(i.text).toContain('หนึ่งหมื่นสามพันสามร้อยเก้าสิบสี่บาทห้าสิบสตางค์');
    expect(i.text).toContain(WHT_ESTIMATE_NOTE);
    expect(i.text).toContain('ผู้จัดทำ / Prepared by');
    expect(i.text).toContain('ผู้อนุมัติ / Approved by');
    expect(i.text).toContain('ผู้รับเงิน / Collector');
    expect(i.foot).toEqual(['SA-2610-0008 · หน้า 1/1']);
    expect(i.over).toBe(false);
    expect(i.sigBottom).toBeGreaterThanOrEqual(40);
    expect(i.sigBottom).toBeLessThan(80);
    matchGolden(
      golden('paid'),
      await r.withPage(doc, (p) => p.screenshot({ fullPage: true, type: 'png' })),
    );
  }, 90_000);

  it('ร่าง: ลายน้ำ "ร่าง" ไม่มีเลข · WHT 1% + 3% แยกบรรทัด · หักหลายชนิด · บุคคลธรรมดา (ปิดเลข) · ไม่มีคนขับ/วิธีจ่าย · golden', async () => {
    const m = sampleSettlementDraft();
    const doc = settlementVoucherDocument(m);
    const i = await info(doc);
    expect(i.n).toBe(1);
    expect(i.text).toContain('ร่าง · ยังไม่มีเลขที่');
    expect(i.text).toMatch(/Settlement\s*—/);
    expect(i.text).toMatch(/จ่ายโดย\s*—/);
    expect(i.text).toContain('เลขประจำตัวผู้เสียภาษี XXXXXXXXX4521');
    expect(i.text).not.toContain('คนขับ');
    expect(i.foot).toEqual(['ร่าง · หน้า 1/1']);
    expect(settlementTotalRows(m).map((t) => [t.label, t.value])).toEqual([
      ['ยอดซื้อรวม / Subtotal', '12,350.00'],
      ['หัก ณ ที่จ่าย 1%* / WHT 1%*', '−111.50'],
      ['หัก ณ ที่จ่าย 3%* / WHT 3%*', '−36.00'],
      ['หักเงินเบิกล่วงหน้า / Less advance', '−2,000.00'],
      ['หักค่าน้ำมัน / Less fuel', '−450.00'],
      ['หักค่าปรับ / Less fines', '−300.00'],
      ['จ่ายสุทธิ / Net paid', '9,452.50'],
    ]);
    expect(i.text).toContain('เก้าพันสี่ร้อยห้าสิบสองบาทห้าสิบสตางค์');
    const wm = await r.withPage(
      doc,
      (p) => p.evaluate(`document.querySelectorAll('section.page .wm').length`) as Promise<number>,
    );
    expect(wm).toBe(1);
    expect(i.over).toBe(false);
    matchGolden(
      golden('draft'),
      await r.withPage(doc, (p) => p.screenshot({ fullPage: true, type: 'png' })),
    );
  }, 90_000);

  it('หลายหน้า (ค.ศ. · อนุมัติแล้ว ยังไม่จ่าย · 40 เที่ยว): หัวย่อ "(ต่อ)" + หัวตารางซ้ำ, "หน้า x/y", เส้นรวม/ลายเซ็นหน้าสุดท้าย · golden', async () => {
    const m = sampleSettlementLong();
    const doc = settlementVoucherDocument(m);
    const i = await info(doc);
    expect(i.n).toBeGreaterThanOrEqual(2);
    expect(i.text).toContain('วันที่ 30 พ.ย. 2026');
    expect(i.foot).toEqual(
      Array.from({ length: i.n }, (_, k) => `SA-2611-0021 · หน้า ${k + 1}/${i.n}`),
    );
    for (const c of i.cont) expect(c).toContain('ใบสำคัญจ่าย SA-2611-0021 (ต่อ)');
    expect(i.rows.reduce((a, b) => a + b, 0)).toBe(40);
    expect(i.over).toBe(false);
    expect(i.totals).toContain('186,585.00');
    expect(i.totals).toContain('หักค่าเสียหาย / Less damages');
    const pdf = await r.pdf(doc);
    expect(pageCount(pdf)).toBe(i.n);
    matchGolden(
      golden('long'),
      await r.withPage(doc, (p) => p.screenshot({ fullPage: true, type: 'png' })),
    );
  }, 90_000);

  it('UAT 24 พ.ย. + review L6: 6 เที่ยว — เส้นรวม+ลายเซ็นไม่พอหน้าแรก → ย้ายเที่ยวสุดท้ายไปหน้า 2 พร้อมเส้นรวม/ลายเซ็น (ไม่มีหน้าที่มีแต่ยอด)', async () => {
    const m = sampleSettlementPaid();
    m.trips = Array.from({ length: 6 }, (_, k) => ({
      ...m.trips[k % 3]!,
      tripNo: `TRP-2610-03${String(k).padStart(2, '0')}`,
    }));
    const doc = settlementVoucherDocument(m);
    const pages = (await r.withPage(doc, (p) =>
      p.evaluate(`[...document.querySelectorAll('section.page')].map((pg) => ({
        rows: pg.querySelectorAll('tbody tr').length,
        end: !!pg.querySelector('.end'),
        sig: !!pg.querySelector('.sig'),
        text: pg.innerText,
        over: pg.scrollHeight > pg.clientHeight + 1,
      }))`),
    )) as { rows: number; end: boolean; sig: boolean; text: string; over: boolean }[];
    expect(pages.map((x) => [x.rows, x.end, x.sig])).toEqual([
      [5, false, false],
      [1, true, true],
    ]);
    expect(pages[0]!.text).not.toContain('13,394.50');
    expect(pages[1]!.text).toContain('ใบสำคัญจ่าย SA-2610-0008 (ต่อ)');
    expect(pages[1]!.text).toContain('TRP-2610-0305');
    expect(pages[1]!.text).toContain('13,394.50');
    expect(pages[1]!.text).toContain('หนึ่งหมื่นสามพันสามร้อยเก้าสิบสี่บาทห้าสิบสตางค์');
    expect(pages[1]!.text).toContain('ผู้รับเงิน / Collector');
    expect(pages.every((x) => !x.over)).toBe(true);
  }, 90_000);

  it('sandbox (ตามแนว D-61): ลายน้ำ "ตัวอย่าง — ใช้ไม่ได้จริง" ทุกหน้า (data-wm-kind sample) · live ไม่มีลายน้ำ · ร่างใน sandbox ยังเป็น "ร่าง"', async () => {
    const wms = async (m: ReturnType<typeof sampleSettlementPaid>) =>
      (await r.withPage(settlementVoucherDocument(m), (p) =>
        p.evaluate(`[...document.querySelectorAll('section.page .wm')].map((w) => w.textContent)`),
      )) as string[];
    const sb = settlementVoucherDocument(sampleSettlementSandbox());
    expect(sb.body).toContain(`data-wm="${SANDBOX_WATERMARK}"`);
    expect(sb.body).toContain('data-wm-kind="sample"');
    expect(await wms(sampleSettlementSandbox())).toEqual([SANDBOX_WATERMARK]);
    const i = await info(sb);
    expect(i.foot).toEqual(['TEST-SA-2610-0008 · หน้า 1/1']);
    expect(i.over).toBe(false);
    // live: ไม่มี data-wm เลย (ผลพิมพ์เดิม — golden 3 แบบข้างบนยังผ่าน)
    for (const m of [sampleSettlementPaid(), sampleSettlementLong()]) {
      expect(settlementVoucherDocument(m).body).not.toContain('data-wm=');
      expect(await wms(m)).toEqual([]);
    }
    // หลายหน้า: ทุกหน้า
    const long = { ...sampleSettlementLong(), settlementNo: 'TEST-SA-2611-0021', sandbox: true };
    const li = await info(settlementVoucherDocument(long));
    expect(li.n).toBeGreaterThanOrEqual(2);
    expect(await wms(long)).toEqual(Array.from({ length: li.n }, () => SANDBOX_WATERMARK));
    expect(li.over).toBe(false);
    // ร่างใน sandbox: ลายน้ำ "ร่าง" ตามเดิม (ค่า watermark ไม่มีผลเมื่อยังไม่มีเลข)
    const draft = { ...sampleSettlementDraft(), sandbox: true };
    expect(await wms(draft)).toEqual(await wms(sampleSettlementDraft()));
  }, 90_000);

  it('ไม่มี WHT (ต่ำกว่าขั้นต่ำ) → ไม่มีบรรทัดหัก ณ ที่จ่าย/หมายเหตุประมาณการ · ยอดแยกอัตราไม่ตรงยอดรวม → บรรทัดเดียว · escape', () => {
    const m = sampleSettlementPaid();
    const none = { ...m, whtByRate: [], whtTotal: '0.00', net: '13550.00' };
    expect(settlementTotalRows(none).map((t) => t.label)).toEqual([
      'ยอดซื้อรวม / Subtotal',
      'หักเงินเบิกล่วงหน้า / Less advance',
      'จ่ายสุทธิ / Net paid',
    ]);
    expect(settlementVoucherDocument(none).body).not.toContain('ประมาณการ');
    const odd = { ...m, whtByRate: [{ rate: '1.00', amount: '100.00' }] };
    expect(settlementTotalRows(odd)[1]).toEqual({
      label: 'หัก ณ ที่จ่าย* / WHT*',
      value: '−155.50',
    });
    const x = sampleSettlementPaid();
    x.trips[0]!.route = '<script>alert(1)</script>';
    x.payee.name = '<b>x</b>';
    const { body } = settlementVoucherDocument(x);
    expect(body).not.toContain('<script>alert');
    expect(body).toContain('&lt;script&gt;');
    expect(body).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('แม่แบบร่วม: ใบแจ้งหนี้ยังใช้ส่วนท้ายแบบเดิม (ป้าย "ลูกค้า", เส้นรวม 300 px, ลายเซ็นห่าง 40 px)', () => {
    const { body } = invoiceDocument(sampleInvoiceExempt());
    expect(body).toContain('ลูกค้า / Customer');
    expect(body).toContain('width:300px');
    expect(body).toContain('gap:40px;padding-top:28px');
    const pv = settlementVoucherDocument(sampleSettlementPaid()).body;
    expect(pv).toContain('width:320px');
    expect(pv).toContain('gap:24px;padding-top:28px');
    expect(pv).not.toContain('ลูกค้า / Customer');
  });
});
