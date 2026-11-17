import { describe, expect, it } from 'vitest';
import {
  bodyOf,
  canResolve,
  fmtQty,
  modeOf,
  openLines,
  problems,
  resolvedLines,
  type DeliveryOrder,
} from './returnForm';

/** ST4-T11 dialog "ตีกลับบางส่วน" — กติกาบนหน้าจอ */
const line = (
  lineNo: number,
  reject: string,
  redelivered = '0',
  returned = '0',
  open = reject,
) => ({
  lineNo,
  soLineNo: lineNo,
  description: `สินค้า ${lineNo}`,
  qtyPlanned: '20',
  qtyActual: reject === '0' ? null : String(20 - Number(reject)),
  rejectQty: reject === '0' ? null : reject,
  rejectReasonCodeId: reject === '0' ? null : 'rsn_1',
  redeliveredQty: redelivered,
  returnedQty: returned,
  openRejectQty: open,
  unit: 'TON',
  weightKg: null,
  cbm: null,
});
const doOf = (status: string, lines: ReturnType<typeof line>[]) =>
  ({ id: 'do_1', doNo: 'DO-1', status, version: 3, lines }) as unknown as DeliveryOrder;

describe('returnForm (ST4-T11)', () => {
  it('modeOf / canResolve: ส่งแล้วต้องมีปฏิเสธคงเหลือ · ส่งไม่สำเร็จ = ทั้งใบ · สถานะอื่น = ไม่ได้', () => {
    expect(modeOf('UNBILLED')).toBe('rejected');
    expect(modeOf('FAILED')).toBe('failed');
    expect(modeOf('DRAFT')).toBeNull();
    expect(canResolve(doOf('UNBILLED', [line(1, '10')]))).toBe(true);
    expect(canResolve(doOf('UNBILLED', [line(1, '10', '10', '0', '0')]))).toBe(false);
    expect(canResolve(doOf('FAILED', [line(1, '0')]))).toBe(true);
    expect(canResolve(doOf('CANCELLED', [line(1, '10')]))).toBe(false);
  });

  it('openLines / resolvedLines / fmtQty', () => {
    const d = doOf('UNBILLED', [
      line(1, '10', '4', '0', '6'),
      line(2, '0'),
      line(3, '2', '0', '2', '0'),
    ]);
    expect(openLines(d).map((l) => l.lineNo)).toEqual([1]);
    expect(resolvedLines(d).map((l) => l.lineNo)).toEqual([1, 3]);
    expect(fmtQty('1234.5')).toBe('1,234.5');
  });

  it('problems: ต้องเลือกรายการ · ธงรูป/โน้ต (≥ 5) · ชื่อเหตุผล + โน้ต ≥ 10', () => {
    const r = { label: 'จำนวนไม่ครบ', requiresPhoto: true, requiresNote: false };
    const base = { items: [], action: 'redeliver' as const, reasonId: 'rsn_1', note: '' };
    expect(problems('rejected', base, r, 0)).toEqual(['pick', 'photo']);
    expect(problems('rejected', { ...base, items: [1] }, r, 1)).toEqual([]);
    expect(problems('failed', base, { ...r, requiresPhoto: false }, 0)).toEqual([]);
    const noteReq = { label: 'ลูกค้าปฏิเสธรับบางรายการ', requiresPhoto: false, requiresNote: true };
    expect(problems('rejected', { ...base, items: [1], note: 'บุบ' }, noteReq, 0)).toEqual([
      'note',
    ]);
    expect(problems('rejected', { ...base, items: [1], note: 'กล่องบุบ' }, noteReq, 0)).toEqual([]);
    const tiny = { label: 'บุบ', requiresPhoto: false, requiresNote: false };
    expect(problems('rejected', { ...base, items: [1] }, tiny, 0)).toEqual(['short']);
    expect(problems('rejected', { ...base, items: [1], note: 'สองกล่อง' }, tiny, 0)).toEqual([]);
    expect(problems('rejected', { ...base, items: [1] }, undefined, 0)).toEqual(['short']);
  });

  it('bodyOf: ส่งแล้ว = บรรทัดที่ติ๊ก × คงเหลือทั้งจำนวน · ส่งไม่สำเร็จ = ไม่ส่ง lines', () => {
    const d = doOf('UNBILLED', [line(1, '10', '4', '0', '6'), line(2, '3')]);
    const draft = { items: [1], action: 'redeliver' as const, reasonId: 'rsn_9', note: '  ' };
    expect(bodyOf('rejected', d, draft)).toEqual({
      reasonCodeId: 'rsn_9',
      note: null,
      lines: [{ lineNo: 1, qty: '6' }],
    });
    expect(bodyOf('failed', d, { ...draft, note: 'ร้านปิด' })).toEqual({
      reasonCodeId: 'rsn_9',
      note: 'ร้านปิด',
    });
  });
});
