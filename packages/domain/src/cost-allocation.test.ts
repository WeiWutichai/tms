import { describe, expect, it } from 'vitest';
import { allocateTripCostLines, type CostAllocationLine } from './cost-allocation';

const L = (id: string, amount: bigint, reversalOfId: string | null = null): CostAllocationLine => ({
  id,
  amount,
  reversalOfId,
});
const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

describe('allocateTripCostLines (ST6-T01c)', () => {
  it('ปันยอดรวมของเที่ยวครั้งเดียว: เศษทั้งหมดไปตัวรับเศษ (3.34/3.33/3.33 ไม่ใช่ 3.40/3.30/3.30)', () => {
    // 10 บรรทัด × 1.00 บาท รายได้เท่ากัน 3 DO → รวม 10.00 = 3.34 / 3.33 / 3.33
    const lines = Array.from({ length: 10 }, (_, i) => L(`l${i}`, 100n));
    const r = allocateTripCostLines(lines, [1n, 1n, 1n]);
    expect(r.targets).toEqual([334n, 333n, 333n]);
    const perDo = [0n, 0n, 0n];
    for (const l of lines) {
      const p = r.perLine.get(l.id)!;
      expect(sum(p)).toBe(100n);
      expect(p.every((v) => v >= 0n)).toBe(true);
      p.forEach((v, i) => (perDo[i]! += v));
    }
    expect(perDo).toEqual([334n, 333n, 333n]);
  });
  it('ค่าตัวอย่าง: 4800.50 + 180.01 ตามรายได้ 200:100:0 → ยอดรวม 4980.51 ปันครั้งเดียว', () => {
    const r = allocateTripCostLines([L('fee', 480050n), L('toll', 18001n)], [200n, 100n, 0n]);
    expect(r.targets).toEqual([332034n, 166017n, 0n]); // 498051 ÷ 3 ลงตัว — ไม่มีเศษ
    expect(sum(r.perLine.get('fee')!)).toBe(480050n);
    expect(sum(r.perLine.get('toll')!)).toBe(18001n);
  });
  it('คู่กลับรายการหักล้างพอดีต่อ DO · บรรทัดติดลบไม่มีคู่ยังลงตัว', () => {
    const r = allocateTripCostLines(
      [L('a', 480050n), L('b', -480050n, 'a'), L('c', 520000n), L('d', 2n), L('e', -1n)],
      [1n, 1n, 1n],
    );
    const a = r.perLine.get('a')!;
    expect(r.perLine.get('b')).toEqual(a.map((v) => -v));
    expect(r.targets).toEqual([173335n, 173333n, 173333n]);
  });
  it('น้ำหนักรวม 0 → ทั้งยอดไปตัวรับเศษ · ไม่มีบรรทัด → 0 · สุทธิติดลบ → RangeError', () => {
    expect(allocateTripCostLines([L('a', 5n)], [0n, 0n]).targets).toEqual([5n, 0n]);
    expect(allocateTripCostLines([], [3n, 1n]).targets).toEqual([0n, 0n]);
    expect(() => allocateTripCostLines([L('a', -5n)], [1n])).toThrow(RangeError);
  });
});
