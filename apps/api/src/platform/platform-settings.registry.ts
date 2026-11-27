/**
 * Registry ค่าตั้งของแพลตฟอร์ม (P1-ST1-T04; spec/01 §9 `PlatformSetting`, PLT-099 · plan/13 §4.1)
 * ทุก key มี type + ค่าเริ่มต้น · ค่าผิด type → 422 · ไม่มีแถวใน platform_setting = ใช้ค่าเริ่มต้น
 * แก้ได้เฉพาะ Console owner (SUPER_ADMIN) พร้อมเหตุผล + platform_audit_log · ค่าใหม่มีผลกับเหตุการณ์ถัดไป ไม่ย้อนหลัง
 * ค่าเริ่มต้นที่มาจากข้อเสนอ (ไม่ใช่ docs) ติดป้าย [PROPOSED] ใน spec/01 §9 / [DECISION — lead 27 พ.ย. 2569, ย้อนได้] ใน plan/13 §3–4
 * stage ถัดไป (T03 dunning, T06 usage, ST3 billing, ST2 signup) อ่านค่าผ่าน PlatformSettingsService.get()
 */

export type PlatformSettingType =
  | { kind: 'int'; min: number; max: number }
  | { kind: 'bool' }
  | { kind: 'enum'; values: readonly string[] }
  /** ทศนิยมเป็นสตริง ≤ 2 ตำแหน่ง ในช่วง [min, max] (ไม่ใช้ float) */
  | { kind: 'decimal'; min: string; max: string }
  /** ชุดย่อยของค่าที่กำหนด (ไม่ว่าง ไม่ซ้ำ) */
  | { kind: 'set'; values: readonly string[] }
  /** วันเตือนต่อสถานะ (dunning.reminderDays) — แต่ละสถานะเป็นเลขวันเรียงจากน้อยไปมาก */
  | { kind: 'dayLists'; keys: readonly string[]; min: number; max: number };

export type PlatformSettingGroup = 'trial' | 'dunning' | 'retention' | 'usage' | 'billing' | 'ops';

export interface PlatformSettingDef {
  group: PlatformSettingGroup;
  type: PlatformSettingType;
  default: unknown;
  /** ที่มาของค่าเริ่มต้น (แสดงใน Console) */
  source: string;
  description: string;
}

