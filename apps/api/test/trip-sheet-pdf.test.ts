import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { afterAll, describe, expect, it } from 'vitest';
import { docDateShort } from '../src/common/thai-date';
import { sampleTripSheet } from '../src/modules/trip-sheets/trip-sheet.sample';
import { companyInitials, tripSheetDocument } from '../src/modules/trip-sheets/trip-sheet.template';
import { PdfRenderer } from '../src/pdf/pdf-renderer';

/**
 * ST3-T20 golden ของใบคุมรถ A4 (แบบเดียวกับ PDF engine ST0-T17 — test/pdf.test.ts):
 * ภาพหน้าเอกสารที่ render ด้วย Chromium + Sarabun ชุดเดียวกับ PDF → สระ/วรรณยุกต์ไม่ลอย, layout ตามต้นแบบ TMS Print#trip
 * golden แยก OS (anti-aliasing ต่างกัน) — Linux = image playwright v1.65.0-noble amd64 (ขั้นตอนใน test/golden/README.md)
 * อัปเดต: UPDATE_GOLDEN=1 pnpm --filter @tms/api exec vitest run test/trip-sheet-pdf.test.ts แล้วเปิดภาพตรวจด้วยตาก่อน commit
 */
const GOLDEN = join(__dirname, `golden/trip-sheet-th.${process.platform}.png`);

describe('ใบคุมรถ PDF (ST3-T20)', () => {
  const r = new PdfRenderer();
  afterAll(() => r.onModuleDestroy());

  it('PDF A4 1 หน้า/เที่ยว ฝัง Sarabun · ใบรายวัน 2 เที่ยว = 2 หน้า', async () => {
    const d = sampleTripSheet();
    const pdf = await r.pdf(tripSheetDocument(d));
    const raw = pdf.toString('latin1');
    expect(raw).toMatch(/FontName\s*\/[A-Z]{6}\+Sarabun/);
    expect(raw).toMatch(/MediaBox\s*\[\s*0 0 59[45]\.\d+ 84[12]\.\d+/);
    expect(raw.match(/\/Type\s*\/Page[^s]/g)).toHaveLength(1);
    const two = await r.pdf(
      tripSheetDocument({
        ...d,
        pages: [d.pages[0]!, { ...d.pages[0]!, tripNo: 'TRP-2611-0042' }],
      }),
    );
    expect(two.toString('latin1').match(/\/Type\s*\/Page[^s]/g)).toHaveLength(2);
  }, 60_000);

  it('ภาพหน้าเอกสารตรง golden (ภาษาไทยถูกต้อง สระ/วรรณยุกต์ไม่ลอย)', async () => {
    const shot = await r.withPage(tripSheetDocument(sampleTripSheet()), (page) =>
      page.screenshot({ fullPage: false, type: 'png' }),
    );
    if (process.env.UPDATE_GOLDEN === '1' || !existsSync(GOLDEN)) {
      writeFileSync(GOLDEN, shot);
      if (process.env.UPDATE_GOLDEN !== '1')
        throw new Error(`created golden ${GOLDEN} — inspect it, then re-run`);
      return;
    }
    const a = PNG.sync.read(readFileSync(GOLDEN));
    const b = PNG.sync.read(shot);
    expect([b.width, b.height]).toEqual([a.width, a.height]);
    const diff = pixelmatch(a.data, b.data, undefined, a.width, a.height, { threshold: 0.1 });
    expect(diff / (a.width * a.height)).toBeLessThan(0.001);
  }, 60_000);

  it('escape ข้อความจากผู้ใช้ · ตัวย่อบริษัท · วันที่ พ.ศ./ค.ศ. แบบย่อ', () => {
    const d = sampleTripSheet();
    d.pages[0]!.stops[0]!.siteName = '<script>alert(1)</script>';
    const html = tripSheetDocument(d).body;
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(companyInitials('บริษัท ศรีไทยขนส่ง จำกัด')).toBe('ศร');
    expect(companyInitials('Example Co., Ltd.')).toBe('EX');
    expect(docDateShort('2026-11-03', 'BE')).toBe('3 พ.ย. 2569');
    expect(docDateShort('2026-11-03', 'CE')).toBe('3 พ.ย. 2026');
  });
});
