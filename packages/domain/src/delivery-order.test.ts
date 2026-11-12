import { describe, expect, it } from 'vitest';
import {
  DO_EVENTS,
  DO_STATUSES,
  DO_STATUS_LABEL_TH,
  DO_TRANSITIONS,
  DoRuleError,
  checkMergeable,
  doTotals,
  formatMilli,
  isDoActive,
  isDoEditable,
  parseMilli,
  planAllocation,
  planMerge,
  planSplit,
  remainingBySoLine,
  type DoLinePlan,
  type DoStatus,
  type SoLineInfo,
} from './delivery-order';
import { InvalidTransitionError, canTransition, transition } from './state-machine';

/** ตารางที่คาดหวัง (docs/01 §4.3 + D-23) — ทุกคู่ที่ไม่อยู่ในนี้ต้องถูกปฏิเสธ */
const EXPECTED: Record<string, DoStatus> = {
  'DRAFT.plan': 'PLANNED',
  'DRAFT.cancel': 'CANCELLED',
  'DRAFT.split': 'CANCELLED',
  'DRAFT.merge': 'CANCELLED',
  'PLANNED.unplan': 'DRAFT',
  'PLANNED.dispatch': 'DISPATCHED',
  'DISPATCHED.pick_up': 'PICKED_UP',
  'DISPATCHED.deliver': 'DELIVERED',
  'DISPATCHED.fail': 'FAILED',
  'PICKED_UP.deliver': 'DELIVERED',
  'PICKED_UP.fail': 'FAILED',
  'FAILED.redeliver': 'CANCELLED',
  'FAILED.return': 'RETURNED',
  'DELIVERED.pod_wait': 'POD_PENDING',
  'DELIVERED.pod_accept': 'UNBILLED',
  'POD_PENDING.pod_accept': 'UNBILLED',
  'UNBILLED.bill': 'BILLED',
  'BILLED.unbill': 'UNBILLED',
};

const line = (
  id: string,
  lineNo: number,
  qty: string,
  extra: Partial<SoLineInfo> = {},
): SoLineInfo => ({
  id,
  lineNo,
  description: `สินค้า ${lineNo}`,
  qtyOrdered: qty,
  unit: 'TON',
  weightKg: null,
  cbm: null,
  ...extra,
});
const errCodes = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DoRuleError);
    return (e as DoRuleError).issues.map((i) => `${i.field}:${i.code}`);
  }
  throw new Error('expected DoRuleError');
};
const sumQty = (parts: DoLinePlan[][], soLine: string) =>
  formatMilli(
    parts
      .flat()
      .filter((l) => l.salesOrderLineId === soLine)
      .reduce((s, l) => s + parseMilli(l.qty)!, 0n),
  );

describe('DO state machine (docs/01 §4.3 + D-23)', () => {
  it('ทุกคู่ สถานะ × event: อนุญาตเฉพาะตาราง ที่เหลือ invalid_state_transition', () => {
    let allowed = 0;
    for (const s of DO_STATUSES)
      for (const e of DO_EVENTS) {
        const want = EXPECTED[`${s}.${e}`];
        if (want) {
          expect(transition('delivery_order', DO_TRANSITIONS, s, e)).toBe(want);
          allowed++;
        } else {
          expect(canTransition(DO_TRANSITIONS, s, e)).toBe(false);
          expect(() => transition('delivery_order', DO_TRANSITIONS, s, e)).toThrow(
            InvalidTransitionError,
          );
        }
      }
    expect(allowed).toBe(Object.keys(EXPECTED).length);
  });

  it('RETURNED / CANCELLED สิ้นสุด · ยกเลิก/แยก/รวมได้เฉพาะ DRAFT · ส่งใหม่ = ใบเดิมยกเลิก (D-23)', () => {
    for (const s of ['RETURNED', 'CANCELLED'] as const) expect(DO_TRANSITIONS[s]).toBeUndefined();
    for (const s of DO_STATUSES)
      for (const e of ['cancel', 'split', 'merge'] as const)
        expect(canTransition(DO_TRANSITIONS, s, e)).toBe(s === 'DRAFT');
    expect(transition('delivery_order', DO_TRANSITIONS, 'FAILED', 'redeliver')).toBe('CANCELLED');
    expect(DO_STATUSES.filter(isDoEditable)).toEqual(['DRAFT']);
    expect(DO_STATUSES.filter((s) => !isDoActive(s))).toEqual(['CANCELLED']);
    // ทุกสถานะไปถึงได้จาก DRAFT และมีป้ายไทย
    const seen = new Set<DoStatus>(['DRAFT']);
    let changed = true;
    while (changed) {
      changed = false;
      for (const s of [...seen])
        for (const to of Object.values(DO_TRANSITIONS[s] ?? {}))
          if (to && !seen.has(to)) {
            seen.add(to);
            changed = true;
          }
    }
    expect([...seen].sort()).toEqual([...DO_STATUSES].sort());
    for (const s of DO_STATUSES) expect(DO_STATUS_LABEL_TH[s]).toMatch(/[ก-๙]/);
  });
});

