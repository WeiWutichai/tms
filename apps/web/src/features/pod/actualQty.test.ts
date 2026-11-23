import { describe, expect, it } from 'vitest';
import { anyShort, linesBody, linesDraftOf, milli, qtyStr, rejectOf } from './actualQty';
import type { DoPod } from './usePod';

/** ST4-T10 ยอดส่งจริงในฟอร์มหลักฐานส่ง — ค่าเริ่ม = แผน · ส่ง lines เฉพาะเมื่อแก้ · เหตุผลชุดเดียวใช้กับบรรทัดที่ขาด */
const L = (x: Partial<DoPod['lines'][number]> = {}): DoPod['lines'][number] => ({
  doLineId: `dol_${String(x.lineNo ?? 1).padStart(32, '0')}`,
  lineNo: 1,
  description: 'ปูนซีเมนต์',
  unit: 'ตัน',
  qtyPlanned: '20',
  qtyActual: null,
  rejectQty: null,
  rejectReason: null,
  note: null,
  ...x,
});
const pod = (lines: DoPod['lines']) => ({ lines }) as DoPod;

describe('actualQty', () => {
  it('milli / qtyStr ไม่มี float', () => {
    expect(milli('1,250.5')).toBe(1250500n);
    expect(milli('1.0001')).toBeNull();
    expect(qtyStr(2500n)).toBe('2.5');
  });
  it('ค่าเริ่ม = ที่บันทึกไว้ หรือแผน · เหตุผล/โน้ตจากบรรทัดที่ขาด', () => {
    const p = pod([
      L(),
      L({
        lineNo: 2,
        qtyPlanned: '5',
        qtyActual: '4',
        rejectQty: '1',
        rejectReason: { id: 'rsn_a', code: 'SHORT_QTY', label: 'จำนวนไม่ครบ' },
        note: 'ขาด 1',
      }),
    ]);
    expect(linesDraftOf(p)).toEqual({ qty: { 1: '20', 2: '4' }, reason: 'rsn_a', note: 'ขาด 1' });
  });
  it('ไม่แก้ = ไม่ส่ง lines · แก้ = ส่งทุกบรรทัด + เหตุผลเฉพาะบรรทัดที่ขาด', () => {
    const p = pod([L(), L({ lineNo: 2, qtyPlanned: '5' })]);
    const d = linesDraftOf(p);
    expect(linesBody(p, d)).toBeUndefined();
    const d2 = { ...d, qty: { ...d.qty, 1: '18' }, reason: 'rsn_a', note: ' กล่องบุบ ' };
    expect(anyShort(p, d2)).toBe(true);
    expect(linesBody(p, d2)).toEqual([
      { lineNo: 1, qtyActual: '18', rejectReasonCodeId: 'rsn_a', note: 'กล่องบุบ' },
      { lineNo: 2, qtyActual: '5' },
    ]);
    // ขาดแต่ยังไม่เลือกเหตุผล → ส่ง null ให้ API ตอบ reason_required
    expect(linesBody(p, { ...d, qty: { 1: '18', 2: '5' } })![0]).toMatchObject({
      rejectReasonCodeId: null,
    });
  });
  it('rejectOf: เกินแผน/ผิดรูป = null', () => {
    expect(rejectOf(L(), '18')).toBe(2000n);
    expect(rejectOf(L(), '21')).toBeNull();
    expect(rejectOf(L(), 'x')).toBeNull();
  });
});
