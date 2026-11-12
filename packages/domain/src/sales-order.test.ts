import { describe, expect, it } from 'vitest';
import {
  INTAKE_HOLD_CODES,
  SO_EVENTS,
  SO_STATUSES,
  SO_TRANSITIONS,
  evaluateIntakeHolds,
  formatOrderSource,
  intakeHoldNoteTh,
  isIntakeEditable,
  isValidSourceRef,
  parseOrderSource,
  planIntake,
  soRequiresNumber,
  type IntakeFacts,
  type SoEvent,
  type SoStatus,
} from './sales-order';
import { InvalidTransitionError, canTransition, transition } from './state-machine';

/** ตาราง transition ที่คาดหวัง (docs/01 §4.1 + D-21) — ทุกคู่ (สถานะ × event) ที่ไม่อยู่ในนี้ต้องถูกปฏิเสธ */
const EXPECTED: Record<string, SoStatus> = {
  'DRAFT.submit': 'RECEIVED',
  'DRAFT.cancel': 'CANCELLED',
  'RECEIVED.hold': 'ON_HOLD',
  'RECEIVED.plan': 'PLANNED',
  'RECEIVED.cancel': 'CANCELLED',
  'ON_HOLD.release': 'RECEIVED',
  'ON_HOLD.plan': 'PLANNED',
  'ON_HOLD.cancel': 'CANCELLED',
  'PLANNED.hold': 'ON_HOLD',
  'PLANNED.dispatch': 'IN_TRANSIT',
  'PLANNED.cancel': 'CANCELLED',
  'IN_TRANSIT.deliver_partial': 'PARTIALLY_DELIVERED',
  'IN_TRANSIT.deliver': 'DELIVERED',
  'PARTIALLY_DELIVERED.resume': 'IN_TRANSIT',
  'PARTIALLY_DELIVERED.deliver': 'DELIVERED',
  'DELIVERED.close': 'CLOSED',
};

describe('SO state machine (docs/01 §4.1)', () => {
  it('ทุกคู่ สถานะ × event: อนุญาตเฉพาะตาราง docs ที่เหลือ invalid_state_transition', () => {
    let allowed = 0;
    for (const s of SO_STATUSES)
      for (const e of SO_EVENTS) {
        const want = EXPECTED[`${s}.${e}`];
        if (want) {
          expect(transition('sales_order', SO_TRANSITIONS, s, e)).toBe(want);
          allowed++;
        } else {
          expect(canTransition(SO_TRANSITIONS, s, e)).toBe(false);
          expect(() => transition('sales_order', SO_TRANSITIONS, s, e)).toThrow(
            InvalidTransitionError,
          );
        }
      }
    expect(allowed).toBe(Object.keys(EXPECTED).length);
  });

  it('CLOSED / CANCELLED เป็นสถานะสิ้นสุด · ออกรถแล้วยกเลิกไม่ได้', () => {
    for (const e of SO_EVENTS) {
      expect(canTransition(SO_TRANSITIONS, 'CLOSED', e)).toBe(false);
      expect(canTransition(SO_TRANSITIONS, 'CANCELLED', e)).toBe(false);
    }
    expect(canTransition(SO_TRANSITIONS, 'IN_TRANSIT', 'cancel')).toBe(false);
  });

  it('ร่างไม่กินเลข · ทางเข้าเขียนทับได้เฉพาะ DRAFT/RECEIVED/ON_HOLD', () => {
    expect(soRequiresNumber('DRAFT')).toBe(false);
    expect(SO_STATUSES.filter(soRequiresNumber)).toHaveLength(SO_STATUSES.length - 1);
    expect(SO_STATUSES.filter(isIntakeEditable)).toEqual(['DRAFT', 'RECEIVED', 'ON_HOLD']);
  });
});

