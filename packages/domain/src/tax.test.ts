import { describe, expect, it } from 'vitest';
import { computeDocumentTax } from './tax';
import { decimalFromSatang, satangFromDecimal as d } from './money';

/**
 * เคสในไฟล์นี้เป็น "ตัวอย่างโครงสร้าง" — golden case จริงต้องให้นักบัญชีเซ็นรับ (plan/03 §4)
 * แล้วย้ายมาไว้ใน golden/*.json พร้อมเลขอ้างอิงเอกสารตัวอย่าง
 */
describe('computeDocumentTax', () => {
  it('ค่าขนส่งอย่างเดียว: ไม่มี VAT, หัก ณ ที่จ่าย 1%', () => {
    const r = computeDocumentTax([{ amount: d('10000.00'), vatType: 'EXEMPT', whtRate: '0.01' }]);
    expect(decimalFromSatang(r.vat)).toBe('0.00');
    expect(decimalFromSatang(r.grandTotal)).toBe('10000.00');
    expect(decimalFromSatang(r.wht)).toBe('100.00');
    expect(decimalFromSatang(r.netPayable)).toBe('9900.00');
  });

  it('ขนส่ง + บริการยก: VAT เฉพาะบริการ, WHT แยกอัตรา', () => {
    const r = computeDocumentTax([
      { amount: d('10000.00'), vatType: 'EXEMPT', whtRate: '0.01' },
      { amount: d('1500.00'), vatType: 'VAT7', whtRate: '0.03' },
    ]);
    expect(decimalFromSatang(r.exemptBase)).toBe('10000.00');
    expect(decimalFromSatang(r.vatableBase)).toBe('1500.00');
    expect(decimalFromSatang(r.vat)).toBe('105.00');
    expect(decimalFromSatang(r.grandTotal)).toBe('11605.00');
    expect(decimalFromSatang(r.wht)).toBe('145.00'); // 100 + 45
    expect(decimalFromSatang(r.netPayable)).toBe('11460.00');
  });

  it('ปัดเศษ VAT ครั้งเดียวทั้งใบ และกระจายเศษให้บรรทัดสุดท้าย', () => {
    // 33.33 × 3 บรรทัด = 99.99 → VAT 7% = 6.9993 → 7.00 (ปัดรวม) ขณะที่ปัดรายบรรทัด 2.33 × 3 = 6.99
    const r = computeDocumentTax([
      { amount: d('33.33'), vatType: 'VAT7', whtRate: '0' },
      { amount: d('33.33'), vatType: 'VAT7', whtRate: '0' },
      { amount: d('33.33'), vatType: 'VAT7', whtRate: '0' },
    ]);
    expect(decimalFromSatang(r.vat)).toBe('7.00');
    expect(r.lines.map((l) => decimalFromSatang(l.vat))).toEqual(['2.33', '2.33', '2.34']);
  });

  it('บรรทัดติดลบ (ส่วนลด/ใบลดหนี้) หักฐานและ VAT ถูกต้อง', () => {
    const r = computeDocumentTax([
      { amount: d('1000.00'), vatType: 'VAT7', whtRate: '0.03' },
      { amount: d('-100.00'), vatType: 'VAT7', whtRate: '0.03' },
    ]);
    expect(decimalFromSatang(r.vatableBase)).toBe('900.00');
    expect(decimalFromSatang(r.vat)).toBe('63.00');
    expect(decimalFromSatang(r.wht)).toBe('27.00');
  });
});
