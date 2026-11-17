/**
 * POD checklist (ST4-T05; docs/04 E2 "POD checklist config ต่อลูกค้า", docs/01 §3.2 `customer.pod_requirements`)
 *
 * - ค่าเริ่มต้นของ tenant อยู่ใน tenant_setting `pod.checklist`; ลูกค้า override ทั้งชุดได้ที่ `customer.pod_requirements`
 *   (`{}` = ใช้ค่าเริ่มต้นขององค์กร)
 * - ฟังก์ชันในไฟล์นี้เป็น pure — งานอื่นเรียกใช้: T07 ePOD เว็บ, T09 ลิงก์รถร่วม, แอปคนขับ (`POST /driver/stops/{id}/pod`)
 *
 * ST4-T06: ชนิดเพิ่ม BARCODE / SINGLE_CHOICE / PIN / RATING + ชุดแยก "ไม่สำเร็จ" (`failure`)
 *   - BARCODE = สแกนบาร์โค้ด/QR อย่างน้อย 1 รหัส (spec/04 §13 `barcodeScan`, `Pod.scanCodes[]`)
 *   - SINGLE_CHOICE = คำถามเลือกตอบ 1 ข้อ (ตั้งคำถาม + ตัวเลือก 2–10) — เพิ่มได้หลายข้อแบบ BOOLEAN
 *   - PIN = รหัสตัวเลขที่ผู้รับกรอก **เก็บเป็นค่าที่บันทึกเท่านั้น** (ตรวจรูปแบบ: ตัวเลขครบ `length` หลัก) —
 *     ยังไม่เทียบกับรหัสที่ส่งให้ผู้รับล่วงหน้า (docs/spec ไม่ได้กำหนดที่มาของรหัส — DECISION spec/12 §3)
 *   - RATING = คะแนนความพึงพอใจของผู้รับ 1–`max` ดาว
 */

/** ชนิด field (docs/04 E2) */
export const POD_FIELD_TYPES = [
  'PHOTO',
  'SIGNATURE',
  'NOTE',
  'BARCODE',
  'PIN',
  'RATING',
  'BOOLEAN',
  'SINGLE_CHOICE',
] as const;
export type PodFieldType = (typeof POD_FIELD_TYPES)[number];

/** Disabled = ไม่แสดง · Enabled = แสดง ไม่บังคับ · Required = ต้องมีจึงปิดงานได้ */
export const POD_FIELD_LEVELS = ['DISABLED', 'ENABLED', 'REQUIRED'] as const;
export type PodFieldLevel = (typeof POD_FIELD_LEVELS)[number];

/** ชุด checklist ต่อผลการส่ง: SUCCESS = ส่งสำเร็จ (DELIVERED/PARTIAL) · FAILURE = ส่งไม่สำเร็จ (FAILED/UNDELIVERED_RETAIN) */
export const POD_OUTCOMES = ['SUCCESS', 'FAILURE'] as const;
export type PodOutcome = (typeof POD_OUTCOMES)[number];
/** ชื่อ key ใน JSON ต่อชุด */
export const POD_SET_KEY: Record<PodOutcome, 'success' | 'failure'> = {
  SUCCESS: 'success',
  FAILURE: 'failure',
};

/** ผลปิดจุด (stop outcome — `stop-event.ts`) → ชุด checklist ที่ใช้ตรวจ */
export function podOutcomeFor(
  outcome: 'DELIVERED' | 'PARTIAL' | 'FAILED' | 'UNDELIVERED_RETAIN' | PodOutcome,
): PodOutcome {
  return outcome === 'FAILED' || outcome === 'UNDELIVERED_RETAIN' || outcome === 'FAILURE'
    ? 'FAILURE'
    : 'SUCCESS';
}

/** ชนิดที่มีได้ชิ้นเดียวต่อชุด (key = ชื่อชนิดตัวเล็ก) — ที่เหลือ (BOOLEAN / SINGLE_CHOICE) เพิ่มได้หลายข้อ */
export const POD_SINGLETON_TYPES = [
  'PHOTO',
  'SIGNATURE',
  'NOTE',
  'BARCODE',
  'PIN',
  'RATING',
] as const satisfies readonly PodFieldType[];
/** ชนิดที่ผู้ใช้ตั้งข้อความเอง (ต้องมี label + key) */
export const POD_CUSTOM_TYPES = [
  'BOOLEAN',
  'SINGLE_CHOICE',
] as const satisfies readonly PodFieldType[];

