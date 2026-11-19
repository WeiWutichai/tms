import { describe, expect, it } from 'vitest';
import {
  allocateSatang,
  allocateSatangRemainderTo,
  decimalFromSatang,
  mulRateHalfUp,
  satangFromDecimal,
} from './money';

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

describe('allocateSatang', () => {
  it('ผลรวมเท่ายอดเดิมพอดี — เศษไปตัวที่เศษมากสุด (เท่ากัน = ลำดับก่อน)', () => {
    expect(allocateSatang(1000n, [1n, 1n, 1n])).toEqual([334n, 333n, 333n]);
    expect(allocateSatang(100n, [1n, 2n])).toEqual([33n, 67n]);
    expect(allocateSatang(1n, [5n, 5n])).toEqual([1n, 0n]);
    expect(allocateSatang(500000n, [700n, 300n])).toEqual([350000n, 150000n]);
  });
  it('น้ำหนักรวม 0 = แบ่งเท่ากัน · ไม่มีน้ำหนัก = []', () => {
    expect(allocateSatang(10n, [0n, 0n, 0n])).toEqual([4n, 3n, 3n]);
    expect(allocateSatang(10n, [])).toEqual([]);
    expect(allocateSatang(0n, [1n, 2n])).toEqual([0n, 0n]);
  });
  it('ยอด/น้ำหนักติดลบ → RangeError', () => {
    expect(() => allocateSatang(-1n, [1n])).toThrow(RangeError);
    expect(() => allocateSatang(1n, [-1n, 2n])).toThrow(RangeError);
  });
});

describe('allocateSatangRemainderTo (ST6-T01c)', () => {
  it('ปันตามสัดส่วน เศษทั้งหมดให้ตัวที่กำหนด · ผลรวมเท่ายอดเดิม', () => {
    // 100.01 บาท ตามรายได้ 1:1:1 → 33.33 ×3 + เศษ 0.02 ไปตัวที่ index 1
    expect(allocateSatangRemainderTo(10001n, [100n, 100n, 100n], 1)).toEqual([3333n, 3335n, 3333n]);
    const r = allocateSatangRemainderTo(480050n, [300000n, 125000n, 7n], 0);
    expect(r.reduce((a, b) => a + b, 0n)).toBe(480050n);
    expect(r[1]).toBe((480050n * 125000n) / 425007n);
  });
  it('ยอดติดลบ = กลับเครื่องหมายของการปันยอดบวก (กลับรายการหักล้างพอดี)', () => {
    const pos = allocateSatangRemainderTo(10001n, [1n, 2n], 1);
    const neg = allocateSatangRemainderTo(-10001n, [1n, 2n], 1);
    expect(neg).toEqual(pos.map((v) => -v));
  });
  it('น้ำหนักศูนย์ได้ 0 · น้ำหนักรวม 0 → ทั้งยอดไปตัวที่กำหนด · ผิดรูป → RangeError', () => {
    expect(allocateSatangRemainderTo(999n, [0n, 5n], 1)).toEqual([0n, 999n]);
    expect(allocateSatangRemainderTo(999n, [0n, 0n], 0)).toEqual([999n, 0n]);
    expect(() => allocateSatangRemainderTo(1n, [-1n, 2n], 0)).toThrow(RangeError);
    expect(() => allocateSatangRemainderTo(1n, [1n], 1)).toThrow(RangeError);
  });
});
