import { describe, expect, it } from 'vitest';
import {
  copyFromOrder,
  editableOf,
  emptyForm,
  fromBangkok,
  fromOrder,
  fromTemplate,
  toBangkok,
  toCreateBody,
  toPatch,
  toPayload,
  totalWeightKg,
  validate,
  type Order,
} from './orderForm';

const ORDER: Order = {
  id: 'ord_1',
  soNo: 'SO-6911-0007',
  status: 'received',
  source: 'MANUAL',
  sourceType: 'MANUAL',
  connector: null,
  externalId: null,
  customer: {
    match: { method: 'INPUT', candidates: [] },
    id: 'cus_1',
    code: 'CUS-0001',
    legalName: 'บจก. ตัวอย่าง',
    externalId: null,
    name: null,
  },
  billingCompanyId: 'cmp_1',
  customerRef: 'PO-123',
  requestedDate: '2026-11-13',
  vehicleTypeId: 'vty_1',
  holdReason: null,
  holdCodes: [],
  pricingStatus: 'AVAILABLE',
  pricingReasons: [],
  stops: [
    {
      sequence: 1,
      match: { method: null, score: null, candidates: [] },
      type: 'PICKUP',
      siteId: 'loc_a',
      siteText: 'คลังบางนา',
      windowStart: '2026-11-13T00:00:00.000Z', // 07:00 เวลาไทย
      windowEnd: '2026-11-13T02:00:00.000Z',
    },
    {
      sequence: 2,
      match: { method: null, score: null, candidates: [] },
      type: 'DELIVERY',
      siteId: 'loc_b',
      siteText: 'โรงงานชลบุรี',
      windowStart: '2026-11-14T06:00:00.000Z', // วันถัดไป 13:00
      windowEnd: null,
    },
  ],
  lines: [
    {
      lineNo: 1,
      description: 'น้ำดื่ม',
      qty: '12.5',
      unitId: 'unt_t',
      unit: 'ตัน',
      productId: 'prd_x',
      itemCode: 'WTR-01',
      weightKg: '12500',
      cbm: '18.2',
      isDangerous: true,
      tempMin: '-18',
      tempMax: '-15.5',
    },
  ],
  editableFields: [
    'customer',
    'billingCompanyId',
    'customerRef',
    'requestedDate',
    'vehicleTypeId',
    'stops',
    'stops.window',
    'lines',
    'sourceIssues',
  ],
  version: 3,
  createdAt: '2026-11-12T01:00:00.000Z',
  updatedAt: '2026-11-12T02:00:00.000Z',
} as Order;

