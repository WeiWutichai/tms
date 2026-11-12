import { describe, expect, it } from 'vitest';
import {
  checkVehicleCompatibility,
  hasCompatibilityWarnings,
  type CompatProduct,
  type CompatSite,
  type CompatVehicleType,
  type CompatibilityInput,
} from './vehicle-compatibility';

// ประเภทรถตามชุดเริ่มต้น spec/02 §4
const T6W: CompatVehicleType = { id: 'vt6', code: '6W', vehicleClass: '6W', capabilityTags: [] };
const T10W: CompatVehicleType = {
  id: 'vt10',
  code: '10W',
  vehicleClass: '10W',
  capabilityTags: [],
};
const TRL: CompatVehicleType = {
  id: 'trl',
  code: 'TRL',
  vehicleClass: 'TRAILER',
  capabilityTags: [],
};
const REF6: CompatVehicleType = {
  id: 'ref6',
  code: 'REF6',
  vehicleClass: '6W',
  capabilityTags: ['REFRIGERATED'],
  tempMinC: '0.0',
  tempMaxC: '8.0',
};
const HAZ10: CompatVehicleType = { ...T10W, id: 'haz', capabilityTags: ['HAZMAT', 'CRANE'] };

const general: CompatProduct = { id: 'p1', code: 'P-1', tempControlled: false, hazardous: false };
const chilled: CompatProduct = {
  id: 'p2',
  code: 'P-2',
  tempControlled: true,
  tempMinC: 2,
  tempMaxC: 8,
  hazardous: false,
};
const frozen: CompatProduct = {
  id: 'p3',
  code: 'P-3',
  tempControlled: true,
  tempMinC: '-18.0',
  tempMaxC: '-15.0',
  hazardous: false,
};
const fuel: CompatProduct = { id: 'p4', code: 'P-4', tempControlled: false, hazardous: true };

const soi: CompatSite = { id: 's1', code: 'LOC-1', maxVehicleClass: '6W' };
const open: CompatSite = { id: 's2', code: 'LOC-2', maxVehicleClass: null };
const dc: CompatSite = { id: 's3', code: 'LOC-3', maxVehicleClass: '10W' };

const codes = (i: CompatibilityInput) => checkVehicleCompatibility(i).map((w) => w.code);

