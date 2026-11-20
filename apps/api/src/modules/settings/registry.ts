/**
 * Registry ค่าตั้งองค์กร (ST1-T17; docs/04 I "ตั้งค่าองค์กร", spec/01 §13) — stage ถัดไปลงทะเบียน key เพิ่มที่นี่
 * ทุก key มี type + default; ค่าที่ผิด type ถูกปฏิเสธ (422) · ไม่มีแถวใน tenant_setting = ใช้ default
 * `store: 'tenant'` = เก็บในคอลัมน์ของตาราง tenant (ใช้ร่วมกับส่วนอื่นที่อ่านอยู่แล้ว)
 */
import {
  DEFAULT_MAX_AUTO_RESCHEDULES,
  DEFAULT_POD_REQUIREMENTS,
  MAX_AUTO_RESCHEDULES_LIMIT,
  parsePodRequirements,
} from '@tms/domain';
import { RETENTION_MAX, RETENTION_MIN } from '../retention/retention-policy';

/** ST6-T07 วงเงิน step-up อนุมัติใบสำคัญจ่าย (บาท, ยอดสุทธิ) — ค่าเริ่ม [DECISION spec/12 §3] */
export const SETTLEMENT_STEP_UP_DEFAULT = 100_000;
/** เพดาน = numeric(14,2) ส่วนจำนวนเต็ม */
export const SETTLEMENT_STEP_UP_MAX = 999_999_999_999;

export type SettingType =
  | { kind: 'string'; max: number }
  | { kind: 'enum'; values: readonly (string | number)[] }
  | { kind: 'bool' }
  | { kind: 'int'; min: number; max: number; nullable?: boolean }
  /** id ของ entity อื่น (เช่น `cmp_…`) — ตรวจว่ามีอยู่จริงที่ service */
  | { kind: 'ref'; entity: 'company'; nullable: true }
  /** POD checklist ค่าเริ่มต้นของ tenant (ST4-T05) — ตรวจด้วย `parsePodRequirements` ของ @tms/domain */
  | { kind: 'podRequirements' }
  /** เบอร์โทร (ST4-T14 เบอร์บริษัทบนหน้าติดตาม) — null = ไม่ตั้ง */
  | { kind: 'phone'; nullable: true };

export interface SettingDef {
  type: SettingType;
  default: unknown;
  /** กลุ่มในหน้า ตั้งค่า (org / tax / sec / billing) */
  group:
    | 'org'
    | 'tax'
    | 'sec'
    | 'billing'
    | 'routing'
    | 'dispatch'
    | 'pod'
    | 'tracking'
    | 'retention'
    | 'settlement';
  store?: { table: 'tenant'; column: 'name' | 'yearStyle' };
  description: string;
}