/** รูปสูงสุดต่อ stop ของลิงก์รถร่วม = 5 (ST4-T09) → จำนวนขั้นต่ำที่ตั้งได้ไม่เกิน 5 */
export const POD_PHOTO_MIN_COUNT_MAX = 5;
export const POD_BOOLEAN_MAX = 10;
export const POD_CHOICE_MAX = 10;
export const POD_LABEL_MAX = 100;
/** ตัวเลือกของ SINGLE_CHOICE: 2–10 ข้อ ข้อละ 1–50 ตัวอักษร ไม่ซ้ำ */
export const POD_OPTIONS_MIN = 2;
export const POD_OPTIONS_MAX = 10;
export const POD_OPTION_MAX = 50;
/** PIN: จำนวนหลัก 4–8 (ค่าเริ่มต้น 4) */
export const POD_PIN_LENGTH_MIN = 4;
export const POD_PIN_LENGTH_MAX = 8;
export const POD_PIN_LENGTH_DEFAULT = 4;
/** RATING: คะแนนเต็ม 3–10 (ค่าเริ่มต้น 5 ดาว) */
export const POD_RATING_MAX_MIN = 3;
export const POD_RATING_MAX_MAX = 10;
export const POD_RATING_MAX_DEFAULT = 5;
/** รหัสที่สแกนได้ ยาวไม่เกิน 200 ตัว */
export const POD_SCAN_CODE_MAX = 200;
const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;

export interface PodField {
  /** อ้างอิงใน submission — PHOTO/SIGNATURE/NOTE = 'photo'/'signature'/'note' */
  key: string;
  type: PodFieldType;
  level: PodFieldLevel;
  /** ข้อความที่ผู้ส่งต้องยืนยัน (BOOLEAN) / คำถาม (SINGLE_CHOICE) — บังคับสำหรับสองชนิดนี้เท่านั้น */
  label?: string;
  /** จำนวนรูปขั้นต่ำเมื่อ REQUIRED (PHOTO เท่านั้น, 1–5) */
  minCount?: number;
  /** ตัวเลือก (SINGLE_CHOICE เท่านั้น, 2–10 ข้อ) */
  options?: string[];
  /** จำนวนหลักของรหัส (PIN เท่านั้น, 4–8) */
  length?: number;
  /** คะแนนเต็ม (RATING เท่านั้น, 3–10) */
  max?: number;
}

export interface PodChecklist {
  fields: PodField[];
}

/** รูปที่เก็บใน JSON (tenant default เต็มชุด / customer override บางชุดหรือ `{}`) */
export type PodRequirements = Partial<Record<'success' | 'failure', PodChecklist>>;

/** ชนิดเดี่ยวที่ไม่ได้ตั้ง = DISABLED (พร้อมค่าตั้งต้นของตัวเลือกประจำชนิด) */
function disabledSingleton(t: (typeof POD_SINGLETON_TYPES)[number]): PodField {
  return {
    key: t.toLowerCase(),
    type: t,
    level: 'DISABLED',
    ...(t === 'PHOTO' ? { minCount: 1 } : {}),
    ...(t === 'PIN' ? { length: POD_PIN_LENGTH_DEFAULT } : {}),
    ...(t === 'RATING' ? { max: POD_RATING_MAX_DEFAULT } : {}),
  };
}
const withSingletons = (on: Partial<Record<string, Partial<PodField>>>): PodChecklist => ({
  fields: POD_SINGLETON_TYPES.map((t) => ({ ...disabledSingleton(t), ...(on[t] ?? {}) })),
});

/**
 * ค่าเริ่มต้นของระบบ (spec/04 §13 PodProfile คอลัมน์ สำเร็จ / ไม่สำเร็จ):
 * สำเร็จ = รูป ≥ 1 บังคับ, ลายเซ็นบังคับ, หมายเหตุไม่บังคับ · ไม่สำเร็จ = รูป ≥ 1 บังคับ, ลายเซ็นไม่ใช้, หมายเหตุบังคับ
 */