describe('source ของ order (docs/04 C)', () => {
  it('ชื่อ docs/04 ↔ ค่าที่เก็บ (docs/01 §3.3)', () => {
    expect(formatOrderSource({ source: 'MANUAL', connector: '' })).toBe('MANUAL');
    expect(formatOrderSource({ source: 'IMPORT', connector: '' })).toBe('EXCEL');
    expect(formatOrderSource({ source: 'API', connector: '' })).toBe('API');
    expect(formatOrderSource({ source: 'PORTAL', connector: '' })).toBe('PORTAL');
    expect(formatOrderSource({ source: 'CONNECTOR', connector: 'krs' })).toBe('ERP:krs');
    expect(parseOrderSource('EXCEL')).toEqual({ source: 'IMPORT', connector: '' });
    expect(parseOrderSource('import')).toEqual({ source: 'IMPORT', connector: '' });
    expect(parseOrderSource('ERP:KRS')).toEqual({ source: 'CONNECTOR', connector: 'krs' });
    expect(parseOrderSource('api')).toEqual({ source: 'API', connector: '' });
    for (const bad of ['ERP:', 'ERP:ก', 'ERP:' + 'x'.repeat(33), 'CSV', 'CONNECTOR', ''])
      expect(parseOrderSource(bad)).toBeNull();
  });

  it('CONNECTOR ต้องมีรหัส connector · ช่องทางอื่นต้องไม่มี', () => {
    expect(isValidSourceRef({ source: 'CONNECTOR', connector: 'krs' })).toBe(true);
    expect(isValidSourceRef({ source: 'CONNECTOR', connector: '' })).toBe(false);
    expect(isValidSourceRef({ source: 'API', connector: 'krs' })).toBe(false);
    expect(isValidSourceRef({ source: 'FAX' as never, connector: '' })).toBe(false);
  });
});

describe('กฎรับงานเข้า → ใบค้าง', () => {
  const ok: IntakeFacts = {
    sourceIssues: [],
    customerMapped: true,
    stops: [
      { type: 'PICKUP', mapped: true },
      { type: 'DELIVERY', mapped: true },
    ],
    pricingStatus: 'AVAILABLE',
  };

  it('ข้อมูลครบ + มีราคา → ไม่ค้าง', () => {
    expect(evaluateIntakeHolds(ok)).toEqual([]);
  });

  it('เหตุค้างเรียงตามความสำคัญ (ตัวแรก = reason code บน SO)', () => {
    const holds = evaluateIntakeHolds({
      sourceIssues: ['ไม่มีวันที่'],
      customerMapped: false,
      stops: [
        { type: 'PICKUP', mapped: true },
        { type: 'DELIVERY', mapped: false },
      ],
      pricingStatus: 'RATE_MISSING',
    });
    expect(holds).toEqual([
      { code: 'SOURCE_ERROR', field: 'source' },
      { code: 'CUSTOMER_UNMAPPED', field: 'customer' },
      { code: 'LOCATION_UNMAPPED', field: 'stops[1].site' },
      { code: 'RATE_MISSING', field: 'pricing' },
    ]);
    expect(holds.map((h) => h.code)).toEqual([...INTAKE_HOLD_CODES]);
  });

  it('ไม่มีจุดรับ หรือจุดส่ง → LOCATION_UNMAPPED · คำนวณราคาไม่ได้ก็นับเป็น RATE_MISSING', () => {
    expect(evaluateIntakeHolds({ ...ok, stops: [{ type: 'DELIVERY', mapped: true }] })[0]).toEqual({
      code: 'LOCATION_UNMAPPED',
      field: 'stops.pickup',
    });
    expect(evaluateIntakeHolds({ ...ok, stops: [{ type: 'PICKUP', mapped: true }] })[0]).toEqual({
      code: 'LOCATION_UNMAPPED',
      field: 'stops.delivery',
    });
    expect(evaluateIntakeHolds({ ...ok, pricingStatus: 'CALCULATION_FAILURE' })).toEqual([
      { code: 'RATE_MISSING', field: 'pricing' },
    ]);
  });
});