export const SETTINGS = {
  'org.name': {
    group: 'org',
    type: { kind: 'string', max: 200 },
    default: '',
    store: { table: 'tenant', column: 'name' },
    description: 'ชื่อองค์กร (ชื่อที่แสดงในระบบ — ชื่อบนเอกสารภาษีใช้ชื่อนิติบุคคล)',
  },
  'org.timezone': {
    group: 'org',
    type: { kind: 'enum', values: ['Asia/Bangkok'] },
    default: 'Asia/Bangkok',
    description: 'เขตเวลา',
  },
  'org.yearStyle': {
    group: 'org',
    type: { kind: 'enum', values: ['BE', 'CE'] },
    default: 'BE',
    store: { table: 'tenant', column: 'yearStyle' },
    description: 'รูปแบบปีในเอกสาร: BE = พ.ศ., CE = ค.ศ. (D-30)',
  },
  'tax.vatDefault': {
    group: 'tax',
    type: { kind: 'enum', values: ['VAT_7', 'EXEMPT_TRANSPORT'] },
    default: 'VAT_7',
    description: 'VAT ค่าเริ่มต้นของบรรทัดใหม่ (แก้ได้ต่อบรรทัด — vat_type อยู่ที่บรรทัด)',
  },
  'tax.invoiceModePolicy': {
    group: 'tax',
    type: { kind: 'enum', values: ['ON_PAYMENT', 'ON_ISSUE', 'PER_CUSTOMER'] },
    default: 'PER_CUSTOMER',
    description:
      'โหมดออกใบกำกับภาษี: ออกเมื่อรับชำระ / ออกพร้อมใบแจ้งหนี้ / ตามค่าของลูกค้าแต่ละราย (ลูกค้าใหม่ = ON_PAYMENT — docs/01 §3.2)',
  },
  'tax.wht1Enabled': {
    group: 'tax',
    type: { kind: 'bool' },
    default: true,
    description: 'เปิดใช้หัก ณ ที่จ่าย 1% (ค่าขนส่ง)',
  },
  'tax.wht3Enabled': {
    group: 'tax',
    type: { kind: 'bool' },
    default: true,
    description: 'เปิดใช้หัก ณ ที่จ่าย 3% (ค่าบริการ)',
  },
  'tax.separateVatDocs': {
    group: 'tax',
    type: { kind: 'bool' },
    default: false,
    description: 'แยกเอกสารรายการ VAT 7% กับรายการยกเว้น VAT เป็นคนละใบ',
  },
  'billing.cycleDefault': {
    group: 'billing',
    type: { kind: 'enum', values: ['PER_DO', 'WEEKLY', 'MONTHLY', 'MANUAL'] },
    default: 'MONTHLY',
    description: 'รอบวางบิลเริ่มต้นของลูกค้าใหม่',
  },
  'billing.freeTimeMinutes': {
    group: 'billing',
    type: { kind: 'int', min: 0, max: 1440, nullable: true },
    default: null,
    description: 'free time ค่ารอเริ่มต้น (นาที) — null = ไม่ตั้ง (จุดส่ง/ลูกค้ากำหนดเอง)',
  },
  'routing.invoiceAsCompanyId': {
    group: 'routing',
    type: { kind: 'ref', entity: 'company', nullable: true },
    default: null,
    description:
      'ออกบิลในนาม (Invoice As) ค่าเริ่มต้นของ tenant — ลูกค้า override ได้ (ST2-T01); null = นิติบุคคลเดียวที่มี',
  },
  'routing.tenderAsCompanyId': {
    group: 'routing',
    type: { kind: 'ref', entity: 'company', nullable: true },
    default: null,
    description:
      'จ้างในนาม (Tender As) ค่าเริ่มต้นของ tenant — รถร่วม override ได้ (ST2-T05); null = นิติบุคคลเดียวที่มี',
  },
  'dispatch.subconResponseHours': {
    group: 'dispatch',
    type: { kind: 'int', min: 1, max: 47 },
    default: 2,
    description:
      'รถร่วมไม่ตอบข้อเสนองานภายในกี่ชั่วโมง → แจ้งผู้จัดรถ + ปุ่ม "ส่งรายถัดไป" (docs/04 D3 — ต้องน้อยกว่าอายุลิงก์ 48 ชม.; ใช้กับข้อเสนอใหม่)',
  },
  'dispatch.maxAutoReschedules': {
    group: 'dispatch',
    type: { kind: 'int', min: 0, max: MAX_AUTO_RESCHEDULES_LIMIT },
    default: DEFAULT_MAX_AUTO_RESCHEDULES,
    description:
      'นัดส่งใหม่อัตโนมัติได้กี่ครั้งต่อใบส่งของ (ST4-T12; docs/04 E2) — เกินแล้วใบสั่งขึ้นใบค้าง RESCHEDULES_EXHAUSTED · 0 = ขึ้นใบค้างทันที',
  },
  'pod.checklist': {
    group: 'pod',
    type: { kind: 'podRequirements' },
    default: DEFAULT_POD_REQUIREMENTS,
    description:
      'POD checklist ค่าเริ่มต้นของลูกค้าทุกราย (docs/04 E2) — ชุด success/failure; ชนิด PHOTO/SIGNATURE/NOTE/BARCODE/PIN/RATING/BOOLEAN/SINGLE_CHOICE ตั้ง DISABLED/ENABLED/REQUIRED; ลูกค้า override ได้ที่ `podRequirements` (แยกต่อชุด)',
  },
  'tracking.contactPhone': {
    group: 'tracking',
    type: { kind: 'phone', nullable: true },
    default: null,
    description:
      'ST4-T14 เบอร์บริษัทขนส่งบนหน้าติดตามของผู้รับ (ปุ่มโทร + "ติดต่อ …" — spec/04 §4 ไม่ใช่เบอร์คนขับ) · null = ไม่แสดง',
  },
  'tracking.showPod': {
    group: 'tracking',
    type: { kind: 'bool' },
    default: false,
    description:
      'ST4-T14 แสดงหลักฐานส่ง (รูป ลายเซ็น ชื่อผู้รับ) บนหน้าติดตามของผู้รับเมื่อส่งแล้ว (docs/04 E2 "POD (ถ้าเปิด)") — ค่าเริ่ม ปิด',
  },
  'tracking.linkDays': {
    group: 'tracking',
    type: { kind: 'int', min: 7, max: 90 },
    default: 30,
    description:
      'ST4-T14 ลิงก์ติดตามใช้ได้ถึงกี่วันหลังงานจบ (ส่งแล้ว/ส่งไม่สำเร็จ/ยกเลิก — spec/04 §4 expiresAt 7–90 วัน ค่าเริ่ม 30)',
  },
  'security.require2faAll': {
    group: 'sec',
    type: { kind: 'bool' },
    default: false,
    description: 'บังคับ 2FA สำหรับผู้ใช้ทุกคน (owner/admin/accounting บังคับอยู่แล้ว)',
  },
  'security.autoLogout': {
    group: 'sec',
    type: { kind: 'bool' },
    default: true,
    description: 'ออกจากระบบอัตโนมัติเมื่อไม่ได้ใช้งาน',
  },
  'security.idleTimeoutMinutes': {
    group: 'sec',
    type: { kind: 'enum', values: [30, 60, 480] },
    default: 480,
    description: 'เวลาไม่ใช้งานก่อนออกจากระบบ (นาที) — docs/04 A1 ค่าเริ่ม 8 ชม.',
  },
  // ST6-T07 (docs/04 F6 "Approve (separation of duties)": step-up 2FA เกินวงเงินที่ตั้ง) — ไม่มีหน้าจอ (ต้นแบบไม่มีช่อง — spec/12 §3)
  'settlement.approvalStepUpAmount': {
    group: 'settlement',
    type: { kind: 'int', min: 0, max: SETTLEMENT_STEP_UP_MAX, nullable: true },
    default: SETTLEMENT_STEP_UP_DEFAULT,
    description:
      'อนุมัติใบสำคัญจ่ายรถร่วมที่ยอดสุทธิเกินกี่บาท ต้องยืนยัน 2FA ซ้ำ (step-up) — 0 = ทุกใบ · null = ไม่บังคับ · เพิ่มค่า/ปิด = ลดความปลอดภัย ต้อง step-up',
  },
  // ST9-T14 ระยะเก็บ (docs/04 J — ตั้งต่อ tenant ไม่ต่ำกว่าขั้นต่ำ) · ค่าเริ่ม = ขั้นต่ำ · ต่ำกว่าขั้นต่ำ = 422 · ลดระยะต้อง step-up
  // ไม่มีหน้าจอ (ต้นแบบไม่มี — spec/12 §3) ตั้งผ่าน PATCH /v1/settings · เอกสารภาษีไม่อยู่ในกลุ่มนี้ (ST9-T15)
  'retention.auditLogYears': {
    group: 'retention',
    type: { kind: 'int', min: RETENTION_MIN.auditLogYears, max: RETENTION_MAX.auditLogYears },
    default: RETENTION_MIN.auditLogYears,
    description:
      'ระยะเก็บ audit log (ปี) — ขั้นต่ำ 5 ปี; เหตุการณ์ของเอกสารภาษี/นิติบุคคล/เลขเอกสาร/ค่าตั้ง ไม่ถูกลบตามค่านี้ (ST9-T15)',
  },
  'retention.integrationLogMonths': {
    group: 'retention',
    type: {
      kind: 'int',
      min: RETENTION_MIN.integrationLogMonths,
      max: RETENTION_MAX.integrationLogMonths,
    },
    default: RETENTION_MIN.integrationLogMonths,
    description:
      'ระยะเก็บ integration log (เดือน) — ขั้นต่ำ 24 เดือน; ครบแล้ว archive (วิธี archive ยังไม่ตัดสิน [OPEN — PO] — ตอนนี้ไม่ลบ)',
  },
  'retention.loginLogMonths': {
    group: 'retention',
    type: { kind: 'int', min: RETENTION_MIN.loginLogMonths, max: RETENTION_MAX.loginLogMonths },
    default: RETENTION_MIN.loginLogMonths,
    description: 'ระยะเก็บประวัติ login (เดือน) — ขั้นต่ำ 12 เดือน',
  },
  'retention.podFileYears': {
    group: 'retention',
    type: { kind: 'int', min: RETENTION_MIN.podFileYears, max: RETENTION_MAX.podFileYears },
    default: RETENTION_MIN.podFileYears,
    description:
      'ระยะเก็บไฟล์หลักฐานส่ง (รูป/ลายเซ็น/ไฟล์ POD) นับจากวันอัปโหลด (ปี) — ขั้นต่ำ 2 ปี; ครบแล้วลบไฟล์ (ข้อมูล POD ยังอยู่)',
  },
  'retention.gpsLogDays': {
    group: 'retention',
    type: { kind: 'int', min: RETENTION_MIN.gpsLogDays, max: RETENTION_MAX.gpsLogDays },
    default: RETENTION_MIN.gpsLogDays,
    description: 'ระยะเก็บจุด GPS ดิบ (วัน) นับจากเวลาที่ระบบรับ — ขั้นต่ำ 90 วัน',
  },
} as const satisfies Record<string, SettingDef>;

