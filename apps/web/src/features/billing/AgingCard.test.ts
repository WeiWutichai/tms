import { describe, expect, it } from 'vitest';
import { agingPct, AGING_ORDER } from './AgingCard';

describe('การ์ดอายุลูกหนี้ (ST5-T22)', () => {
  it('ส่วนกว้างแถบ = ยอดช่วง / ยอดรวม ทศนิยม 2 ตำแหน่ง (ต้นแบบ) · ยอดรวม 0 / ไม่มีสิทธิ์ดูยอด = 0%', () => {
    expect(agingPct('3998587.00', '5100942.00')).toBe('78.39%');
    expect(agingPct('0.00', '0.00')).toBe('0.00%');
    expect(agingPct(undefined, undefined)).toBe('0.00%');
  });
  it('ลำดับช่วงตามต้นแบบ agingB', () => {
    expect(AGING_ORDER).toEqual([
      'NOT_DUE',
      'DAYS_1_30',
      'DAYS_31_60',
      'DAYS_61_90',
      'DAYS_OVER_90',
    ]);
  });
});
