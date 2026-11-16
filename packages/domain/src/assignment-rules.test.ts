import { describe, expect, it } from 'vitest';
import {
  checkDrivingHours,
  drivingDays,
  reconcileOverrides,
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

describe('checkDrivingHours — ข้ามเที่ยงคืน (review L6)', () => {
  it('เที่ยว 20:00–04:00 แบ่งเข้าแต่ละวัน · เที่ยวเมื่อวานที่ล้นมาวันนี้นับในวันนี้', () => {
    const night = {
      tripDate: '2026-11-19',
      start: '2026-11-19T20:00:00+07:00',
      end: '2026-11-20T04:00:00+07:00',
    };
    expect(drivingDays(night)).toEqual(['2026-11-19', '2026-11-20']);
    const day = {
      tripDate: '2026-11-20',
      start: '2026-11-20T06:00:00+07:00',
      end: '2026-11-20T11:00:00+07:00',
    };
    // 20 พ.ย.: 4 ชม. (ล้นจากเมื่อวาน) + 5 ชม. = 9 ชม.
    expect(checkDrivingHours('2026-11-20', [night, day]).map((i) => i.params.hours)).toEqual([
      '9.0',
    ]);
    // 19 พ.ย.: นับแค่ 20:00–24:00 = 4 ชม.
    expect(checkDrivingHours('2026-11-19', [night, day])).toEqual([]);
  });
});

describe('ruleKey / reconcileOverrides / pendingRules — ขอบเขตการยกเว้น (PO อนุมัติ 17 พ.ย. 2569)', () => {
  const ctx = { vehicleId: 'v1', driverId: 'd1', reliefDriverId: 'd9' };
  const doc: RuleResult = {
    code: 'DOC_CMI_EXPIRED',
    severity: 'block',
    params: { docType: 'COMPULSORY_ACT', expiredOn: '2026-10-31' },
  };
  const lic: RuleResult = { code: 'DRIVER_LICENCE_EXPIRED', severity: 'block', params: {} };
  const ow: RuleResult = { code: 'OVERWEIGHT', severity: 'warning', params: { load: '6800' } };
  const ovl: RuleResult = {
    code: 'vehicle_overlap',
    severity: 'warning',
    params: { trips: ['TRP-2', 'TRP-1'] },
  };
  const info: RuleResult = { code: 'VEHICLE_LARGER_THAN_REQUESTED', severity: 'info', params: {} };
  const ov = (r: RuleResult, c = ctx) => ({
    key: ruleKey(r, c),
    code: r.code,
    severity: r.severity as 'block' | 'warning',
    kind: 'ACKNOWLEDGE' as const,
    reason: 'เหตุผลทดสอบยาวพอ',
    actorId: null,
    at: '2026-11-17T00:00:00Z',
    message: '',
    params: r.params,
  });

  it('เอกสารผูกรถเท่านั้น · ใบขับขี่ผูกคนขับคนนั้นเท่านั้น (หลัก/สำรอง) · ซ้อนเวลารวมชุดเที่ยว', () => {
    expect(ruleKey(doc, { ...ctx, driverId: 'd2' })).toBe(ruleKey(doc, ctx));
    expect(ruleKey(doc, { ...ctx, vehicleId: 'v2' })).not.toBe(ruleKey(doc, ctx));
    expect(ruleKey(lic, { ...ctx, vehicleId: 'v2' })).toBe(ruleKey(lic, ctx));
    expect(ruleKey(lic, { ...ctx, driverId: 'd2' })).not.toBe(ruleKey(lic, ctx));
    const relief = { ...lic, params: { driverRole: 'relief' } };
    expect(ruleKey(relief, { ...ctx, driverId: 'd2' })).toBe(ruleKey(relief, ctx));
    expect(ruleKey(relief, ctx)).toContain('d=d9');
    expect(ruleKey(ovl, ctx)).toBe(ruleKey({ ...ovl, params: { trips: ['TRP-1', 'TRP-2'] } }, ctx));
    expect(ruleKey(ovl, ctx)).not.toBe(ruleKey({ ...ovl, params: { trips: ['TRP-1'] } }, ctx));
  });

  it('แยก ค้างยกเว้น / ค้างยืนยัน / ยกเว้นแล้ว — info ไม่ต้องยืนยัน', () => {
    expect(pendingRules([doc, ow, info], [], ctx)).toEqual({
      blocks: [doc],
      warnings: [ow],
      covered: [],
    });
    expect(pendingRules([doc, ow], [ov(ow)], ctx)).toEqual({
      blocks: [doc],
      warnings: [],
      covered: [ow],
    });
  });

  it('ค่าแย่ลง (น้ำหนักเพิ่ม) → หมดผล WORSENED · ลดลง → ยังมีผล', () => {
    const heavier = { ...ow, params: { load: '7000' } };
    const lighter = { ...ow, params: { load: '6500' } };
    expect(pendingRules([heavier], [ov(ow)], ctx).warnings).toEqual([heavier]);
    expect(pendingRules([lighter], [ov(ow)], ctx).covered).toEqual([lighter]);
    const r = reconcileOverrides([heavier], [ov(ow)], ctx, 'T1');
    expect(r.changed).toBe(true);
    expect(r.overrides[0]).toMatchObject({ supersededAt: 'T1', supersededReason: 'WORSENED' });
  });

  it('ย้ายรถไปแล้วกลับมา → การยกเว้นเดิมไม่กลับมามีผล (CHANGED)', () => {
    const first = [ov(doc)];
    const away = reconcileOverrides([], first, { ...ctx, vehicleId: 'v2' }, 'T1');
    expect(away.overrides[0]).toMatchObject({ supersededReason: 'CHANGED' });
    expect(pendingRules([doc], away.overrides, ctx).blocks).toEqual([doc]);
    expect(reconcileOverrides([doc], away.overrides, ctx, 'T2').changed).toBe(false);
  });
});
