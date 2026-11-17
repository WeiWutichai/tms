import { describe, expect, it } from 'vitest';
import {
  cheapestOf,
  cheapestReasonTh,
  decideSelection,
  formatBaht,
  isSubconRejectReason,
  offerTimeLeft,
  SUBCON_REJECT_REASONS,
  subconRejectLabelTh,
} from './subcon';

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

describe('offer link (ST3-T23)', () => {
  it('เหตุผลปฏิเสธ 4 ข้อตามต้นแบบ + ตรวจรหัส', () => {
    expect(SUBCON_REJECT_REASONS.map((r) => r.labelTh)).toEqual([
      'รถไม่ว่างวันที่รับงาน',
      'ราคาไม่คุ้มต้นทุน',
      'ไม่มีรถประเภทที่ต้องการ',
      'เส้นทางไม่สะดวก',
    ]);
    expect(isSubconRejectReason('PRICE_TOO_LOW')).toBe(true);
    expect(isSubconRejectReason('OTHER')).toBe(false);
    expect(isSubconRejectReason(1)).toBe(false);
    expect(subconRejectLabelTh('NO_VEHICLE_TYPE')).toBe('ไม่มีรถประเภทที่ต้องการ');
  });

  it('เวลาที่เหลือ: ชั่วโมงปัดลง · ต่ำกว่า 1 ชม. เป็นนาที · หมดแล้ว = null', () => {
    const now = new Date('2026-11-17T00:00:00Z');
    const at = (ms: number) => new Date(now.getTime() + ms);
    expect(offerTimeLeft(at(48 * 3600_000), now)).toEqual({ unit: 'h', n: 48 });
    expect(offerTimeLeft(at(36 * 3600_000 + 59 * 60_000), now)).toEqual({ unit: 'h', n: 36 });
    expect(offerTimeLeft(at(3600_000), now)).toEqual({ unit: 'h', n: 1 });
    expect(offerTimeLeft(at(59 * 60_000 + 1), now)).toEqual({ unit: 'm', n: 60 });
    expect(offerTimeLeft(at(10_000), now)).toEqual({ unit: 'm', n: 1 });
    expect(offerTimeLeft(at(0), now)).toBeNull();
    expect(offerTimeLeft(at(-5), now)).toBeNull();
  });
});
