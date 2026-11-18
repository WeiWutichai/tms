import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { sampleLongTripSheet, sampleTripSheet } from '../src/modules/trip-sheets/trip-sheet.sample';
import { tripSheetDocument } from '../src/modules/trip-sheets/trip-sheet.template';
import { PdfRenderer, type RenderOptions } from '../src/pdf/pdf-renderer';

/**
 * ST9-T12 "PDF ทุกชนิดเป็นไทย" (docs/04 I ภาษา, K10) — render PDF ทุกชนิดที่ระบบออกได้ แล้วตรวจว่า
 * (1) ข้อความไทยทุกบรรทัดใช้ฟอนต์ Sarabun ที่ฝังมา (ไม่ตกไปฟอนต์เครื่อง = สระ/วรรณยุกต์ไม่ลอย ไม่เป็นกล่อง)
 * (2) ในไฟล์ PDF ฝังเฉพาะ Sarabun และมี ToUnicode ของอักษรไทย (คัดลอก/ค้นข้อความไทยได้)
 * (3) ป้ายหลักของเอกสารเป็นภาษาไทย ทั้งปี พ.ศ. และ ค.ศ.
 * ภาพเทียบ golden ของแต่ละชนิดอยู่ใน test/trip-sheet-pdf.test.ts (เอกสารตัวอย่างของ engine: test/pdf.test.ts — ไม่ใช่เอกสารที่ออกให้ลูกค้า
 *   และมี "→" ที่ Sarabun ไม่มี จึงไม่อยู่ใน KINDS)
 * ชนิดใหม่ (ใบแจ้งหนี้/ใบกำกับภาษี/50 ทวิ ฯลฯ ใน ST5–ST6): ต้องเพิ่มใน KINDS — test สุดท้ายสแกนหาโค้ดที่เรียก `.pdf(` แล้วบังคับ
 */
const KINDS: Array<{
  kind: string;
  /** โฟลเดอร์ของโมดูลที่สร้าง PDF ชนิดนี้ (ใช้จับคู่กับโค้ดที่เรียก PdfRenderer.pdf) */
  module: string;
  docs: () => RenderOptions[];
  /** ข้อความไทยที่ต้องอยู่บนเอกสาร */
  labels: string[];
}> = [
  {
    kind: 'ใบคุมรถ / ใบงานประจำวัน (ST3-T20)',
    module: 'src/modules/trip-sheets',
    docs: () => {
      const ce = sampleTripSheet();
      ce.yearStyle = 'CE';
      return [
        tripSheetDocument(sampleTripSheet()),
        tripSheetDocument(sampleLongTripSheet()),
        tripSheetDocument(ce),
      ];
    },
    labels: ['ใบคุมรถ'],
  },
];

const THAI = /[ก-๛]/;

/** stream ทั้งหมดใน PDF ที่ถอด FlateDecode ได้ (อ่านความยาวจาก /Length ของ dictionary) */
function streams(pdf: Buffer): string[] {
  const out: string[] = [];
  const raw = pdf.toString('latin1');
  const re = /\/Length (\d+)(?: 0 R)?[^]*?>>\s*stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const len = Number(m[1]);
    if (m[0].includes(' 0 R')) continue; // ความยาวแบบอ้างอิง (Chromium ไม่ใช้)
    try {
      out.push(inflateSync(pdf.subarray(start, start + len)).toString('latin1'));
    } catch {
      /* ไม่ใช่ Flate (รูป ฯลฯ) */
    }
    re.lastIndex = start + len;
  }
  return out;
}

/** code point ที่ ToUnicode CMap ของฟอนต์ map ออกมา */
function toUnicodeCodePoints(pdf: Buffer): Set<number> {
  const cps = new Set<number>();
  for (const s of streams(pdf)) {
    if (!s.includes('begincmap')) continue;
    for (const m of s.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      // bfrange: <lo> <hi> <dst>
      const lo = parseInt(m[1]!, 16);
      const hi = parseInt(m[2]!, 16);
      const dst = parseInt(m[3]!.slice(0, 4), 16);
      for (let i = 0; i <= hi - lo && i < 256; i++) cps.add(dst + i);
    }
    for (const m of s.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]{4,})>/g)) {
      const hex = m[2]!;
      for (let i = 0; i + 4 <= hex.length; i += 4) cps.add(parseInt(hex.slice(i, i + 4), 16));
    }
  }
  return cps;
}

