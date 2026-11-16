import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { afterAll, describe, expect, it } from 'vitest';
import { docDateShort } from '../src/common/thai-date';
import { sampleLongTripSheet, sampleTripSheet } from '../src/modules/trip-sheets/trip-sheet.sample';
import { companyInitials, tripSheetDocument } from '../src/modules/trip-sheets/trip-sheet.template';
import { PdfRenderer, RenderGate } from '../src/pdf/pdf-renderer';
import type { Browser } from 'playwright-core';

/**
 * ST3-T20 golden ของใบคุมรถ A4 (แบบเดียวกับ PDF engine ST0-T17 — test/pdf.test.ts):
 * ภาพหน้าเอกสารที่ render ด้วย Chromium + Sarabun ชุดเดียวกับ PDF → สระ/วรรณยุกต์ไม่ลอย, layout ตามต้นแบบ TMS Print#trip
 * golden แยก OS (anti-aliasing ต่างกัน) — Linux = image playwright v1.65.0-noble amd64 (ขั้นตอนใน test/golden/README.md)
 * อัปเดต: UPDATE_GOLDEN=1 pnpm --filter @tms/api exec vitest run test/trip-sheet-pdf.test.ts แล้วเปิดภาพตรวจด้วยตาก่อน commit
 */
const GOLDEN = join(__dirname, `golden/trip-sheet-th.${process.platform}.png`);
const GOLDEN_LONG = join(__dirname, `golden/trip-sheet-long-th.${process.platform}.png`);

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
    matchGolden(GOLDEN, shot);
  }, 60_000);

  it('เที่ยวยาว: แถวจุดแรกสูงเกิน → แยกตามบล็อก DO ตารางเริ่มหน้าแรก · หน้าต่อมีหัว "(ต่อ)" + "TRP-… · หน้า x/y" (golden หลายหน้า)', async () => {
    const doc = tripSheetDocument(sampleLongTripSheet());
    const info = await r.withPage(
      doc,
      (page) =>
        page.evaluate(`(() => {
        const pages = [...document.querySelectorAll('section.page')];
        return {
          n: pages.length,
          foot: pages.map((p) => p.querySelector('.foot').textContent),
          firstRows: pages[0].querySelectorAll('tbody tr').length,
          cont: pages.slice(1).map((p) => p.querySelector('.cont')?.textContent ?? ''),
          over: pages.some((p) => p.scrollHeight > p.clientHeight + 1),
        };
      })()`) as Promise<{
          n: number;
          foot: string[];
          firstRows: number;
          cont: string[];
          over: boolean;
        }>,
    );
    expect(info.n).toBeGreaterThanOrEqual(2);
    expect(info.firstRows).toBeGreaterThanOrEqual(1);
    expect(info.foot).toEqual(
      Array.from({ length: info.n }, (_, i) => `TRP-2611-0099 · หน้า ${i + 1}/${info.n}`),
    );
    for (const c of info.cont) expect(c).toContain('TRP-2611-0099 (ต่อ)');
    expect(info.over).toBe(false);
    const pdf = await r.pdf(doc);
    expect(pageCount(pdf)).toBe(info.n);
    // ใบรายวัน 2 เที่ยว → เลขหน้านับต่อเที่ยว
    const two = sampleLongTripSheet();
    two.pages.push({ ...sampleTripSheet().pages[0]! });
    const feet = await r.withPage(
      tripSheetDocument(two),
      (page) =>
        page.evaluate(
          `[...document.querySelectorAll('.foot')].map((f) => f.textContent)`,
        ) as Promise<string[]>,
    );
    expect(feet.at(-1)).toBe('TRP-2611-0041 · หน้า 1/1');
    expect(feet.at(-2)).toBe(`TRP-2611-0099 · หน้า ${info.n}/${info.n}`);
    const shot = await r.withPage(doc, (page) => page.screenshot({ fullPage: true, type: 'png' }));
    matchGolden(GOLDEN_LONG, shot);
  }, 90_000);

  it('RenderGate: พร้อมกันไม่เกิน max · รอคิวเกินเส้นตาย → 503 service_busy · render เกินเส้นตาย → 503 pdf_render_timeout', async () => {
    const g = new RenderGate(2, 200);
    let peak = 0;
    const job = () =>
      g.run(async () => {
        peak = Math.max(peak, g.running);
        await new Promise((ok) => setTimeout(ok, 30));
        return 1;
      });
    expect(await Promise.all(Array.from({ length: 6 }, job))).toEqual([1, 1, 1, 1, 1, 1]);
    expect(peak).toBe(2);

    const slow = new RenderGate(1, 120, 30);
    let cleaned = false;
    const hang = slow.run(async (onTimeout) => {
      onTimeout(() => (cleaned = true));
      await new Promise((ok) => setTimeout(ok, 200));
    });
    const queued = slow.run(async () => 1);
    const [h, q] = await Promise.allSettled([hang, queued]);
    expect(h).toMatchObject({ status: 'rejected', reason: { code: 'pdf_render_timeout' } });
    expect(q).toMatchObject({ status: 'rejected', reason: { code: 'service_busy' } });
    expect(cleaned).toBe(true);
    expect(slow.running).toBe(0);
    expect(await slow.run(async () => 2)).toBe(2); // ช่องว่างคืนแล้ว
  });

  it('browser หลุดระหว่าง getBrowser() กับ newContext() → เปิดใหม่ 1 ครั้งแล้ว render ได้', async () => {
    let launches = 0;
    class Flaky extends PdfRenderer {
      protected override async launch(): Promise<Browser> {
        launches++;
        const real = await super.launch();
        if (launches > 1) return real;
        await real.close(); // ตายก่อน newContext
        return real;
      }
    }
    const f = new Flaky();
    try {
      const pdf = await f.pdf(tripSheetDocument(sampleTripSheet()));
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      expect(launches).toBe(2);
    } finally {
      await f.onModuleDestroy();
    }
  }, 60_000);

  it('escape ข้อความจากผู้ใช้ · ตัวย่อบริษัท · วันที่ พ.ศ./ค.ศ. แบบย่อ', () => {
    const d = sampleTripSheet();
    d.pages[0]!.stops[0]!.siteName = '<script>alert(1)</script>';
    const html = tripSheetDocument(d).body;
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
    expect(companyInitials('บริษัท ศรีไทยขนส่ง จำกัด')).toBe('ศร');
    expect(companyInitials('Example Co., Ltd.')).toBe('EX');
    expect(docDateShort('2026-11-03', 'BE')).toBe('3 พ.ย. 2569');
    expect(docDateShort('2026-11-03', 'CE')).toBe('3 พ.ย. 2026');
  });
});