export const PLATFORM_SETTINGS = {
  'trial.days': {
    group: 'trial',
    type: { kind: 'int', min: 1, max: 90 },
    default: 30,
    source: 'docs/02 §2 · D-43',
    description:
      'จำนวนวันทดลองใช้ของ tenant ใหม่ (ทับ trialDays ของเวอร์ชันแพ็กเกจเมื่อตั้งแล้ว) — tenant เดิมคงวันหมด trial เดิม',
  },
  'trial.vehicleLimit': {
    group: 'trial',
    type: { kind: 'int', min: 1, max: 1000 },
    default: 20,
    source: 'docs/02 §2 · D-43',
    description: 'จำนวนรถ active สูงสุดระหว่างทดลองใช้',
  },
  'pendingVerification.vehicleLimit': {
    group: 'trial',
    type: { kind: 'int', min: 0, max: 1000 },
    default: 5,
    source: 'spec/01 §9 [PROPOSED]',
    description: 'จำนวนรถสูงสุดระหว่างรอยืนยันบริษัท',
  },
  'signup.approvalPolicy': {
    group: 'trial',
    type: { kind: 'enum', values: ['auto_when_verified', 'manual_all'] },
    default: 'auto_when_verified',
    source: 'spec/01 §9 [PROPOSED]',
    description: 'นโยบายอนุมัติการสมัคร — อัตโนมัติเมื่อตรวจผ่าน / ทีมตรวจทุกราย',
  },
  'dunning.pastDueDays': {
    group: 'dunning',
    type: { kind: 'int', min: 1, max: 60 },
    default: 7,
    source: 'spec/01 §9 · D-45',
    description: 'เลยกำหนดชำระกี่วันจึงเป็น "ค้างชำระ"',
  },
  'dunning.readOnlyUntilDay': {
    group: 'dunning',
    type: { kind: 'int', min: 2, max: 120 },
    default: 21,
    source: 'spec/01 §9 · D-45',
    description: 'ค้างชำระถึงวันที่เท่าไรจึงเป็น "อ่านอย่างเดียว"',
  },
  'dunning.suspendUntilDay': {
    group: 'dunning',
    type: { kind: 'int', min: 3, max: 365 },
    default: 60,
    source: 'spec/01 §9 · D-45',
    description: 'ค้างชำระถึงวันที่เท่าไรจึง "ระงับ"',
  },
  'dunning.reminderDays': {
    group: 'dunning',
    type: { kind: 'dayLists', keys: ['past_due', 'read_only', 'suspended'], min: 1, max: 365 },
    default: { past_due: [1, 3, 6], read_only: [8, 14, 20], suspended: [22, 45, 55] },
    source: 'spec/01 §9 [PROPOSED]',
    description: 'วันที่ส่งอีเมลเตือนในแต่ละสถานะ',
  },
  'trialExpiry.readOnlyDays': {
    group: 'dunning',
    type: { kind: 'int', min: 0, max: 90 },
    default: 14,
    source: 'spec/01 §9 · D-45',
    description: 'trial หมดแล้วอ่านอย่างเดียวกี่วันก่อนระงับ',
  },
  'retention.operationalDays': {
    group: 'retention',
    type: { kind: 'int', min: 30, max: 3650 },
    default: 90,
    source: 'docs/02 §4 · D-45',
    description: 'เก็บข้อมูลหลังยกเลิกกี่วันก่อนลบ',
  },
  'retention.purgeEnabled': {
    group: 'retention',
    type: { kind: 'bool' },
    default: false,
    source: 'plan/13 R-12 [DECISION — lead 27 พ.ย. 2569, ย้อนได้]',
    description: 'เปิดงานลบข้อมูล tenant ที่ยกเลิกครบกำหนด — ปิดไว้จนกว่าทนาย/นักบัญชีตอบ (X-06)',
  },
  'retention.platformTaxDocsYears': {
    group: 'retention',
    type: { kind: 'int', min: 5, max: 20 },
    default: 7,
    source: 'spec/01 §9 (กฎหมายขั้นต่ำ 5 ปี)',
    description: 'เก็บเอกสารภาษีค่าบริการของแพลตฟอร์มกี่ปี',
  },
  'retention.auditLogYears': {
    group: 'retention',
    type: { kind: 'int', min: 1, max: 20 },
    default: 2,
    source: 'spec/01 §9 [PROPOSED]',
    description: 'เก็บ audit log กี่ปีก่อน archive',
  },
  'usage.activeVehicleRule': {
    group: 'usage',
    type: { kind: 'enum', values: ['trip_started', 'doc_closed'] },
    default: 'trip_started',
    source: 'plan/13 R-05 · D-41 [DECISION — lead 27 พ.ย. 2569, ย้อนได้]',
    description: 'นับรถ active เมื่อเที่ยวออกวิ่งแล้ว / เมื่อเอกสารปิดงาน',
  },
  'usage.subconWeight': {
    group: 'usage',
    type: { kind: 'decimal', min: '0', max: '1' },
    default: '1.00',
    source: 'plan/13 R-05 · D-41 [DECISION — lead 27 พ.ย. 2569, ย้อนได้]',
    description: 'น้ำหนักรถร่วมในการนับรถ active (1.00 = เต็มราคา, 0.50 = ครึ่งราคา)',
  },
  'pricing.publicVisible': {
    group: 'billing',
    type: { kind: 'bool' },
    default: false,
    source: 'plan/13 R-06 · D-40',
    description: 'แสดงหน้าราคาสาธารณะ — เปิดหลัง PO เคาะราคา (D-40)',
  },
  'billing.paymentMethods': {
    group: 'billing',
    // review N4: เฟส 1 มีแค่โอน + แนบสลิป — `card`/`promptpay` เพิ่มเข้ารายการเมื่อ P1-ST3-T08 (ขวางโดย D-44) มีผู้ให้บริการจริง
    type: { kind: 'set', values: ['transfer'] },
    default: ['transfer'],
    source: 'plan/13 R-04 [DECISION — lead 27 พ.ย. 2569, ย้อนได้]',
    description: 'ช่องทางชำระค่าบริการที่เปิด (บัตร/PromptPay มาใน P1-ST3-T08 — รอ D-44)',
  },
  'invoice.dueDays': {
    group: 'billing',
    type: { kind: 'int', min: 0, max: 90 },
    default: 7,
    source: 'spec/01 §9 [PROPOSED]',
    description: 'ครบกำหนดชำระกี่วันหลังออกใบแจ้งหนี้ค่าบริการ',
  },
  'planMigration.noticeDays': {
    group: 'billing',
    type: { kind: 'int', min: 0, max: 365 },
    default: 30,
    source: 'spec/01 PLT-060 [PROPOSED]',
    description: 'แจ้งล่วงหน้ากี่วันก่อนย้ายลูกค้าเดิมไปเวอร์ชันราคาที่แพงขึ้น',
  },
  'impersonation.maxMinutes': {
    group: 'ops',
    type: { kind: 'int', min: 5, max: 240 },
    default: 60,
    source: 'spec/01 PLT-121',
    description: 'เข้าใช้งานแทนได้นานสุดกี่นาทีต่อครั้ง',
  },
} as const satisfies Record<string, PlatformSettingDef>;

