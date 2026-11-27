/**
 * P1-ST6-T04 ล้าง SVG ของโลโก้องค์กรก่อนเก็บ (docs/04 I "โลโก้" · plan/13 P1-ST6-T04 "SVG sanitize")
 *
 * โลโก้ถูกฝังใน PDF ใบแจ้งหนี้/ใบวางบิล/ใบสำคัญจ่าย และหน้าติดตามสาธารณะ — SVG เป็น XML ที่รันสคริปต์/โหลดของภายนอกได้
 * จึงสร้างเอกสารใหม่แบบ **allowlist** (ไม่ใช่แค่ตัดสิ่งที่รู้ว่าอันตราย):
 * - เก็บเฉพาะ element รูปทรง/ข้อความ/gradient ที่โลโก้ใช้ — อื่น ๆ (script, foreignObject, image, iframe, animate/set, a, …)
 *   ถูกตัด **ทั้ง element และเนื้อในทั้งหมด**
 * - attribute: ตัด `on*` (event handler) ทุกตัว · `href` / `xlink:href` ได้เฉพาะอ้างภายในเอกสาร (`#id`) · ค่าที่มี `url(`
 *   ต้องเป็น `url(#…)` · ค่าที่มี `javascript:` / `data:` / `expression(` / `@import` = ตัด attribute
 * - `<style>`: ตัด `@import` และ `url(...)` ที่ไม่ใช่ `#…` · ไม่มี CDATA/comment/processing instruction/DOCTYPE (กัน XXE/entity)
 * - ผลลัพธ์ต้องมี root `<svg>` — ไม่มี/ไม่ใช่ SVG = null (ผู้เรียกตอบ 422)
 * ตรวจซ้ำผลลัพธ์อีกรอบ (`svgUnsafe`) — เหลือรูปแบบอันตราย = ปฏิเสธทั้งไฟล์ (defense in depth)
 */

const ALLOWED_ELEMENTS = new Set([
  'svg',
  'g',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'text',
  'tspan',
  'defs',
  'lineargradient',
  'radialgradient',
  'stop',
  'clippath',
  'mask',
  'pattern',
  'use',
  'symbol',
  'title',
  'desc',
  'style',
]);

/** ชื่อ element แบบ SVG (camelCase) จากชื่อตัวพิมพ์เล็ก */
const CAMEL: Record<string, string> = {
  lineargradient: 'linearGradient',
  radialgradient: 'radialGradient',
  clippath: 'clipPath',
};
const tagName = (n: string) => CAMEL[n] ?? n;

