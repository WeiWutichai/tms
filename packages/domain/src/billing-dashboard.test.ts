import { describe, expect, it } from 'vitest';
import { billingMonthRanges } from './billing-dashboard';

describe('billingMonthRanges (ST9-T02 เดือนนี้ vs เดือนก่อน)', () => {
  it('เดือนนี้ = วันที่ 1 ถึงวันนี้ · เดือนก่อน = ทั้งเดือน', () => {
    expect(billingMonthRanges('2026-11-22')).toEqual({
      thisMonth: { month: '2026-11', from: '2026-11-01', to: '2026-11-22' },
      lastMonth: { month: '2026-10', from: '2026-10-01', to: '2026-10-31' },
    });
  });
  it('มกราคม → ธันวาคมปีก่อน', () => {
    expect(billingMonthRanges('2027-01-01').lastMonth).toEqual({
      month: '2026-12',
      from: '2026-12-01',
      to: '2026-12-31',
    });
  });
  it('กุมภาพันธ์ปีอธิกสุรทิน / ปีปกติ', () => {
    expect(billingMonthRanges('2028-03-05').lastMonth.to).toBe('2028-02-29');
    expect(billingMonthRanges('2027-03-05').lastMonth.to).toBe('2027-02-28');
  });
  it('วันที่ผิดรูปแบบ → error', () => {
    expect(() => billingMonthRanges('2026-1-2')).toThrow();
  });
});
