import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POD_REQUIREMENTS,
  DEFAULT_POD_SETS,
  podOutcomeFor,
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
      { key: 'barcode', type: 'BARCODE', level: 'DISABLED' },
      { key: 'pin', type: 'PIN', level: 'DISABLED', length: 4 },
      { key: 'rating', type: 'RATING', level: 'DISABLED', max: 5 },
      { key: 'goods_ok', type: 'BOOLEAN', level: 'REQUIRED', label: 'สินค้าครบ ไม่เสียหาย' },
    ]);
  });

  it('ปฏิเสธชนิด/ระดับที่ไม่รู้จัก ชนิดเดี่ยวซ้ำ BOOLEAN ไม่มีข้อความ และ minCount เกิน 5', () => {
    const r = parsePodChecklist({
      fields: [
        { type: 'QR', level: 'REQUIRED' },
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
    // ชุดที่ไม่ส่ง: ค่าองค์กร = เติมค่าระบบ (เพิ่มชุดใหม่ใน T06 แล้วข้อมูลเดิมไม่ 422)
    expect(parsePodRequirements({}, true)).toEqual({ value: DEFAULT_POD_REQUIREMENTS, errors: [] });
    expect(parsePodRequirements({}, false)).toEqual({ value: {}, errors: [] });
    expect(parsePodRequirements({ partial: { fields: [] } }, false).errors[0]!.code).toBe(
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

describe('resolvePodChecklist: ค่าในฐานผิดรูป', () => {
  it('override ลูกค้าผิดรูป → ใช้ค่าองค์กร และคืน fallbacks ให้ผู้เรียก log', () => {
    const r = resolvePodChecklist(
      { success: { fields: [{ type: 'NOTE', level: 'REQUIRED' }] } },
      { success: { fields: [{ type: 'PHOTO', level: 'BAD' }] } },
    );
    expect(r.source).toBe('TENANT');
    expect(r.fallbacks).toHaveLength(1);
    expect(r.fallbacks[0]!.layer).toBe('CUSTOMER');
    expect(resolvePodChecklist(undefined, {}).fallbacks).toEqual([]);
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

describe('ST4-T06 ชนิดเพิ่ม: BARCODE / SINGLE_CHOICE / PIN / RATING', () => {
  it('parse: ตัวเลือกประจำชนิด + ค่าเริ่มต้น และตัดช่องว่างตัวเลือก', () => {
    const r = parsePodChecklist({
      fields: [
        { type: 'BARCODE', level: 'REQUIRED' },
        { type: 'PIN', level: 'REQUIRED', length: 6 },
        { type: 'RATING', level: 'ENABLED' },
        {
          type: 'SINGLE_CHOICE',
          key: 'cond',
          level: 'REQUIRED',
          label: ' สภาพกล่อง ',
          options: [' ปกติ', 'บุบ ', 'เปียก'],
        },
      ],
    });
    expect(r.errors).toEqual([]);
    expect(r.value!.fields.slice(3)).toEqual([
      { key: 'barcode', type: 'BARCODE', level: 'REQUIRED' },
      { key: 'pin', type: 'PIN', level: 'REQUIRED', length: 6 },
      { key: 'rating', type: 'RATING', level: 'ENABLED', max: 5 },
      {
        key: 'cond',
        type: 'SINGLE_CHOICE',
        level: 'REQUIRED',
        label: 'สภาพกล่อง',
        options: ['ปกติ', 'บุบ', 'เปียก'],
      },
    ]);
  });

  it('parse: ปฏิเสธตัวเลือกผิด (น้อยกว่า 2 / ซ้ำ / ว่าง), PIN/RATING นอกช่วง, ตัวเลือกบนชนิดอื่น', () => {
    const r = parsePodChecklist({
      fields: [
        { type: 'SINGLE_CHOICE', key: 'a', level: 'ENABLED', label: 'x', options: ['เดียว'] },
        { type: 'SINGLE_CHOICE', key: 'b', level: 'ENABLED', label: 'y', options: ['ก', 'ก', ''] },
        { type: 'SINGLE_CHOICE', key: 'c', level: 'ENABLED', options: ['ก', 'ข'] },
        { type: 'PIN', level: 'REQUIRED', length: 3 },
        { type: 'RATING', level: 'REQUIRED', max: 11 },
        { type: 'BARCODE', level: 'REQUIRED', options: ['x'], label: 'สแกน' },
        { type: 'BOOLEAN', key: 'pin', level: 'REQUIRED', label: 'x' },
      ],
    });
    expect(r.value).toBeNull();
    expect(r.errors.map((e) => `${e.path}:${e.code}`)).toEqual(
      expect.arrayContaining([
        'fields.0.options:invalid',
        'fields.1.options.1:duplicate',
        'fields.1.options.2:invalid',
        'fields.2.label:invalid',
        'fields.3.length:invalid',
        'fields.4.max:invalid',
        'fields.5.options:not_allowed',
        'fields.5.label:not_allowed',
        'fields.6.key:invalid',
      ]),
    );
  });

  const c: PodChecklist = {
    fields: [
      { key: 'barcode', type: 'BARCODE', level: 'REQUIRED' },
      { key: 'pin', type: 'PIN', level: 'REQUIRED', length: 4 },
      { key: 'rating', type: 'RATING', level: 'ENABLED', max: 5 },
      {
        key: 'cond',
        type: 'SINGLE_CHOICE',
        level: 'REQUIRED',
        label: 'สภาพกล่อง',
        options: ['ปกติ', 'บุบ'],
      },
    ],
  };
  const base = { photoCount: 0, hasSignature: false };

  it('validate: บังคับแต่ไม่ส่ง → required (RATING ไม่บังคับ → ไม่ขาด)', () => {
    const r = validatePod(c, { ...base, scanCodes: ['  '] });
    expect(r.missing.map((m) => `${m.key}:${m.code}`)).toEqual([
      'barcode:required',
      'pin:required',
      'cond:required',
    ]);
    expect(r.missing[2]).toMatchObject({ label: 'สภาพกล่อง' });
  });

  it('validate: ส่งผิดรูปแบบ → invalid (ทั้งบังคับและไม่บังคับ)', () => {
    const r = validatePod(c, {
      ...base,
      scanCodes: ['x'.repeat(201)],
      pin: '12a4',
      rating: 6,
      choices: { cond: 'แตก' },
    });
    expect(r.missing.map((m) => `${m.key}:${m.code}`)).toEqual([
      'barcode:invalid',
      'pin:invalid',
      'rating:invalid',
      'cond:invalid',
    ]);
    expect(validatePod(c, { ...base, pin: '12345' }).missing.map((m) => m.key)).toContain('pin');
  });

  it('validate: ครบถูกรูปแบบ → ok; DISABLED ไม่ตรวจแม้ค่าผิด', () => {
    expect(
      validatePod(c, {
        ...base,
        scanCodes: ['8850001234567'],
        pin: ' 0042 ',
        rating: 4,
        choices: { cond: 'บุบ' },
      }).ok,
    ).toBe(true);
    const off: PodChecklist = {
      fields: [{ key: 'pin', type: 'PIN', level: 'DISABLED', length: 4 }],
    };
    expect(validatePod(off, { ...base, pin: 'abc' }).ok).toBe(true);
  });
});

describe('ST4-T06 ชุด "ไม่สำเร็จ"', () => {
  const base = { photoCount: 0, hasSignature: false };
  it('podOutcomeFor: FAILED/UNDELIVERED_RETAIN → FAILURE, DELIVERED/PARTIAL → SUCCESS', () => {
    expect(podOutcomeFor('FAILED')).toBe('FAILURE');
    expect(podOutcomeFor('UNDELIVERED_RETAIN')).toBe('FAILURE');
    expect(podOutcomeFor('DELIVERED')).toBe('SUCCESS');
    expect(podOutcomeFor('PARTIAL')).toBe('SUCCESS');
    expect(podOutcomeFor('FAILURE')).toBe('FAILURE');
  });

  it('ค่าระบบชุดไม่สำเร็จ = รูป ≥ 1 บังคับ + หมายเหตุบังคับ, ลายเซ็นไม่ใช้ (spec/04 §13)', () => {
    const f = DEFAULT_POD_REQUIREMENTS.failure.fields;
    expect(f.find((x) => x.type === 'PHOTO')).toMatchObject({ level: 'REQUIRED', minCount: 1 });
    expect(f.find((x) => x.type === 'NOTE')).toMatchObject({ level: 'REQUIRED' });
    expect(f.find((x) => x.type === 'SIGNATURE')).toMatchObject({ level: 'DISABLED' });
  });

  it('ข้อมูล T05 (มีแค่ success) → ชุด failure ใช้ค่าองค์กร/ค่าระบบ; override แยกต่อชุด', () => {
    const t05 = { success: photoSig };
    expect(parsePodRequirements(t05, false)).toMatchObject({ errors: [] });
    expect(parsePodRequirements(t05, true).value!.failure).toEqual(DEFAULT_POD_SETS.FAILURE);
    const tenant = { failure: { fields: [{ type: 'PHOTO', level: 'ENABLED' }] } };
    expect(resolvePodChecklist(tenant, t05, 'FAILURE')).toMatchObject({ source: 'TENANT' });
    expect(resolvePodChecklist(tenant, t05, 'SUCCESS')).toMatchObject({ source: 'CUSTOMER' });
    expect(resolvePodChecklist(undefined, t05, 'FAILURE').checklist).toEqual(
      DEFAULT_POD_SETS.FAILURE,
    );
  });

  it('ตั้งชุด "ไม่สำเร็จ" บังคับรูป → ปิดงานแบบ failed ไม่มีรูปขาด photo; ชุดสำเร็จไม่กระทบ', () => {
    const cust = {
      success: { fields: [{ type: 'PHOTO', level: 'DISABLED' }] },
      failure: { fields: [{ type: 'PHOTO', level: 'REQUIRED', minCount: 1 }] },
    };
    const fail = resolvePodChecklist(undefined, cust, podOutcomeFor('FAILED')).checklist;
    expect(validatePod(fail, base).missing.map((m) => m.key)).toEqual(['photo']);
    expect(validatePod(fail, { ...base, photoCount: 1 }).ok).toBe(true);
    const ok = resolvePodChecklist(undefined, cust, podOutcomeFor('DELIVERED')).checklist;
    expect(validatePod(ok, base).ok).toBe(true);
  });
});
