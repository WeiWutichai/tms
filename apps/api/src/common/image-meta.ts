/**
 * ตัด metadata ที่อาจมีข้อมูลส่วนบุคคล (EXIF/GPS, XMP, IPTC, คอมเมนต์, ข้อความแฝง) ออกจากรูป — ST4-T14 EXE-064
 * ใช้กับรูปที่ส่งออกช่องทางสาธารณะ (หน้าติดตามของผู้รับ) · ไม่ decode/ย่อภาพ (ย่อ ≤ 1280px = plan/01 §5 #26)
 * รูปแบบที่ไม่รู้จัก/โครงสร้างเสีย → คืน null (ผู้เรียกไม่ส่งรูปนั้น)
 */
export function stripImageMetadata(data: Buffer, mime: string): Buffer | null {
  try {
    if (mime === 'image/jpeg') return stripJpeg(data);
    if (mime === 'image/png') return stripPng(data);
    if (mime === 'image/webp') return stripWebp(data);
  } catch {
    return null;
  }
  return null;
}

/** JPEG: ทิ้ง APP1 (EXIF/XMP), APP12–APP15 (IPTC/Photoshop ฯลฯ), COM — เก็บ APP0 (JFIF), APP2 (ICC), APP14 (Adobe สี) */
function stripJpeg(b: Buffer): Buffer | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const out: Buffer[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1]!;
    if (m === 0xda) {
      out.push(b.subarray(i)); // SOS → ข้อมูลภาพจนจบไฟล์
      return Buffer.concat(out);
    }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      out.push(b.subarray(i, i + 2));
      i += 2;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > b.length) return null;
    const drop = m === 0xe1 || m === 0xec || m === 0xed || m === 0xef || m === 0xfe;
    if (!drop) out.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  return null;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_DROP = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

/** PNG: ทิ้ง chunk eXIf / tEXt / zTXt / iTXt / tIME */
function stripPng(b: Buffer): Buffer | null {
  if (b.length < 8 || !b.subarray(0, 8).equals(PNG_SIG)) return null;
  const out: Buffer[] = [PNG_SIG];
  let i = 8;
  while (i + 12 <= b.length) {
    const len = b.readUInt32BE(i);
    const type = b.toString('latin1', i + 4, i + 8);
    const end = i + 12 + len;
    if (end > b.length) return null;
    if (!PNG_DROP.has(type)) out.push(b.subarray(i, end));
    i = end;
    if (type === 'IEND') return Buffer.concat(out);
  }
  return null;
}

/** WebP: ทิ้ง chunk EXIF / XMP + ล้างธงใน VP8X แล้วคำนวณขนาด RIFF ใหม่ */
function stripWebp(b: Buffer): Buffer | null {
  if (
    b.length < 12 ||
    b.toString('latin1', 0, 4) !== 'RIFF' ||
    b.toString('latin1', 8, 12) !== 'WEBP'
  )
    return null;
  const chunks: Buffer[] = [];
  let i = 12;
  while (i + 8 <= b.length) {
    const type = b.toString('latin1', i, i + 4);
    const len = b.readUInt32LE(i + 4);
    const end = i + 8 + len + (len % 2);
    if (i + 8 + len > b.length) return null;
    const c = Buffer.from(b.subarray(i, Math.min(end, b.length)));
    if (type === 'VP8X' && c.length > 8) c[8] = c[8]! & ~0x0c; // ธง EXIF (0x08) + XMP (0x04)
    if (type !== 'EXIF' && type !== 'XMP ') chunks.push(c);
    i = end;
  }
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length + 4, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}