export const DEFAULT_POD_SETS: Record<PodOutcome, PodChecklist> = {
  SUCCESS: withSingletons({
    PHOTO: { level: 'REQUIRED' },
    SIGNATURE: { level: 'REQUIRED' },
    NOTE: { level: 'ENABLED' },
  }),
  FAILURE: withSingletons({
    PHOTO: { level: 'REQUIRED' },
    NOTE: { level: 'REQUIRED' },
  }),
};

export const DEFAULT_POD_REQUIREMENTS: Required<PodRequirements> = {
  success: DEFAULT_POD_SETS.SUCCESS,
  failure: DEFAULT_POD_SETS.FAILURE,
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
  const allowed = ['key', 'type', 'level', 'label', 'minCount', 'options', 'length', 'max'];
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
      message: `key must match ^[a-z][a-z0-9_]{0,39}$ and not be ${POD_SINGLETON_TYPES.map((t) => t.toLowerCase()).join('/')}`,
    });
  }
  const f: PodField = { key: key as string, type, level };
  const notAllowed = (prop: string, only: string) => {
    if (raw[prop] !== undefined && raw[prop] !== null)
      errors.push({
        path: `${path}.${prop}`,
        code: 'not_allowed',
        message: `${prop} is only for ${only}`,
      });
  };
  const intIn = (prop: 'minCount' | 'length' | 'max', def: number, min: number, max: number) => {
    const v = raw[prop] ?? def;
    if (!Number.isInteger(v) || (v as number) < min || (v as number) > max)
      errors.push({
        path: `${path}.${prop}`,
        code: 'invalid',
        message: `${prop} must be an integer ${min}–${max}`,
      });
    f[prop] = v as number;
  };
  if ((POD_CUSTOM_TYPES as readonly string[]).includes(type)) {
    const label = typeof raw.label === 'string' ? raw.label.trim() : '';
    if (!label || label.length > POD_LABEL_MAX)
      errors.push({
        path: `${path}.label`,
        code: 'invalid',
        message: `label is required for ${type} (1–${POD_LABEL_MAX} chars)`,
      });
    f.label = label;
  } else notAllowed('label', POD_CUSTOM_TYPES.join('/'));
  if (type === 'PHOTO') intIn('minCount', 1, 1, POD_PHOTO_MIN_COUNT_MAX);
  else notAllowed('minCount', 'PHOTO');
  if (type === 'PIN')
    intIn('length', POD_PIN_LENGTH_DEFAULT, POD_PIN_LENGTH_MIN, POD_PIN_LENGTH_MAX);
  else notAllowed('length', 'PIN');
  if (type === 'RATING')
    intIn('max', POD_RATING_MAX_DEFAULT, POD_RATING_MAX_MIN, POD_RATING_MAX_MAX);
  else notAllowed('max', 'RATING');
  if (type === 'SINGLE_CHOICE') {
    const opts = raw.options;
    if (!Array.isArray(opts) || opts.length < POD_OPTIONS_MIN || opts.length > POD_OPTIONS_MAX) {
      errors.push({
        path: `${path}.options`,
        code: 'invalid',
        message: `options must be an array of ${POD_OPTIONS_MIN}–${POD_OPTIONS_MAX} strings`,
      });
    } else {
      const seen = new Set<string>();
      const out: string[] = [];
      opts.forEach((o, j) => {
        const v = typeof o === 'string' ? o.trim() : '';
        if (!v || v.length > POD_OPTION_MAX)
          errors.push({
            path: `${path}.options.${j}`,
            code: 'invalid',
            message: `option must be 1–${POD_OPTION_MAX} chars`,
          });
        else if (seen.has(v))
          errors.push({
            path: `${path}.options.${j}`,
            code: 'duplicate',
            message: `duplicate option "${v}"`,
          });
        seen.add(v);
        out.push(v);
      });
      f.options = out;
    }
  } else notAllowed('options', 'SINGLE_CHOICE');
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
  if (parsed.filter((f) => f.type === 'SINGLE_CHOICE').length > POD_CHOICE_MAX)
    errors.push({
      path: `${pre}fields`,
      code: 'too_many',
      message: `at most ${POD_CHOICE_MAX} SINGLE_CHOICE fields`,
    });
  if (errors.length) return { value: null, errors };
  const fields: PodField[] = [];
  for (const t of POD_SINGLETON_TYPES)
    fields.push(parsed.find((x) => x.type === t) ?? disabledSingleton(t));
  fields.push(
    ...parsed.filter((x) => !(POD_SINGLETON_TYPES as readonly string[]).includes(x.type)),
  );
  return { value: { fields }, errors };
}

