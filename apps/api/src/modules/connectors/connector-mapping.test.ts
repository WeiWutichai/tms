import { describe, expect, it } from 'vitest';
import { normalizeOrderInput } from '../orders/order-input';
import {
  externalCodes,
  externalKey,
  fallbackInput,
  mapExternalOrder,
  minimalOrder,
  show,
  type MappedRefs,
} from './connector-mapping';

const refs = (over: Partial<MappedRefs> = {}): MappedRefs => ({
  customerId: 'c1',
  sites: new Map([
    ['S-1', { id: '11111111-1111-4111-8111-111111111111', customerId: null }],
    ['S-OTHER', { id: '22222222-2222-4222-8222-222222222222', customerId: 'c2' }],
  ]),
  vehicleTypes: new Map([['6W', '33333333-3333-4333-8333-333333333333']]),
  ...over,
});

describe('mapExternalOrder (ST3-T05)', () => {
  it('ข้อมูลครบ → input ที่ผ่านกฎ upsert ไม่มี issue · ตัวเลข JS แปลงเป็นสตริง · ที่มา ERP:{connector}', () => {
    const m = mapExternalOrder(
      {
        externalId: 'SO-1',
        customer: { code: 'C-1', name: 'ลูกค้า' },
        requestedDate: '2026-11-13',
        vehicleTypeCode: '6W',
        stops: [
          { type: 'pickup', siteCode: 'S-1' },
          { type: 'DELIVERY', siteCode: 'S-OTHER', text: 'ร้าน' },
        ],
        lines: [{ description: 'ปูน', qty: 12.5, unit: 'TON', isDangerous: false }],
      },
      'erp1',
      refs(),
      '2026-11-13',
    );
    expect(m.issues).toEqual([]);
    expect(m.input.source).toEqual({ source: 'CONNECTOR', connector: 'erp1' });
    expect(m.input.lines![0]!.qty).toBe('12.5');
    // สถานที่ของลูกค้าอื่น = ไม่จับคู่ (LOCATION_UNMAPPED) ไม่ปฏิเสธทั้งใบ
    expect(m.input.stops.map((s) => [s.type, s.siteId !== null])).toEqual([
      ['PICKUP', true],
      ['DELIVERY', false],
    ]);
    expect(() => normalizeOrderInput(m.input)).not.toThrow();
  });

  it('ข้อมูลขยะทุกช่อง → ยังได้ input ที่ผ่านกฎ upsert + issues (ไม่ทิ้งใบ)', () => {
    const m = mapExternalOrder(
      {
        externalId: { x: 1 },
        customer: 'C' as never,
        customerRef: ['a'],
        requestedDate: '2026-02-30',
        vehicleTypeCode: 'ZZ',
        stops: [
          null,
          {
            type: 1,
            windowStart: '2026-11-13T10:00:00+07:00',
            windowEnd: '2026-11-13T09:00:00+07:00',
          },
        ],
        lines: [null, { qty: '-1', unit: 'x' }, { description: 'ok', qty: '1e3', unit: 'T' }],
        issues: 'broken',
        raw: { big: 'x'.repeat(300 * 1024) },
      },
      'erp1',
      refs(),
      '2026-11-13',
    );
    expect(() => normalizeOrderInput(m.input)).not.toThrow();
    expect(m.input.requestedDate).toBe('2026-11-13');
    expect(m.input.externalId).toMatch(/^erp1-nokey-[0-9a-f]{16}$/);
    expect(m.input.lines).toEqual([]);
    expect(m.input.rawPayload).toMatchObject({ truncated: true });
    expect(m.warnings).toEqual(['ไม่รู้จักรหัสประเภทรถ ZZ']);
    expect(m.issues[0]).toBe('ต้นทางแจ้งปัญหา (broken)');
    expect(m.issues.length).toBeGreaterThan(5);
  });

  it('เลขแทนเมื่อไม่มีเลขอ้างอิงคงที่ต่อ payload · ปัญหาเกิน 50 ข้อรวบเป็นข้อสุดท้าย', () => {
    const a = mapExternalOrder({ externalId: null, raw: { r: 1 } }, 'k', refs(), '2026-11-13');
    const b = mapExternalOrder({ externalId: '', raw: { r: 1 } }, 'k', refs(), '2026-11-14');
    expect(a.input.externalId).toBe(b.input.externalId);
    const many = mapExternalOrder(
      { externalId: 'X', issues: Array.from({ length: 80 }, (_, i) => `p${i}`) },
      'k',
      refs(),
      '2026-11-13',
    );
    expect(many.issues).toHaveLength(50);
    expect(many.issues[49]).toMatch(/^…และอีก \d+ ปัญหา$/);
    expect(() => normalizeOrderInput(many.input)).not.toThrow();
  });

  it('ใบสำรอง: หัวใบ + จุดเป็นข้อความ + ข้อผิดพลาดเป็น sourceIssues', () => {
    const m = mapExternalOrder(
      {
        externalId: 'X',
        requestedDate: '2026-11-13',
        stops: [{ type: 'PICKUP', siteCode: 'S-1' }],
      },
      'k',
      refs(),
      '2026-11-13',
    );
    const f = fallbackInput(m, ['vehicleTypeId invalid_id']);
    expect(f.stops).toEqual([{ type: 'PICKUP', siteText: 'S-1' }]);
    expect(f.sourceIssues).toEqual(['รับข้อมูลไม่ได้: vehicleTypeId invalid_id']);
    expect(() => normalizeOrderInput(f)).not.toThrow();
  });

  it('externalCodes อ่านรหัสจาก payload ที่ยังไม่ตรวจโดยไม่ล้ม', () => {
    expect(externalCodes({ externalId: 1, stops: 'x' as never })).toEqual({
      customer: null,
      sites: [],
      vehicleType: null,
    });
    expect(
      externalCodes({
        externalId: 1,
        customer: { code: 7 },
        stops: [{ siteCode: 'A' }, { siteCode: 'A' }, null],
      }),
    ).toEqual({ customer: '7', sites: ['A'], vehicleType: null });
  });

  it('show() ไม่ล้มกับค่าใด ๆ · externalKey: ยาวเกินใช้ hash ของเลขเต็ม, วนซ้ำไม่ล้ม · minimalOrder ผ่านกฎ upsert', () => {
    const circ: Record<string, unknown> = {};
    circ.a = circ;
    const evil = {
      toJSON() {
        throw new Error('x');
      },
    };
    expect(show(5n)).toBe('5n');
    expect(show(circ)).toBe('[object Object]');
    expect(show(evil)).toBe('[object Object]');
    expect(show(Object.create(null))).toBe('{}');
    const long = 'A'.repeat(150);
    expect(externalKey({ externalId: long }, 'k').value).toBe(
      externalKey({ externalId: long, raw: { other: 1 } }, 'k').value,
    );
    expect(externalKey({ externalId: long }, 'k').value).toMatch(/^k-longid-[0-9a-f]{32}$/);
    expect(externalKey({ externalId: null, raw: circ }, 'k').value).toMatch(/^k-nokey-/);
    expect(externalKey({ externalId: 7n }, 'k').value).toBe('7');
    const m = minimalOrder({ externalId: 'P' }, 'k', '2026-11-13', new Error('boom'));
    expect(() => normalizeOrderInput(m.input)).not.toThrow();
    expect(m.issues).toEqual(['ข้อมูลจากต้นทางอ่านไม่ได้ (boom)']);
  });
});
