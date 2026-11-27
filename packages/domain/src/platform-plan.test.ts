import { describe, expect, it } from 'vitest';
import { basicFeatureViolations, planPricingErrors, type PlanPricingInput } from './platform-plan';

const base: PlanPricingInput = {
  pricePerVehicleMonthly: '350.00',
  minimumMonthly: '2500.00',
  annualDiscountPct: '15.00',
  volumeTiers: [],
  vehicleMin: 1,
  vehicleMax: 15,
  trialDays: 30,
};

describe('planPricingErrors (P1-ST1-T01)', () => {
  it('ค่าตั้งต้น docs/02 §2 ถูกต้อง · Enterprise ตกลงราคา (null) ถูกต้อง', () => {
    expect(planPricingErrors(base)).toEqual([]);
    expect(
      planPricingErrors({
        ...base,
        pricePerVehicleMonthly: null,
        minimumMonthly: null,
        annualDiscountPct: '0',
        vehicleMin: 201,
        vehicleMax: null,
      }),
    ).toEqual([]);
  });

  it.each([
    [{ pricePerVehicleMonthly: '350.555' }, 'pricePerVehicleMonthly', 'money_format'],
    [{ pricePerVehicleMonthly: '-1.00' }, 'pricePerVehicleMonthly', 'money_range'],
    [{ minimumMonthly: '1e3' }, 'minimumMonthly', 'money_format'],
    [{ minimumMonthly: '10000000000000.00' }, 'minimumMonthly', 'money_range'],
    [{ annualDiscountPct: '100.01' }, 'annualDiscountPct', 'pct_range'],
    [{ annualDiscountPct: '15.5%' }, 'annualDiscountPct', 'pct_format'],
    [{ vehicleMin: 0 }, 'vehicleMin', 'vehicle_range'],
    [{ vehicleMin: 16, vehicleMax: 15 }, 'vehicleMax', 'vehicle_range'],
    [{ trialDays: 366 }, 'trialDays', 'trial_days_range'],
    [{ trialDays: 1.5 }, 'trialDays', 'trial_days_range'],
  ] as const)('%o → %s %s', (patch, field, code) => {
    expect(planPricingErrors({ ...base, ...patch })).toEqual([{ field, code }]);
  });

  it('volume tiers ต้องเรียงจากน้อยไปมาก ไม่ซ้ำ และส่วนลด 0–100', () => {
    expect(
      planPricingErrors({
        ...base,
        volumeTiers: [
          { fromVehicle: 51, discountPct: '10' },
          { fromVehicle: 101, discountPct: '20.00' },
        ],
      }),
    ).toEqual([]);
    expect(
      planPricingErrors({
        ...base,
        volumeTiers: [
          { fromVehicle: 101, discountPct: '20' },
          { fromVehicle: 51, discountPct: '10' },
          { fromVehicle: 200, discountPct: '120' },
        ],
      }),
    ).toEqual([
      { field: 'volumeTiers[1].fromVehicle', code: 'tiers_order' },
      { field: 'volumeTiers[2].discountPct', code: 'pct_range' },
    ]);
  });
});

describe('basicFeatureViolations (PLT-061)', () => {
  it('ฟีเจอร์พื้นฐานที่ไม่ใช่ included ถูกคืน', () => {
    const basic = new Set(['settle', 'sub']);
    expect(
      basicFeatureViolations(
        [
          { featureKey: 'settle', mode: 'addon' },
          { featureKey: 'sub', mode: 'included' },
          { featureKey: 'report', mode: 'not_available' },
        ],
        basic,
      ),
    ).toEqual(['settle']);
  });
});