/**
 * ตรวจ `pod_requirements` ทั้งก้อน — **ทุกชุดไม่บังคับส่ง** (เพิ่มชุดใหม่ใน T06 แล้วข้อมูล/หน้าจอเดิมยังบันทึกได้)
 * @param fillDefaults true = ค่าเริ่มต้นของ tenant: ชุดที่ไม่ส่ง = เติมค่าเริ่มต้นของระบบ ·
 *   false = override ของลูกค้า: ชุดที่ไม่ส่ง = ไม่ override (ใช้ค่าองค์กรของชุดนั้น — override แยกต่อชุด)
 */
export function parsePodRequirements(
  raw: unknown,
  fillDefaults: boolean,
): { value: PodRequirements | null; errors: PodConfigError[] } {
  if (!isObj(raw))
    return { value: null, errors: [{ path: '', code: 'invalid', message: 'must be an object' }] };
  const errors: PodConfigError[] = [];
  const setKeys: string[] = POD_OUTCOMES.map((o) => POD_SET_KEY[o]);
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
      if (fillDefaults) {
        const o = POD_OUTCOMES.find((x) => POD_SET_KEY[x] === k)!;
        (out as Record<string, PodChecklist>)[k] = DEFAULT_POD_SETS[o];
      }
      continue;
    }
    const r = parsePodChecklist(raw[k], k);
    errors.push(...r.errors);
    if (r.value) (out as Record<string, PodChecklist>)[k] = r.value;
  }
  return errors.length ? { value: null, errors } : { value: out, errors };
}

export type PodChecklistSource = 'TENANT' | 'CUSTOMER';

/** ชั้นที่อ่านจากฐานแล้วผิดรูปจนต้องข้าม — ผู้เรียกต้อง log (ไม่เงียบ) */
export interface PodResolveFallback {
  layer: PodChecklistSource;
  errors: PodConfigError[];
}

/**
 * checklist ที่ใช้จริงของลูกค้าหนึ่งรายต่อผลการส่ง (แยกต่อชุด): override ของลูกค้า (ถ้ามีชุดนั้น) → ค่าองค์กร → ค่าเริ่มต้นของระบบ
 * ค่าที่อ่านจากฐานแต่ผิดรูป (ไม่ควรเกิด — เขียนผ่านตัวตรวจเสมอ) → ข้ามไปชั้นถัดไป และคืนใน `fallbacks`
 */
export function resolvePodChecklist(
  tenantDefault: unknown,
  customerOverride: unknown,
  outcome: PodOutcome = 'SUCCESS',
): { source: PodChecklistSource; checklist: PodChecklist; fallbacks: PodResolveFallback[] } {
  const k = POD_SET_KEY[outcome];
  const fallbacks: PodResolveFallback[] = [];
  if (customerOverride != null && !isObj(customerOverride))
    fallbacks.push({
      layer: 'CUSTOMER',
      errors: [{ path: '', code: 'invalid', message: 'not an object' }],
    });
  if (isObj(customerOverride) && customerOverride[k] != null) {
    const r = parsePodChecklist(customerOverride[k], k);
    if (r.value) return { source: 'CUSTOMER', checklist: r.value, fallbacks };
    fallbacks.push({ layer: 'CUSTOMER', errors: r.errors });
  }
  if (isObj(tenantDefault) && tenantDefault[k] != null) {
    const r = parsePodChecklist(tenantDefault[k], k);
    if (r.value) return { source: 'TENANT', checklist: r.value, fallbacks };
    fallbacks.push({ layer: 'TENANT', errors: r.errors });
  }
  return { source: 'TENANT', checklist: DEFAULT_POD_SETS[outcome], fallbacks };
}

