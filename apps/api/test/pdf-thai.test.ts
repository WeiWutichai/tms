import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { inflateSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import {
  sampleBillingNote,
  sampleBillingNoteLong,
  sampleBillingNoteSandbox,
} from '../src/modules/billing-notes/billing-note.sample';
import { billingNoteDocument } from '../src/modules/billing-notes/billing-note.template';
import {
  sampleInvoiceExempt,
  sampleInvoiceLong,
  sampleInvoiceMixed,
  sampleInvoiceSandbox,
} from '../src/modules/invoices/invoice.sample';
import { invoiceDocument } from '../src/modules/invoices/invoice.template';
import {
  sampleSettlementDraft,
  sampleSettlementLong,
  sampleSettlementPaid,
  sampleSettlementSandbox,
} from '../src/modules/settlements/settlement-pdf.sample';
import { settlementVoucherDocument } from '../src/modules/settlements/settlement-pdf.template';
import { sampleLongTripSheet, sampleTripSheet } from '../src/modules/trip-sheets/trip-sheet.sample';
import { tripSheetDocument } from '../src/modules/trip-sheets/trip-sheet.template';
import {
  sampleAgingPdf,
  sampleRevenueRoutePdf,
  sampleUnbilledPdf,
} from '../src/modules/exports/export-pdf.sample';
import { sarabunFontCss } from '../src/pdf/fonts';
import { PdfRenderer, type RenderOptions } from '../src/pdf/pdf-renderer';
import { woff2CodePoints } from './woff2-cmap';

/**
 * ST9-T12 "PDF ทุกชนิดเป็นไทย" (docs/04 I ภาษา, K10) — render PDF ทุกชนิดที่ระบบออกได้ แล้วตรวจว่า
 * (1) ข้อความไทยทุกบรรทัดใช้ฟอนต์ Sarabun ที่ฝังมา (ไม่ตกไปฟอนต์เครื่อง = สระ/วรรณยุกต์ไม่ลอย ไม่เป็นกล่อง)
 * (2) ในไฟล์ PDF ฝังเฉพาะ Sarabun และมี ToUnicode ของอักษรไทย (คัดลอก/ค้นข้อความไทยได้)
 * (3) ป้ายหลักของเอกสารเป็นภาษาไทย ทั้งปี พ.ศ. และ ค.ศ.
 * ภาพเทียบ golden ของแต่ละชนิดอยู่ใน test/trip-sheet-pdf.test.ts (เอกสารตัวอย่างของ engine: test/pdf.test.ts — ไม่ใช่เอกสารที่ออกให้ลูกค้า
 *   และมี "→" ที่ Sarabun ไม่มี จึงไม่อยู่ใน KINDS)
 * ชนิดใหม่ (ใบแจ้งหนี้/ใบกำกับภาษี/50 ทวิ ฯลฯ ใน ST5–ST6): ต้องเพิ่มใน KINDS — test สุดท้ายสแกนไฟล์ที่ import `pdf/pdf-renderer` แล้วบังคับ
 * (4) ทุกอักขระบนเอกสารอยู่ใน unicode-range และ cmap (glyph จริง ทุกน้ำหนัก) ของ Sarabun ที่ฝัง (ตรวจแบบ static — ไม่ขึ้นกับฟอนต์ในเครื่อง/OS)
 *     — เช่น "→" ของต้นแบบ TMS Print ไม่มีใน Sarabun เอกสารจริงใช้ "–" แทน (spec/12 §3)
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
    kind: 'ไฟล์ส่งออกรายงาน PDF — รายงานรายได้ต่อเส้นทาง (ST9-T05)',
    module: 'src/modules/exports',
    docs: () => [sampleRevenueRoutePdf()],
    labels: [
      'รายงานรายได้ต่อเส้นทาง',
      'งวด',
      'รวม',
      'พิมพ์เมื่อ',
      'ไม่ระบุ',
      '125,000.50',
      '1,750.00',
    ],
  },
  {
    kind: 'ไฟล์ส่งออกรายงาน PDF — DO ยังไม่วางบิล (D-81 · D68-99)',
    module: 'src/modules/exports',
    docs: () => [sampleUnbilledPdf()],
    labels: [
      'รายงาน DO ยังไม่วางบิล',
      'ส่งถึงแล้วเกิน 7 วัน',
      'ค้างวางบิล (วัน)',
      'รอ POD',
      'อยู่ในร่าง (วัน)',
      'พิมพ์เมื่อ',
      '125,000.50',
      '1,750.00',
    ],
  },
  {
    kind: 'ไฟล์ส่งออกรายงาน PDF — ลูกหนี้คงค้าง (D-81 · D68-99)',
    module: 'src/modules/exports',
    docs: () => [sampleAgingPdf()],
    labels: [
      'รายงานลูกหนี้คงค้าง',
      'ยังไม่ครบกำหนด',
      '1–30 วัน',
      'เกิน 90 วัน',
      'รวม',
      'พิมพ์เมื่อ',
      '48,250.00',
      '1,350.49',
    ],
  },
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
  {
    kind: 'ใบแจ้งหนี้ (ST5-T08 — ร่าง/ต้นฉบับ/สำเนา, ยกเว้น VAT/ผสม/หลายหน้า · D-61 ลายน้ำ sandbox)',
    module: 'src/modules/invoices',
    docs: () => {
      const original = sampleInvoiceMixed();
      original.invoiceNo = 'INV-2611-0001';
      original.copy = 'ORIGINAL';
      const ce = sampleInvoiceExempt();
      ce.yearStyle = 'CE';
      return [
        sampleInvoiceExempt(),
        sampleInvoiceMixed(),
        sampleInvoiceLong(),
        original,
        ce,
        sampleInvoiceSandbox(),
      ].map(invoiceDocument);
    },
    labels: ['ใบแจ้งหนี้', 'รวมทั้งสิ้น'],
  },
  {
    kind: 'ใบสำคัญจ่ายรถร่วม (ST6-T04 — ร่าง/จ่ายแล้ว, หลายหน้า · ลายน้ำ sandbox ตามแนว D-61)',
    module: 'src/modules/settlements',
    docs: () => {
      const ce = sampleSettlementPaid();
      ce.yearStyle = 'CE';
      return [
        sampleSettlementDraft(),
        sampleSettlementPaid(),
        sampleSettlementLong(),
        ce,
        sampleSettlementSandbox(),
      ].map(settlementVoucherDocument);
    },
    labels: ['ใบสำคัญจ่าย'],
  },
  {
    kind: 'ใบวางบิล (ST5-T11 — ร่าง/ต้นฉบับ, หลายหน้า · D-61 ลายน้ำ sandbox)',
    module: 'src/modules/billing-notes',
    docs: () => {
      const draft = sampleBillingNote();
      draft.billingNoteNo = null;
      draft.copy = null;
      const ce = sampleBillingNote();
      ce.yearStyle = 'CE';
      return [
        sampleBillingNote(),
        sampleBillingNoteLong(),
        draft,
        ce,
        sampleBillingNoteSandbox(),
      ].map(billingNoteDocument);
    },
    labels: ['ใบวางบิล', 'รวมทั้งสิ้น'],
  },
];

const THAI = /[ก-๛]/;

/** ช่วง code point ที่ @font-face ของ Sarabun ครอบ (จาก unicode-range ใน sarabunFontCss) */
const SARABUN_RANGES: Array<[number, number]> = [
  ...sarabunFontCss().matchAll(/unicode-range:([^;}]+)/g),
].flatMap((m) =>
  m[1]!.split(',').map((r) => {
    const [a, b] = r.trim().replace(/^U\+/i, '').split('-');
    return [parseInt(a!, 16), parseInt(b ?? a!, 16)] as [number, number];
  }),
);
const inRange = (cp: number) => SARABUN_RANGES.some(([a, b]) => cp >= a && cp <= b);

