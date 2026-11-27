/**
 * P1-ST6-T04 ล้าง SVG ของโลโก้องค์กรก่อนเก็บ (docs/04 I "โลโก้" · plan/13 P1-ST6-T04 "SVG sanitize")
 *
 * โลโก้ถูกฝังใน PDF ใบแจ้งหนี้/ใบวางบิล/ใบสำคัญจ่าย และหน้าติดตามสาธารณะ — SVG เป็น XML ที่รันสคริปต์/โหลดของภายนอกได้
 * จึงสร้างเอกสารใหม่แบบ **allowlist** ด้วย tokenizer อ่านรอบเดียว (เวลา O(n) — ไม่มี regex ที่ย้อนกลับได้กับข้อมูลผู้ใช้;
 * review 27 พ.ย. 2569 ReDoS):
 * - เก็บเฉพาะ element รูปทรง/ข้อความ/gradient ที่โลโก้ใช้ — อื่น ๆ (script, style, foreignObject, image, iframe, animate/set, a, …)
 *   ถูกตัด **ทั้ง element และเนื้อในทั้งหมด** · `<style>` ตัดทิ้งทั้งก้อน (CSS escape / entity เลี่ยงตัวกรองได้)
 * - attribute: ตัด `on*` ทุกตัว · attribute ที่ชื่อท้าย (local name) เป็น `href` ไม่ว่า prefix ใด ได้เฉพาะ `#id` ·
 *   `xmlns` / `xmlns:*` ได้เฉพาะ namespace ของ SVG / XLink · ค่าถอด entity แล้ว: มี `\` (CSS escape), `javascript:`, `data:`,
 *   `expression(`, `@import` หรือ `url(` ที่ไม่ใช่ `#` = ตัด attribute
 * - comment / processing instruction / DOCTYPE (รวม internal subset) / CDATA ถูกทิ้ง · `&` ที่ไม่ใช่ entity มาตรฐานของ XML
 *   (amp/lt/gt/quot/apos หรือเลข) ถูก escape (กัน XML พังเมื่อไม่มี DOCTYPE — `&nbsp;`)
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
]);

/** ชื่อ element แบบ SVG (camelCase) จากชื่อตัวพิมพ์เล็ก */
const CAMEL: Record<string, string> = {
  lineargradient: 'linearGradient',
  radialgradient: 'radialGradient',
  clippath: 'clipPath',
};
const tagName = (n: string) => CAMEL[n] ?? n;

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const ATTR_NAME_RE = /^[a-zA-Z_][-a-zA-Z0-9_.:]{0,63}$/;
const BAD_VALUE_RE = /javascript:|vbscript:|data:|expression\(|@import/i;
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** `&` ที่ไม่ใช่ entity มาตรฐานของ XML → `&amp;` (เดินทีละตัว — O(n)) */
function escapeAmp(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '<') out += '&lt;';
    else if (c !== '&') out += c;
    else {
      // มองแค่ 12 ตัวถัดไป (ไม่ค้นทั้งสตริง — O(n) แม้มี & จำนวนมาก)
      const win = s.slice(i + 1, i + 12);
      const semi = win.indexOf(';');
      const ent = semi > 0 ? win.slice(0, semi) : '';
      out += /^(amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-fA-F]{1,6})$/.test(ent) ? '&' : '&amp;';
    }
  }
  return out;
}

/** ถอด entity (เลข + 5 ตัวมาตรฐาน) แล้วตัดช่องว่าง/อักขระควบคุม — ใช้ตรวจค่าเท่านั้น */
function decodeForCheck(v: string): string {
  return v
    .replace(/&#x([0-9a-f]{1,6});?/gi, (_s, h: string) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d{1,7});?/g, (_s, d: string) => safeChar(Number(d)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (_s, n: string) => NAMED[n]!)
    .replace(/[\u0000- ]/g, '');
}
const safeChar = (n: number) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '');

/** ทุก `url(` ในค่าต้องตามด้วย `#` (ค่าที่ถอดแล้ว ไม่มีช่องว่าง) */
function urlsInternal(v: string): boolean {
  const low = v.toLowerCase();
  let at = low.indexOf('url(');
  while (at >= 0) {
    let p = at + 4;
    if (low[p] === '"' || low[p] === "'") p++;
    if (low[p] !== '#') return false;
    at = low.indexOf('url(', p);
  }
  return true;
}