describe('planIntake (สถานะหลัง upsert)', () => {
  const hold = [{ code: 'CUSTOMER_UNMAPPED' as const }];
  const ev = (events: SoEvent[], from: SoStatus) =>
    events.reduce<SoStatus>((s, e) => transition('sales_order', SO_TRANSITIONS, s, e), from);

  it('ใบใหม่: ร่าง → DRAFT · ไม่ค้าง → RECEIVED · ค้าง → RECEIVED แล้ว hold', () => {
    expect(planIntake({ current: null, currentHoldCode: null, draft: true, holds: hold })).toEqual({
      initial: 'DRAFT',
      events: [],
      holdCode: null,
      holdCodeChanged: false,
    });
    expect(planIntake({ current: null, currentHoldCode: null, draft: false, holds: [] })).toEqual({
      initial: 'RECEIVED',
      events: [],
      holdCode: null,
      holdCodeChanged: false,
    });
    const p = planIntake({ current: null, currentHoldCode: null, draft: false, holds: hold });
    expect(p).toMatchObject({
      initial: 'RECEIVED',
      events: ['hold'],
      holdCode: 'CUSTOMER_UNMAPPED',
    });
    expect(ev(p.events, p.initial!)).toBe('ON_HOLD');
  });

  it('ร่างเดิม → ส่ง (submit) + hold ตามเหตุ; ยังขอร่าง = คงร่าง', () => {
    const p = planIntake({ current: 'DRAFT', currentHoldCode: null, draft: false, holds: hold });
    expect(p.events).toEqual(['submit', 'hold']);
    expect(ev(p.events, 'DRAFT')).toBe('ON_HOLD');
    expect(
      planIntake({ current: 'DRAFT', currentHoldCode: null, draft: true, holds: hold }).events,
    ).toEqual([]);
  });

  it('ค้างด้วยเหตุของทางเข้า: เหตุหมด → release; เหตุเปลี่ยน → เปลี่ยน reason code ไม่เปลี่ยนสถานะ', () => {
    const r = planIntake({
      current: 'ON_HOLD',
      currentHoldCode: 'CUSTOMER_UNMAPPED',
      draft: false,
      holds: [],
    });
    expect(r).toEqual({
      initial: null,
      events: ['release'],
      holdCode: null,
      holdCodeChanged: false,
    });
    expect(ev(r.events, 'ON_HOLD')).toBe('RECEIVED');
    expect(
      planIntake({
        current: 'ON_HOLD',
        currentHoldCode: 'CUSTOMER_UNMAPPED',
        draft: false,
        holds: [{ code: 'RATE_MISSING' }],
      }),
    ).toEqual({ initial: null, events: [], holdCode: 'RATE_MISSING', holdCodeChanged: true });
  });

  it('ค้างด้วยเหตุที่ flow อื่นตั้ง (รถร่วมปฏิเสธ) → upsert ไม่แตะ', () => {
    expect(
      planIntake({
        current: 'ON_HOLD',
        currentHoldCode: 'CARRIER_REJECTED',
        draft: false,
        holds: [],
      }),
    ).toEqual({ initial: null, events: [], holdCode: 'CARRIER_REJECTED', holdCodeChanged: false });
  });

  it('ขอร่างกับใบที่พ้นร่างแล้ว → invalid_state_transition', () => {
    expect(() =>
      planIntake({ current: 'RECEIVED', currentHoldCode: null, draft: true, holds: [] }),
    ).toThrow(InvalidTransitionError);
  });
});

describe('ราคากำหนดเอง + ข้อความใบค้าง', () => {
  it('มีบรรทัดค่าขนส่ง MANUAL → ไม่ค้าง RATE_MISSING', () => {
    const f: IntakeFacts = {
      sourceIssues: [],
      customerMapped: true,
      stops: [
        { type: 'PICKUP', mapped: true },
        { type: 'DELIVERY', mapped: true },
      ],
      pricingStatus: 'RATE_MISSING',
    };
    expect(evaluateIntakeHolds(f).map((h) => h.code)).toEqual(['RATE_MISSING']);
    expect(evaluateIntakeHolds({ ...f, manualFreight: true })).toEqual([]);
  });

  it('ข้อความไทยสำหรับคนอ่าน (ไม่ใช่ชื่อช่อง)', () => {
    expect(intakeHoldNoteTh({ code: 'CUSTOMER_UNMAPPED' }, { customerRef: 'C-9' })).toBe(
      'ยังไม่ได้จับคู่ลูกค้า (รหัสต้นทาง C-9)',
    );
    expect(
      intakeHoldNoteTh(
        { code: 'LOCATION_UNMAPPED', field: 'stops[1].site' },
        { stopTexts: ['a', 'ตลาด'] },
      ),
    ).toBe('จุดที่ 2 ยังไม่ได้จับคู่สถานที่: ตลาด');
    expect(intakeHoldNoteTh({ code: 'LOCATION_UNMAPPED', field: 'stops.pickup' })).toBe(
      'ยังไม่มีจุดรับสินค้า',
    );
    expect(intakeHoldNoteTh({ code: 'SOURCE_ERROR' }, { sourceIssues: ['ไม่มีวันส่ง'] })).toBe(
      'ข้อมูลจากต้นทางไม่ครบ: ไม่มีวันส่ง',
    );
  });
});
