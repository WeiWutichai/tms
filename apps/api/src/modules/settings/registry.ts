/**
 * Registry ค่าตั้งองค์กร (ST1-T17; docs/04 I "ตั้งค่าองค์กร", spec/01 §13) — stage ถัดไปลงทะเบียน key เพิ่มที่นี่
 * ทุก key มี type + default; ค่าที่ผิด type ถูกปฏิเสธ (422) · ไม่มีแถวใน tenant_setting = ใช้ default
 * `store: 'tenant'` = เก็บในคอลัมน์ของตาราง tenant (ใช้ร่วมกับส่วนอื่นที่อ่านอยู่แล้ว)
 */
export type SettingType =
  | { kind: 'string'; max: number }
  | { kind: 'enum'; values: readonly (string | number)[] }
  | { kind: 'bool' }
  | { kind: 'int'; min: number; max: number; nullable?: boolean }
  /** id ของ entity อื่น (เช่น `cmp_…`) — ตรวจว่ามีอยู่จริงที่ service */
  | { kind: 'ref'; entity: 'company'; nullable: true };

export interface SettingDef {
  type: SettingType;
  default: unknown;
  /** กลุ่มในหน้า ตั้งค่า (org / tax / sec / billing) */
  group: 'org' | 'tax' | 'sec' | 'billing' | 'routing';
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
    case 'int':
      if (value === null && t.nullable) return null;
      return Number.isInteger(value) && (value as number) >= t.min && (value as number) <= t.max
        ? null
        : `must be an integer ${t.min}–${t.max}${t.nullable ? ' or null' : ''}`;
  }
}
