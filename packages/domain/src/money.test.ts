import { describe, expect, it } from 'vitest';
import { decimalFromSatang, mulRateHalfUp, satangFromDecimal } from './money';

describe('money', () => {
  it('แปลงไปกลับไม่เสียค่า', () => {
    for (const v of ['0.00', '0.05', '1234.50', '-7.01', '99999999999.99']) {
      expect(decimalFromSatang(satangFromDecimal(v))).toBe(v);
    }
  });
  it('ปฏิเสธทศนิยมเกิน 2 ตำแหน่งและรูปแบบผิด', () => {
    expect(() => satangFromDecimal('1.005')).toThrow(RangeError);
    expect(() => satangFromDecimal('1e3')).toThrow(RangeError);
    expect(() => satangFromDecimal('abc')).toThrow(RangeError);
  });
  it('ปัด half-up ที่สตางค์', () => {
    expect(mulRateHalfUp(satangFromDecimal('100.05'), '0.07')).toBe(700n); // 7.0035 → 7.00
    expect(mulRateHalfUp(satangFromDecimal('100.07'), '0.07')).toBe(700n); // 7.0049 → 7.00
    expect(mulRateHalfUp(satangFromDecimal('100.08'), '0.07')).toBe(701n); // 7.0056 → 7.01
    expect(mulRateHalfUp(satangFromDecimal('50.00'), '0.07')).toBe(350n);
    expect(mulRateHalfUp(satangFromDecimal('-50.00'), '0.01')).toBe(-50n);
  });
});
