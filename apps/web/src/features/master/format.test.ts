import { describe, expect, it } from 'vitest';
import { signedNum, tempRange } from './format';

describe('format อุณหภูมิ', () => {
  it('ใช้เครื่องหมายลบ U+2212 และเว้นวรรครอบ en dash เมื่อมีค่าติดลบ', () => {
    expect(signedNum(-2)).toBe('−2');
    expect(tempRange(2, 8)).toBe('2–8 °C');
    expect(tempRange(-18.5, -10)).toBe('−18.5 – −10 °C');
    expect(tempRange(-2, 4)).toBe('−2 – 4 °C');
  });
});
