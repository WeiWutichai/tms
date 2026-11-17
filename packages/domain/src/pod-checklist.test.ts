import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POD_REQUIREMENTS,
  parsePodChecklist,
  parsePodRequirements,
  resolvePodChecklist,
  validatePod,
  type PodChecklist,
} from './pod-checklist';

const photoSig: PodChecklist = {
  fields: [
    { key: 'photo', type: 'PHOTO', level: 'REQUIRED', minCount: 1 },
    { key: 'signature', type: 'SIGNATURE', level: 'REQUIRED' },
    { key: 'note', type: 'NOTE', level: 'DISABLED' },
  ],
};

describe('parsePodChecklist', () => {
  it('เติมชนิดเดี่ยวที่ไม่ส่งเป็น DISABLED และเรียงตามชนิด', () => {
    const r = parsePodChecklist({
      fields: [
        { type: 'BOOLEAN', key: 'goods_ok', level: 'REQUIRED', label: '  สินค้าครบ ไม่เสียหาย ' },
        { type: 'SIGNATURE', level: 'ENABLED' },
      ],
    });
    expect(r.errors).toEqual([]);
    expect(r.value!.fields).toEqual([
      { key: 'photo', type: 'PHOTO', level: 'DISABLED', minCount: 1 },
      { key: 'signature', type: 'SIGNATURE', level: 'ENABLED' },
      { key: 'note', type: 'NOTE', level: 'DISABLED' },
      { key: 'goods_ok', type: 'BOOLEAN', level: 'REQUIRED', label: 'สินค้าครบ ไม่เสียหาย' },
    ]);
  });

  it('ปฏิเสธชนิด/ระดับที่ไม่รู้จัก ชนิดเดี่ยวซ้ำ BOOLEAN ไม่มีข้อความ และ minCount เกิน 5', () => {
    const r = parsePodChecklist({
      fields: [
        { type: 'BARCODE', level: 'REQUIRED' },
        { type: 'PHOTO', level: 'MANDATORY' },
        { type: 'PHOTO', level: 'REQUIRED', minCount: 6 },
        { type: 'BOOLEAN', key: 'x', level: 'ENABLED' },
        { type: 'NOTE', level: 'ENABLED', minCount: 2 },
        { type: 'SIGNATURE', key: 'sig', level: 'ENABLED' },
      ],
    });
    expect(r.value).toBeNull();
    const codes = r.errors.map((e) => `${e.path}:${e.code}`);
    expect(codes).toEqual(
      expect.arrayContaining([
        'fields.0.type:invalid',
        'fields.1.level:invalid',
        'fields.2.minCount:invalid',
        'fields.2.key:duplicate',
        'fields.3.label:invalid',
        'fields.4.minCount:not_allowed',
        'fields.5.key:invalid',
      ]),
    );
  });

  it('BOOLEAN ใช้ key ของชนิดเดี่ยวไม่ได้ และเกิน 10 ข้อถูกปฏิเสธ', () => {
    expect(
      parsePodChecklist({
        fields: [{ type: 'BOOLEAN', key: 'photo', level: 'ENABLED', label: 'x' }],
      }).errors[0]!.code,
    ).toBe('invalid');
    const many = Array.from({ length: 11 }, (_, i) => ({
      type: 'BOOLEAN',
      key: `c${i}`,
      level: 'ENABLED',
      label: `ข้อ ${i}`,
    }));
    expect(parsePodChecklist({ fields: many }).errors.map((e) => e.code)).toContain('too_many');
  });
});

describe('parsePodRequirements', () => {
  it('ค่าองค์กรต้องมีชุด success; ของลูกค้า {} = ใช้ค่าองค์กร', () => {
    expect(parsePodRequirements({}, true).errors[0]).toMatchObject({
      path: 'success',
      code: 'required',
    });
    expect(parsePodRequirements({}, false)).toEqual({ value: {}, errors: [] });
    expect(parsePodRequirements({ failure: { fields: [] } }, false).errors[0]!.code).toBe(
      'unknown_property',
    );
    expect(parsePodRequirements(DEFAULT_POD_REQUIREMENTS, true).errors).toEqual([]);
  });
});

describe('resolvePodChecklist', () => {
  const tenant = { success: { fields: [{ type: 'PHOTO', level: 'ENABLED' }] } };
  it('ลูกค้าที่ override ใช้ชุดของลูกค้า', () => {
    const r = resolvePodChecklist(tenant, { success: photoSig });
    expect(r.source).toBe('CUSTOMER');
    expect(r.checklist.fields[1]).toMatchObject({ type: 'SIGNATURE', level: 'REQUIRED' });
  });
  it('ลูกค้าไม่ override ({}) ใช้ค่าองค์กร; ไม่มีค่าองค์กร = ค่าเริ่มต้นของระบบ', () => {
    expect(resolvePodChecklist(tenant, {})).toMatchObject({ source: 'TENANT' });
    expect(resolvePodChecklist(tenant, {}).checklist.fields[0]).toMatchObject({ level: 'ENABLED' });
    expect(resolvePodChecklist(undefined, null).checklist).toEqual(
      DEFAULT_POD_REQUIREMENTS.success,
    );
  });
});

describe('validatePod', () => {
  it('ลูกค้า A บังคับรูป + ลายเซ็น: ไม่มีรูป → ขาด photo', () => {
    const r = validatePod(photoSig, { photoCount: 0, hasSignature: true });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual([
      { key: 'photo', type: 'PHOTO', code: 'required', expected: 1, actual: 0 },
    ]);
  });
  it('ครบ → ok; รูปน้อยกว่าขั้นต่ำ → min_count', () => {
    expect(validatePod(photoSig, { photoCount: 2, hasSignature: true }).ok).toBe(true);
    const two: PodChecklist = {
      fields: [{ key: 'photo', type: 'PHOTO', level: 'REQUIRED', minCount: 2 }],
    };
    expect(validatePod(two, { photoCount: 1, hasSignature: false }).missing[0]).toMatchObject({
      code: 'min_count',
      expected: 2,
      actual: 1,
    });
  });
  it('NOTE บังคับต้องไม่ว่าง; BOOLEAN บังคับต้องเป็น true; ENABLED/DISABLED ไม่ตรวจ', () => {
    const c: PodChecklist = {
      fields: [
        { key: 'photo', type: 'PHOTO', level: 'ENABLED', minCount: 3 },
        { key: 'note', type: 'NOTE', level: 'REQUIRED' },
        { key: 'ok', type: 'BOOLEAN', level: 'REQUIRED', label: 'ของครบ' },
        { key: 'opt', type: 'BOOLEAN', level: 'ENABLED', label: 'ไม่บังคับ' },
      ],
    };
    const r = validatePod(c, {
      photoCount: 0,
      hasSignature: false,
      note: '   ',
      checks: { ok: false },
    });
    expect(r.missing.map((m) => m.key)).toEqual(['note', 'ok']);
    expect(
      validatePod(c, {
        photoCount: 0,
        hasSignature: false,
        note: 'วางหน้าร้าน',
        checks: { ok: true },
      }).ok,
    ).toBe(true);
  });
});
