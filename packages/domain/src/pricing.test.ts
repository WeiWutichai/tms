import { describe, expect, it } from 'vitest';
import {
  convertQuantity,
  priceShipment,
  type PricingProduct,
  type PricingRate,
  type PricingReasonCode,
  type PricingServiceItem,
  type PricingShipment,
  type PricingStatus,
  type PricingUnit,
} from './pricing';

/** ST2-T15 — docs/04 B1 + spec/02 MD-114/115 · ตัวเลขทุกกรณีคิดมือแล้ว (ค่าคาดหวังเป็นสตริงตรงตัว) */

const FREIGHT: PricingServiceItem = {
  sourceItemId: 'si-freight',
  code: 'FREIGHT',
  unit: 'PER_TRIP',
  unitPrice: null,
  vatType: 'EXEMPT_TRANSPORT',
  whtRate: '1.00',
};
const EXTRA_STOP: PricingServiceItem = {
  sourceItemId: 'si-extra',
  code: 'EXTRA_STOP',
  unit: 'PER_STOP',
  unitPrice: '300.00',
  vatType: 'EXEMPT_TRANSPORT',
  whtRate: '1.00',
};
const WAIT: PricingServiceItem = {
  sourceItemId: 'si-wait',
  code: 'WAIT',
  unit: 'PER_HOUR',
  unitPrice: '200.00',
  vatType: 'EXEMPT_TRANSPORT',
  whtRate: '1.00',
};
const LOAD: PricingServiceItem = {
  sourceItemId: 'si-load',
  code: 'LOAD',
  unit: 'PER_TRIP',
  unitPrice: '500.00',
  vatType: 'VAT_7',
  whtRate: '3.00',
};
const TOLL_ACTUAL: PricingServiceItem = {
  ...WAIT,
  sourceItemId: 'si-toll',
  code: 'TOLL',
  unit: 'ACTUAL',
  unitPrice: null,
};
const NO_PRICE: PricingServiceItem = {
  ...WAIT,
  sourceItemId: 'si-np',
  code: 'NP',
  unitPrice: null,
};

const U = {
  TON: { id: 'u-ton', code: 'TON', kind: 'WEIGHT', toKg: '1000' },
  KG: { id: 'u-kg', code: 'KG', kind: 'WEIGHT', toKg: '1' },
  CBM: { id: 'u-cbm', code: 'CBM', kind: 'VOLUME', toCbm: '1' },
  L: { id: 'u-l', code: 'L', kind: 'VOLUME', toCbm: '0.001' },
  BAG: { id: 'u-bag', code: 'BAG', kind: 'COUNT' },
  PLT: { id: 'u-plt', code: 'PLT', kind: 'COUNT' },
  PCS: { id: 'u-pcs', code: 'PCS', kind: 'COUNT' },
  BOX: { id: 'u-box', code: 'BOX', kind: 'COUNT' },
} satisfies Record<string, PricingUnit>;

/** ปูนถุง 50 กก. (0.04 ลบ.ม.) · 1 พาเลท = 40 ถุง */
const CEMENT: PricingProduct = {
  baseUnit: U.BAG,
  weightPerUnitKg: '50',
  volumePerUnitCbm: '0.04',
  altUnits: [{ unitId: U.PLT.id, factorToBase: '40' }],
};

const rate = (over: Partial<PricingRate> = {}): PricingRate => ({
  rateCardId: 'rc-1',
  code: 'RC-S-0001',
  revision: 1,
  pricingModel: 'PER_TRIP',
  unitPrice: '4500.00',
  minCharge: null,
  extraStopPrice: null,
  includedStops: 2,
  unit: null,
  serviceItem: FREIGHT,
  extraStopItem: EXTRA_STOP,
  accessorials: [],
  ...over,
});