interface PageInfo {
  thaiNodes: number;
  wrongFont: string[];
  fontLoaded: boolean;
  text: string;
}

describe('ST9-T12 PDF ทุกชนิดเป็นภาษาไทย ฝังฟอนต์ไทย', () => {
  const r = new PdfRenderer();
  afterAll(() => r.onModuleDestroy());

  for (const k of KINDS) {
    it(`${k.kind}: ข้อความไทยใช้ Sarabun ที่ฝังมา · PDF มีอักษรไทยแบบค้นได้`, async () => {
      for (const doc of k.docs()) {
        const info = (await r.withPage(doc, (page) =>
          page.evaluate(`(() => {
            const THAI = /[\\u0E01-\\u0E5B]/;
            const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            let n, thaiNodes = 0; const wrongFont = [];
            while ((n = w.nextNode())) {
              if (!THAI.test(n.textContent)) continue;
              thaiNodes++;
              const ff = getComputedStyle(n.parentElement).fontFamily;
              if (!/^['"]?Sarabun/.test(ff)) wrongFont.push(ff + ': ' + n.textContent.trim().slice(0, 40));
            }
            return {
              thaiNodes, wrongFont,
              fontLoaded: document.fonts.check('16px Sarabun', 'ก่ำ'),
              text: document.body.innerText,
            };
          })()`),
        )) as PageInfo;
        expect(info.thaiNodes).toBeGreaterThan(5);
        expect(info.wrongFont).toEqual([]);
        expect(info.fontLoaded).toBe(true);
        for (const l of k.labels) expect(info.text).toContain(l);

        const pdf = await r.pdf(doc);
        const raw = pdf.toString('latin1');
        const fonts = [...raw.matchAll(/\/FontName\s*\/([A-Za-z0-9+_-]+)/g)].map((m) => m[1]!);
        expect(fonts.length).toBeGreaterThan(0);
        expect(fonts.filter((f) => !/^[A-Z]{6}\+Sarabun/.test(f))).toEqual([]);
        const thaiCps = [...toUnicodeCodePoints(pdf)].filter((c) =>
          THAI.test(String.fromCharCode(c)),
        );
        expect(thaiCps.length).toBeGreaterThan(10);
        // สระบน/วรรณยุกต์ที่ใช้บ่อยต้องอยู่ในไฟล์ (ไม่หายตอน subset)
        for (const ch of 'ี่้')
          expect(thaiCps, `ไม่มี ${ch} ใน ToUnicode`).toContain(ch.charCodeAt(0));
      }
    }, 120_000);
  }

  it('ตัวตรวจจับได้จริง: อักขระที่ Sarabun ไม่มี (เช่น →) ตกไปฟอนต์เครื่อง → ฟอนต์อื่นโผล่ใน PDF (template ต้องเลี่ยง)', async () => {
    const pdf = await r.pdf({ body: '<p>กรุงเทพฯ → แหลมฉบัง</p>' });
    const fonts = [...pdf.toString('latin1').matchAll(/\/FontName\s*\/([A-Za-z0-9+_-]+)/g)].map(
      (m) => m[1]!,
    );
    expect(fonts.some((f) => /\+Sarabun/.test(f))).toBe(true);
    expect(fonts.some((f) => !/\+Sarabun/.test(f))).toBe(true);
  }, 60_000);

  it('ทุกโมดูลที่สร้าง PDF (เรียก .pdf(…) ของ PdfRenderer) มีชนิดอยู่ใน KINDS', () => {
    const root = join(__dirname, '..');
    const callers: string[] = [];
    (function walk(d: string) {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) {
          const src = readFileSync(p, 'utf8');
          if (/\.pdf\.pdf\(|renderer\.pdf\(|\bpdf\(\s*[a-zA-Z]+Document\(/.test(src))
            callers.push(relative(root, p));
        }
      }
    })(join(root, 'src'));
    expect(callers.length).toBeGreaterThan(0);
    const uncovered = callers.filter((c) => !KINDS.some((k) => c.startsWith(k.module + '/')));
    expect(uncovered).toEqual([]);
  });
});
