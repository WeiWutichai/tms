import { describe, expect, it } from 'vitest';
import { safeNextPath } from './Login';

/** ST9-T13 รอบสุดท้าย R2-L01 — `?next=` หลัง login ต้องเป็น path ภายในเท่านั้น (กัน open redirect) */
describe('safeNextPath', () => {
  it('path ภายในผ่าน (รวม query ที่ encode แล้ว)', () => {
    expect(safeNextPath('/orders')).toBe('/orders');
    expect(safeNextPath('/billing?tab=notes&q=a%20b')).toBe('/billing?tab=notes&q=a%20b');
  });

  it('ไม่มีค่า / URL ภายนอก / protocol-relative → /', () => {
    for (const n of [
      null,
      '',
      'orders',
      'https://evil.example',
      '//evil.example',
      'javascript:alert(1)',
    ])
      expect(safeNextPath(n)).toBe('/');
  });

  it('backslash (GHSA-wrjc-x8rr-h8h6: /\\evil → //evil) และอักขระควบคุม/ช่องว่าง → /', () => {
    for (const n of [
      '/\\evil.example',
      '/\\\\evil.example',
      '/a\\b',
      '/\t/evil.example',
      '/ /x',
      '/\n//evil',
    ])
      expect(safeNextPath(n)).toBe('/');
    // backslash ที่ encode แล้วอยู่ใน path ตามตัวอักษร — ไม่ถูกแปลงเป็น `/`
    expect(safeNextPath('/%5Cevil.example')).toBe('/%5Cevil.example');
  });
});