function keepAttr(name: string, value: string): boolean {
  const lname = name.toLowerCase();
  const local = lname.includes(':') ? lname.slice(lname.lastIndexOf(':') + 1) : lname;
  if (!ATTR_NAME_RE.test(name) || local.startsWith('on')) return false;
  if (lname === 'xml:base' || local === 'externalresourcesrequired') return false;
  const v = decodeForCheck(value);
  if (lname === 'xmlns') return v === SVG_NS;
  if (lname.startsWith('xmlns:')) return v === SVG_NS || v === XLINK_NS;
  if (local === 'href') return v.startsWith('#') && !v.includes('\\');
  if (v.includes('\\')) return false; // CSS escape เช่น \75rl(
  if (BAD_VALUE_RE.test(v)) return false;
  if (v.toLowerCase().includes('url(') && !urlsInternal(v)) return false;
  return true;
}

const isSpace = (c: string | undefined) => c === ' ' || c === '\n' || c === '\t' || c === '\r';
const isNameChar = (c: string | undefined) => !!c && /[-a-zA-Z0-9_:.]/.test(c);

interface Tag {
  closing: boolean;
  name: string;
  attrs: [string, string | null][];
  selfClosing: boolean;
  /** ตำแหน่งหลัง `>` */
  end: number;
}

/**
 * อ่าน tag ที่ `src[i] === '<'` — คืน null เมื่อไม่ใช่ tag ที่สมบูรณ์ (เจอ `<` ใหม่หรือจบไฟล์ก่อน `>` นอกเครื่องหมายคำพูด)
 * พร้อมตำแหน่งที่อ่านต่อ (> i เสมอ) · เดินไปข้างหน้าอย่างเดียว
 */
function readTag(src: string, i: number): Tag | { fail: number } {
  let p = i + 1;
  const closing = src[p] === '/';
  if (closing) p++;
  const start = p;
  while (p < src.length && isNameChar(src[p])) p++;
  if (p === start) return { fail: i + 1 };
  const name = src.slice(start, p);
  const attrs: [string, string | null][] = [];
  for (;;) {
    while (isSpace(src[p])) p++;
    const c = src[p];
    if (c === undefined || c === '<') return { fail: p > i ? p : i + 1 };
    if (c === '>') return { closing, name, attrs, selfClosing: false, end: p + 1 };
    if (c === '/' && src[p + 1] === '>')
      return { closing, name, attrs, selfClosing: true, end: p + 2 };
    const an = p;
    while (p < src.length && !isSpace(src[p]) && !'=/><"\''.includes(src[p]!)) p++;
    if (p === an) {
      p++; // อักขระแปลก (" ' / หรือ =) — ข้าม
      continue;
    }
    const aname = src.slice(an, p);
    while (isSpace(src[p])) p++;
    if (src[p] !== '=') {
      attrs.push([aname, null]);
      continue;
    }
    p++;
    while (isSpace(src[p])) p++;
    const q = src[p];
    if (q === '"' || q === "'") {
      const close = src.indexOf(q, p + 1);
      if (close < 0) return { fail: src.length };
      attrs.push([aname, src.slice(p + 1, close)]);
      p = close + 1;
    } else {
      const vs = p;
      while (p < src.length && !isSpace(src[p]) && src[p] !== '>' && src[p] !== '<') p++;
      attrs.push([aname, src.slice(vs, p)]);
    }
  }
}

/** ข้าม `<!…>` / `<?…?>` — คืนตำแหน่งหลังส่วนนั้น (ไม่ปิด = จบไฟล์) */
function skipMarkup(src: string, i: number): number {
  const find = (s: string, from: number) => {
    const at = src.indexOf(s, from);
    return at < 0 ? src.length : at + s.length;
  };
  if (src.startsWith('<!--', i)) return find('-->', i + 4);
  if (src.startsWith('<?', i)) return find('?>', i + 2);
  if (src.startsWith('<![CDATA[', i)) return find(']]>', i + 9);
  // <!DOCTYPE …[ internal subset ]> — เดินหา `>` นอกวงเล็บ [ ] (ข้อความในเครื่องหมายคำพูดข้าม)
  let depth = 0;
  for (let p = i + 2; p < src.length; p++) {
    const c = src[p];
    if (c === '"' || c === "'") {
      const close = src.indexOf(c, p + 1);
      if (close < 0) return src.length;
      p = close;
    } else if (c === '[') depth++;
    else if (c === ']') depth = Math.max(0, depth - 1);
    else if (c === '>' && depth === 0) return p + 1;
  }
  return src.length;
}