const ATTR_NAME_RE = /^[a-zA-Z_][-a-zA-Z0-9_.:]*$/;
const BAD_VALUE_RE = /javascript:|vbscript:|data:|expression\s*\(|@import/i;
const ATTR_RE = /([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;

const escAttr = (v: string) =>
  v
    .replace(/&(?![a-zA-Z]+;|#\d+;|#x[0-9a-fA-F]+;)/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');

/** ทุก `url(...)` ในค่าต้องอ้างภายใน (`#id`) */
function urlsInternal(v: string): boolean {
  for (const m of v.matchAll(/url\s*\(\s*(['"]?)([^)'"]*)\1\s*\)/gi))
    if (!m[2]!.trim().startsWith('#')) return false;
  return true;
}

function cleanAttrs(raw: string): string {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of raw.matchAll(ATTR_RE)) {
    const name = m[1]!;
    const lname = name.toLowerCase();
    if (!ATTR_NAME_RE.test(name) || seen.has(lname)) continue;
    if (lname.startsWith('on')) continue; // event handler
    if (lname === 'xml:base' || lname === 'externalresourcesrequired') continue;
    let value = m[2] ?? '';
    if (value.startsWith('"') || value.startsWith("'")) value = value.slice(1, -1);
    // ถอด entity ตัวเลขก่อนตรวจ (กัน `&#106;avascript:`)
    const decoded = value
      .replace(/&#x([0-9a-f]+);?/gi, (_s, h: string) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);?/g, (_s, d: string) => String.fromCodePoint(Number(d)))
      .replace(/[\u0000- ]/g, '');
    if (lname === 'href' || lname === 'xlink:href') {
      if (!decoded.startsWith('#')) continue;
    } else if (BAD_VALUE_RE.test(decoded) || (/url\s*\(/i.test(decoded) && !urlsInternal(decoded)))
      continue;
    seen.add(lname);
    out.push(m[2] === undefined ? name : `${name}="${escAttr(value)}"`);
  }
  return out.length ? ` ${out.join(' ')}` : '';
}

function cleanStyleText(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, '')
    .replace(/url\s*\(\s*(['"]?)([^)'"]*)\1\s*\)/gi, (s, _q, u: string) =>
      u.trim().startsWith('#') ? s : 'none',
    )
    .replace(/expression\s*\(/gi, '')
    .replace(/</g, '');
}

/** รูปแบบอันตรายที่ต้องไม่เหลือในผลลัพธ์ */
export function svgUnsafe(svg: string): boolean {
  return /<\s*(script|foreignobject|iframe|object|embed|image|a|animate|set|handler|listener)\b|\son[a-z]+\s*=|javascript:|<!ENTITY|<!DOCTYPE|xlink:href\s*=\s*["'](?!#)|\shref\s*=\s*["'](?!#)/i.test(
    svg,
  );
}

/** ล้าง SVG — คืนเอกสารใหม่ (UTF-8) หรือ null เมื่อไม่ใช่ SVG / ล้างแล้วยังไม่ปลอดภัย */
export function sanitizeSvg(input: string): string | null {
  // ตัดส่วนที่ไม่ใช่ element ทั้งหมด: BOM, XML decl/PI, comment, DOCTYPE (รวม internal subset), CDATA
  const src = input
    .replace(/^﻿/, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^[>]*(\[[\s\S]*?\])?\s*>/gi, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const out: string[] = [];
  /** element ที่เปิดอยู่ (ชื่อตัวพิมพ์เล็ก) */
  const stack: string[] = [];
  /** ความลึกของ element ที่กำลังตัดทิ้ง (> 0 = อยู่ใน element ต้องห้าม) */
  let skip = 0;
  let sawRoot = false;
  const TAG_RE = /<(\/?)([a-zA-Z][-a-zA-Z0-9_:.]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
  let last = 0;
  for (const m of src.matchAll(TAG_RE)) {
    const text = src.slice(last, m.index);
    last = m.index! + m[0].length;
    if (!skip && stack.length)
      out.push(
        stack[stack.length - 1] === 'style' ? cleanStyleText(text) : text.replace(/</g, '&lt;'),
      );
    const closing = m[1] === '/';
    const name = m[2]!.toLowerCase().replace(/^svg:/, '');
    const rawAttrs = m[3] ?? '';
    const selfClosing = /\/\s*$/.test(rawAttrs);
    if (closing) {
      if (skip) {
        skip -= 1;
        continue;
      }
      const at = stack.lastIndexOf(name);
      if (at < 0) continue;
      while (stack.length > at) out.push(`</${tagName(stack.pop()!)}>`);
      if (!stack.length) break; // root ปิดแล้ว — ส่วนที่เหลือไม่ใช่ของ SVG
      continue;
    }
    if (skip || !ALLOWED_ELEMENTS.has(name) || (!sawRoot && name !== 'svg')) {
      if (!selfClosing) skip += 1;
      continue;
    }
    sawRoot = true;
    const attrs = cleanAttrs(rawAttrs.replace(/\/\s*$/, ''));
    if (selfClosing) {
      out.push(`<${tagName(name)}${attrs}/>`);
      if (!stack.length) break;
    } else {
      out.push(`<${tagName(name)}${attrs}>`);
      stack.push(name);
    }
  }
  while (stack.length) out.push(`</${stack.pop()}>`);
  if (!sawRoot) return null;
  let svg = out.join('');
  // root ต้องมี xmlns ของ SVG (รูปใน <img> / data URI ต้องมี ไม่งั้นไม่แสดง)
  svg = svg.replace(/^<svg(?![^>]*\sxmlns=)/, '<svg xmlns="http://www.w3.org/2000/svg"');
  if (svgUnsafe(svg)) return null;
  return svg;
}

/** เนื้อไฟล์เป็น SVG ไหม (ข้าม BOM / XML decl / comment / DOCTYPE แล้วเจอ `<svg`) */
export function looksLikeSvg(buf: Buffer): boolean {
  const head = buf
    .subarray(0, Math.min(buf.length, 4096))
    .toString('utf8')
    .replace(/^﻿/, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .trimStart();
  return /^<svg[\s>]/i.test(head);
}
