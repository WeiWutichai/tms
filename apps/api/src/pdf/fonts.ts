import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * ฟอนต์ Sarabun (SIL OFL 1.1 — @fontsource/sarabun) ฝังเป็น base64 ใน HTML ทุกครั้ง
 * → PDF ไม่พึ่งฟอนต์ในเครื่อง/เน็ต และผลเหมือนกันทุกเครื่อง (ต้นแบบ TMS Print ใช้ Sarabun สำหรับ A4)
 */
let css: string | null = null;

export function sarabunFontCss(): string {
  if (css) return css;
  const dir = join(dirname(require.resolve('@fontsource/sarabun/package.json')), 'files');
  const faces: string[] = [];
  for (const weight of [400, 600, 700]) {
    for (const [subset, range] of [
      ['thai', 'U+02D7, U+0303, U+0331, U+0E01-0E5B, U+200C-200D, U+25CC'],
      [
        'latin',
        'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD',
      ],
    ] as const) {
      const data = readFileSync(join(dir, `sarabun-${subset}-${weight}-normal.woff2`)).toString(
        'base64',
      );
      faces.push(
        `@font-face{font-family:'Sarabun';font-style:normal;font-weight:${weight};font-display:block;src:url(data:font/woff2;base64,${data}) format('woff2');unicode-range:${range};}`,
      );
    }
  }
  css = faces.join('\n');
  return css;
}