/**
 * glyph ที่ไฟล์ Sarabun ที่ฝัง (ทุกน้ำหนัก ทุก subset ใน fonts.ts) มีจริง — unicode-range กว้างกว่า glyph ที่มี
 * (U+2000-206F ทั้งช่วง) จึงต้องอยู่ทั้งใน range และ cmap ของทุกน้ำหนัก (ตัวหนา/บางต้องไม่ตกไปฟอนต์เครื่อง)
 */
const SARABUN_GLYPHS: Set<number> = (() => {
  const dir = join(dirname(require.resolve('@fontsource/sarabun/package.json')), 'files');
  const perWeight = [400, 500, 600, 700].map((w) => {
    const s = new Set<number>();
    for (const subset of ['thai', 'latin'])
      for (const cp of woff2CodePoints(join(dir, `sarabun-${subset}-${w}-normal.woff2`))) s.add(cp);
    return s;
  });
  return new Set([...perWeight[0]!].filter((cp) => perWeight.every((s) => s.has(cp))));
})();
const covered = (cp: number) => cp <= 0x20 || (inRange(cp) && SARABUN_GLYPHS.has(cp));

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
        const outside = [...new Set([...info.text].filter((c) => !covered(c.codePointAt(0)!)))];
        expect(outside, 'อักขระนอกชุด Sarabun (จะตกไปฟอนต์เครื่อง)').toEqual([]);
        expect(info.text).not.toContain('→');

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

  it('ตัวตรวจจับได้จริง: → ไม่อยู่ในชุด Sarabun แต่ – อยู่ (static + cmap) · ใน PDF ฟอนต์อื่นโผล่ (ข้ามถ้าเครื่องไม่มีฟอนต์สำรอง)', async (ctx) => {
    expect(covered('ก'.codePointAt(0)!)).toBe(true);
    expect(covered('→'.codePointAt(0)!)).toBe(false);
    // "→" อยู่นอก unicode-range อยู่แล้ว · U+2192 ตรวจ cmap โดยตรง (ตัวแทนที่ใช้บนเอกสาร "–" ต้องมี glyph)
    expect(SARABUN_GLYPHS.has(0x2192)).toBe(false);
    expect(covered('–'.codePointAt(0)!)).toBe(true);
    expect(SARABUN_GLYPHS.has('ก'.codePointAt(0)!)).toBe(true);
    const pdf = await r.pdf({ body: '<p>กรุงเทพฯ → แหลมฉบัง</p>' });
    const fonts = [...pdf.toString('latin1').matchAll(/\/FontName\s*\/([A-Za-z0-9+_-]+)/g)].map(
      (m) => m[1]!,
    );
    expect(fonts.some((f) => /\+Sarabun/.test(f))).toBe(true);
    // ไม่มีฟอนต์สำรองที่มี → ในเครื่อง (เช่น container ที่ฟอนต์น้อย) → ตรวจระดับ PDF ไม่ได้ ส่วน static ด้านบนยังตรวจ
    if (!fonts.some((f) => !/\+Sarabun/.test(f))) ctx.skip();
  }, 60_000);

  it('ทุกโมดูลที่ใช้ PdfRenderer (import pdf/pdf-renderer) มีชนิดอยู่ใน KINDS', () => {
    const root = join(__dirname, '..');
    const users: string[] = [];
    (function walk(d: string) {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) {
          const rel = relative(root, p);
          if (rel.startsWith('src/pdf/') || rel === 'src/app.module.ts') continue;
          if (/from '[./]*(?:\.\.\/)*pdf\/pdf-renderer'/.test(readFileSync(p, 'utf8')))
            users.push(rel);
        }
      }
    })(join(root, 'src'));
    expect(users.length).toBeGreaterThan(0);
    const uncovered = users.filter((c) => !KINDS.some((k) => c.startsWith(k.module + '/')));
    expect(uncovered).toEqual([]);
  });
});
