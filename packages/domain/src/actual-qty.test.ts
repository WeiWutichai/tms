import { describe, expect, it } from 'vitest';
import {
  billableQtyBySoLine,
  checkActualLines,
  hasShortfall,
  isQtyBasedPricing,
  milliQty,
  qtyText,
} from './actual-qty';

const PLAN = [
  { lineNo: 1, qtyPlanned: '100' },
  { lineNo: 2, qtyPlanned: '12.5' },
];

describe('milliQty / qtyText', () => {
  it('ทศนิยม ≤ 3 ตำแหน่ง ไม่มี float', () => {
    expect(milliQty('12.5')).toBe(12500n);
    expect(milliQty('0.001')).toBe(1n);
    expect(milliQty('1.0005')).toBeNull();
    expect(milliQty('-1')).toBeNull();
    expect(milliQty('1e3')).toBeNull();
    expect(qtyText(12500n)).toBe('12.5');
    expect(qtyText(100000n)).toBe('100');
    expect(qtyText(1n)).toBe('0.001');
  });
});

describe('checkActualLines', () => {
  it('ส่งจริงน้อยกว่าแผนโดยไม่มีเหตุผล → reason_required', () => {
    const r = checkActualLines(PLAN, [{ lineNo: 1, qtyActual: '90' }]);
    expect(r.errors).toEqual([{ index: 0, field: 'rejectReasonCodeId', code: 'reason_required' }]);
  });
  it('ส่งน้อยกว่าแผน + เหตุผล → ปฏิเสธ = แผน − ส่งจริง', () => {
    const r = checkActualLines(PLAN, [
      { lineNo: 2, qtyActual: '10.25', rejectReasonCodeId: 'rsn_1', note: ' กล่องบุบ ' },
    ]);
    expect(r.errors).toEqual([]);
    expect(r.lines).toEqual([
      {
        lineNo: 2,
        qtyPlanned: '12.5',
        qtyActual: '10.25',
        rejectQty: '2.25',
        rejectReasonCodeId: 'rsn_1',
        note: 'กล่องบุบ',
      },
    ]);
    expect(hasShortfall(r.lines)).toBe(true);
  });
  it('ส่งครบ = ไม่มีปฏิเสธ · ส่งเหตุผลมา = reason_not_applicable · โน้ตของบรรทัดครบถูกตัด', () => {
    expect(checkActualLines(PLAN, [{ lineNo: 1, qtyActual: '100' }]).lines[0]).toMatchObject({
      rejectQty: '0',
      rejectReasonCodeId: null,
    });
    expect(
      checkActualLines(PLAN, [{ lineNo: 1, qtyActual: '100', rejectReasonCodeId: 'rsn_1' }]).errors,
    ).toEqual([{ index: 0, field: 'rejectReasonCodeId', code: 'reason_not_applicable' }]);
  });
  it('เกินแผน / รูปผิด / บรรทัดไม่มี / ซ้ำ / rejectQty ไม่ตรง', () => {
    const r = checkActualLines(PLAN, [
      { lineNo: 1, qtyActual: '100.001' },
      { lineNo: 2, qtyActual: 'x' },
      { lineNo: 9, qtyActual: '1' },
    ]);
    expect(r.errors.map((e) => e.code)).toEqual(['exceeds_planned', 'invalid', 'unknown_line']);
    expect(
      checkActualLines(PLAN, [
        { lineNo: 1, qtyActual: '100' },
        { lineNo: 1, qtyActual: '100' },
      ]).errors[0]?.code,
    ).toBe('duplicate');
    expect(
      checkActualLines(PLAN, [
        { lineNo: 1, qtyActual: '90', rejectQty: '5', rejectReasonCodeId: 'r' },
      ]).errors[0]?.code,
    ).toBe('reject_qty_mismatch');
    expect(
      checkActualLines(PLAN, [
        { lineNo: 1, qtyActual: '90', rejectQty: '10', rejectReasonCodeId: 'r' },
      ]).errors,
    ).toEqual([]);
  });
  it('บรรทัดที่ไม่ส่ง = คงค่าเดิม · ส่งใหม่ทับ', () => {
    const prev = checkActualLines(PLAN, [
      { lineNo: 1, qtyActual: '90', rejectReasonCodeId: 'r' },
    ]).lines;
    const r = checkActualLines(PLAN, [{ lineNo: 2, qtyActual: '12.5' }], prev);
    expect(r.lines.map((l) => [l.lineNo, l.qtyActual])).toEqual([
      [1, '90'],
      [2, '12.5'],
    ]);
    const back = checkActualLines(PLAN, [{ lineNo: 1, qtyActual: '100' }], prev);
    expect(back.lines[0]).toMatchObject({ qtyActual: '100', rejectQty: '0' });
  });
  it('ส่งจริง 0 ได้ (ปฏิเสธทั้งบรรทัด) แต่ต้องมีเหตุผล', () => {
    expect(checkActualLines(PLAN, [{ lineNo: 1, qtyActual: '0' }]).errors[0]?.code).toBe(
      'reason_required',
    );
  });
});

describe('billableQtyBySoLine', () => {
  const lines = [
    { salesOrderLineId: 'a', qtyPlanned: '10', qtyActual: '8' },
    { salesOrderLineId: 'a', qtyPlanned: '5', qtyActual: null },
    { salesOrderLineId: 'b', qtyPlanned: '2.5', qtyActual: '2.5' },
    { salesOrderLineId: null, qtyPlanned: '99', qtyActual: '1' },
  ];
  it('ACTUAL ใช้ส่งจริง (ยังไม่บันทึก = แผน)', () => {
    expect(Object.fromEntries(billableQtyBySoLine(lines, 'ACTUAL'))).toEqual({ a: '13', b: '2.5' });
  });
  it('PLANNED ใช้แผนเสมอ', () => {
    expect(Object.fromEntries(billableQtyBySoLine(lines, 'PLANNED'))).toEqual({
      a: '15',
      b: '2.5',
    });
  });
});

describe('isQtyBasedPricing', () => {
  it('เฉพาะสูตรตามน้ำหนัก/ปริมาตร/หน่วยนับ', () => {
    expect(['PER_TON', 'PER_CBM', 'PER_UNIT'].every(isQtyBasedPricing)).toBe(true);
    expect(['PER_TRIP', 'PER_KM', 'PER_DAY', null].some(isQtyBasedPricing)).toBe(false);
  });
});
