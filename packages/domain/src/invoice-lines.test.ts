import { describe, expect, it } from 'vitest';
import { canMergeInvoiceLines, invoicePrintLines, type InvoiceDetailLine } from './invoice-lines';

const L = (o: Partial<InvoiceDetailLine> & { id: string; lineNo: number }): InvoiceDetailLine => ({
  serviceItemId: 'freight',
  description: 'ค่าขนส่ง ชลบุรี → ระยอง',
  quantity: '5',
  unitLabel: 'ตัน',
  unitPrice: '350.00',
  amount: '1750.00',
  discount: '0.00',
  vatType: 'EXEMPT_TRANSPORT',
  whtRate: '1.00',
  printGroup: null,
  deliveryOrderNo: null,
  ...o,
});

describe('invoicePrintLines (ST5-T07 Group / Merge / Single)', () => {
  const lines = [
    L({ id: 'a', lineNo: 1, deliveryOrderNo: 'DO-1' }),
    L({
      id: 'b',
      lineNo: 2,
      serviceItemId: 'load',
      description: 'ค่ายกขน',
      quantity: '1',
      unitLabel: 'ครั้ง',
      unitPrice: '500.00',
      amount: '500.00',
      vatType: 'VAT_7',
      whtRate: '3.00',
      deliveryOrderNo: 'DO-1',
    }),
    L({ id: 'c', lineNo: 3, quantity: '2.5', amount: '875.00', deliveryOrderNo: 'DO-2' }),
    L({
      id: 'd',
      lineNo: 4,
      unitPrice: '400.00',
      amount: '2000.00',
      discount: '100.00',
      deliveryOrderNo: 'DO-3',
    }),
  ];

  it('SINGLE = บรรทัดละรายการ ตามเลขบรรทัด', () => {
    const p = invoicePrintLines([...lines].reverse(), 'SINGLE');
    expect(p.map((x) => x.lineIds)).toEqual([['a'], ['b'], ['c'], ['d']]);
    expect(p.map((x) => x.no)).toEqual([1, 2, 3, 4]);
  });

  it('GROUP รวมรายการ/ราคาเดียวกัน → จำนวนรวม · ราคาต่างกันแยก · ไม่รวมข้าม VAT', () => {
    const p = invoicePrintLines(lines, 'GROUP');
    expect(p.map((x) => x.lineIds)).toEqual([['a', 'c'], ['b'], ['d']]);
    expect(p[0]).toMatchObject({
      quantity: '7.5',
      unitPrice: '350.00',
      amount: '2625.00',
      deliveryOrderNos: ['DO-1', 'DO-2'],
    });
  });

  it('MERGE รวมตามรายการบริการ — ราคาต่อหน่วยต่างกัน → ไม่แสดงราคา · ส่วนลดรวม', () => {
    const p = invoicePrintLines(lines, 'MERGE');
    expect(p.map((x) => x.lineIds)).toEqual([['a', 'c', 'd'], ['b']]);
    expect(p[0]).toMatchObject({
      quantity: '12.5',
      unitPrice: null,
      amount: '4625.00',
      discount: '100.00',
    });
  });

  it('กลุ่มที่ผู้ใช้รวมเองมาก่อนรูปของใบ · หน่วยต่างกัน → ไม่แสดงจำนวน', () => {
    const p = invoicePrintLines(
      [
        L({ id: 'a', lineNo: 1, printGroup: 1 }),
        L({ id: 'x', lineNo: 2, unitLabel: 'เที่ยว', quantity: '1', printGroup: 1 }),
        L({ id: 'c', lineNo: 3 }),
      ],
      'SINGLE',
    );
    expect(p.map((x) => x.lineIds)).toEqual([['a', 'x'], ['c']]);
    expect(p[0]).toMatchObject({ manual: true, quantity: null, unitLabel: null, unitPrice: null });
  });

  it('กลุ่มเดียวกันแต่ภาษีต่างกัน (ข้อมูลผิด) ก็ไม่รวมข้าม VAT/WHT', () => {
    const p = invoicePrintLines(
      [
        L({ id: 'a', lineNo: 1, printGroup: 1 }),
        L({ id: 'b', lineNo: 2, printGroup: 1, vatType: 'VAT_7' }),
      ],
      'MERGE',
    );
    expect(p).toHaveLength(2);
  });

  it('canMergeInvoiceLines: ต้อง ≥ 2 บรรทัด และ VAT + WHT เดียวกัน', () => {
    expect(canMergeInvoiceLines([lines[0]!])).toBe(false);
    expect(canMergeInvoiceLines([lines[0]!, lines[2]!])).toBe(true);
    expect(canMergeInvoiceLines([lines[0]!, lines[1]!])).toBe(false);
    expect(canMergeInvoiceLines([lines[0]!, { vatType: 'EXEMPT_TRANSPORT', whtRate: '1' }])).toBe(
      true,
    );
  });
});
