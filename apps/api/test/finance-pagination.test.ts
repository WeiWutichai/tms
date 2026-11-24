import { afterAll, describe, expect, it } from 'vitest';
import { sampleBillingNoteLong } from '../src/modules/billing-notes/billing-note.sample';
import { billingNoteDocument } from '../src/modules/billing-notes/billing-note.template';
import { sampleInvoiceLong } from '../src/modules/invoices/invoice.sample';
import { invoiceDocument } from '../src/modules/invoices/invoice.template';
import { sampleSettlementLong } from '../src/modules/settlements/settlement-pdf.sample';
import { settlementVoucherDocument } from '../src/modules/settlements/settlement-pdf.template';
import { PdfRenderer } from '../src/pdf/pdf-renderer';

/**
 * ตัวแบ่งหน้าเอกสารการเงิน (UAT 24 พ.ย. 2569 + review L6) — ทั้ง layout `stacked` (ใบสำคัญจ่าย) และ `side` (ใบแจ้งหนี้/ใบวางบิล):
 * ทุกจำนวนแถว (รวมช่วงที่เส้นรวม + ลายเซ็นไม่พอหน้าหลังแถวสุดท้าย) — เส้นรวมอยู่หน้าเดียวกับลายเซ็นเสมอ, หน้านั้นมีรายการ ≥ 1 แถว,
 * ไม่มีหน้าล้น, จำนวนแถวรวมครบ · และต้องเจอกรณี "ย้ายแถวสุดท้ายไปหน้าใหม่" อย่างน้อย 1 ครั้งต่อชนิดเอกสาร
 * ตรวจโครงสร้างเท่านั้น (ยอดเงินในตัวอย่างไม่ตรงกับแถวที่ตัด — layout ไม่อ่านยอด)
 */
interface Pg {
  rows: number;
  end: boolean;
  sig: boolean;
  over: boolean;
}
const PAGES = `[...document.querySelectorAll('section.page')].map((p) => ({
  rows: p.querySelectorAll('tbody tr').length,
  end: !!p.querySelector('.end'),
  sig: !!p.querySelector('.sig'),
  over: p.scrollHeight > p.clientHeight + 1,
}))`;

describe('PDF เอกสารการเงิน: เส้นรวม/ลายเซ็นไม่อยู่หน้าที่ไม่มีรายการ (review L6)', () => {
  const r = new PdfRenderer();
  afterAll(() => r.onModuleDestroy());
  const pages = (doc: { body: string; css: string; title: string }) =>
    r.withPage(doc, (p) => p.evaluate(PAGES) as Promise<Pg[]>);

  const cases: [string, (n: number) => { body: string; css: string; title: string }, number][] = [
    [
      'ใบสำคัญจ่าย (stacked)',
      (n) => {
        const m = sampleSettlementLong();
        return settlementVoucherDocument({ ...m, trips: m.trips.slice(0, n) });
      },
      16,
    ],
    [
      'ใบแจ้งหนี้ (side)',
      (n) => {
        const m = sampleInvoiceLong();
        return invoiceDocument({ ...m, lines: m.lines.slice(0, n) });
      },
      16,
    ],
    [
      'ใบวางบิล (side)',
      (n) => {
        const m = sampleBillingNoteLong();
        return billingNoteDocument({ ...m, invoices: m.invoices.slice(0, n) });
      },
      18,
    ],
  ];

  for (const [name, make, max] of cases)
    it(`${name}: 1–${max} แถว`, async () => {
      let moved = 0;
      for (let n = 1; n <= max; n++) {
        const ps = await pages(make(n));
        const at = ps.findIndex((p) => p.end);
        expect(at, `${name} n=${n}`).toBe(ps.length - 1);
        const last = ps[at]!;
        expect(last.sig, `${name} n=${n} ลายเซ็นอยู่หน้าเดียวกับเส้นรวม`).toBe(true);
        expect(ps.filter((p) => p.sig)).toHaveLength(1);
        expect(last.rows, `${name} n=${n} หน้าเส้นรวมมีรายการ`).toBeGreaterThanOrEqual(1);
        expect(
          ps.every((p) => p.rows >= 1),
          `${name} n=${n} ทุกหน้ามีรายการ`,
        ).toBe(true);
        expect(
          ps.some((p) => p.over),
          `${name} n=${n} ล้นหน้า`,
        ).toBe(false);
        // แถวที่ยาวเกินหน้าแยกเป็น "(ต่อ)" ได้ → จำนวนแถวรวม ≥ n
        expect(ps.reduce((a, p) => a + p.rows, 0)).toBeGreaterThanOrEqual(n);
        if (ps.length > 1 && last.rows === 1) moved++;
      }
      expect(moved, `${name}: ต้องเจอกรณีย้ายแถวสุดท้าย`).toBeGreaterThanOrEqual(1);
    }, 180_000);
});
