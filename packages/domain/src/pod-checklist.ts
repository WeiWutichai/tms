/**
 * POD checklist (ST4-T05; docs/04 E2 "POD checklist config ต่อลูกค้า", docs/01 §3.2 `customer.pod_requirements`)
 *
 * - ค่าเริ่มต้นของ tenant อยู่ใน tenant_setting `pod.checklist`; ลูกค้า override ทั้งชุดได้ที่ `customer.pod_requirements`
 *   (`{}` = ใช้ค่าเริ่มต้นขององค์กร)
 * - ฟังก์ชันในไฟล์นี้เป็น pure — งานอื่นเรียกใช้: T07 ePOD เว็บ, T09 ลิงก์รถร่วม, แอปคนขับ (`POST /driver/stops/{id}/pod`)
 *
 * จุดต่อขยาย T06 (ทำที่นี่ที่เดียว):
 *   1. เพิ่มชนิดใน `POD_FIELD_TYPES` (BARCODE / SINGLE_CHOICE / PIN / RATING) + กฎใน `parseField` / `missingFor`
 *   2. เพิ่ม 'FAILURE' ใน `POD_OUTCOMES` → ชุดแยก `failure` (ค่าเริ่มต้นของชุดใหม่อยู่ใน `DEFAULT_POD_SETS`)
 */

/** ชนิด field ของเฟสนี้ — T06 ต่อท้าย BARCODE / SINGLE_CHOICE / PIN / RATING */
export const POD_FIELD_TYPES = ['PHOTO', 'SIGNATURE', 'NOTE', 'BOOLEAN'] as const;
export type PodFieldType = (typeof POD_FIELD_TYPES)[number];

/** Disabled = ไม่แสดง · Enabled = แสดง ไม่บังคับ · Required = ต้องมีจึงปิดงานได้ */
export const POD_FIELD_LEVELS = ['DISABLED', 'ENABLED', 'REQUIRED'] as const;
export type PodFieldLevel = (typeof POD_FIELD_LEVELS)[number];

/** ชุด checklist ต่อผลการส่ง — เฟสนี้มีเฉพาะ "สำเร็จ"; T06 เพิ่ม FAILURE */
export const POD_OUTCOMES = ['SUCCESS'] as const;
export type PodOutcome = (typeof POD_OUTCOMES)[number];
/** ชื่อ key ใน JSON ต่อชุด */
export const POD_SET_KEY: Record<PodOutcome, string> = { SUCCESS: 'success' };

/** ชนิดที่มีได้ชิ้นเดียวต่อชุด (key = ชื่อชนิดตัวเล็ก) — ที่เหลือ (BOOLEAN) เพิ่มได้หลายข้อ */
export const POD_SINGLETON_TYPES = [
  'PHOTO',
  'SIGNATURE',
  'NOTE',
] as const satisfies readonly PodFieldType[];

/** รูปสูงสุดต่อ stop ของลิงก์รถร่วม = 5 (ST4-T09) → จำนวนขั้นต่ำที่ตั้งได้ไม่เกิน 5 */
export const POD_PHOTO_MIN_COUNT_MAX = 5;
export const POD_BOOLEAN_MAX = 10;
export const POD_LABEL_MAX = 100;
const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

export interface PodField {
  /** อ้างอิงใน submission — PHOTO/SIGNATURE/NOTE = 'photo'/'signature'/'note' */
  key: string;
  type: PodFieldType;
  level: PodFieldLevel;
  /** ข้อความที่ผู้ส่งต้องยืนยัน (BOOLEAN — บังคับ) */
  label?: string;
  /** จำนวนรูปขั้นต่ำเมื่อ REQUIRED (PHOTO เท่านั้น, 1–5) */
  minCount?: number;
}

export interface PodChecklist {
  fields: PodField[];
}