interface Case {
  name: string;
  rate: PricingRate | null;
  shipment: PricingShipment;
  status: PricingStatus;
  total?: string | null;
  /** [code, qty, unitPrice, amount] ต่อบรรทัด */
  lines?: [string, string, string, string][];
  minApplied?: boolean;
  reasons?: PricingReasonCode[];
  quantity?: string;
}

const cases: Case[] = [
  // ---- ตัวอย่างไทยใน docs/04 B1 ----
  {
    name: 'B1 เหมาเที่ยว กรุงเทพ→ชลบุรี 6 ล้อ 4,500',
    rate: rate(),
    shipment: { stops: 2 },
    status: 'AVAILABLE',
    total: '4500.00',
    lines: [['FREIGHT', '1', '4500.00', '4500.00']],
  },
  {
    name: 'B1 18 บาท/กม. ขั้นต่ำ 1,500 — 120 กม. = 2,160 (เกินขั้นต่ำ)',
    rate: rate({ pricingModel: 'PER_KM', unitPrice: '18.00', minCharge: '1500.00' }),
    shipment: { distanceKm: '120', stops: 2 },
    status: 'AVAILABLE',
    total: '2160.00',
    lines: [['FREIGHT', '120', '18.00', '2160.00']],
    minApplied: false,
  },
  {
    name: 'B1 18 บาท/กม. ขั้นต่ำ 1,500 — 50 กม. = 900 → ขั้นต่ำ 1,500',
    rate: rate({ pricingModel: 'PER_KM', unitPrice: '18.00', minCharge: '1500.00' }),
    shipment: { distanceKm: '50', stops: 2 },
    status: 'AVAILABLE',
    total: '1500.00',
    lines: [['FREIGHT', '50', '18.00', '1500.00']],
    minApplied: true,
  },
  {
    name: 'B1 350 บาท/ตัน — 12 ตัน = 4,200',
    rate: rate({ pricingModel: 'PER_TON', unitPrice: '350.00' }),
    shipment: { quantities: [{ value: '12', unit: U.TON }], stops: 2 },
    status: 'AVAILABLE',
    total: '4200.00',
    lines: [['FREIGHT', '12', '350.00', '4200.00']],
    quantity: '12',
  },
  {
    name: 'B1 จุดที่ 4 ขึ้นไป +300/จุด — 4 จุด (รวมในราคา 3) = 4,500 + 300',
    rate: rate({ extraStopPrice: '300.00', includedStops: 3 }),
    shipment: { stops: 4 },
    status: 'AVAILABLE',
    total: '4800.00',
    lines: [
      ['FREIGHT', '1', '4500.00', '4500.00'],
      ['EXTRA_STOP', '1', '300.00', '300.00'],
    ],
  },
  // ---- ระยะทาง: ขอบขั้นต่ำ + ปัดเศษ ----
  {
    name: 'PER_KM ขอบ: 83.3 กม. = 1,499.40 < ขั้นต่ำ → 1,500',
    rate: rate({ pricingModel: 'PER_KM', unitPrice: '18.00', minCharge: '1500.00' }),
    shipment: { distanceKm: '83.3' },
    status: 'AVAILABLE',
    total: '1500.00',
    minApplied: true,
  },
  {
    name: 'PER_KM ขอบ: 83.4 กม. = 1,501.20 ≥ ขั้นต่ำ → ใช้ค่าคำนวณ',
    rate: rate({ pricingModel: 'PER_KM', unitPrice: '18.00', minCharge: '1500.00' }),
    shipment: { distanceKm: '83.4' },
    status: 'AVAILABLE',
    total: '1501.20',
    minApplied: false,
  },
  {
    name: 'PER_KM ปัด half-up: 12.35 บาท × 10.5 กม. = 129.675 → 129.68',
    rate: rate({ pricingModel: 'PER_KM', unitPrice: '12.35' }),
    shipment: { distanceKm: '10.5' },
    status: 'AVAILABLE',
    total: '129.68',
  },
  {
    name: 'PER_KM ปัด half-up ที่ .5 สตางค์พอดี: 12.33 × 10.5 = 129.465 → 129.47',
    rate: rate({ pricingModel: 'PER_KM', unitPrice: '12.33' }),
    shipment: { distanceKm: '10.5' },
    status: 'AVAILABLE',
    total: '129.47',
  },
  // ---- น้ำหนัก/ปริมาตร/หน่วยนับ + แปลงหน่วย ----
  {
    name: 'PER_TON จาก กก.: 12,500 กก. × 350 = 4,375',
    rate: rate({ pricingModel: 'PER_TON', unitPrice: '350.00' }),
    shipment: { quantities: [{ value: '12500', unit: U.KG }] },
    status: 'AVAILABLE',
    total: '4375.00',
    quantity: '12.5',
  },
  {
    name: 'PER_TON จากถุงผ่านสินค้า: 300 ถุง × 50 กก. = 15 ตัน × 350 = 5,250',
    rate: rate({ pricingModel: 'PER_TON', unitPrice: '350.00' }),
    shipment: { quantities: [{ value: '300', unit: U.BAG, product: CEMENT }] },
    status: 'AVAILABLE',
    total: '5250.00',
    quantity: '15',
  },
  {
    name: 'PER_TON จากพาเลท (หน่วยรอง): 5 พาเลท × 40 ถุง × 50 กก. = 10 ตัน + 2,000 กก. = 12 ตัน',
    rate: rate({ pricingModel: 'PER_TON', unitPrice: '350.00' }),
    shipment: {
      quantities: [
        { value: '5', unit: U.PLT, product: CEMENT },
        { value: '2000', unit: U.KG },
      ],
    },
    status: 'AVAILABLE',
    total: '4200.00',
    quantity: '12',
  },
  {
    name: 'PER_TON ขั้นต่ำ: 2 ตัน × 350 = 700 < 1,000 → 1,000',
    rate: rate({ pricingModel: 'PER_TON', unitPrice: '350.00', minCharge: '1000.00' }),
    shipment: { quantities: [{ value: '2', unit: U.TON }] },
    status: 'AVAILABLE',
    total: '1000.00',
    minApplied: true,
  },
  {
    name: 'PER_CBM จากลิตร: 2,500 ลิตร = 2.5 ลบ.ม. × 420 = 1,050',
    rate: rate({ pricingModel: 'PER_CBM', unitPrice: '420.00' }),
    shipment: { quantities: [{ value: '2500', unit: U.L }] },
    status: 'AVAILABLE',
    total: '1050.00',
    quantity: '2.5',
  },
  {
    name: 'PER_CBM จากถุง: 100 ถุง × 0.04 = 4 ลบ.ม. × 420 = 1,680',
    rate: rate({ pricingModel: 'PER_CBM', unitPrice: '420.00' }),
    shipment: { quantities: [{ value: '100', unit: U.BAG, product: CEMENT }] },
    status: 'AVAILABLE',
    total: '1680.00',
  },
  {
    name: 'PER_UNIT พาเลท: 18 พาเลท × 250 = 4,500',
    rate: rate({ pricingModel: 'PER_UNIT', unitPrice: '250.00', unit: U.PLT }),
    shipment: { quantities: [{ value: '18', unit: U.PLT }] },
    status: 'AVAILABLE',
    total: '4500.00',
    lines: [['FREIGHT', '18', '250.00', '4500.00']],
  },
  {
    name: 'PER_UNIT พาเลท จากถุง: 100 ถุง = 2.5 พาเลท × 250 = 625 (ขั้นต่ำ 1,200)',
    rate: rate({
      pricingModel: 'PER_UNIT',
      unitPrice: '250.00',
      unit: U.PLT,
      minCharge: '1200.00',
    }),
    shipment: { quantities: [{ value: '100', unit: U.BAG, product: CEMENT }] },
    status: 'AVAILABLE',
    total: '1200.00',
    minApplied: true,
    quantity: '2.5',
  },
  {
    name: 'PER_UNIT จำนวนเศษไม่สิ้นสุด: 2 ถุง = 2/3 กล่อง × 100 = 66.666… → 66.67 (คิดจากเศษส่วนจริง ไม่ปัดจำนวนก่อน)',
    rate: rate({ pricingModel: 'PER_UNIT', unitPrice: '100.00', unit: U.BOX }),
    shipment: {
      quantities: [
        {
          value: '2',
          unit: U.BAG,
          product: { ...CEMENT, altUnits: [{ unitId: U.BOX.id, factorToBase: '3' }] },
        },
      ],
    },
    status: 'AVAILABLE',
    total: '66.67',
    lines: [['FREIGHT', '0.6667', '100.00', '66.67']],
  },
  // ---- จุดเพิ่ม ----
  {
    name: 'จุดเพิ่ม: 6 จุด รวม 3 → 3 จุด × 300 = 900',
    rate: rate({ extraStopPrice: '300.00', includedStops: 3 }),
    shipment: { stops: 6 },
    status: 'AVAILABLE',
    total: '5400.00',
    lines: [
      ['FREIGHT', '1', '4500.00', '4500.00'],
      ['EXTRA_STOP', '3', '300.00', '900.00'],
    ],
  },
  {
    name: 'จุดเพิ่ม: 3 จุด รวม 3 → ไม่มีบรรทัดค่าจุดเพิ่ม',
    rate: rate({ extraStopPrice: '300.00', includedStops: 3 }),
    shipment: { stops: 3 },
    status: 'AVAILABLE',
    total: '4500.00',
    lines: [['FREIGHT', '1', '4500.00', '4500.00']],
  },
  {
    name: 'จุดเพิ่ม: rate ไม่ตั้งราคาจุดเพิ่ม (null) → ไม่คิด แม้จุดเกิน',
    rate: rate({ extraStopPrice: null, includedStops: 2 }),
    shipment: { stops: 8 },
    status: 'AVAILABLE',
    total: '4500.00',
    lines: [['FREIGHT', '1', '4500.00', '4500.00']],
  },
  {
    name: 'จุดเพิ่มไม่โดนขั้นต่ำ: 50 กม. × 18 → ขั้นต่ำ 1,500 + 2 จุด × 300',
    rate: rate({
      pricingModel: 'PER_KM',
      unitPrice: '18.00',
      minCharge: '1500.00',
      extraStopPrice: '300.00',
      includedStops: 2,
    }),
    shipment: { distanceKm: '50', stops: 4 },
    status: 'AVAILABLE',
    total: '2100.00',
  },
  // ---- ค่าบริการเสริม ----
  {
    name: 'ค่าบริการเสริม: ค่ารอ 3 ชม. ราคาเฉพาะ rate 250 + ค่าขึ้นสินค้าราคาตั้งต้น 500 (VAT 7%/3% ติดบรรทัด)',
    rate: rate({ accessorials: [{ serviceItemId: 'si-wait', price: '250.00' }] }),
    shipment: {
      stops: 2,
      accessorials: [
        { serviceItem: WAIT, qty: '3' },
        { serviceItem: LOAD, qty: '1' },
      ],
    },
    status: 'AVAILABLE',
    total: '5750.00',
    lines: [
      ['FREIGHT', '1', '4500.00', '4500.00'],
      ['WAIT', '3', '250.00', '750.00'],
      ['LOAD', '1', '500.00', '500.00'],
    ],
  },
  // ---- สถานะ ----
  {
    name: 'RATE_MISSING: ไม่พบ rate',
    rate: null,
    shipment: { distanceKm: '100', stops: 2 },
    status: 'RATE_MISSING',
    total: null,
    reasons: ['RATE_MISSING'],
  },
  {
    name: 'CALCULATION_FAILURE: คิดตามระยะทางแต่ไม่มีระยะทาง',
    rate: rate({ pricingModel: 'PER_KM', unitPrice: '18.00' }),
    shipment: { distanceKm: null, stops: 2 },
    status: 'CALCULATION_FAILURE',
    total: null,
    reasons: ['DISTANCE_MISSING'],
  },
  {
    name: 'CALCULATION_FAILURE: ระยะทาง 0',
    rate: rate({ pricingModel: 'PER_KM', unitPrice: '18.00' }),
    shipment: { distanceKm: '0' },
    status: 'CALCULATION_FAILURE',
    reasons: ['DISTANCE_INVALID'],
  },
  {
    name: 'CALCULATION_FAILURE: คิดต่อตันแต่ไม่มีจำนวน',
    rate: rate({ pricingModel: 'PER_TON', unitPrice: '350.00' }),
    shipment: { quantities: [] },
    status: 'CALCULATION_FAILURE',
    reasons: ['QUANTITY_MISSING'],
  },
  {
    name: 'CALCULATION_FAILURE: น้ำหนักรวม 0 ตัน (ไม่คิดขั้นต่ำให้)',
    rate: rate({ pricingModel: 'PER_TON', unitPrice: '350.00', minCharge: '1000.00' }),
    shipment: { quantities: [{ value: '0', unit: U.TON }] },
    status: 'CALCULATION_FAILURE',
    reasons: ['QUANTITY_INVALID'],
  },
  {
    name: 'CALCULATION_FAILURE: คิดต่อตันแต่ส่งเป็นชิ้นโดยไม่มีข้อมูลสินค้า',
    rate: rate({ pricingModel: 'PER_TON', unitPrice: '350.00' }),
    shipment: { quantities: [{ value: '10', unit: U.PCS }] },
    status: 'CALCULATION_FAILURE',
    reasons: ['UNIT_CONVERSION_FAILED'],
  },
  {
    name: 'CALCULATION_FAILURE: คิดต่อพาเลทแต่สินค้าไม่มีหน่วยพาเลท (ชิ้น)',
    rate: rate({ pricingModel: 'PER_UNIT', unitPrice: '250.00', unit: U.PLT }),
    shipment: { quantities: [{ value: '10', unit: U.PCS, product: CEMENT }] },
    status: 'CALCULATION_FAILURE',
    reasons: ['UNIT_CONVERSION_FAILED'],
  },
  {
    name: 'CALCULATION_FAILURE: PER_UNIT แต่ rate ไม่มีหน่วย',
    rate: rate({ pricingModel: 'PER_UNIT', unitPrice: '250.00', unit: null }),
    shipment: { quantities: [{ value: '1', unit: U.PLT }] },
    status: 'CALCULATION_FAILURE',
    reasons: ['RATE_UNIT_MISSING'],
  },
  {
    name: 'CALCULATION_FAILURE: เหมาวัน (P1) ยังไม่รองรับ',
    rate: rate({ pricingModel: 'PER_DAY', unitPrice: '3500.00' }),
    shipment: { stops: 2 },
    status: 'CALCULATION_FAILURE',
    reasons: ['PRICING_MODEL_UNSUPPORTED'],
  },
  {
    name: 'CALCULATION_FAILURE: rate คิดค่าจุดเพิ่มแต่ไม่รู้จำนวนจุด',
    rate: rate({ extraStopPrice: '300.00', includedStops: 3 }),
    shipment: {},
    status: 'CALCULATION_FAILURE',
    reasons: ['STOPS_MISSING'],
  },
  {
    name: 'CALCULATION_FAILURE: จำนวนจุดไม่ใช่จำนวนเต็ม',
    rate: rate(),
    shipment: { stops: 2.5 },
    status: 'CALCULATION_FAILURE',
    reasons: ['STOPS_INVALID'],
  },
  {
    name: 'CALCULATION_FAILURE: ไม่มีรายการ EXTRA_STOP',
    rate: rate({ extraStopPrice: '300.00', includedStops: 3, extraStopItem: null }),
    shipment: { stops: 5 },
    status: 'CALCULATION_FAILURE',
    reasons: ['EXTRA_STOP_ITEM_MISSING'],
  },
  {
    name: 'CALCULATION_FAILURE: ค่าบริการเสริมไม่มีราคา + ตามจริง + จำนวน 0 → เหตุผลครบทุกข้อ',
    rate: rate(),
    shipment: {
      accessorials: [
        { serviceItem: NO_PRICE, qty: '1' },
        { serviceItem: TOLL_ACTUAL, qty: '1' },
        { serviceItem: WAIT, qty: '0' },
      ],
    },
    status: 'CALCULATION_FAILURE',
    reasons: ['ACCESSORIAL_PRICE_MISSING', 'ACCESSORIAL_UNSUPPORTED', 'ACCESSORIAL_QTY_INVALID'],
  },
  {
    name: 'CALCULATION_FAILURE: หลายสาเหตุพร้อมกัน (ไม่มีระยะทาง + ไม่รู้จำนวนจุด)',
    rate: rate({ pricingModel: 'PER_KM', unitPrice: '18.00', extraStopPrice: '300.00' }),
    shipment: {},
    status: 'CALCULATION_FAILURE',
    reasons: ['DISTANCE_MISSING', 'STOPS_MISSING'],
  },
  {
    name: 'CALCULATION_FAILURE: ราคาใน rate ผิดรูป',
    rate: rate({ unitPrice: '12.345' }),
    shipment: { stops: 2 },
    status: 'CALCULATION_FAILURE',
    reasons: ['INVALID_RATE'],
  },
];

