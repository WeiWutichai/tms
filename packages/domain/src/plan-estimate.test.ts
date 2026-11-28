import { describe, expect, it } from 'vitest';
import {
  entitlementCell,
  estimatePlanCharge,
  perVehicleMonthly,
  planForVehicles,
  vatEstimate,
  type PlanChargeInput,
} from './platform-plan';
import { VAT_RATE_7 } from './tax';

/** ราคาตั้งต้น docs/02 §2 (seed migration 0175 — R-06 / D-40 ยังไม่ประกาศ) */
const starter: PlanChargeInput = {
  pricePerVehicleMonthly: '350.00',
  minimumMonthly: '2500.00',
  annualDiscountPct: '15.00',
  volumeTiers: [],
};
const growth: PlanChargeInput = {
  ...starter,
  pricePerVehicleMonthly: '280.00',
  minimumMonthly: '4500.00',
};
const business: PlanChargeInput = {
  ...starter,
  pricePerVehicleMonthly: '220.00',
  minimumMonthly: '13500.00',
};
const enterprise: PlanChargeInput = {
  pricePerVehicleMonthly: null,
  minimumMonthly: null,
  annualDiscountPct: '0.00',
  volumeTiers: [],
};

describe('estimatePlanCharge (P1-ST2-T02 / P1-ST3-T01) — ก่อน VAT', () => {
  it.each([
    // [ชื่อ, แพ็กเกจ, รถ, รอบ, ต่อเดือน, ต่อปี, คิดขั้นต่ำ]
    ['Starter 1 คัน → ขั้นต่ำ', starter, 1, 'monthly', '2500.00', '30000.00', true],
    ['Starter 1 คัน รายปี → ขั้นต่ำ −15%', starter, 1, 'annual', '2125.00', '25500.00', true],
    ['Starter 7 คัน (2,450 < 2,500) → ขั้นต่ำ', starter, 7, 'monthly', '2500.00', '30000.00', true],
    ['Starter 8 คัน = 2,800', starter, 8, 'monthly', '2800.00', '33600.00', false],
    ['Starter 15 คัน', starter, 15, 'monthly', '5250.00', '63000.00', false],
    ['Starter 15 คัน รายปี (ส่วนลด 787.50)', starter, 15, 'annual', '4462.50', '53550.00', false],
    ['Growth 16 คัน (4,480 < 4,500) → ขั้นต่ำ', growth, 16, 'monthly', '4500.00', '54000.00', true],
    ['Growth 30 คัน = 8,400 (docs/02 §7)', growth, 30, 'monthly', '8400.00', '100800.00', false],
    ['Growth 30 คัน รายปี', growth, 30, 'annual', '7140.00', '85680.00', false],
    ['Growth 60 คัน', growth, 60, 'monthly', '16800.00', '201600.00', false],
    [
      'Business 61 คัน (13,420 < 13,500) → ขั้นต่ำ',
      business,
      61,
      'monthly',
      '13500.00',
      '162000.00',
      true,
    ],
    ['Business 100 คัน รายปี', business, 100, 'annual', '18700.00', '224400.00', false],
    ['Growth 0 คัน → ขั้นต่ำ', growth, 0, 'monthly', '4500.00', '54000.00', true],
  ] as const)('%s', (_n, plan, n, cycle, monthly, yearly, minApplied) => {
    const e = estimatePlanCharge(plan, n, cycle)!;
    expect(e.monthly).toBe(monthly);
    expect(e.yearly).toBe(yearly);
    expect(e.minimumApplied).toBe(minApplied);
  });

  it('รายละเอียดบรรทัด: Growth 30 คัน รายปี', () => {
    expect(estimatePlanCharge(growth, 30, 'annual')).toEqual({
      vehicles: 30,
      cycle: 'annual',
      pricePerVehicle: '280.00',
      baseMonthly: '8400.00',
      volumeDiscountMonthly: '0.00',
      usageMonthly: '8400.00',
      minimumMonthly: '4500.00',
      minimumApplied: false,
      chargeableMonthly: '8400.00',
      annualDiscountPct: '15.00',
      annualDiscountMonthly: '1260.00',
      monthly: '7140.00',
      yearly: '85680.00',
    });
  });

  it('ตกลงราคา (Enterprise) → null', () => {
    expect(estimatePlanCharge(enterprise, 250, 'monthly')).toBeNull();
    expect(perVehicleMonthly(enterprise, 'annual')).toBeNull();
  });

  it('ส่วนลดตามจำนวนรถแบบขั้นบันได (คันที่ ≥ fromVehicle)', () => {
    const p: PlanChargeInput = {
      pricePerVehicleMonthly: '100.00',
      minimumMonthly: null,
      annualDiscountPct: '0',
      volumeTiers: [
        { fromVehicle: 21, discountPct: '20.00' },
        { fromVehicle: 11, discountPct: '10.00' },
      ],
    };
    // คัน 11–20 ลด 10% (100) + คัน 21–25 ลด 20% (100)
    const e = estimatePlanCharge(p, 25, 'monthly')!;
    expect(e.volumeDiscountMonthly).toBe('200.00');
    expect(e.monthly).toBe('2300.00');
    expect(estimatePlanCharge(p, 10, 'monthly')!.volumeDiscountMonthly).toBe('0.00');
    expect(estimatePlanCharge(p, 11, 'monthly')!.volumeDiscountMonthly).toBe('10.00');
  });

  it('ปัดสตางค์ half-up — ไม่ใช้ float', () => {
    const p: PlanChargeInput = {
      ...starter,
      pricePerVehicleMonthly: '297.33',
      minimumMonthly: null,
    };
    // 297.33 × 15% = 44.5995 → 44.60
    expect(estimatePlanCharge(p, 1, 'annual')!.monthly).toBe('252.73');
  });

  it('จำนวนรถติดลบ/ไม่ใช่จำนวนเต็ม → RangeError', () => {
    expect(() => estimatePlanCharge(starter, -1, 'monthly')).toThrow(RangeError);
    expect(() => estimatePlanCharge(starter, 1.5, 'monthly')).toThrow(RangeError);
  });

  it('ราคาต่อรถรายปี (การ์ด) = ราคา − 15%', () => {
    expect(perVehicleMonthly(starter, 'monthly')).toBe('350.00');
    expect(perVehicleMonthly(starter, 'annual')).toBe('297.50');
    expect(perVehicleMonthly(growth, 'annual')).toBe('238.00');
    expect(perVehicleMonthly(business, 'annual')).toBe('187.00');
  });
});

