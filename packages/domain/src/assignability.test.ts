import { describe, expect, it } from 'vitest';
import {
  ASSIGNABILITY_OVERRIDE,
  checkAssignability,
  isAssignable,
  type AssignDocument,
  type AssignabilityInput,
} from './assignability';

const DATE = '2026-11-20';
const doc = (
  docType: string,
  startsOn: string,
  expiresOn: string,
  extra: Partial<AssignDocument> = {},
): AssignDocument => ({
  id: `${docType}-${expiresOn}`,
  docType,
  status: 'ACTIVE',
  startsOn,
  expiresOn,
  isRequiredForDispatch: docType === 'INSURANCE' || docType === 'COMPULSORY_ACT',
  ...extra,
});
const INS_OK = doc('INSURANCE', '2026-01-01', '2026-12-31');
const CMI_OK = doc('COMPULSORY_ACT', '2026-03-01', '2027-02-28');
const subcon = (documents: AssignDocument[], driver?: AssignabilityInput['driver'], date = DATE) =>
  checkAssignability({ vehicle: { ownership: 'SUBCONTRACT' }, documents, driver, date });
const own = (documents: AssignDocument[], driver?: AssignabilityInput['driver'], date = DATE) =>
  checkAssignability({ vehicle: { ownership: 'OWN' }, documents, driver, date });

