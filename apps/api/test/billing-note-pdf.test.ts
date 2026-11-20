import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { afterAll, describe, expect, it } from 'vitest';
import {
  sampleBillingNote,
  sampleBillingNoteLong,
} from '../src/modules/billing-notes/billing-note.sample';
import {
  billingNoteDocument,
  billingNoteTotalRows,
} from '../src/modules/billing-notes/billing-note.template';
import { PdfRenderer } from '../src/pdf/pdf-renderer';

/**
 * ST5-T11 PDF ใบวางบิล — แม่แบบกลางเดียวกับใบแจ้งหนี้ (`pdf/finance-document.ts`) ตามต้นแบบ TMS Print #bill
 * golden 2 แบบ: ออกแล้ว 3 ใบแจ้งหนี้ (พ.ศ.) / ร่างหลายหน้า 40 ใบ (ค.ศ.) — แยก OS (test/golden/README.md)
 * อัปเดต: UPDATE_GOLDEN=1 pnpm --filter @tms/api exec vitest run test/billing-note-pdf.test.ts แล้วเปิดภาพตรวจด้วยตาก่อน commit
 */
const golden = (name: string) =>
  join(__dirname, `golden/billing-note-${name}-th.${process.platform}.png`);

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
}
const INFO = `(() => {
  const pages = [...document.querySelectorAll('section.page')];
  return {
    n: pages.length,
    text: document.body.innerText,
    foot: pages.map((p) => p.querySelector('.foot').textContent),
    cont: pages.slice(1).map((p) => p.querySelector('.cont')?.textContent ?? ''),
    rows: pages.map((p) => p.querySelectorAll('tbody tr').length),
    over: pages.some((p) => p.scrollHeight > p.clientHeight + 1),
  };
})()`;

describe('ใบวางบิล PDF (ST5-T11)', () => {
  const r = new PdfRenderer();
  afterAll(() => r.onModuleDestroy());
  const info = (doc: ReturnType<typeof billingNoteDocument>) =>
    r.withPage(doc, (page) => page.evaluate(INFO) as Promise<PageInfo>);

  it('ออกแล้ว 3 ใบแจ้งหนี้ (พ.ศ.): หัว "ใบวางบิล / BILLING NOTE", ตารางใบแจ้งหนี้, ยอดรวม = Σ, นัดรับเช็ค, ลายเซ็นผู้วางบิล/ผู้รับวางบิล · golden', async () => {
    const m = sampleBillingNote();
    const doc = billingNoteDocument(m);
    const pdf = await r.pdf(doc);
    const raw = pdf.toString('latin1');
    expect(raw).toMatch(/FontName\s*\/[A-Z]{6}\+Sarabun/);
    expect(pageCount(pdf)).toBe(1);
    const i = await info(doc);
    expect(i.n).toBe(1);
    expect(i.text).toContain('ใบวางบิล');
    expect(i.text).toContain('BILLING NOTE');
    expect(i.text).not.toContain('ใบกำกับภาษี');
    expect(i.text).toContain('BN-2611-0013');
    expect(i.text).toContain('ต้นฉบับ / Original');
    expect(i.text).toContain('บริษัท ศรีไทยขนส่ง จำกัด (สำนักงานใหญ่)');
    expect(i.text).toContain('บริษัท สยามพลาสติก จำกัด (สำนักงานใหญ่)');
    expect(i.text).toContain('วันที่ 3 พ.ย. 2569');
    expect(i.text).toMatch(/ใบแจ้งหนี้\s*3 ใบ/);
    expect(i.text).toMatch(/งวด\s*16 ต.ค. – 1 พ.ย. 2569/);
    expect(i.text).toMatch(/นัดรับเช็ค\s*3 ธ.ค. 2569/);
    expect(i.text).toContain('INV-00000-2610-0047');
    expect(i.text).toContain('12,194.50');
    expect(i.rows).toEqual([3]);
    // ยอดรวม = Σ ยอดค้างของ 3 ใบ (7,000.00 + 12,194.50 + 6,550.00)
    expect(billingNoteTotalRows(m).map((t) => [t.label, t.value])).toEqual([
      ['รวมทั้งสิ้น / Grand total', '25,744.50'],
      ['หัก ณ ที่จ่าย*', '256.50'],
      ['ยอดชำระสุทธิ*', '25,488.00'],
    ]);
    expect(i.text).toContain('สองหมื่นห้าพันเจ็ดร้อยสี่สิบสี่บาทห้าสิบสตางค์');
    expect(i.text).not.toContain('VAT');
    expect(i.text).toContain('นัดรับเช็ค / โอนเงิน ภายในวันที่ 3 ธ.ค. 2569');
    expect(i.text).toContain('ผู้วางบิล / Biller');
    expect(i.text).toContain('ผู้รับวางบิล / Received by');
    expect(i.foot).toEqual(['BN-2611-0013 · หน้า 1/1']);
    expect(i.over).toBe(false);
    matchGolden(
      golden('issued'),
      await r.withPage(doc, (p) => p.screenshot({ fullPage: true, type: 'png' })),
    );
  }, 90_000);

  it('ร่างหลายหน้า 40 ใบ (ค.ศ.): ลายน้ำ "ร่าง" ไม่มีเลข, หัวย่อ (ต่อ) + หัวตารางซ้ำ, หน้า x/y, ไม่มีเส้น WHT เมื่อเป็น 0 · golden', async () => {
    const m = sampleBillingNoteLong();
    const doc = billingNoteDocument(m);
    const i = await info(doc);
    expect(i.n).toBeGreaterThan(1);
    expect(i.text).toContain('ร่าง · ยังไม่มีเลขที่');
    expect(i.text).not.toContain('ต้นฉบับ');
    expect(i.text).toContain('2026');
    expect(i.rows.reduce((a, b) => a + b, 0)).toBe(40);
    expect(i.foot).toEqual(Array.from({ length: i.n }, (_, k) => `ร่าง · หน้า ${k + 1}/${i.n}`));
    for (const c of i.cont) expect(c).toContain('ใบวางบิล ร่าง (ต่อ)');
    expect(billingNoteTotalRows(m).map((t) => t.label)).toEqual(['รวมทั้งสิ้น / Grand total']);
    expect(i.text).toContain('(สาขาที่ 00001)');
    expect(i.over).toBe(false);
    matchGolden(
      golden('long'),
      await r.withPage(doc, (p) => p.screenshot({ fullPage: true, type: 'png' })),
    );
  }, 90_000);
});
