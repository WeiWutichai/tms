import { readFileSync } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';

/**
 * อ่านตาราง `cmap` ของไฟล์ WOFF2 (เฉพาะที่ต้องใช้ใน test — format 4 และ 12) → ชุด code point ที่ฟอนต์มี glyph จริง
 * ใช้ตรวจว่าอักขระบน PDF อยู่ในฟอนต์ Sarabun ที่ฝังจริง — unicode-range ของ @font-face กว้างกว่า glyph ที่มี
 * (เช่น U+2000-206F ทั้งช่วง ทั้งที่บางตัวไม่มี glyph) จึงใช้ cmap จริงแทน · ไม่พึ่ง library ฟอนต์ภายนอก
 * อ้างอิงรูปแบบ: W3C WOFF2 §4–5, OpenType `cmap`
 */
const KNOWN_TAGS = [
  'cmap',
  'head',
  'hhea',
  'hmtx',
  'maxp',
  'name',
  'OS/2',
  'post',
  'cvt ',
  'fpgm',
  'glyf',
  'loca',
  'prep',
  'CFF ',
  'VORG',
  'EBDT',
  'EBLC',
  'gasp',
  'hdmx',
  'kern',
  'LTSH',
  'PCLT',
  'VDMX',
  'vhea',
  'vmtx',
  'BASE',
  'GDEF',
  'GPOS',
  'GSUB',
  'EBSC',
  'JSTF',
  'MATH',
  'CBDT',
  'CBLC',
  'COLR',
  'CPAL',
  'SVG ',
  'sbix',
  'acnt',
  'avar',
  'bdat',
  'bloc',
  'bsln',
  'cvar',
  'fdsc',
  'feat',
  'fmtx',
  'fvar',
  'gvar',
  'hsty',
  'just',
  'lcar',
  'mort',
  'morx',
  'opbd',
  'prop',
  'trak',
  'Zapf',
  'Silf',
  'Glat',
  'Gloc',
  'Feat',
  'Sill',
];

export function woff2CodePoints(file: string): Set<number> {
  const b = readFileSync(file);
  if (b.toString('latin1', 0, 4) !== 'wOF2') throw new Error(`not WOFF2: ${file}`);
  const numTables = b.readUInt16BE(12);
  const totalCompressed = b.readUInt32BE(20);
  let p = 48;
  const base128 = () => {
    let v = 0;
    for (let i = 0; i < 5; i++) {
      const c = b[p++]!;
      v = v * 128 + (c & 0x7f);
      if (!(c & 0x80)) return v;
    }
    throw new Error('bad UIntBase128');
  };
  const tables: Array<{ tag: string; len: number }> = [];
  for (let i = 0; i < numTables; i++) {
    const flags = b[p++]!;
    const custom = (flags & 0x3f) === 63;
    const tag = custom ? b.toString('latin1', p, p + 4) : KNOWN_TAGS[flags & 0x3f]!;
    if (custom) p += 4;
    const version = (flags >> 6) & 3;
    let len = base128();
    const transformed = tag === 'glyf' || tag === 'loca' ? version !== 3 : version !== 0;
    if (transformed) len = base128();
    tables.push({ tag, len });
  }
  const data = brotliDecompressSync(b.subarray(p, p + totalCompressed));
  let off = 0;
  let cmap: Buffer | undefined;
  for (const t of tables) {
    if (t.tag === 'cmap') cmap = data.subarray(off, off + t.len);
    off += t.len;
  }
  if (!cmap) throw new Error(`no cmap: ${file}`);
  const out = new Set<number>();
  const n = cmap.readUInt16BE(2);
  for (let i = 0; i < n; i++) {
    const o = cmap.readUInt32BE(4 + i * 8 + 4);
    const format = cmap.readUInt16BE(o);
    if (format === 4) {
      const segX2 = cmap.readUInt16BE(o + 6);
      const ends = o + 14;
      const starts = ends + segX2 + 2;
      for (let s = 0; s < segX2 / 2; s++) {
        const end = cmap.readUInt16BE(ends + s * 2);
        for (let c = cmap.readUInt16BE(starts + s * 2); c <= end && c !== 0xffff; c++) out.add(c);
      }
    } else if (format === 12) {
      const groups = cmap.readUInt32BE(o + 12);
      for (let g = 0; g < groups; g++) {
        const end = cmap.readUInt32BE(o + 20 + g * 12);
        for (let c = cmap.readUInt32BE(o + 16 + g * 12); c <= end; c++) out.add(c);
      }
    }
  }
  return out;
}
