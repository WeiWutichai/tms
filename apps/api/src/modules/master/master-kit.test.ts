import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { isNoopUpdate, stableStringify } from './master-kit';

/** Defect ST2-T08 review: Date ถูกแปลงเป็น `{}` → แก้เฉพาะวันที่ถูกมองว่าไม่เปลี่ยน (PATCH/PUT ไม่บันทึก) */
describe('stableStringify / isNoopUpdate', () => {
  it('Date: ต่างวัน = ต่างกัน, วันเดียวกัน = เท่ากัน', () => {
    const a = new Date('2028-03-31T00:00:00Z');
    expect(stableStringify(a)).not.toBe('{}');
    expect(stableStringify(a)).toBe(stableStringify(new Date('2028-03-31T00:00:00Z')));
    expect(stableStringify(a)).not.toBe(stableStringify(new Date('2028-04-01T00:00:00Z')));
    expect(isNoopUpdate({ d: a }, { d: new Date('2028-04-01T00:00:00Z') })).toBe(false);
    expect(isNoopUpdate({ d: a }, { d: new Date(a) })).toBe(true);
    expect(isNoopUpdate({ d: null }, { d: a })).toBe(false);
    expect(isNoopUpdate({ d: a }, { d: null })).toBe(false);
  });

  it('Decimal: ค่าเท่ากันต่างรูปแบบ = เท่ากัน · ต่างค่า = ต่างกัน', () => {
    expect(stableStringify(new Prisma.Decimal('500000.00'))).toBe(
      stableStringify(new Prisma.Decimal(500000)),
    );
    expect(stableStringify(new Prisma.Decimal('1.50'))).not.toBe(
      stableStringify(new Prisma.Decimal('1.51')),
    );
    expect(
      isNoopUpdate({ x: new Prisma.Decimal('10.00') }, { x: new Prisma.Decimal('10.01') }),
    ).toBe(false);
    expect(isNoopUpdate({ x: new Prisma.Decimal('10.00') }, { x: '10' }, ['x'])).toBe(true);
  });

  it('BigInt / Buffer / object ซ้อน', () => {
    expect(stableStringify(10n)).not.toBe(stableStringify(11n));
    expect(stableStringify(Buffer.from('a'))).not.toBe(stableStringify(Buffer.from('b')));
    expect(stableStringify({ b: 1, a: new Date(0) })).toBe(
      stableStringify({ a: new Date(0), b: 1 }),
    );
    expect(stableStringify({ a: new Date(0) })).not.toBe(stableStringify({ a: new Date(1) }));
  });
});
