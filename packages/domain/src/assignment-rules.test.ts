import { describe, expect, it } from 'vitest';
import {
  checkDrivingHours,
  checkLoad,
  isBlockingRule,
  pendingRules,
  ruleKey,
  type RuleResult,
} from './assignment-rules';

describe('isBlockingRule — D-07 (PO 16 พ.ย. 2569): กฎเอกสาร = บล็อก ที่เหลือ = เตือน', () => {
  it.each([
    ['DOC_CMI_EXPIRED', true],
    ['DOC_MISSING', true],
    ['DOC_NOT_YET_VALID', true],
    ['DRIVER_LICENCE_EXPIRED', true],
    ['DRIVER_LICENCE_MISSING', true],
    ['DRIVER_LICENCE_CLASS', true],
    ['OVERWEIGHT', false],
    ['OVER_VOLUME', false],
    ['LOCATION_VEHICLE_LIMIT', false],
    ['TEMP_MISMATCH', false],
    ['DRIVING_HOURS_EXCEEDED', false],
    ['vehicle_overlap', false],
  ])('%s → %s', (code, block) => expect(isBlockingRule(code)).toBe(block));
});

describe('checkLoad — น้ำหนัก/ปริมาตร (เตือน)', () => {
  it('เกณฑ์ตรวจรับ: จัดงานเกินน้ำหนัก → คำเตือน OVERWEIGHT พร้อมส่วนเกิน', () => {
    expect(
      checkLoad({ weightKg: '6800', cbm: null, capacityKg: '6000', capacityCbm: null }),
    ).toEqual([
      {
        code: 'OVERWEIGHT',
        severity: 'warning',
        messageKey: 'rule.overweight',
        params: { load: '6800', capacity: '6000', over: '800' },
      },
    ]);
  });
  it('เท่าพิกัดพอดี / ไม่ทราบความจุ / ไม่มีน้ำหนัก → ไม่เตือน', () => {
    expect(checkLoad({ weightKg: '6000', cbm: null, capacityKg: 6000, capacityCbm: null })).toEqual(
      [],
    );
    expect(checkLoad({ weightKg: '9000', cbm: null, capacityKg: null, capacityCbm: null })).toEqual(
      [],
    );
    expect(checkLoad({ weightKg: null, cbm: null, capacityKg: 6000, capacityCbm: 20 })).toEqual([]);
  });
  it('ปริมาตรเกิน → OVER_VOLUME (ทศนิยมไม่ใช้ float)', () => {
    const r = checkLoad({ weightKg: '10', cbm: '20.3', capacityKg: 6000, capacityCbm: '20.1' });
    expect(r.map((x) => [x.code, x.params.over])).toEqual([['OVER_VOLUME', '0.2']]);
  });
});

describe('checkDrivingHours — ชั่วโมงขับตามแผนต่อวัน (เตือน)', () => {
  const span = (s: string, e: string, tripDate = '2026-11-20') => ({
    tripDate,
    start: `${tripDate}T${s}:00+07:00`,
    end: `${tripDate}T${e}:00+07:00`,
  });
  it('รวมเกิน 8 ชม. → DRIVING_HOURS_EXCEEDED', () => {
    const r = checkDrivingHours('2026-11-20', [span('06:00', '11:00'), span('12:00', '16:30')]);
    expect(r).toEqual([
      {
        code: 'DRIVING_HOURS_EXCEEDED',
        severity: 'warning',
        messageKey: 'rule.drivingHours',
        params: { hours: '9.5', limit: 8, date: '2026-11-20' },
      },
    ]);
  });
  it('ไม่เกิน / ต่างวัน / ไม่มีช่วงวิ่ง → ไม่เตือน', () => {
    expect(checkDrivingHours('2026-11-20', [span('06:00', '14:00')])).toEqual([]);
    expect(
      checkDrivingHours('2026-11-20', [
        span('06:00', '12:00'),
        span('06:00', '12:00', '2026-11-21'),
        { tripDate: '2026-11-20', start: null, end: null },
      ]),
    ).toEqual([]);
  });
});

describe('ruleKey / pendingRules — การยกเว้นผูกกับรถ + คนขับ (PLN-090)', () => {
  const ctx = { vehicleId: 'v1', driverId: 'd1' };
  const doc: RuleResult = {
    code: 'DOC_CMI_EXPIRED',
    severity: 'block',
    params: { docType: 'COMPULSORY_ACT', expiredOn: '2026-10-31' },
  };
  const ow: RuleResult = { code: 'OVERWEIGHT', severity: 'warning', params: { load: '6800' } };
  const info: RuleResult = { code: 'VEHICLE_LARGER_THAN_REQUESTED', severity: 'info', params: {} };

  it('ค่าในกฎเปลี่ยน (น้ำหนัก/วันหมด) ไม่เปลี่ยนกุญแจ · เปลี่ยนรถ/คนขับ = กุญแจใหม่', () => {
    expect(ruleKey({ ...ow, params: { load: '7000' } }, ctx)).toBe(ruleKey(ow, ctx));
    expect(ruleKey(ow, { ...ctx, vehicleId: 'v2' })).not.toBe(ruleKey(ow, ctx));
    expect(ruleKey(ow, { ...ctx, driverId: 'd2' })).not.toBe(ruleKey(ow, ctx));
    expect(ruleKey(doc, ctx)).not.toBe(ruleKey({ ...doc, params: { docType: 'INSURANCE' } }, ctx));
  });

  it('แยก ค้างยกเว้น / ค้างยืนยัน / ยกเว้นแล้ว — info ไม่ต้องยืนยัน', () => {
    expect(pendingRules([doc, ow, info], [], ctx)).toEqual({
      blocks: [doc],
      warnings: [ow],
      covered: [],
    });
    expect(pendingRules([doc, ow], [{ key: ruleKey(ow, ctx) }], ctx)).toEqual({
      blocks: [doc],
      warnings: [],
      covered: [ow],
    });
    // ยกเว้นไว้กับรถคันเดิม — ย้ายรถแล้วต้องยกเว้นใหม่
    expect(
      pendingRules([doc], [{ key: ruleKey(doc, ctx) }], { ...ctx, vehicleId: 'v2' }).blocks,
    ).toEqual([doc]);
  });
});
