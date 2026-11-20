import { describe, expect, it } from 'vitest';
import { billRanges, selectionTotals } from './billing';

describe('billRanges (ต้นแบบ vBill ranges)', () => {
  it('งวดครึ่งเดือน · เดือนก่อน · 7 วันล่าสุด', () => {
    expect(billRanges('2026-11-04')).toEqual([
      { from: '2026-10-16', to: '2026-11-04' },
      { from: '2026-10-01', to: '2026-10-31' },
      { from: '2026-10-28', to: '2026-11-04' },
    ]);
    expect(billRanges('2026-01-10')[1]).toEqual({ from: '2025-12-01', to: '2025-12-31' });
  });
});

describe('selectionTotals — VAT ประมาณการจากฐาน 7% เท่านั้น', () => {
  it('ค่าขนส่งยกเว้น + บริการประกอบ 7%', () => {
    expect(
      selectionTotals([
        {
          sellFreightAmount: '1750.00',
          sellServiceAmount: '500.00',
          sellExemptBase: '1750.00',
          sellVatableBase: '500.00',
          sellTotal: '2250.00',
        },
        {
          sellFreightAmount: '1000.50',
          sellServiceAmount: '0.00',
          sellExemptBase: '1000.50',
          sellVatableBase: '0.00',
          sellTotal: '1000.50',
        },
      ]),
    ).toEqual({ freight: '2750.50', service: '500.00', vat: '35.00', net: '3285.50' });
  });
  it('ไม่ได้ติ๊ก = 0', () => {
    expect(selectionTotals([])).toEqual({
      freight: '0.00',
      service: '0.00',
      vat: '0.00',
      net: '0.00',
    });
  });
});