describe('planForVehicles — tier ตามจำนวนรถ (docs/02 §2)', () => {
  const plans = [
    { code: 'start', vehicleMin: 1, vehicleMax: 15 },
    { code: 'std', vehicleMin: 16, vehicleMax: 60 },
    { code: 'biz', vehicleMin: 61, vehicleMax: 200 },
    { code: 'ent', vehicleMin: 201, vehicleMax: null },
  ];
  it.each([
    [1, 'start'],
    [15, 'start'],
    [16, 'std'],
    [30, 'std'],
    [200, 'biz'],
    [201, 'ent'],
    [5000, 'ent'],
  ])('%i คัน → %s', (n, code) => expect(planForVehicles(plans, n)?.code).toBe(code));
  it('ไม่มีช่วงที่ครอบ → undefined', () => expect(planForVehicles(plans, 0)).toBeUndefined());
});

describe('entitlementCell — เซลล์ตารางเปรียบเทียบ', () => {
  it.each([
    ['boolean', { mode: 'included', limit: null }, { kind: 'yes' }],
    ['boolean', { mode: 'addon', limit: null }, { kind: 'addon' }],
    ['boolean', { mode: 'not_available', limit: null }, { kind: 'no' }],
    ['boolean', undefined, { kind: 'no' }],
    ['limit', { mode: 'included', limit: 300 }, { kind: 'limit', limit: 300 }],
    ['limit', { mode: 'included', limit: null }, { kind: 'unlimited' }],
    ['metered', { mode: 'included', limit: 20 }, { kind: 'limit', limit: 20 }],
    ['limit', { mode: 'not_available', limit: 5 }, { kind: 'no' }],
  ] as const)('%s %j → %j', (type, e, cell) => expect(entitlementCell(type, e)).toEqual(cell));
});

describe('ส่วนลดตามจำนวนรถ + ขั้นต่ำ + รายปี รวมกัน (review S3 — ขั้นต่ำได้ส่วนลดรายปีด้วย [OPEN — PO] D-40)', () => {
  const p: PlanChargeInput = {
    pricePerVehicleMonthly: '100.00',
    minimumMonthly: '2000.00',
    annualDiscountPct: '15.00',
    volumeTiers: [{ fromVehicle: 11, discountPct: '10.00' }],
  };
  it.each([
    // [รถ, รอบ, ส่วนลดจำนวนรถ, ยอดตามรถ, คิดขั้นต่ำ, ส่วนลดรายปี, ต่อเดือน]
    [15, 'monthly', '50.00', '1450.00', true, '0.00', '2000.00'],
    [15, 'annual', '50.00', '1450.00', true, '300.00', '1700.00'], // ขั้นต่ำ − 15%
    [22, 'monthly', '120.00', '2080.00', false, '0.00', '2080.00'],
    [22, 'annual', '120.00', '2080.00', false, '312.00', '1768.00'],
    // ก่อนส่วนลดจำนวนรถเกินขั้นต่ำ (2,100) แต่หลังส่วนลดต่ำกว่า (2,090) → ขั้นต่ำ
    [21, 'monthly', '110.00', '1990.00', true, '0.00', '2000.00'],
  ] as const)('%i คัน %s', (n, cycle, vol, usage, minApplied, annual, monthly) => {
    const e = estimatePlanCharge(p, n, cycle)!;
    expect([e.volumeDiscountMonthly, e.usageMonthly, e.minimumApplied]).toEqual([
      vol,
      usage,
      minApplied,
    ]);
    expect([e.annualDiscountMonthly, e.monthly]).toEqual([annual, monthly]);
  });
});

describe('vatEstimate — ประมาณการ VAT ตามต้นแบบ (ไม่ใช่เอกสารภาษี)', () => {
  it('อัตรา = VAT_RATE_7 · ปัด half-up', () => {
    expect(vatEstimate('8400.00')).toEqual({ rate: VAT_RATE_7, vat: '588.00', total: '8988.00' });
    expect(vatEstimate('100800.00')).toEqual({ rate: '0.07', vat: '7056.00', total: '107856.00' });
    expect(vatEstimate('0.07').vat).toBe('0.00'); // 0.0049 → 0.00
    expect(vatEstimate('0.08').vat).toBe('0.01'); // 0.0056 → 0.01
  });
});