/** หลักฐานที่ส่งมาตรวจ (ผู้เรียกแปลงจาก payload ของตัวเอง — จำนวนรูป/มีลายเซ็น/หมายเหตุ/คำตอบข้อยืนยัน) */
export interface PodSubmission {
  photoCount: number;
  hasSignature: boolean;
  note?: string | null;
  /** key ของ BOOLEAN → true = ยืนยันแล้ว */
  checks?: Record<string, boolean | null | undefined>;
  /** รหัสที่สแกนได้ (BARCODE — spec/04 §13 `Pod.scanCodes[]`) */
  scanCodes?: (string | null | undefined)[] | null;
  /** key ของ SINGLE_CHOICE → ตัวเลือกที่ตอบ (ต้องตรงกับ `options` ตัวใดตัวหนึ่ง) */
  choices?: Record<string, string | null | undefined>;
  /** รหัสที่ผู้รับกรอก (PIN — ตัวเลขครบ `length` หลัก) */
  pin?: string | null;
  /** คะแนนของผู้รับ (RATING — จำนวนเต็ม 1–`max`) */
  rating?: number | null;
}

export interface PodMissing {
  key: string;
  type: PodFieldType;
  /**
   * `required` = ไม่มี · `min_count` = รูปไม่ถึงจำนวนขั้นต่ำ ·
   * `invalid` = ส่งค่ามาแต่ผิดรูปแบบ (ตัวเลือกไม่อยู่ในรายการ / PIN ไม่ใช่ตัวเลขครบหลัก / คะแนนนอกช่วง / รหัสสแกนยาวเกิน)
   */
  code: 'required' | 'min_count' | 'invalid';
  /** จำนวนที่ต้องมี (min_count) */
  expected?: number;
  actual?: number;
  label?: string;
}

const blank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && !v.trim());

/**
 * ค่าของชนิดที่มีรูปแบบ (BARCODE / SINGLE_CHOICE / PIN / RATING): ไม่ส่ง → `required` เมื่อบังคับ ·
 * ส่งมาแต่ผิดรูปแบบ → `invalid` ทั้งบังคับและไม่บังคับ (ไม่เก็บค่าผิดรูป) · DISABLED ไม่ตรวจ
 */
function formatIssue(f: PodField, s: PodSubmission): 'required' | 'invalid' | null {
  const need = f.level === 'REQUIRED';
  switch (f.type) {
    case 'BARCODE': {
      const codes = (s.scanCodes ?? []).filter((c) => !blank(c)) as string[];
      if (!codes.length) return need ? 'required' : null;
      return codes.some((c) => typeof c !== 'string' || c.trim().length > POD_SCAN_CODE_MAX)
        ? 'invalid'
        : null;
    }
    case 'SINGLE_CHOICE': {
      const v = s.choices?.[f.key];
      if (blank(v)) return need ? 'required' : null;
      return typeof v === 'string' && (f.options ?? []).includes(v.trim()) ? null : 'invalid';
    }
    case 'PIN': {
      const v = s.pin;
      if (blank(v)) return need ? 'required' : null;
      const len = f.length ?? POD_PIN_LENGTH_DEFAULT;
      return typeof v === 'string' && new RegExp(`^[0-9]{${len}}$`).test(v.trim())
        ? null
        : 'invalid';
    }
    case 'RATING': {
      const v = s.rating;
      if (v === undefined || v === null) return need ? 'required' : null;
      const max = f.max ?? POD_RATING_MAX_DEFAULT;
      return Number.isInteger(v) && v >= 1 && v <= max ? null : 'invalid';
    }
    default:
      return null;
  }
}

function missingFor(f: PodField, s: PodSubmission): PodMissing | null {
  if (f.level === 'DISABLED') return null;
  if (
    f.type === 'BARCODE' ||
    f.type === 'SINGLE_CHOICE' ||
    f.type === 'PIN' ||
    f.type === 'RATING'
  ) {
    const code = formatIssue(f, s);
    return code ? { key: f.key, type: f.type, code, ...(f.label ? { label: f.label } : {}) } : null;
  }
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

/**
 * ตัวตรวจ POD — คืนรายการที่ขาด (ว่าง = ครบ) · DISABLED ไม่ตรวจ ส่งมาเกินก็ไม่ปฏิเสธ ·
 * ENABLED ไม่บังคับ แต่ค่าที่ส่งมาของ BARCODE/SINGLE_CHOICE/PIN/RATING ต้องถูกรูปแบบ (`invalid`)
 */
export function validatePod(
  checklist: PodChecklist,
  submission: PodSubmission,
): { ok: boolean; missing: PodMissing[] } {
  const missing = checklist.fields
    .map((f) => missingFor(f, submission))
    .filter((x): x is PodMissing => x !== null);
  return { ok: missing.length === 0, missing };
}
