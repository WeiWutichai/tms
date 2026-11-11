import { describe, expect, it } from 'vitest';
import { safe } from './export';

/** กัน CSV/formula injection (OWASP) — `@` เฉพาะที่ดูเป็นสูตร (ST2-T05 QA: LINE ID) */
describe('export safe()', () => {
  it("= + - tab CR → ใส่ ' นำหน้า", () => {
    for (const v of ['=1+1', '+A1', '-2+3', '\tx', '\rx']) expect(safe(v)).toBe(`'${v}`);
  });
  it("@ฟังก์ชัน( → ใส่ ' · LINE ID / อีเมลไม่แก้", () => {
    expect(safe('@SUM(A1:A2)')).toBe("'@SUM(A1:A2)");
    expect(safe('@HYPERLINK("x")')).toBe('\'@HYPERLINK("x")');
    expect(safe('@sapsomboon')).toBe('@sapsomboon');
    expect(safe('@sriracha-lgs')).toBe('@sriracha-lgs');
    expect(safe('ข้อความ')).toBe('ข้อความ');
  });
});