describe('checkAssignability — รถร่วม: เอกสารบังคับก่อนรับงาน (ST2-T20)', () => {
  it('เกณฑ์ตรวจรับ: รถร่วมที่ พ.ร.บ. หมดอายุ → isAssignable() = false พร้อมเหตุ', () => {
    const cmi = doc('COMPULSORY_ACT', '2025-11-01', '2026-10-31', { status: 'EXPIRED' });
    const input = {
      vehicle: { ownership: 'SUBCONTRACT' },
      documents: [INS_OK, cmi],
      date: DATE,
    };
    expect(isAssignable(input)).toBe(false);
    expect(checkAssignability(input)).toEqual({
      assignable: false,
      blocks: [
        {
          code: 'DOC_CMI_EXPIRED',
          severity: 'block',
          messageKey: 'assign.docExpired',
          params: { docType: 'COMPULSORY_ACT', expiredOn: '2026-10-31' },
          docType: 'COMPULSORY_ACT',
          expiredOn: '2026-10-31',
          documentId: cmi.id,
        },
      ],
      warnings: [],
      overridable: true,
    });
  });

  it('เอกสารครบ + ใบขับขี่ยังไม่หมด → assignable', () => {
    const r = subcon([INS_OK, CMI_OK], { licenceExpiresOn: '2028-05-01' });
    expect(r).toEqual({ assignable: true, blocks: [], warnings: [], overridable: true });
  });

  it.each([
    // [กรณี, เอกสาร, คนขับ, รหัสที่คาด]
    ['ไม่มีประกันภัย', [CMI_OK], null, ['DOC_MISSING']],
    ['ไม่มีทั้งสองฉบับ', [], null, ['DOC_MISSING', 'DOC_MISSING']],
    [
      'ประกันภัยหมด',
      [doc('INSURANCE', '2025-11-01', '2026-11-19'), CMI_OK],
      null,
      ['DOC_INSURANCE_EXPIRED'],
    ],
    ['วันหมด = วันวิ่ง ยังใช้ได้', [doc('INSURANCE', '2025-11-21', DATE), CMI_OK], null, []],
    [
      'ประกันภัยยกเลิกแล้ว = ไม่มี',
      [doc('INSURANCE', '2026-01-01', '2026-12-31', { status: 'CANCELLED' }), CMI_OK],
      null,
      ['DOC_MISSING'],
    ],
    [
      'ST2-T21: ประกันภัยฉบับใหม่ที่รถร่วมส่งผ่านลิงก์ยังรอตรวจ = ยังไม่ปลดบล็อก',
      [
        doc('INSURANCE', '2025-11-01', '2026-11-19', { status: 'EXPIRED' }),
        doc('INSURANCE', '2026-11-19', '2027-11-19', { status: 'PENDING_REVIEW' }),
        CMI_OK,
      ],
      null,
      ['DOC_INSURANCE_EXPIRED'],
    ],
    [
      'ST2-T21: ฉบับที่ไม่อนุมัติ = ไม่มี',
      [doc('INSURANCE', '2026-01-01', '2026-12-31', { status: 'REJECTED' }), CMI_OK],
      null,
      ['DOC_MISSING'],
    ],
    [
      'ใบขับขี่หมด',
      [INS_OK, CMI_OK],
      { licenceExpiresOn: '2026-11-19' },
      ['DRIVER_LICENCE_EXPIRED'],
    ],
    [
      'ใบขับขี่ไม่มีวันหมด',
      [INS_OK, CMI_OK],
      { licenceExpiresOn: null },
      ['DRIVER_LICENCE_MISSING'],
    ],
    ['ไม่ส่งคนขับ = ไม่ตรวจใบขับขี่', [INS_OK, CMI_OK], null, []],
    [
      'ธง isRequiredForDispatch ปิดก็ยังบังคับประกัน/พ.ร.บ.',
      [doc('INSURANCE', '2025-01-01', '2025-12-31', { isRequiredForDispatch: false }), CMI_OK],
      null,
      ['DOC_INSURANCE_EXPIRED'],
    ],
    [
      'ภาษีประจำปีที่ตั้ง "บังคับก่อนจ่ายงาน" หมด → บล็อก',
      [
        INS_OK,
        CMI_OK,
        doc('ANNUAL_TAX', '2025-01-01', '2026-01-01', { isRequiredForDispatch: true }),
      ],
      null,
      ['DOC_TAX_EXPIRED'],
    ],
    [
      'ตรอ. ไม่ได้ตั้งบังคับ หมดก็ไม่บล็อก',
      [INS_OK, CMI_OK, doc('INSPECTION', '2025-01-01', '2026-01-01')],
      null,
      [],
    ],
    [
      'GPS DLT ตั้งบังคับ หมด → DOC_OTHER_EXPIRED',
      [
        INS_OK,
        CMI_OK,
        doc('GPS_DLT_CERT', '2025-01-01', '2026-01-01', { isRequiredForDispatch: true }),
      ],
      null,
      ['DOC_OTHER_EXPIRED'],
    ],
    [
      'ต่ออายุแล้ว (ฉบับเก่า SUPERSEDED หมด + ฉบับใหม่ครอบคลุม) → ผ่าน',
      [
        doc('COMPULSORY_ACT', '2025-11-01', '2026-10-31', { status: 'SUPERSEDED' }),
        doc('COMPULSORY_ACT', '2026-11-01', '2027-10-31'),
        INS_OK,
      ],
      null,
      [],
    ],
    [
      'ฉบับใหม่เริ่มหลังวันวิ่ง และฉบับเดิมหมดก่อน → DOC_NOT_YET_VALID',
      [
        doc('COMPULSORY_ACT', '2025-11-01', '2026-10-31', { status: 'SUPERSEDED' }),
        doc('COMPULSORY_ACT', '2026-12-01', '2027-11-30'),
        INS_OK,
      ],
      null,
      ['DOC_NOT_YET_VALID'],
    ],
    [
      'วันวิ่งในอดีต — ฉบับเก่าที่ถูกต่ออายุยังครอบคลุม → ผ่าน',
      [
        doc('INSURANCE', '2025-01-01', '2025-12-31', { status: 'SUPERSEDED' }),
        INS_OK,
        doc('COMPULSORY_ACT', '2025-01-01', '2025-12-31', { status: 'SUPERSEDED' }),
        CMI_OK,
      ],
      null,
      [],
      '2025-06-01',
    ],
    [
      'ทุกอย่างพร้อมกัน: เรียงตามประเภทเอกสาร แล้วใบขับขี่',
      [doc('COMPULSORY_ACT', '2025-01-01', '2025-12-31')],
      { licenceExpiresOn: '2020-01-01' },
      ['DOC_MISSING', 'DOC_CMI_EXPIRED', 'DRIVER_LICENCE_EXPIRED'],
    ],
  ] as [string, AssignDocument[], AssignabilityInput['driver'], string[], string?][])(
    '%s',
    (_name, docs, driver, codes, date = DATE) => {
      const r = subcon(docs, driver, date);
      expect(r.blocks.map((b) => b.code)).toEqual(codes);
      expect(r.assignable).toBe(codes.length === 0);
      expect(r.warnings).toEqual([]);
      expect(r.blocks.every((b) => b.severity === 'block')).toBe(true);
    },
  );

  it('ไม่มีเอกสาร: docType บอกว่าขาดฉบับไหน', () => {
    expect(subcon([CMI_OK]).blocks).toEqual([
      {
        code: 'DOC_MISSING',
        severity: 'block',
        messageKey: 'assign.docMissing',
        params: { docType: 'INSURANCE' },
        docType: 'INSURANCE',
      },
    ]);
  });

  it('ยังไม่เริ่มคุ้มครอง: บอกวันเริ่มของฉบับถัดไป', () => {
    const r = subcon([INS_OK, doc('COMPULSORY_ACT', '2026-12-01', '2027-11-30')]);
    expect(r.blocks[0]).toMatchObject({
      code: 'DOC_NOT_YET_VALID',
      messageKey: 'assign.docNotYetValid',
      params: { docType: 'COMPULSORY_ACT', startsOn: '2026-12-01' },
    });
  });

  it('วันที่ต้องเป็น YYYY-MM-DD', () => {
    expect(() => subcon([], null, '20/11/2026')).toThrow(RangeError);
    expect(() => subcon([], null, '2026-02-30')).toThrow(RangeError);
  });

  it('override: admin (owner + admin) พร้อมเหตุผล ≥ 10 ตัว หมวด OVERRIDE', () => {
    expect(ASSIGNABILITY_OVERRIDE).toEqual({
      permission: 'users:write',
      roles: ['owner', 'admin'],
      reasonCategory: 'OVERRIDE',
      reasonMinLength: 10,
    });
  });
});