describe('orderForm (ST3-T02)', () => {
  it('เวลาไทย ↔ ISO', () => {
    expect(toBangkok('2026-11-12T17:30:00.000Z')).toEqual({ date: '2026-11-13', time: '00:30' });
    expect(fromBangkok('2026-11-13', '07:00')).toBe('2026-11-13T07:00:00+07:00');
    expect(fromBangkok('2026-11-13', '')).toBeNull();
    expect(Date.parse(fromBangkok('2026-11-13', '07:00')!)).toBe(
      Date.parse('2026-11-13T00:00:00Z'),
    );
  });

  it('ใบเดิม → ฟอร์ม → payload ได้ค่าเท่าเดิม (ไม่มีการแก้ = PATCH ว่าง)', () => {
    const f = fromOrder(ORDER);
    expect(f.customer).toEqual({ id: 'cus_1', label: 'บจก. ตัวอย่าง', sub: 'CUS-0001' });
    expect(f.stops[0]).toMatchObject({
      type: 'PICKUP',
      date: '2026-11-13',
      from: '07:00',
      to: '09:00',
    });
    expect(f.stops[1]).toMatchObject({ date: '2026-11-14', from: '13:00', to: '' });
    const p = toPayload(f);
    expect(p.stops.map((s) => [s.siteId, s.siteText])).toEqual([
      ['loc_a', 'คลังบางนา'],
      ['loc_b', 'โรงงานชลบุรี'],
    ]);
    // ทุกช่องของสินค้าพาไปครบ (review B1) — ไม่ทำสินค้าอันตราย/อุณหภูมิ/ปริมาตรหาย
    expect(p.lines![0]).toEqual({
      description: 'น้ำดื่ม',
      qty: '12.5',
      unitId: 'unt_t',
      unit: 'ตัน',
      productId: 'prd_x',
      itemCode: 'WTR-01',
      weightKg: '12500',
      cbm: '18.2',
      isDangerous: true,
      tempMin: '-18',
      tempMax: '-15.5',
    });
    expect(p.billingCompanyId).toBe('cmp_1');
    expect(toPatch(ORDER, f, false)).toEqual({});
  });

  it('PATCH ส่งเฉพาะช่องที่เปลี่ยน · ร่าง + ยืนยัน = draft:false', () => {
    const f = fromOrder(ORDER);
    f.customerRef = 'PO-999';
    f.stops[0]!.to = '10:00';
    const patch = toPatch(ORDER, f, true);
    expect(Object.keys(patch).sort()).toEqual(['customerRef', 'stops']);
    expect((patch.stops as { windowEnd: string }[])[0]!.windowEnd).toBe(
      '2026-11-13T10:00:00+07:00',
    );
    expect(toPatch({ ...ORDER, status: 'draft' } as Order, fromOrder(ORDER), true)).toEqual({
      draft: false,
    });
  });

  it('คัดลอกเป็นใบใหม่ (ORD-022): ข้อมูลเท่าต้นฉบับ ยกเว้น PO · วันรับของ = พรุ่งนี้ เวลาเดิม คงระยะห่างวัน', () => {
    const c = copyFromOrder(ORDER, '2026-11-20');
    expect(c.customerRef).toBe('');
    expect(c.requestedDate).toBe('2026-11-21');
    expect(c.stops.map((s) => [s.type, s.site?.id, s.date, s.from, s.to])).toEqual([
      ['PICKUP', 'loc_a', '2026-11-21', '07:00', '09:00'],
      ['DELIVERY', 'loc_b', '2026-11-22', '13:00', ''],
    ]);
    const body = toCreateBody(c, true);
    const src = toPayload(fromOrder(ORDER));
    expect(body.draft).toBe(true);
    expect(body).not.toHaveProperty('externalId');
    expect(body.customer).toEqual(src.customer);
    expect(body.billingCompanyId).toBe('cmp_1');
    expect(body.vehicleTypeId).toBe(src.vehicleTypeId);
    expect(body.lines).toEqual(src.lines);
    // เท่ากับทุกช่องของบรรทัดในใบเดิม (ยกเว้นเลขบรรทัด)
    expect(body.lines).toEqual(ORDER.lines.map(({ lineNo: _n, ...x }) => x));
    expect(body.stops.map((s) => [s.type, s.siteId, s.siteText])).toEqual(
      src.stops.map((s) => [s.type, s.siteId, s.siteText]),
    );
  });

  it('เทมเพลต → ฟอร์มใบใหม่ เลื่อนวันที่ทั้งใบ', () => {
    const p = toPayload(fromOrder(ORDER));
    const f = fromTemplate(
      p,
      { id: 'cus_1', code: 'CUS-0001', legalName: 'บจก. ตัวอย่าง' },
      '2026-12-01',
    );
    expect(f.requestedDate).toBe('2026-12-01');
    expect(f.stops.map((s) => s.date)).toEqual(['2026-12-01', '2026-12-02']);
    expect(f.customer?.label).toBe('บจก. ตัวอย่าง');
    expect(toPayload(f).lines).toEqual(p.lines);
    expect(toPayload(f).billingCompanyId).toBe('cmp_1');
  });

  it('ตรวจฟอร์ม: ร่างตรวจแค่รูปแบบ · ส่งต้องมีลูกค้า ประเภทรถ จุดรับ/ส่ง และสินค้าครบ', () => {
    const f = emptyForm('2026-11-13');
    expect(f.requestedDate).toBe('2026-11-14');
    const sub = validate(f, false);
    expect(sub).toMatchObject({
      'customer.id': 'required',
      vehicleTypeId: 'required',
      'stops[0].siteId': 'required',
      'lines[0].description': 'required',
      'lines[0].qty': 'must_be_positive',
      'lines[0].unit': 'required',
    });
    const draft = validate({ ...f, lines: [] }, true);
    expect(draft).not.toHaveProperty('customer.id');
    expect(draft).toHaveProperty('stops[0].siteId');
    const g = fromOrder(ORDER);
    expect(validate(g, false)).toEqual({});
    g.stops = g.stops.filter((s) => s.type !== 'DELIVERY');
    expect(validate(g, false).stops).toBe('need_delivery');
    g.stops[0]!.from = '10:00';
    g.stops[0]!.to = '09:00';
    expect(validate(g, true)['stops[0].windowEnd']).toBe('window_order');
  });

  it('ช่องที่แก้ได้ตามสถานะ (editableFields) · น้ำหนักรวมไม่ใช้ float', () => {
    expect(editableOf(null).stops).toBe(true);
    const planned = editableOf({
      ...ORDER,
      editableFields: ['customerRef', 'stops.window'],
    } as Order);
    expect(planned).toMatchObject({
      customer: false,
      stops: false,
      window: true,
      customerRef: true,
      lines: false,
      any: true,
    });
    expect(editableOf({ ...ORDER, editableFields: [] } as Order).any).toBe(false);
    expect(totalWeightKg([{ weightKg: '0.1' }, { weightKg: '0.2' }, { weightKg: null }])).toBe(
      '0.3',
    );
    expect(totalWeightKg([{ weightKg: '1200' }, { weightKg: '300.5' }])).toBe('1500.5');
    expect(totalWeightKg([])).toBeNull();
  });

  it('ช่วงเวลาข้ามคืน/หลายวัน (dateTo): เก็บ/ส่งวันสิ้นสุด · ตรวจด้วยวันเวลาเต็ม · เลื่อนวันพร้อมกัน', () => {
    const o = {
      ...ORDER,
      stops: [
        {
          ...ORDER.stops[0]!,
          windowStart: '2026-11-13T15:00:00.000Z', // 22:00
          windowEnd: '2026-11-13T19:00:00.000Z', // 02:00 วันถัดไป
        },
        ORDER.stops[1]!,
      ],
    } as Order;
    const f = fromOrder(o);
    expect(f.stops[0]).toMatchObject({
      date: '2026-11-13',
      from: '22:00',
      dateTo: '2026-11-14',
      to: '02:00',
    });
    expect(validate(f, false)).toEqual({});
    expect(toPayload(f).stops[0]!.windowEnd).toBe('2026-11-14T02:00:00+07:00');
    expect(toPatch(o, f, false)).toEqual({});
    // ไม่มี dateTo → วันเดียวกัน 22:00–02:00 = ผิดลำดับ
    f.stops[0]!.dateTo = '';
    expect(validate(f, true)['stops[0].windowEnd']).toBe('window_order');
    const c = copyFromOrder(o, '2026-11-20');
    expect(c.stops[0]).toMatchObject({ date: '2026-11-21', dateTo: '2026-11-22' });
  });
});