describe('ทศนิยม 3 ตำแหน่ง (สตริง ไม่ใช้ float)', () => {
  it('parse/format', () => {
    expect(parseMilli('12.5')).toBe(12500n);
    expect(parseMilli('0.001')).toBe(1n);
    expect(parseMilli('99999999999.999')).toBe(99999999999999n);
    for (const bad of ['', '-1', '1.2345', '1e3', ' 1', '1.', '.5', '123456789012'])
      expect(parseMilli(bad)).toBeNull();
    expect(parseMilli(1 as unknown as string)).toBeNull();
    expect(formatMilli(12500n)).toBe('12.5');
    expect(formatMilli(1n)).toBe('0.001');
    expect(formatMilli(0n)).toBe('0');
    expect(formatMilli(-1500n)).toBe('-1.5');
  });
});

describe('จัดสรรจาก SO (ORD-081) — ห้ามเกินคงเหลือ', () => {
  const so = [
    line('a', 1, '24', { weightKg: '24000', cbm: '10' }),
    line('b', 2, '3', { unit: 'PALLET' }),
  ];

  it('ค่าเริ่มต้น = คงเหลือทั้งหมดทุกบรรทัด', () => {
    expect(planAllocation(so, [])).toEqual([
      {
        salesOrderLineId: 'a',
        soLineNo: 1,
        description: 'สินค้า 1',
        qty: '24',
        unit: 'TON',
        weightKg: '24000',
        cbm: '10',
      },
      {
        salesOrderLineId: 'b',
        soLineNo: 2,
        description: 'สินค้า 2',
        qty: '3',
        unit: 'PALLET',
        weightKg: null,
        cbm: null,
      },
    ]);
  });

  it('จัดสรรบางส่วน → ที่เหลือได้น้ำหนักคงเหลือพอดี (เศษไปใบสุดท้าย)', () => {
    const first = planAllocation(so, [], [{ salesOrderLineId: 'a', qty: '7' }]);
    expect(first).toEqual([expect.objectContaining({ qty: '7', weightKg: '7000', cbm: '2.917' })]);
    const rest = planAllocation(so, first);
    expect(rest.map((l) => [l.salesOrderLineId, l.qty, l.weightKg, l.cbm])).toEqual([
      ['a', '17', '17000', '7.083'],
      ['b', '3', null, null],
    ]);
    expect(remainingBySoLine(so, [...first, ...rest]).get('a')).toEqual({
      qty: 0n,
      weight: 0n,
      cbm: 0n,
    });
    // จัดหมดแล้ว → ค่าเริ่มต้นไม่มีบรรทัด
    expect(planAllocation(so, [...first, ...rest])).toEqual([]);
  });

  it('เกินคงเหลือ / บรรทัดไม่รู้จัก / ซ้ำ / หน่วยผิด / จำนวนผิดรูป → รวมทุกช่อง', () => {
    expect(
      errCodes(() =>
        planAllocation(
          so,
          [{ salesOrderLineId: 'a', qty: '20', weightKg: null, cbm: null }],
          [
            { salesOrderLineId: 'a', qty: '4.001' },
            { salesOrderLineId: 'x', qty: '1' },
            { salesOrderLineId: 'a', qty: '1' },
            { salesOrderLineId: 'b', qty: '1', unit: 'TON' },
          ],
        ),
      ),
    ).toEqual([
      'lines[1].salesOrderLineId:unknown_line',
      'lines[2].salesOrderLineId:duplicate_line',
      'lines[3].unit:unit_mismatch',
      'lines[0].qty:over_allocated',
    ]);
    for (const qty of ['0', '-1', '1.0001', 'abc', ''])
      expect(errCodes(() => planAllocation(so, [], [{ salesOrderLineId: 'a', qty }]))).toEqual([
        'lines[0].qty:invalid_qty',
      ]);
    expect(errCodes(() => planAllocation(so, [], []))).toEqual(['lines:empty']);
    // หน่วยเดียวกันระบุได้
    expect(
      planAllocation(so, [], [{ salesOrderLineId: 'b', qty: '1', unit: 'PALLET' }])[0]!.qty,
    ).toBe('1');
  });
});