describe('checkAssignability — รถบริษัท: เตือนไม่บล็อก (docs/04 B2.3 D)', () => {
  it('ไม่มีเอกสารเลย → ไม่บล็อก ไม่เตือน', () => {
    expect(own([], { licenceExpiresOn: null })).toEqual({
      assignable: true,
      blocks: [],
      warnings: [],
      overridable: true,
    });
  });

  it('พ.ร.บ. (บังคับก่อนจ่ายงาน) + ใบขับขี่หมด → คำเตือน, assignable ยังเป็น true', () => {
    const r = own([INS_OK, doc('COMPULSORY_ACT', '2025-11-01', '2026-10-31')], {
      licenceExpiresOn: '2026-11-01',
    });
    expect(r.assignable).toBe(true);
    expect(r.blocks).toEqual([]);
    expect(r.warnings.map((w) => [w.code, w.severity])).toEqual([
      ['DOC_CMI_EXPIRED', 'warning'],
      ['DRIVER_LICENCE_EXPIRED', 'warning'],
    ]);
  });

  it('เอกสารที่ไม่ได้ตั้งบังคับหมด → ไม่เตือน', () => {
    const r = own([doc('INSURANCE', '2025-01-01', '2025-12-31', { isRequiredForDispatch: false })]);
    expect(r.warnings).toEqual([]);
  });

  it('ฉบับปัจจุบันยังไม่เริ่ม (ช่องว่าง) → คำเตือน DOC_NOT_YET_VALID', () => {
    const r = own([doc('INSURANCE', '2026-12-01', '2027-11-30')]);
    expect(r.assignable).toBe(true);
    expect(r.warnings.map((w) => [w.code, w.severity])).toEqual([['DOC_NOT_YET_VALID', 'warning']]);
  });
});

