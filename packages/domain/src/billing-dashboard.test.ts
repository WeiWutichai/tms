import { describe, expect, it } from 'vitest';
import { addMonths, billingMonthRanges, isMonth, monthRange, monthSpan } from './billing-dashboard';

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

describe('เดือนของรายงานรายได้ (ST9-T05)', () => {
  it('addMonths / monthRange / monthSpan / isMonth', () => {
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-11', -11)).toBe('2025-12');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(monthRange('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(monthRange('2026-11')).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(monthSpan('2025-12', '2026-11')).toBe(12);
    expect(monthSpan('2026-11', '2026-10')).toBe(0);
    expect(isMonth('2026-13')).toBe(false);
    expect(isMonth('2026-1')).toBe(false);
    expect(isMonth('2026-01')).toBe(true);
  });
});