export type PlatformSettingKey = keyof typeof PLATFORM_SETTINGS;
export const PLATFORM_SETTING_KEYS = Object.keys(PLATFORM_SETTINGS) as PlatformSettingKey[];

const DEC_RE = /^\d{1,3}(\.\d{1,2})?$/;
const cents = (s: string) => {
  const [w, f = ''] = s.split('.');
  return Number(w) * 100 + Number((f + '00').slice(0, 2));
};

/** ตรวจค่าตาม type → ค่าที่ normalize แล้ว หรือรหัส error (`setting_type` / `setting_range` / `setting_option`) */
export function parsePlatformSetting(
  def: PlatformSettingDef,
  v: unknown,
): { ok: true; value: unknown } | { ok: false; code: string } {
  const t = def.type;
  switch (t.kind) {
    case 'int':
      if (typeof v !== 'number' || !Number.isInteger(v)) return { ok: false, code: 'setting_type' };
      return v < t.min || v > t.max ? { ok: false, code: 'setting_range' } : { ok: true, value: v };
    case 'bool':
      return typeof v === 'boolean' ? { ok: true, value: v } : { ok: false, code: 'setting_type' };
    case 'enum':
      if (typeof v !== 'string') return { ok: false, code: 'setting_type' };
      return t.values.includes(v) ? { ok: true, value: v } : { ok: false, code: 'setting_option' };
    case 'decimal': {
      if (typeof v !== 'string' || !DEC_RE.test(v)) return { ok: false, code: 'setting_type' };
      const c = cents(v);
      if (c < cents(t.min) || c > cents(t.max)) return { ok: false, code: 'setting_range' };
      return { ok: true, value: `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}` };
    }
    case 'set': {
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string'))
        return { ok: false, code: 'setting_type' };
      const uniq = [...new Set(v as string[])];
      if (!uniq.length || uniq.length !== v.length) return { ok: false, code: 'setting_range' };
      if (!uniq.every((x) => t.values.includes(x))) return { ok: false, code: 'setting_option' };
      // เรียงตามลำดับที่ประกาศ (ค่าเดียวกัน = รูปเดียวกัน)
      return { ok: true, value: t.values.filter((x) => uniq.includes(x)) };
    }
    case 'dayLists': {
      if (!v || typeof v !== 'object' || Array.isArray(v))
        return { ok: false, code: 'setting_type' };
      const o = v as Record<string, unknown>;
      if (Object.keys(o).sort().join() !== [...t.keys].sort().join())
        return { ok: false, code: 'setting_type' };
      const out: Record<string, number[]> = {};
      for (const k of t.keys) {
        const list = o[k];
        if (
          !Array.isArray(list) ||
          !list.every((n) => typeof n === 'number' && Number.isInteger(n))
        )
          return { ok: false, code: 'setting_type' };
        if (
          list.length > 10 ||
          list.some((n, i) => n < t.min || n > t.max || (i > 0 && n <= list[i - 1]))
        )
          return { ok: false, code: 'setting_range' };
        out[k] = list as number[];
      }
      return { ok: true, value: out };
    }
  }
}

/**
 * กฎข้ามช่อง: ลำดับวัน dunning ต้องเพิ่มขึ้น (past_due < read_only < suspended) และวันเตือนต้องอยู่ในช่วงของสถานะนั้น (review N5)
 * นับเป็นวันที่เลยกำหนดชำระ: ค้างชำระ 1…pastDueDays · อ่านอย่างเดียว pastDueDays+1…readOnlyUntilDay ·
 * ระงับ readOnlyUntilDay+1…suspendUntilDay (ค่าเริ่มต้น spec/01 §9: 1,3,6 · 8,14,20 · 22,45,55 กับ 7 / 21 / 60)
 */
export function crossSettingError(
  values: Record<string, unknown>,
): { field: string; code: string } | null {
  const a = values['dunning.pastDueDays'] as number;
  const b = values['dunning.readOnlyUntilDay'] as number;
  const c = values['dunning.suspendUntilDay'] as number;
  if (!(a < b && b < c)) return { field: 'dunning', code: 'dunning_order' };
  const r = values['dunning.reminderDays'] as Record<string, readonly number[]>;
  const within = (list: readonly number[] | undefined, lo: number, hi: number) =>
    (list ?? []).every((d) => d >= lo && d <= hi);
  if (!within(r.past_due, 1, a) || !within(r.read_only, a + 1, b) || !within(r.suspended, b + 1, c))
    return { field: 'dunning.reminderDays', code: 'reminder_window' };
  return null;
}