describe('checkAssignability — ชุดเอกสาร OTHER + ช่วงวิ่ง (review ST2-T20)', () => {
  const other = (
    id: string,
    startsOn: string,
    expiresOn: string,
    extra: Partial<AssignDocument> = {},
  ) => doc('OTHER', startsOn, expiresOn, { id, title: `เอกสาร ${id}`, ...extra });

  it('OTHER: ชุดที่ตั้งบังคับหมด + อีกชุดไม่ตั้งบังคับยังใช้ได้ → ยังบล็อก', () => {
    const r = subcon([
      INS_OK,
      CMI_OK,
      other('o1', '2025-01-01', '2026-01-01', { isRequiredForDispatch: true }),
      other('o2', '2026-01-01', '2027-12-31', { isRequiredForDispatch: false }),
    ]);
    expect(r.blocks).toEqual([
      {
        code: 'DOC_OTHER_EXPIRED',
        severity: 'block',
        messageKey: 'assign.docExpired',
        params: { docType: 'OTHER', expiredOn: '2026-01-01', title: 'เอกสาร o1' },
        docType: 'OTHER',
        expiredOn: '2026-01-01',
        documentId: 'o1',
      },
    ]);
  });

  it('OTHER: ตั้งบังคับ 2 ชุด หมด 1 ชุด → บล็อกชุดที่หมด', () => {
    const r = subcon([
      INS_OK,
      CMI_OK,
      other('a', '2026-01-01', '2027-12-31', { isRequiredForDispatch: true }),
      other('b', '2025-01-01', '2026-06-30', { isRequiredForDispatch: true }),
    ]);
    expect(r.blocks.map((b) => [b.code, b.documentId])).toEqual([['DOC_OTHER_EXPIRED', 'b']]);
  });

  it('OTHER: ต่ออายุในสายเดียวกัน (renewsId) → ชุดเดียว ครอบคลุม', () => {
    const r = subcon([
      INS_OK,
      CMI_OK,
      other('x1', '2025-01-01', '2026-06-30', {
        status: 'SUPERSEDED',
        isRequiredForDispatch: true,
      }),
      other('x2', '2026-07-01', '2027-06-30', { renewsId: 'x1', isRequiredForDispatch: true }),
    ]);
    expect(r.blocks).toEqual([]);
  });

  it('ช่วงวิ่ง: ต้องครอบคลุมทั้งช่วง — พ.ร.บ./ใบขับขี่หมดกลางช่วง → บล็อก (เทียบวันสิ้นสุด)', () => {
    const cmi = doc('COMPULSORY_ACT', '2025-11-22', '2026-11-21');
    const base = { vehicle: { ownership: 'SUBCONTRACT' }, documents: [INS_OK, cmi] };
    expect(
      checkAssignability({ ...base, window: { from: '2026-11-20', to: '2026-11-21' } }).assignable,
    ).toBe(true);
    const r = checkAssignability({
      ...base,
      driver: { licenceExpiresOn: '2026-11-21' },
      window: { from: '2026-11-20', to: '2026-11-22' },
    });
    expect(r.blocks.map((b) => [b.code, b.expiredOn])).toEqual([
      ['DOC_CMI_EXPIRED', '2026-11-21'],
      ['DRIVER_LICENCE_EXPIRED', '2026-11-21'],
    ]);
  });

  it('ช่วงวิ่ง: ฉบับต่อกันพอดี = ครอบคลุม · มีช่องว่าง 1 วัน = DOC_NOT_YET_VALID', () => {
    const base = {
      vehicle: { ownership: 'SUBCONTRACT' },
      window: { from: '2026-11-20', to: '2026-11-25' },
    };
    const old = doc('COMPULSORY_ACT', '2025-11-22', '2026-11-21', { status: 'SUPERSEDED' });
    const next = (s: string, e: string) => doc('COMPULSORY_ACT', s, e);
    expect(
      checkAssignability({ ...base, documents: [INS_OK, old, next('2026-11-22', '2027-11-21')] })
        .assignable,
    ).toBe(true);
    const gap = checkAssignability({
      ...base,
      documents: [INS_OK, old, next('2026-11-23', '2027-11-22')],
    });
    expect(gap.blocks.map((b) => [b.code, b.params.startsOn])).toEqual([
      ['DOC_NOT_YET_VALID', '2026-11-23'],
    ]);
  });

  it('ช่วงวิ่งกลับด้าน → RangeError', () => {
    expect(() =>
      checkAssignability({
        vehicle: { ownership: 'OWN' },
        documents: [],
        window: { from: '2026-11-22', to: '2026-11-20' },
      }),
    ).toThrow(RangeError);
  });
});