export type SettingKey = keyof typeof SETTINGS;
export const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

/** ตรวจค่าตาม type — คืนข้อความ error หรือ null */
export function validateSetting(key: SettingKey, value: unknown): string | null {
  const t: SettingType = SETTINGS[key].type;
  switch (t.kind) {
    case 'string':
      return typeof value === 'string' && value.trim().length > 0 && value.length <= t.max
        ? null
        : `must be a non-empty string up to ${t.max} chars`;
    case 'enum':
      return t.values.includes(value as never) ? null : `must be one of ${t.values.join(', ')}`;
    case 'bool':
      return typeof value === 'boolean' ? null : 'must be boolean';
    case 'ref':
      return value === null || (typeof value === 'string' && /^cmp_[0-9a-f]{32}$/i.test(value))
        ? null
        : 'must be a company id (cmp_…) or null';
    case 'podRequirements': {
      const errs = settingFieldErrors(key, value);
      return errs.length ? errs.map((e) => `${e.path}: ${e.message}`).join('; ') : null;
    }
    case 'phone':
      if (value === null) return null;
      return typeof value === 'string' && /^\+?[0-9][0-9 -]{5,24}$/.test(value.trim())
        ? null
        : 'must be a phone number (digits, space, -) or null';
    case 'int':
      if (value === null && t.nullable) return null;
      return Number.isInteger(value) && (value as number) >= t.min && (value as number) <= t.max
        ? null
        : `must be an integer ${t.min}–${t.max}${t.nullable ? ' or null' : ''}`;
  }
}