cases.push(
  // ---- review ST2-T15 ----
  {
    name: 'ค่ารอ (ต่อชั่วโมง) 1.5 ชม. ได้ — 1.5 × 200 = 300',
    rate: rate(),
    shipment: { accessorials: [{ serviceItem: WAIT, qty: '1.5' }] },
    status: 'AVAILABLE',
    total: '4800.00',
  },
  {
    name: 'CALCULATION_FAILURE: ค่าบริการต่อเที่ยว 1.5 เที่ยว (ต้องเป็นจำนวนเต็ม)',
    rate: rate(),
    shipment: { accessorials: [{ serviceItem: LOAD, qty: '1.5' }] },
    status: 'CALCULATION_FAILURE',
    reasons: ['ACCESSORIAL_QTY_INVALID'],
  },
  {
    name: 'CALCULATION_FAILURE: ส่ง EXTRA_STOP/FREIGHT มาเป็นค่าบริการเสริม (รหัสสงวน)',
    rate: rate(),
    shipment: {
      accessorials: [
        { serviceItem: EXTRA_STOP, qty: '1' },
        { serviceItem: FREIGHT, qty: '1' },
      ],
    },
    status: 'CALCULATION_FAILURE',
    reasons: ['ACCESSORIAL_RESERVED', 'ACCESSORIAL_RESERVED'],
  },
  {
    name: 'CALCULATION_FAILURE: จำนวนจุด 0 (ตรวจเสมอ แม้ rate ไม่คิดค่าจุดเพิ่ม)',
    rate: rate(),
    shipment: { stops: 0 },
    status: 'CALCULATION_FAILURE',
    reasons: ['STOPS_INVALID'],
  },
  {
    name: 'CALCULATION_FAILURE: ยอดบรรทัดเกิน 999,999,999,999.99',
    rate: rate({ pricingModel: 'PER_KM', unitPrice: '99999999999.99' }),
    shipment: { distanceKm: '100' },
    status: 'CALCULATION_FAILURE',
    reasons: ['AMOUNT_OVERFLOW'],
  },
  {
    name: 'CALCULATION_FAILURE: ยอดรวมเกิน (บรรทัดละไม่เกิน)',
    rate: rate({ unitPrice: '999999999999.99' }),
    shipment: { accessorials: [{ serviceItem: LOAD, qty: '1' }] },
    status: 'CALCULATION_FAILURE',
    reasons: ['AMOUNT_OVERFLOW'],
  },
  {
    name: 'ยอดพอดีเพดาน 999,999,999,999.99 ได้',
    rate: rate({ unitPrice: '999999999999.99' }),
    shipment: {},
    status: 'AVAILABLE',
    total: '999999999999.99',
  },
);