/** รูปที่เก็บใน JSON (tenant default เต็มชุด / customer override บางชุดหรือ `{}`) */
export type PodRequirements = Partial<Record<'success', PodChecklist>>;

/** ค่าเริ่มต้นของระบบ (spec/04 §13 PodProfile: รูป ≥ 1 บังคับ, ลายเซ็นบังคับ, หมายเหตุไม่บังคับ) */
export const DEFAULT_POD_SETS: Record<PodOutcome, PodChecklist> = {
  SUCCESS: {
    fields: [
      { key: 'photo', type: 'PHOTO', level: 'REQUIRED', minCount: 1 },
      { key: 'signature', type: 'SIGNATURE', level: 'REQUIRED' },
      { key: 'note', type: 'NOTE', level: 'ENABLED' },
    ],
  },
};

export const DEFAULT_POD_REQUIREMENTS: Required<PodRequirements> = {
  success: DEFAULT_POD_SETS.SUCCESS,
};

export interface PodConfigError {
  /** path ใน JSON เช่น `success.fields.1.label` */
  path: string;
  code: string;
  message: string;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function parseField(raw: unknown, path: string, errors: PodConfigError[]): PodField | null {
  if (!isObj(raw)) {
    errors.push({ path, code: 'invalid', message: 'field must be an object' });
    return null;
  }
  const allowed = ['key', 'type', 'level', 'label', 'minCount'];
  for (const k of Object.keys(raw))
    if (!allowed.includes(k))
      errors.push({ path: `${path}.${k}`, code: 'unknown_property', message: 'unknown property' });
  const type = raw.type as PodFieldType;
  if (!(POD_FIELD_TYPES as readonly string[]).includes(type as string)) {
    errors.push({
      path: `${path}.type`,
      code: 'invalid',
      message: `type must be one of ${POD_FIELD_TYPES.join(', ')}`,
    });
    return null;
  }
  const level = raw.level as PodFieldLevel;
  if (!(POD_FIELD_LEVELS as readonly string[]).includes(level as string))
    errors.push({
      path: `${path}.level`,
      code: 'invalid',
      message: `level must be one of ${POD_FIELD_LEVELS.join(', ')}`,
    });
  const singleton = (POD_SINGLETON_TYPES as readonly string[]).includes(type);
  const key = singleton ? type.toLowerCase() : raw.key;
  if (singleton) {
    if (raw.key !== undefined && raw.key !== key)
      errors.push({
        path: `${path}.key`,
        code: 'invalid',
        message: `key of ${type} must be "${key}"`,
      });
  } else if (
    typeof key !== 'string' ||
    !KEY_RE.test(key) ||
    (POD_SINGLETON_TYPES as readonly string[]).includes(key.toUpperCase())
  ) {
    errors.push({
      path: `${path}.key`,
      code: 'invalid',
      message: 'key must match ^[a-z][a-z0-9_]{0,39}$ and not be photo/signature/note',
    });
  }
  const f: PodField = { key: key as string, type, level };
  if (type === 'BOOLEAN') {
    const label = typeof raw.label === 'string' ? raw.label.trim() : '';
    if (!label || label.length > POD_LABEL_MAX)
      errors.push({
        path: `${path}.label`,
        code: 'invalid',
        message: `label is required for BOOLEAN (1–${POD_LABEL_MAX} chars)`,
      });
    f.label = label;
  } else if (raw.label !== undefined && raw.label !== null) {
    errors.push({
      path: `${path}.label`,
      code: 'not_allowed',
      message: `label is only for BOOLEAN`,
    });
  }
  if (type === 'PHOTO') {
    const mc = raw.minCount ?? 1;
    if (!Number.isInteger(mc) || (mc as number) < 1 || (mc as number) > POD_PHOTO_MIN_COUNT_MAX)
      errors.push({
        path: `${path}.minCount`,
        code: 'invalid',
        message: `minCount must be an integer 1–${POD_PHOTO_MIN_COUNT_MAX}`,
      });
    f.minCount = mc as number;
  } else if (raw.minCount !== undefined && raw.minCount !== null) {
    errors.push({
      path: `${path}.minCount`,
      code: 'not_allowed',
      message: 'minCount is only for PHOTO',
    });
  }
  return f;
}

/** ตรวจ + ทำให้เป็นรูปมาตรฐาน: ชนิดเดี่ยวครบทุกตัว (ที่ไม่ส่ง = DISABLED) เรียงตาม POD_FIELD_TYPES */
export function parsePodChecklist(
  raw: unknown,
  path = '',
): { value: PodChecklist | null; errors: PodConfigError[] } {
  const errors: PodConfigError[] = [];
  if (!isObj(raw) || !Array.isArray(raw.fields)) {
    return {
      value: null,
      errors: [{ path, code: 'invalid', message: 'must be { fields: [...] }' }],
    };
  }
  const pre = path ? `${path}.` : '';
  for (const k of Object.keys(raw))
    if (k !== 'fields')
      errors.push({ path: `${pre}${k}`, code: 'unknown_property', message: 'unknown property' });
  const withIdx: { f: PodField; i: number }[] = [];
  raw.fields.forEach((x, i) => {
    const f = parseField(x, `${pre}fields.${i}`, errors);
    if (f) withIdx.push({ f, i });
  });
  const parsed = withIdx.map((x) => x.f);
  const seen = new Set<string>();
  withIdx.forEach(({ f, i }) => {
    if (seen.has(f.key))
      errors.push({
        path: `${pre}fields.${i}.key`,
        code: 'duplicate',
        message: `duplicate key "${f.key}"`,
      });
    seen.add(f.key);
  });
  if (parsed.filter((f) => f.type === 'BOOLEAN').length > POD_BOOLEAN_MAX)
    errors.push({
      path: `${pre}fields`,
      code: 'too_many',
      message: `at most ${POD_BOOLEAN_MAX} BOOLEAN fields`,
    });
  if (errors.length) return { value: null, errors };
  const fields: PodField[] = [];
  for (const t of POD_SINGLETON_TYPES) {
    const f = parsed.find((x) => x.type === t);
    fields.push(
      f ?? {
        key: t.toLowerCase(),
        type: t,
        level: 'DISABLED',
        ...(t === 'PHOTO' ? { minCount: 1 } : {}),
      },
    );
  }
  fields.push(
    ...parsed.filter((x) => !(POD_SINGLETON_TYPES as readonly string[]).includes(x.type)),
  );
  return { value: { fields }, errors };
}

/**
 * ตรวจ `pod_requirements` ทั้งก้อน
 * @param requireAll true = ค่าเริ่มต้นของ tenant (ต้องมีครบทุกชุด) · false = override ของลูกค้า (ชุดที่ไม่ส่ง = ใช้ค่าองค์กร)
 */
export function parsePodRequirements(
  raw: unknown,
  requireAll: boolean,
): { value: PodRequirements | null; errors: PodConfigError[] } {
  if (!isObj(raw))
    return { value: null, errors: [{ path: '', code: 'invalid', message: 'must be an object' }] };
  const errors: PodConfigError[] = [];
  const setKeys = POD_OUTCOMES.map((o) => POD_SET_KEY[o]);
  for (const k of Object.keys(raw))
    if (!setKeys.includes(k))
      errors.push({
        path: k,
        code: 'unknown_property',
        message: `unknown set (allowed: ${setKeys.join(', ')})`,
      });
  const out: PodRequirements = {};
  for (const k of setKeys) {
    if (raw[k] === undefined || raw[k] === null) {
      if (requireAll) errors.push({ path: k, code: 'required', message: `${k} is required` });
      continue;
    }
    const r = parsePodChecklist(raw[k], k);
    errors.push(...r.errors);
    if (r.value) (out as Record<string, PodChecklist>)[k] = r.value;
  }
  return errors.length ? { value: null, errors } : { value: out, errors };
}

export type PodChecklistSource = 'TENANT' | 'CUSTOMER';

/**
 * checklist ที่ใช้จริงของลูกค้าหนึ่งรายต่อผลการส่ง: override ของลูกค้า (ถ้ามีชุดนั้น) → ค่าองค์กร → ค่าเริ่มต้นของระบบ
 * ค่าที่อ่านจากฐานแต่ผิดรูป (ไม่ควรเกิด — เขียนผ่านตัวตรวจเสมอ) → ข้ามไปชั้นถัดไป
 */
export function resolvePodChecklist(
  tenantDefault: unknown,
  customerOverride: unknown,
  outcome: PodOutcome = 'SUCCESS',
): { source: PodChecklistSource; checklist: PodChecklist } {
  const k = POD_SET_KEY[outcome];
  if (isObj(customerOverride) && customerOverride[k] != null) {
    const r = parsePodChecklist(customerOverride[k], k);
    if (r.value) return { source: 'CUSTOMER', checklist: r.value };
  }
  if (isObj(tenantDefault) && tenantDefault[k] != null) {
    const r = parsePodChecklist(tenantDefault[k], k);
    if (r.value) return { source: 'TENANT', checklist: r.value };
  }
  return { source: 'TENANT', checklist: DEFAULT_POD_SETS[outcome] };
}

/** หลักฐานที่ส่งมาตรวจ (ผู้เรียกแปลงจาก payload ของตัวเอง — จำนวนรูป/มีลายเซ็น/หมายเหตุ/คำตอบข้อยืนยัน) */
export interface PodSubmission {
  photoCount: number;
  hasSignature: boolean;
  note?: string | null;
  /** key ของ BOOLEAN → true = ยืนยันแล้ว */
  checks?: Record<string, boolean | null | undefined>;
}

export interface PodMissing {
  key: string;
  type: PodFieldType;
  /** `required` = ไม่มี · `min_count` = รูปไม่ถึงจำนวนขั้นต่ำ */
  code: 'required' | 'min_count';
  /** จำนวนที่ต้องมี (min_count) */
  expected?: number;
  actual?: number;
  label?: string;
}

function missingFor(f: PodField, s: PodSubmission): PodMissing | null {
  if (f.level !== 'REQUIRED') return null;
  switch (f.type) {
    case 'PHOTO': {
      const need = f.minCount ?? 1;
      const have = Math.max(0, Math.trunc(s.photoCount || 0));
      if (have >= need) return null;
      return have === 0
        ? { key: f.key, type: f.type, code: 'required', expected: need, actual: 0 }
        : { key: f.key, type: f.type, code: 'min_count', expected: need, actual: have };
    }
    case 'SIGNATURE':
      return s.hasSignature ? null : { key: f.key, type: f.type, code: 'required' };
    case 'NOTE':
      return (s.note ?? '').trim() ? null : { key: f.key, type: f.type, code: 'required' };
    case 'BOOLEAN':
      // ข้อยืนยันที่บังคับ = ต้องติ๊ก "ใช่" (เหมือน checkbox required)
      return s.checks?.[f.key] === true
        ? null
        : { key: f.key, type: f.type, code: 'required', ...(f.label ? { label: f.label } : {}) };
  }
}

/** ตัวตรวจ POD — คืนรายการที่ขาด (ว่าง = ครบ) · field ที่ DISABLED/ENABLED ไม่ตรวจ ส่งมาเกินก็ไม่ปฏิเสธ */
export function validatePod(
  checklist: PodChecklist,
  submission: PodSubmission,
): { ok: boolean; missing: PodMissing[] } {
  const missing = checklist.fields
    .map((f) => missingFor(f, submission))
    .filter((x): x is PodMissing => x !== null);
  return { ok: missing.length === 0, missing };
}