describe('checkVehicleCompatibility', () => {
  it('เกณฑ์ตรวจรับ: สินค้า "ห้องเย็นเท่านั้น" + รถธรรมดา → คำเตือน TEMP_MISMATCH (ไม่บล็อก)', () => {
    const w = checkVehicleCompatibility({ vehicleType: T6W, products: [chilled] });
    expect(w).toEqual([
      {
        code: 'TEMP_MISMATCH',
        severity: 'warning',
        messageKey: 'compat.tempNotRefrigerated',
        params: { productTempMinC: 2, productTempMaxC: 8 },
        source: { kind: 'product', id: 'p2', code: 'P-2' },
      },
    ]);
    expect(hasCompatibilityWarnings(w)).toBe(true);
  });

  it('ห้องเย็นที่ช่วงครอบคลุม → ไม่มีคำเตือน', () => {
    expect(codes({ vehicleType: REF6, products: [chilled, general] })).toEqual([]);
  });

  it('ห้องเย็นแต่ช่วงไม่ครอบคลุม (แช่แข็ง −18 กับรถ 0…+8) → tempRangeNotCovered', () => {
    const w = checkVehicleCompatibility({ vehicleType: REF6, products: [frozen] });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({
      code: 'TEMP_MISMATCH',
      messageKey: 'compat.tempRangeNotCovered',
      params: {
        productTempMinC: -18,
        productTempMaxC: -15,
        vehicleTempMinC: 0,
        vehicleTempMaxC: 8,
      },
    });
  });

  it('ขอบช่วงพอดี (เท่ากัน) ถือว่าครอบคลุม; เทียบทศนิยมไม่มีปัญหา float', () => {
    const p = { ...chilled, tempMinC: '0.1', tempMaxC: 0.3 };
    const v = { ...REF6, tempMinC: 0.1, tempMaxC: '0.3' };
    expect(codes({ vehicleType: v, products: [p] })).toEqual([]);
    expect(codes({ vehicleType: { ...v, tempMinC: 0.2 }, products: [p] })).toEqual([
      'TEMP_MISMATCH',
    ]);
  });

  it('รถห้องเย็นที่ไม่มีช่วงอุณหภูมิ → เตือน (ยืนยันไม่ได้)', () => {
    const v = { ...REF6, tempMinC: null, tempMaxC: null };
    expect(checkVehicleCompatibility({ vehicleType: v, products: [chilled] })[0]?.messageKey).toBe(
      'compat.tempRangeNotCovered',
    );
  });

  it('สินค้าอันตราย + รถไม่มีป้าย HAZMAT → HAZMAT_NOT_ALLOWED; มีป้าย → ผ่าน', () => {
    expect(codes({ vehicleType: T10W, products: [fuel] })).toEqual(['HAZMAT_NOT_ALLOWED']);
    expect(codes({ vehicleType: HAZ10, products: [fuel] })).toEqual([]);
  });

  it('สินค้าทั่วไปกับรถทุกประเภท → ไม่มีคำเตือน', () => {
    for (const v of [T6W, T10W, TRL, REF6, HAZ10]) {
      expect(codes({ vehicleType: v, products: [general] })).toEqual([]);
    }
  });

  it.each([
    ['6W', T6W, []],
    ['10W', T10W, ['LOCATION_VEHICLE_LIMIT']],
    ['TRAILER', TRL, ['LOCATION_VEHICLE_LIMIT']],
    ['REF6 (6 ล้อ)', REF6, []],
  ] as const)('จุดส่ง "เข้าได้สูงสุด 6 ล้อ" (ห้าม 10 ล้อเข้าซอย) กับรถ %s', (_l, v, want) => {
    expect(codes({ vehicleType: v, sites: [soi] })).toEqual(want);
  });

  it('จุดไม่จำกัด → ไม่เตือน; พ่วงเข้าจุดเทรลเลอร์ (rank 8 เท่ากัน) → ไม่เตือน', () => {
    expect(codes({ vehicleType: TRL, sites: [open] })).toEqual([]);
    expect(
      codes({ vehicleType: TRL, sites: [{ id: 'x', maxVehicleClass: 'SEMI_TRAILER' }] }),
    ).toEqual([]);
  });

  it('ใช้ข้อจำกัดของทุกจุด (PLN-085) — เตือนรายจุด; จุดซ้ำนับครั้งเดียว', () => {
    const w = checkVehicleCompatibility({ vehicleType: TRL, sites: [open, soi, dc, soi] });
    expect(w.map((x) => x.source)).toEqual([
      { kind: 'site', id: 's1', code: 'LOC-1' },
      { kind: 'site', id: 's3', code: 'LOC-3' },
    ]);
    expect(w[0]!.params).toEqual({ maxVehicleClass: '6W', vehicleClass: 'TRAILER' });
  });

  it('งานต้องการติดเครน/ลากตู้ → CAPABILITY_MISSING ต่อป้าย (เรียงตามลำดับมาตรฐาน, ซ้ำนับครั้งเดียว)', () => {
    const w = checkVehicleCompatibility({
      vehicleType: HAZ10,
      job: { requiredCapabilities: ['CONTAINER', 'CRANE', 'REFRIGERATED', 'CONTAINER'] },
    });
    expect(w.map((x) => x.params.capability)).toEqual(['REFRIGERATED', 'CONTAINER']);
    expect(w.every((x) => x.code === 'CAPABILITY_MISSING' && x.source.kind === 'job')).toBe(true);
  });

  it('MD-093: รถเล็กกว่าที่ SO ขอ → warning; ใหญ่กว่า → info (ไม่นับเป็นคำเตือนที่ต้องมีเหตุผล)', () => {
    const smaller = checkVehicleCompatibility({
      vehicleType: T6W,
      job: { requestedVehicleClass: '10W' },
    });
    expect(smaller).toEqual([
      {
        code: 'VEHICLE_SMALLER_THAN_REQUESTED',
        severity: 'warning',
        messageKey: 'compat.smallerThanRequested',
        params: { requestedClass: '10W', vehicleClass: '6W' },
        source: { kind: 'job' },
      },
    ]);
    const larger = checkVehicleCompatibility({
      vehicleType: TRL,
      job: { requestedVehicleClass: '10W' },
    });
    expect(larger.map((x) => [x.code, x.severity])).toEqual([
      ['VEHICLE_LARGER_THAN_REQUESTED', 'info'],
    ]);
    expect(hasCompatibilityWarnings(larger)).toBe(false);
    expect(codes({ vehicleType: REF6, job: { requestedVehicleClass: '6W' } })).toEqual([]);
  });

  it('รวมทุกแหล่ง: ลำดับ งาน → สินค้า (ตามลำดับที่ส่ง) → จุด และผลเหมือนเดิมทุกครั้ง', () => {
    const input: CompatibilityInput = {
      vehicleType: T10W,
      job: { requiredCapabilities: ['CRANE'], requestedVehicleClass: 'TRAILER' },
      products: [fuel, chilled, general],
      sites: [soi],
    };
    const want = [
      'CAPABILITY_MISSING',
      'VEHICLE_SMALLER_THAN_REQUESTED',
      'HAZMAT_NOT_ALLOWED',
      'TEMP_MISMATCH',
      'LOCATION_VEHICLE_LIMIT',
    ];
    expect(codes(input)).toEqual(want);
    expect(checkVehicleCompatibility(input)).toEqual(checkVehicleCompatibility(input));
  });

  it('สินค้าที่ห้องเย็น + อันตราย พร้อมกัน → 2 คำเตือนจากสินค้าเดียว', () => {
    const both = { ...chilled, id: 'p5', hazardous: true };
    expect(codes({ vehicleType: T6W, products: [both] })).toEqual([
      'TEMP_MISMATCH',
      'HAZMAT_NOT_ALLOWED',
    ]);
  });

  it('ไม่มีสินค้า/จุด/งาน หรือชั้นรถที่ไม่รู้จัก → ไม่เตือน (ไม่เดา)', () => {
    expect(codes({ vehicleType: T10W })).toEqual([]);
    expect(
      codes({ vehicleType: { vehicleClass: 'BUS', capabilityTags: [] }, sites: [soi] }),
    ).toEqual([]);
    expect(codes({ vehicleType: T10W, sites: [{ maxVehicleClass: 'XYZ' }] })).toEqual([]);
  });
});