describe('priceShipment (ST2-T15 — table)', () => {
  it('มีอย่างน้อย 20 กรณี', () => expect(cases.length).toBeGreaterThanOrEqual(20));

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const r = priceShipment(c.rate, c.shipment);
    expect(r.pricingStatus).toBe(c.status);
    if (c.total !== undefined) expect(r.total).toBe(c.total);
    if (c.lines)
      expect(r.lines.map((l) => [l.serviceItem.code, l.qty, l.unitPrice, l.amount])).toEqual(
        c.lines,
      );
    if (c.minApplied !== undefined)
      expect(r.lines.find((l) => l.kind === 'FREIGHT')?.minChargeApplied).toBe(c.minApplied);
    if (c.quantity !== undefined) expect(r.params.quantity).toBe(c.quantity);
    if (c.status === 'AVAILABLE') {
      expect(r.reasons).toEqual([]);
      // ผลรวมบรรทัด = total เสมอ
      const sum = r.lines.reduce((a, l) => a + Math.round(Number(l.amount) * 100), 0);
      expect((sum / 100).toFixed(2)).toBe(r.total);
    } else {
      expect(r.total).toBeNull();
      expect(r.lines).toEqual([]);
      expect(r.reasons.map((x) => x.code)).toEqual(c.reasons);
      for (const x of r.reasons) expect(x.message).toMatch(/[ก-๙]/);
    }
  });
});

