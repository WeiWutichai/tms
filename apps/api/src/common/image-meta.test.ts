import { describe, expect, it } from 'vitest';
import { stripImageMetadata } from './image-meta';

/** ST4-T14 EXE-064: ตัด EXIF/GPS/ข้อความแฝงจากรูปที่ออกหน้าติดตามสาธารณะ */
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
};

describe('stripImageMetadata', () => {
  it('JPEG: ทิ้ง APP1 (EXIF) + COM เก็บ APP0 และข้อมูลภาพ', () => {
    const seg = (m: number, body: string) => {
      const b = Buffer.from(body, 'latin1');
      const h = Buffer.alloc(4);
      h.writeUInt16BE(0xff00 | m, 0);
      h.writeUInt16BE(b.length + 2, 2);
      return Buffer.concat([h, b]);
    };
    const jpg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      seg(0xe0, 'JFIF\0'),
      seg(0xe1, 'Exif\0\0GPS-SECRET'),
      seg(0xfe, 'comment-SECRET'),
      Buffer.from([0xff, 0xda, 0x00, 0x02, 0x01, 0x02, 0xff, 0xd9]),
    ]);
    const out = stripImageMetadata(jpg, 'image/jpeg')!;
    expect(out.includes(Buffer.from('SECRET'))).toBe(false);
    expect(out.includes(Buffer.from('JFIF'))).toBe(true);
    expect(out.subarray(-4).equals(Buffer.from([0x01, 0x02, 0xff, 0xd9]))).toBe(true);
  });

  it('PNG: ทิ้ง eXIf/tEXt/iTXt เก็บ IHDR/IDAT/IEND', () => {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const png = Buffer.concat([
      sig,
      chunk('IHDR', Buffer.alloc(13)),
      chunk('tEXt', Buffer.from('Author\0SECRET')),
      chunk('eXIf', Buffer.from('GPS-SECRET')),
      chunk('IDAT', Buffer.from('pixels')),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    const out = stripImageMetadata(png, 'image/png')!;
    expect(out.includes(Buffer.from('SECRET'))).toBe(false);
    expect(out.includes(Buffer.from('pixels'))).toBe(true);
  });

  it('WebP: ทิ้ง EXIF/XMP + ล้างธง VP8X + ขนาด RIFF ใหม่ · ไม่รู้จัก/เสีย → null', () => {
    const c = (type: string, data: Buffer) => {
      const h = Buffer.alloc(8);
      h.write(type, 0, 'latin1');
      h.writeUInt32LE(data.length, 4);
      return Buffer.concat([h, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
    };
    const vp8x = Buffer.alloc(10);
    vp8x[0] = 0x0c;
    const body = Buffer.concat([
      c('VP8X', vp8x),
      c('VP8 ', Buffer.from('frame!')),
      c('EXIF', Buffer.from('GPS-SECRET')),
      c('XMP ', Buffer.from('<x>SECRET</x>')),
    ]);
    const head = Buffer.alloc(12);
    head.write('RIFF', 0, 'latin1');
    head.writeUInt32LE(body.length + 4, 4);
    head.write('WEBP', 8, 'latin1');
    const out = stripImageMetadata(Buffer.concat([head, body]), 'image/webp')!;
    expect(out.includes(Buffer.from('SECRET'))).toBe(false);
    expect(out.readUInt32LE(4)).toBe(out.length - 8);
    expect(out[20]! & 0x0c).toBe(0);
    expect(stripImageMetadata(Buffer.from('not an image'), 'image/png')).toBeNull();
    expect(stripImageMetadata(Buffer.from([0xff, 0xd8, 0x00]), 'image/jpeg')).toBeNull();
  });
});