/** ล้าง SVG — คืนเอกสารใหม่ (UTF-8) หรือ null เมื่อไม่ใช่ SVG / ล้างแล้วยังไม่ปลอดภัย */
export function sanitizeSvg(input: string): string | null {
  const src = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const out: string[] = [];
  /** element ที่เปิดอยู่ (ชื่อตัวพิมพ์เล็ก) */
  const stack: string[] = [];
  /** ความลึกของ element ที่กำลังตัดทิ้ง (> 0 = อยู่ใน element ต้องห้าม) */
  let skip = 0;
  let sawRoot = false;
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    const textEnd = lt < 0 ? src.length : lt;
    if (textEnd > i && !skip && stack.length) out.push(escapeAmp(src.slice(i, textEnd)));
    if (lt < 0) break;
    if (src[lt + 1] === '!' || src[lt + 1] === '?') {
      i = skipMarkup(src, lt);
      continue;
    }
    const t = readTag(src, lt);
    if ('fail' in t) {
      i = Math.max(t.fail, lt + 1);
      continue;
    }
    i = t.end;
    const name = t.name.toLowerCase().replace(/^svg:/, '');
    if (t.closing) {
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
      if (!t.selfClosing) skip += 1;
      continue;
    }
    sawRoot = true;
    const seen = new Set<string>();
    const attrs: string[] = [];
    for (const [an, av] of t.attrs) {
      const key = an.toLowerCase();
      if (seen.has(key) || !keepAttr(an, av ?? '')) continue;
      seen.add(key);
      attrs.push(av === null ? an : `${an}="${escapeAmp(av).replace(/"/g, '&quot;')}"`);
    }
    const a = attrs.length ? ` ${attrs.join(' ')}` : '';
    if (t.selfClosing) {
      out.push(`<${tagName(name)}${a}/>`);
      if (!stack.length) break;
    } else {
      out.push(`<${tagName(name)}${a}>`);
      stack.push(name);
    }
  }
  while (stack.length) out.push(`</${tagName(stack.pop()!)}>`);
  if (!sawRoot) return null;
  let svg = out.join('');
  // root ต้องมี xmlns ของ SVG (รูปใน <img> / data URI ต้องมี ไม่งั้นไม่แสดง)
  if (!svg.slice(0, svg.indexOf('>') + 1).includes(' xmlns="'))
    svg = `<svg xmlns="${SVG_NS}"${svg.slice(4)}`;
  if (svgUnsafe(svg)) return null;
  return svg;
}

/** รูปแบบอันตรายที่ต้องไม่เหลือในผลลัพธ์ (ผลลัพธ์จาก sanitizeSvg — attribute อยู่ในเครื่องหมาย " เสมอ) */
export function svgUnsafe(svg: string): boolean {
  return (
    /<\s*\/?\s*(script|style|foreignobject|iframe|object|embed|image|a|animate|set|handler|listener)\b/i.test(
      svg,
    ) ||
    /\son[a-z]{1,40}\s?=/i.test(svg) ||
    /javascript:|<!ENTITY|<!DOCTYPE/i.test(svg) ||
    /\s(?:[a-z0-9_.-]{1,40}:)?href="(?!#)/i.test(svg)
  );
}

/** เนื้อไฟล์เป็น SVG ไหม (ข้าม BOM / XML decl / comment / DOCTYPE แล้วเจอ `<svg`) — อ่านแค่ 4 KB แรก */
export function looksLikeSvg(buf: Buffer): boolean {
  let head = buf.subarray(0, Math.min(buf.length, 4096)).toString('utf8');
  if (head.charCodeAt(0) === 0xfeff) head = head.slice(1);
  let i = 0;
  for (;;) {
    while (isSpace(head[i])) i++;
    if (head[i] !== '<') return false;
    if (head[i + 1] === '!' || head[i + 1] === '?') {
      i = skipMarkup(head, i);
      continue;
    }
    return /^<svg[\s>/]/i.test(head.slice(i, i + 5));
  }
}