describe('priceShipment — รายละเอียด', () => {
  it('ภาษีติดบรรทัดจาก snapshot รายการบริการ (ไม่คำนวณ VAT/WHT) + ค่าที่ใช้คิด (MD-117)', () => {
    const r = priceShipment(
      rate({
        pricingModel: 'PER_KM',
        unitPrice: '18.00',
        minCharge: '1500.00',
        extraStopPrice: '300.00',
        includedStops: 3,
      }),
      { distanceKm: '50', stops: 4, accessorials: [{ serviceItem: LOAD, qty: '1' }] },
    );
    expect(r.lines.map((l) => [l.kind, l.vatType, l.whtRate])).toEqual([
      ['FREIGHT', 'EXEMPT_TRANSPORT', '1.00'],
      ['EXTRA_STOP', 'EXEMPT_TRANSPORT', '1.00'],
      ['ACCESSORIAL', 'VAT_7', '3.00'],
    ]);
    expect(r.lines[0]).toMatchObject({
      calculatedAmount: '900.00',
      amount: '1500.00',
      minChargeApplied: true,
    });
    expect(r.lines[0]!.serviceItem).toBe(FREIGHT);
    expect(r.params).toMatchObject({
      rateCardId: 'rc-1',
      rateCode: 'RC-S-0001',
      rateRevision: 1,
      pricingModel: 'PER_KM',
      unitPrice: '18.00',
      minCharge: '1500.00',
      distanceKm: '50',
      stops: 4,
      extraStops: 1,
      includedStops: 3,
    });
    expect(r.total).toBe('2300.00');
  });

  it('qtyExact เต็มความละเอียด (qty แสดงผล 4 ตำแหน่ง): 12,345.67 กก. @ 350/ตัน', () => {
    const r = priceShipment(rate({ pricingModel: 'PER_TON', unitPrice: '350.00' }), {
      quantities: [{ value: '12345.67', unit: U.KG }],
    });
    // 12.34567 × 350 = 4,320.9845 → 4,320.98 (แต่ 12.3457 × 350 = 4,320.995 → 4,321.00)
    expect(r.lines[0]).toMatchObject({ qty: '12.3457', qtyExact: '12.34567', amount: '4320.98' });
    const third = priceShipment(
      rate({ pricingModel: 'PER_UNIT', unitPrice: '100.00', unit: U.BOX }),
      {
        quantities: [
          {
            value: '2',
            unit: U.BAG,
            product: { ...CEMENT, altUnits: [{ unitId: U.BOX.id, factorToBase: '3' }] },
          },
        ],
      },
    );
    expect(third.lines[0]).toMatchObject({ qty: '0.6667', qtyExact: '2/3' });
    expect(priceShipment(rate(), {}).lines[0]!.qtyExact).toBe('1');
  });

  it('FSC บน rate → คำเตือน FSC_IGNORED (ไม่ขวาง) · 0 หรือ null ไม่เตือน', () => {
    const w = priceShipment(rate({ fuelSurchargePct: '5.00' }), {});
    expect(w.pricingStatus).toBe('AVAILABLE');
    expect(w.total).toBe('4500.00');
    expect(w.warnings.map((x) => x.code)).toEqual(['FSC_IGNORED']);
    expect(priceShipment(rate({ fuelSurchargePct: '0.00' }), {}).warnings).toEqual([]);
    expect(priceShipment(rate(), {}).warnings).toEqual([]);
    expect(priceShipment(null, {}).warnings).toEqual([]);
  });

  it('ไม่แก้ input และผลเหมือนเดิมทุกครั้ง (ฟังก์ชันล้วน)', () => {
    const rt = rate({ pricingModel: 'PER_TON', unitPrice: '350.00' });
    const sh: PricingShipment = { quantities: [{ value: '300', unit: U.BAG, product: CEMENT }] };
    const before = JSON.stringify([rt, sh]);
    const a = priceShipment(rt, sh);
    const b = priceShipment(rt, sh);
    expect(a).toEqual(b);
    expect(JSON.stringify([rt, sh])).toBe(before);
  });

  it('ยอดใหญ่ไม่เพี้ยน (ไม่มี float): 99,999,999.99 × 1 และ 0.01 × 1,234,567.891 กม.', () => {
    expect(priceShipment(rate({ unitPrice: '99999999.99' }), {}).total).toBe('99999999.99');
    expect(
      priceShipment(rate({ pricingModel: 'PER_KM', unitPrice: '0.01' }), {
        distanceKm: '1234567.891',
      }).total,
    ).toBe('12345.68');
  });
});

describe('convertQuantity', () => {
  it.each([
    ['12500', U.KG, U.TON, undefined, '12.5'],
    ['3', U.TON, U.KG, undefined, '3000'],
    ['1', U.L, U.CBM, undefined, '0.001'],
    ['2', U.PLT, U.BAG, CEMENT, '80'],
    ['100', U.BAG, U.PLT, CEMENT, '2.5'],
    ['1', U.BAG, U.PLT, CEMENT, '0.025'],
    ['1', U.PLT, U.TON, CEMENT, '2'],
    ['10', U.PCS, U.TON, undefined, null],
    ['1', U.TON, U.CBM, CEMENT, '0.8'], // 1 ตัน ÷ 50 กก. = 20 ถุง × 0.04 ลบ.ม.
    ['1', U.TON, U.PLT, CEMENT, '0.5'],
    ['1', U.PCS, U.TON, CEMENT, null], // ชิ้นไม่ใช่หน่วยของสินค้านี้
    ['abc', U.KG, U.TON, undefined, null],
  ] as const)('%s %s → %s', (v, from, to, product, expected) => {
    expect(convertQuantity(v, from, to, product)).toBe(expected);
  });
});
