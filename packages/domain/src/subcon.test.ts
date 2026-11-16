import { describe, expect, it } from 'vitest';
import { cheapestOf, cheapestReasonTh, decideSelection, formatBaht } from './subcon';

const C = [
  { carrierId: 'a', amount: '5200.00' },
  { carrierId: 'b', amount: '4800.50' },
  { carrierId: 'c', amount: null },
  { carrierId: 'd', amount: '4800.50' },
];

describe('subcon selection (ST3-T22)', () => {
  it('ราคาต่ำสุด — ไม่นับรายที่คิดราคาไม่ได้ · เท่ากันได้หลายราย', () => {
    expect(cheapestOf(C)).toEqual({ amount: '4800.50', carrierIds: ['b', 'd'] });
    expect(cheapestOf([{ carrierId: 'x', amount: null }])).toEqual({
      amount: null,
      carrierIds: [],
    });
  });

  it('จ้างราคา ≤ ต่ำสุด = ถูกสุด ไม่ต้องให้เหตุผล', () => {
    expect(decideSelection('4800.50', C)).toMatchObject({
      isCheapest: true,
      kind: 'CHEAPEST',
      reasonRequired: false,
    });
    expect(decideSelection('4000', C).isCheapest).toBe(true);
  });

  it('จ้างแพงกว่าต่ำสุด 1 สตางค์ = ต้องให้เหตุผล', () => {
    expect(decideSelection('4800.51', C)).toMatchObject({
      isCheapest: false,
      kind: 'OVERRIDE',
      reasonRequired: true,
      cheapestAmount: '4800.50',
    });
  });

  it('ไม่มีราคาให้เทียบ = ต้องให้เหตุผล', () => {
    expect(decideSelection('100.00', [{ carrierId: 'c', amount: null }])).toMatchObject({
      cheapestAmount: null,
      reasonRequired: true,
    });
    expect(decideSelection('100.00', []).reasonRequired).toBe(true);
  });

  it('ข้อความเหตุผลของระบบ + รูปตัวเลข', () => {
    expect(formatBaht('1234567.5')).toBe('1,234,567.50');
    expect(formatBaht('-800.00')).toBe('-800.00');
    expect(cheapestReasonTh(3)).toBe('ราคาถูกสุดจาก 3 รายที่มี rate card ขาซื้อ');
  });
});