describe('แยก DO (ORD-084) — ปริมาณรวมเท่าเดิม', () => {
  const src = planAllocation(
    [
      line('a', 1, '24', { weightKg: '24000', cbm: '1' }),
      line('b', 2, '10', { unit: 'PALLET', weightKg: '100' }),
    ],
    [],
  );

  it('24 ตัน → 12 + 12 · ปริมาณ/น้ำหนัก/ปริมาตรรวมเท่าเดิม', () => {
    const parts = planSplit(src, [
      [
        { salesOrderLineId: 'a', qty: '12' },
        { salesOrderLineId: 'b', qty: '3' },
      ],
      [
        { salesOrderLineId: 'a', qty: '12' },
        { salesOrderLineId: 'b', qty: '7' },
      ],
    ]);
    expect(parts.map((p) => p.map((l) => [l.salesOrderLineId, l.qty, l.weightKg, l.cbm]))).toEqual([
      [
        ['a', '12', '12000', '0.5'],
        ['b', '3', '30', null],
      ],
      [
        ['a', '12', '12000', '0.5'],
        ['b', '7', '70', null],
      ],
    ]);
    expect(sumQty(parts, 'a')).toBe('24');
    expect(sumQty(parts, 'b')).toBe('10');
    expect(parts.map(doTotals)).toEqual([
      { weightKg: '12030', cbm: '0.5' },
      { weightKg: '12070', cbm: '0.5' },
    ]);
  });

  it('เศษปัดไปส่วนสุดท้าย: 1 ตัน (0.001 cbm) แบ่ง 3 ส่วน → น้ำหนักรวมเท่าเดิม', () => {
    const one = planAllocation([line('a', 1, '1', { weightKg: '1000', cbm: '0.001' })], []);
    const parts = planSplit(one, [
      [{ salesOrderLineId: 'a', qty: '0.333' }],
      [{ salesOrderLineId: 'a', qty: '0.333' }],
      [{ salesOrderLineId: 'a', qty: '0.334' }],
    ]);
    expect(parts.map((p) => [p[0]!.qty, p[0]!.weightKg, p[0]!.cbm])).toEqual([
      ['0.333', '333', '0'],
      ['0.333', '333', '0'],
      ['0.334', '334', '0.001'],
    ]);
    expect(doTotals(parts.flat()).weightKg).toBe('1000');
    expect(doTotals(parts.flat()).cbm).toBe('0.001');
  });

  it('ผลรวมไม่เท่า / ส่วนว่าง / น้อยกว่า 2 ส่วน / บรรทัดนอกใบ / หน่วยผิด → ปฏิเสธ', () => {
    expect(
      errCodes(() =>
        planSplit(src, [
          [{ salesOrderLineId: 'a', qty: '12' }],
          [{ salesOrderLineId: 'a', qty: '11.999' }],
        ]),
      ),
    ).toEqual(['lines.1:qty_not_conserved', 'lines.2:qty_not_conserved']);
    expect(
      errCodes(() =>
        planSplit(src, [
          [
            { salesOrderLineId: 'a', qty: '24' },
            { salesOrderLineId: 'b', qty: '10' },
          ],
          [{ salesOrderLineId: 'a', qty: '1' }],
        ]),
      ),
    ).toEqual(['lines.1:qty_not_conserved']);
    expect(errCodes(() => planSplit(src, [[{ salesOrderLineId: 'a', qty: '24' }]]))).toEqual([
      'parts:too_few_parts',
    ]);
    expect(
      errCodes(() =>
        planSplit(src, [
          [
            { salesOrderLineId: 'a', qty: '24' },
            { salesOrderLineId: 'b', qty: '10' },
          ],
          [],
        ]),
      ),
    ).toEqual(['parts[1]:empty']);
    expect(
      errCodes(() =>
        planSplit(src, [
          [
            { salesOrderLineId: 'a', qty: '24', unit: 'KG' },
            { salesOrderLineId: 'z', qty: '1' },
          ],
          [{ salesOrderLineId: 'b', qty: '10' }],
        ]),
      ),
    ).toEqual([
      'parts[0][0].unit:unit_mismatch',
      'parts[0][1].salesOrderLineId:unknown_line',
      'lines.1:qty_not_conserved',
    ]);
  });
});

describe('รวม DO (ORD-086)', () => {
  const src = planAllocation(
    [line('a', 1, '24', { weightKg: '24000' }), line('b', 2, '10', { unit: 'PALLET' })],
    [],
  );
  const parts = planSplit(src, [
    [{ salesOrderLineId: 'a', qty: '12' }],
    [
      { salesOrderLineId: 'a', qty: '12' },
      { salesOrderLineId: 'b', qty: '10' },
    ],
  ]);

  it('รวมกลับได้เท่าใบเดิม', () => {
    expect(planMerge(parts)).toEqual(src);
  });

  it('หน่วยไม่ตรง → ปฏิเสธ', () => {
    expect(errCodes(() => planMerge([parts[0]!, [{ ...parts[0]![0]!, unit: 'KG' }]]))).toEqual([
      'deliveryOrders[1].lines.1:unit_mismatch',
    ]);
  });

  it('เงื่อนไขระดับใบ: ≥ 2 ใบ, SO เดียวกัน, จุดส่งเดียวกัน', () => {
    const d = (id: string, so = 's1', dest = 2) => ({
      id,
      salesOrderId: so,
      destStopSeq: dest,
      status: 'DRAFT' as const,
      onTrip: false,
    });
    expect(() => checkMergeable([d('1'), d('2')])).not.toThrow();
    expect(errCodes(() => checkMergeable([d('1')]))).toEqual(['deliveryOrderIds:too_few']);
    expect(errCodes(() => checkMergeable([d('1'), d('1')]))).toEqual(['deliveryOrderIds:too_few']);
    expect(errCodes(() => checkMergeable([d('1'), d('2', 's2'), d('3', 's1', 3)]))).toEqual([
      'deliveryOrderIds[1]:different_order',
      'deliveryOrderIds[2]:different_drop',
    ]);
  });
});
