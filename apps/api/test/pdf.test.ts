import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalFileStore } from '../src/pdf/file-store';
import { PdfRenderer } from '../src/pdf/pdf-renderer';
import { sampleDocument } from '../src/pdf/sample-template';
import { docDate } from '../src/pdf/thai-date';

/**
 * ST0-T17 เกณฑ์ตรวจรับ: PDF ตัวอย่างสระ/วรรณยุกต์ไม่ลอย เทียบ golden ผ่าน
 * golden = ภาพหน้าเอกสารที่ render ด้วย Chromium + Sarabun ชุดเดียวกับ PDF (ตรวจด้วยตาแล้วตอนสร้าง)
 * อัปเดต golden: UPDATE_GOLDEN=1 pnpm --filter @tms/api test pdf  — แล้วเปิด test/golden/sample-th.<os>.png ตรวจด้วยตาก่อน commit
 */
// golden แยกตาม OS เพราะ anti-aliasing ของ Chromium ต่างกันเล็กน้อยระหว่าง macOS/Linux
// Linux = image mcr.microsoft.com/playwright:v1.65.0-noble (amd64) ตัวเดียวกับ CI — สร้างใหม่ตามขั้นตอนใน apps/api/test/golden/README.md
const GOLDEN = join(__dirname, `golden/sample-th.${process.platform}.png`);
const ISSUED = new Date('2026-11-03T03:00:00Z');

describe('PDF engine', () => {
  const r = new PdfRenderer();
  afterAll(() => r.onModuleDestroy());

  it('สร้าง PDF A4 ที่ฝังฟอนต์ Sarabun', async () => {
    const pdf = await r.pdf(sampleDocument(ISSUED, 'BE'));
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const raw = pdf.toString('latin1');
    expect(raw).toMatch(/FontName\s*\/[A-Z]{6}\+Sarabun/); // subset ฝังในไฟล์
    expect(raw).toMatch(/MediaBox\s*\[\s*0 0 59[45]\.\d+ 84[12]\.\d+/); // A4 (Chromium: 594.96 x 841.92 pt)
  }, 60_000);

  it('ภาพหน้าเอกสารตรง golden (สระ/วรรณยุกต์ไม่ลอย)', async () => {
    const shot = await r.withPage(sampleDocument(ISSUED, 'BE'), (page) =>
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

  it('วันที่บนเอกสาร พ.ศ./ค.ศ. ตามเวลาไทย', () => {
    expect(docDate(ISSUED, 'BE')).toBe('3 พฤศจิกายน 2569');
    expect(docDate(ISSUED, 'CE')).toBe('3 พฤศจิกายน 2026');
    expect(docDate(new Date('2026-12-31T18:00:00Z'), 'BE')).toBe('1 มกราคม 2570'); // UTC 18:00 = ไทย 01:00 วันถัดไป
  });
});

describe('LocalFileStore (immutable)', () => {
  const root = mkdtempSync(join(tmpdir(), 'tms-files-'));
  const store = new LocalFileStore(root);
  const tenant = '00000000-0000-4000-8000-00000000000a';

  it('เก็บแบบ content-addressed: เนื้อเดิม = key เดิม, ไฟล์เป็น read-only', async () => {
    const a = await store.put(tenant, Buffer.from('pdf-1'), 'pdf');
    const b = await store.put(tenant, Buffer.from('pdf-1'), 'pdf');
    expect(b.key).toBe(a.key);
    expect(statSync(join(root, a.key)).mode & 0o222).toBe(0);
    expect((await store.get(a.key)).toString()).toBe('pdf-1');
  });

  it('ไฟล์ถูกแก้นอกระบบ → put ซ้ำต้องโยน error (ตรวจจับการแก้เอกสาร)', async () => {
    const a = await store.put(tenant, Buffer.from('pdf-2'), 'pdf');
    const path = join(root, a.key);
    chmodSync(path, 0o644);
    writeFileSync(path, 'tampered');
    await expect(store.put(tenant, Buffer.from('pdf-2'), 'pdf')).rejects.toThrow(/immutable/);
  });
});
