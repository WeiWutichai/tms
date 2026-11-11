/**
 * ตรวจชนิดไฟล์จากเนื้อไฟล์ (magic bytes) ไม่เชื่อนามสกุล/Content-Type ที่ส่งมา (ST1-T08; docs/04 I "ตรวจ MIME จริง")
 * รองรับเฉพาะชนิดที่ระบบใช้: PDF, PNG, JPEG, WebP + ไฟล์นำเข้า .xlsx/.csv (ST1-T19 — kind IMPORT เท่านั้น)
 */
export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const ALLOWED_MIME = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  XLSX_MIME,
  'text/csv',
] as const;
/** ชนิดไฟล์ของ kind IMPORT (และ kind อื่นใช้ชนิดเหล่านี้ไม่ได้) */
export const IMPORT_MIME: readonly AllowedMime[] = [XLSX_MIME, 'text/csv'];
export type AllowedMime = (typeof ALLOWED_MIME)[number];
export const EXT: Record<AllowedMime, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  [XLSX_MIME]: 'xlsx',
  'text/csv': 'csv',
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
  // xlsx = zip ที่มี [Content_Types].xml และโฟลเดอร์ xl/ (ไม่แตกไฟล์ — แค่หาในส่วนหัวของ entry)
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) {
    const head = buf.subarray(0, Math.min(buf.length, 1 << 20)).toString('latin1');
    return head.includes('[Content_Types].xml') && head.includes('xl/') ? XLSX_MIME : null;
  }
  // csv = ข้อความล้วน (ไม่มี byte 0 และไม่มีอักขระควบคุมนอกจาก tab/CR/LF) — UTF-8 หรือ TIS-620
  const probe = buf.subarray(0, Math.min(buf.length, 64 * 1024));
  if (probe.length && !probe.some((b) => b < 0x09 || (b > 0x0d && b < 0x20) || b === 0x7f))
    return 'text/csv';
  return null;
}
