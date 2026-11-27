import { describe, expect, it } from 'vitest';
import { looksLikeSvg, sanitizeSvg, svgUnsafe } from '../src/modules/documents/svg-sanitize';
import { sniffMime } from '../src/modules/documents/mime';

/**
 * P1-ST6-T04 SVG ของโลโก้ถูกล้างก่อนเก็บ — script / event handler / อ้างของภายนอก / foreignObject ต้องหาย
 * (โลโก้ไปอยู่บน PDF และหน้าติดตามสาธารณะ)
 */
describe('sanitizeSvg (P1-ST6-T04)', () => {
  const LOGO =
    '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><defs><linearGradient id="g"><stop offset="0" stop-color="#13213F"/></linearGradient></defs><rect width="40" height="40" rx="8" fill="url(#g)"/><text x="4" y="26">TMS</text></svg>';

  it('โลโก้ปกติ: รูปทรง/gradient/ข้อความคงอยู่ · ตัด XML declaration', () => {
    const out = sanitizeSvg(LOGO)!;
    expect(out).toContain('<linearGradient id="g">');
    expect(out).toContain('fill="url(#g)"');
    expect(out).toContain('<text x="4" y="26">TMS</text>');
    expect(out.startsWith('<svg')).toBe(true);
    expect(svgUnsafe(out)).toBe(false);
  });

  it('script ทุกแบบถูกตัดทั้ง element และเนื้อใน (รวมตัวพิมพ์ปน, CDATA, ชื่อมี namespace)', () => {
    const out = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><SCRIPT type="text/javascript"><![CDATA[alert(2)]]></SCRIPT><svg:script>alert(3)</svg:script><circle r="4"/></svg>',
    )!;
    expect(out).not.toMatch(/script|alert/i);
    expect(out).toContain('<circle r="4"/>');
  });

  it('event handler (on*) ถูกตัดทุกตัว — element ยังอยู่', () => {
    const out = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect ONCLICK="x()" onmouseover=\'y()\' width="1"/></svg>',
    )!;
    expect(out).not.toMatch(/on[a-z]+=|alert|x\(\)|y\(\)/i);
    expect(out).toContain('<rect width="1"/>');
  });

  it('อ้างของภายนอก: href/xlink:href นอกเอกสาร, javascript:, data:, url(http…), @import, <image> ถูกตัด · #id ภายในคงอยู่', () => {
    const out = sanitizeSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
        <style>@import url(https://evil.example/x.css); .a{fill:url(https://evil.example/p.svg#x)} .b{fill:url(#g)}</style>
        <use xlink:href="https://evil.example/s.svg#icon"/><use href="#ok"/>
        <a href="javascript:alert(1)"><rect width="2"/></a>
        <image href="https://evil.example/track.png"/>
        <rect style="fill:url(http://evil.example/t)" width="3"/>
        <rect fill="&#106;avascript:alert(1)" width="4"/>
        <path d="M0 0" filter="url(data:image/svg+xml;base64,AAAA)"/>
      </svg>`,
    )!;
    expect(out).not.toMatch(/evil\.example|javascript|data:|@import|<image|<a[\s>]/i);
    expect(out).toContain('<use href="#ok"/>');
    expect(out).toContain('.b{fill:url(#g)}');
    expect(out).toContain('<rect width="3"/>');
    expect(out).toContain('<rect width="4"/>');
  });

  it('foreignObject (HTML ฝัง) / iframe / animate-set (เปลี่ยน href ตอนรัน) ถูกตัดทั้งก้อน', () => {
    const out = sanitizeSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><iframe src="https://evil.example"></iframe></body></foreignObject><set attributeName="href" to="javascript:alert(1)"/><animate attributeName="href" values="javascript:alert(1)"/><g><rect width="5"/></g></svg>',
    )!;
    expect(out).not.toMatch(/foreignobject|iframe|body|<set|<animate|javascript/i);
    expect(out).toContain('<g><rect width="5"/></g>');
  });

  it('DOCTYPE + ENTITY (XXE / billion laughs) ถูกตัด · ไม่ใช่ SVG = null', () => {
    const out = sanitizeSvg(
      '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd"><!ENTITY lol "lol">]><svg xmlns="http://www.w3.org/2000/svg"><text>&x;</text></svg>',
    )!;
    expect(out).not.toMatch(/ENTITY|DOCTYPE|passwd/);
    expect(sanitizeSvg('<html><body>hi</body></html>')).toBeNull();
    expect(sanitizeSvg('not svg at all')).toBeNull();
  });

  it('root ไม่มี xmlns → เติมให้ (แสดงใน <img>/data URI ได้) · เนื้อหลัง </svg> ถูกทิ้ง', () => {
    const out = sanitizeSvg(
      '<svg viewBox="0 0 1 1"><rect width="1"/></svg><script>alert(1)</script>',
    )!;
    expect(out).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1"/></svg>',
    );
  });

  it('ตรวจชนิดไฟล์: SVG (มี XML decl / comment / BOM) = image/svg+xml · HTML ปลอมไม่ผ่าน', () => {
    expect(looksLikeSvg(Buffer.from(LOGO))).toBe(true);
    expect(sniffMime(Buffer.from(`﻿<!-- logo --><svg xmlns="x"></svg>`))).toBe('image/svg+xml');
    expect(sniffMime(Buffer.from('<html><svg></svg></html>'))).toBeNull();
  });
});
