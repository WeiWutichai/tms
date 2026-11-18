import { describe, expect, it } from 'vitest';
import { safe } from './export';

/** กัน CSV/formula injection (OWASP) — ทุกค่าที่ขึ้นต้นด้วย = + - @ tab CR (ST9-T10 review) */
describe('export safe()', () => {
  it("= + - @ tab CR → ใส่ ' นำหน้า", () => {
    for (const v of [
      '=1+1',
      '+A1',
      '-2+3',
      '\tx',
      '\rx',
      '\t=1',
      '@foo',
      '@SUM(A1:A2)',
      '@sapsomboon',
    ])
      expect(safe(v)).toBe(`'${v}`);
  });
  it('ข้อความทั่วไป / @ กลางข้อความ ไม่แก้', () => {
    expect(safe('ข้อความ')).toBe('ข้อความ');
    expect(safe('a@b.co')).toBe('a@b.co');
    expect(safe('1-2')).toBe('1-2');
  });
});
