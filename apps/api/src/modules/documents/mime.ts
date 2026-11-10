/**
 * ตรวจชนิดไฟล์จากเนื้อไฟล์ (magic bytes) ไม่เชื่อนามสกุล/Content-Type ที่ส่งมา (ST1-T08; docs/04 I "ตรวจ MIME จริง")
 * รองรับเฉพาะชนิดที่ระบบใช้: PDF, PNG, JPEG, WebP — ชนิดอื่นถูกปฏิเสธ
 */
export const ALLOWED_MIME = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'] as const;
export type AllowedMime = (typeof ALLOWED_MIME)[number];
export const EXT: Record<AllowedMime, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

export function sniffMime(buf: Buffer): AllowedMime | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-')
    return 'application/pdf';
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp';
  return null;
}