/**
 * ค่าที่แสดงใน GET — ค่าที่มีโครงสร้างแสดงในรูปมาตรฐานปัจจุบัน (ST4-T06: ข้อมูล T05 ที่ไม่มีชุด failure/ชนิดใหม่
 * → เติมค่าระบบ/DISABLED) · ผิดรูป (ไม่ควรเกิด) = คืนค่าเดิม
 */
export function presentSetting(key: SettingKey, value: unknown): unknown {
  const t: SettingType = SETTINGS[key].type;
  if (t.kind === 'podRequirements') return parsePodRequirements(value, true).value ?? value;
  return value;
}

/** ทำค่าให้เป็นรูปมาตรฐานก่อนเก็บ (เรียกหลังผ่าน validateSetting) */
export function normalizeSetting(key: SettingKey, value: unknown): unknown {
  const t: SettingType = SETTINGS[key].type;
  if (t.kind === 'podRequirements') return parsePodRequirements(value, true).value;
  return typeof value === 'string' ? value.trim() : value;
}

/**
 * error ราย path ของค่าที่มีโครงสร้าง (POD checklist) — service ใส่ `values.<key>.<path>` ใน field
 * (QA L1: บอกช่องที่ผิดแบบเดียวกับ API ลูกค้า) · ค่าแบบ scalar คืน [] (ใช้ validateSetting)
 */
export function settingFieldErrors(
  key: SettingKey,
  value: unknown,
): { path: string; code: string; message: string }[] {
  const t: SettingType = SETTINGS[key].type;
  if (t.kind !== 'podRequirements') return [];
  return parsePodRequirements(value, true).errors;
}
