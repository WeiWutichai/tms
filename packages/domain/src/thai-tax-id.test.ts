import { describe, expect, it } from 'vitest';
import { isValidThaiTaxId, thaiTaxIdKind } from './thai-tax-id';

describe('isValidThaiTaxId (PLT-020)', () => {
  it('เลขนิติบุคคลจริง 5 เลขจาก research §6 ผ่าน', () => {
    for (const v of [
      '0105567153766',
      '0465566000581',
      '0105560098301',
      '0107536000633',
      '0105536092641',
    ])
      expect(isValidThaiTaxId(v)).toBe(true);
  });
  it('check digit ผิด / ไม่ครบ 13 หลัก / มีตัวอักษร → false', () => {
    expect(isValidThaiTaxId('0105567153767')).toBe(false);
    expect(isValidThaiTaxId('010556715376')).toBe(false);
    expect(isValidThaiTaxId('01055671537a6')).toBe(false);
    expect(isValidThaiTaxId('')).toBe(false);
  });
  it('ประเภทจากหลักแรก', () => {
    expect(thaiTaxIdKind('0105567153766')).toBe('juristic');
    expect(thaiTaxIdKind('1101700203451')).toBe('individual');
  });
});
