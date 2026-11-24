import {
  DEFAULT_EXPIRY_ALERTS,
  expiryAlertsError,
  normalizeExpiryAlerts,
  type ExpiryAlerts,
} from '../reminders/expiry-alerts';
/**
 * Registry ค่าตั้งองค์กร (ST1-T17; docs/04 I "ตั้งค่าองค์กร", spec/01 §13) — stage ถัดไปลงทะเบียน key เพิ่มที่นี่
 * ทุก key มี type + default; ค่าที่ผิด type ถูกปฏิเสธ (422) · ไม่มีแถวใน tenant_setting = ใช้ default
 * `store: 'tenant'` = เก็บในคอลัมน์ของตาราง tenant (ใช้ร่วมกับส่วนอื่นที่อ่านอยู่แล้ว)
 */
import {
  DEFAULT_MAX_AUTO_RESCHEDULES,
  DEFAULT_POD_REQUIREMENTS,
  DEFAULT_WHT_MINIMUM_BAHT,
  MAX_AUTO_RESCHEDULES_LIMIT,
  parsePodRequirements,
} from '@tms/domain';
import {
  FINANCE_DOCUMENT_RETENTION,
  RETENTION_MAX,
  RETENTION_MIN,
} from '../retention/retention-policy';

/** ST6-T07 วงเงิน step-up อนุมัติใบสำคัญจ่าย (บาท, ยอดสุทธิ) — ค่าเริ่ม [DECISION spec/12 §3] */
export const SETTLEMENT_STEP_UP_DEFAULT = 100_000;
/** เพดาน = numeric(14,2) ส่วนจำนวนเต็ม */
export const SETTLEMENT_STEP_UP_MAX = 999_999_999_999;

/**
 * ST8-T13 แทนที่เอกสารในระบบบัญชีที่บอกสถานะลงบัญชีไม่ได้ (เช่น KRS) — ใบที่อายุ **เกิน** N วันต้องมีผู้อนุมัติก่อนส่ง (docs/01 A.2/A.6
 * "กฎอายุ N วัน") · docs ไม่ให้ค่า N → ค่าเริ่ม 0 = ทางระมัดระวัง (ใบที่ออกก่อนวันนี้ต้องอนุมัติทุกใบ) [OPEN — PO] spec/12 §3
 */
export const ERP_REPLACE_APPROVAL_DAYS_DEFAULT = 0;

/** ST9-T06 DO ส่งถึงแล้วเกินกี่วันจึงขึ้นรายงาน/แจ้งเตือน "ยังไม่วางบิล" — ค่าเริ่ม [DECISION spec/12 §3] */
export const UNBILLED_ALERT_DAYS_DEFAULT = 7;

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
  | { kind: 'phone'; nullable: true }
  /** แจ้งเตือนเอกสารรถ/ใบขับขี่ (#40) — ตรวจด้วย `expiryAlertsError` */
  | { kind: 'expiryAlerts' };

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
    | 'settlement'
    | 'reminders';
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
  // ST5-T02 (D-54 ยอดภาษีใน TMS = ประมาณการ) — ค่าตั้งต้นที่รอนักบัญชี (docs/01 §8.2 ข้อ 7) · ไม่มีหน้าจอ (ต้นแบบไม่มีช่อง — spec/12 §3)
  // ใช้กับ computeDocumentTax ของ @tms/domain ผ่าน taxOptionsFromSettings
  'tax.whtMinimumAmount': {
    group: 'tax',
    type: { kind: 'int', min: 0, max: SETTLEMENT_STEP_UP_MAX },
    default: DEFAULT_WHT_MINIMUM_BAHT,
    description:
      'ขั้นต่ำหัก ณ ที่จ่าย (บาท) — ฐานก่อน VAT ของใบ (หรือยอดตามสัญญา) ตั้งแต่ค่านี้ขึ้นไปจึงแสดงยอดหัก · ค่าเริ่ม 0 = หักทุกยอด (ตรงกับระบบบัญชี) · ท.ป.4/2528 ข้อ 12/5 ขั้นต่ำ 1,000 "ตามสัญญา" (research §3.1) แต่ฐานนับต่อเที่ยว/ต่อปียังรอนักบัญชี [OPEN docs/01 §8.2 ข้อ 7] · ยอดประมาณการ (D-54)',
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
  // ST5-T09 (docs/04 A3 "ผู้สร้างใบแจ้งหนี้ finalize ใบตัวเองไม่ได้ (ปิดได้สำหรับ tenant เล็กโดย owner ยอมรับความเสี่ยง)") —
  // ไม่มีหน้าจอ (ต้นแบบไม่มีช่อง — spec/12 §3) ตั้งผ่าน PATCH /v1/settings · เปิด = ลดการควบคุม ต้อง step-up 2FA
  'billing.allowSelfFinalize': {
    group: 'billing',
    type: { kind: 'bool' },
    default: false,
    description:
      'ให้ผู้สร้าง/ผู้แก้ร่างใบแจ้งหนี้ ออกเอกสารใบนั้นเองได้ (ปิดกฎแบ่งหน้าที่ — สำหรับบริษัทเล็กที่ owner ยอมรับความเสี่ยง) · ค่าเริ่ม ปิด · **แก้ได้เฉพาะ owner** · เปิด = ลดการควบคุม ต้อง step-up',
  },
  // ST9-T06 (docs/04 F3 "รายงาน 'ยังไม่วางบิลเกิน N วัน'", H "DO ยังไม่วางบิลเกิน N วัน … ส่งให้ Invoicer อัตโนมัติ") — ไม่มีหน้าจอ
  // (ต้นแบบไม่มีช่อง — spec/12 §3) ตั้งผ่าน PATCH /v1/settings · ค่าเริ่ม 7 วัน [DECISION spec/12 §3]
  'billing.unbilledAlertDays': {
    group: 'billing',
    type: { kind: 'int', min: 1, max: 365 },
    default: UNBILLED_ALERT_DAYS_DEFAULT,
    description:
      'รายงาน/แจ้งเตือน "DO ยังไม่วางบิล": DO ที่ส่งถึงแล้วเกินกี่วัน (นับวันตามเวลาไทยจากวันที่ส่งถึง) และยังไม่อยู่ในใบแจ้งหนี้ใด · ใช้เป็นเกณฑ์ "ร่างค้างเกิน N วัน" ด้วย (DO อยู่ในร่างใบแจ้งหนี้นานเกินกี่วัน — D-71) · ค่าเริ่ม 7',
  },
  // ST8-T13 (docs/01 A.2 "ต้องผ่าน approval ถ้า posted_at ไม่ว่าง หรืออายุใบ > N วัน"; A.6 "ปุ่ม ลงบัญชีแล้ว + กฎอายุ N วัน") — ไม่มีหน้าจอ
  // (ต้นแบบไม่มีช่อง — spec/12 §3) ตั้งผ่าน PATCH /v1/settings · เพิ่มค่า = คุมหลวมขึ้น ต้อง step-up · N ไม่มีใน docs [OPEN — PO]
  'billing.erpReplaceApprovalDays': {
    group: 'billing',
    type: { kind: 'int', min: 0, max: 3650 },
    default: ERP_REPLACE_APPROVAL_DAYS_DEFAULT,
    description:
      'แทนที่ใบแจ้งหนี้ในระบบบัญชีที่บอกสถานะลงบัญชีไม่ได้ (เช่น KRS): ใบที่อายุเกินกี่วัน (นับจากวันที่ใบ เวลาไทย) ต้องมีผู้อนุมัติ (คนละคนกับผู้ขอ) ก่อนส่ง — ใบที่กด "ลงบัญชีแล้ว" ต้องอนุมัติเสมอ · ค่าเริ่ม 0 = ใบที่ออกก่อนวันนี้ต้องอนุมัติทุกใบ (ทางระมัดระวัง — docs ไม่ระบุ N) · เพิ่มค่า = ลดการควบคุม ต้อง step-up',
  },
  // ST5-T13 review M1 (spec/05 BIL-059 [PROPOSED] "ผลต่างเล็กน้อย … ≤ ค่าที่ตั้ง เช่น 10.00 บาท → manager อนุมัติ") — ไม่มีหน้าจอ
  // (ต้นแบบไม่มีช่อง — spec/12 §3) ตั้งผ่าน PATCH /v1/settings · เพิ่มค่า = คุมหลวมขึ้น ต้อง step-up
  'payments.maxDifferenceAmount': {
    group: 'billing',
    type: { kind: 'int', min: 0, max: 1_000_000 },
    default: 10,
    description:
      'ส่วนต่างที่ยอมตัดยอดต่อการรับชำระ (บาท) ที่ผู้บันทึก (บัญชี) ทำเองได้ — เกินค่านี้ต้องมีสิทธิ์ `payments:reverse` (ผู้จัดการขึ้นไป) · ค่าเริ่ม 10 · เพิ่มค่า = ลดการควบคุม ต้อง step-up',
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
  // #40 (PO 24 พ.ย. 2569 ประกอบจากโครงสร้างต้นแบบ `docalert`): ระดับ/ช่องทางเตือนต่อประเภทเอกสารรถ + ใบขับขี่
  'reminders.expiryAlerts': {
    group: 'reminders',
    type: { kind: 'expiryAlerts' },
    default: DEFAULT_EXPIRY_ALERTS,
    description:
      'แจ้งเตือนเอกสารรถ/ใบขับขี่ใกล้หมด (ST2-T18) ต่อประเภท: `levels` ⊆ [60, 30, 7] วัน (ว่าง = ไม่เตือนประเภทนั้น) + ช่องทาง `inApp` / `email` · ผู้รับ = ผู้มีสิทธิ์แก้ข้อมูลรถ (master:write) · สรุปรายวัน 08:00 ระดับละครั้ง (spec/06 FLT-040) · rate card ใช้ 30/7 วันคงที่',
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
  // ST6-T05 (docs/01 §4.5 "DRAFT → APPROVED: tenant ปิดขั้นให้รถร่วมตรวจ") — ไม่มีหน้าจอ (ต้นแบบไม่มีช่อง — spec/12 §3)
  'settlement.carrierReviewRequired': {
    group: 'settlement',
    type: { kind: 'bool' },
    default: false,
    description:
      'ใบสำคัญจ่ายรถร่วมต้องส่งให้รถร่วมตรวจผ่านลิงก์ก่อนอนุมัติ (ปิด = อนุมัติร่างได้ตรง ส่งตรวจหรือไม่ก็ได้) — ค่าเริ่ม ปิด · ปิดจากที่เปิดอยู่ = ลดการควบคุม ต้อง step-up',
  },
  // D-60 (PO 21 พ.ย. 2569, ST6-T09): ผู้บันทึกจ่ายต้องไม่ใช่ผู้อนุมัติใบนั้น — ปิดกฎได้เฉพาะ owner (แบบ `billing.allowSelfFinalize`)
  // ไม่มีหน้าจอ (ต้นแบบไม่มีช่อง — spec/12 §3) ตั้งผ่าน PATCH /v1/settings · เปิด = ลดการควบคุม ต้อง step-up 2FA
  'settlement.allowApproverMarkPaid': {
    group: 'settlement',
    type: { kind: 'bool' },
    default: false,
    description:
      'ให้ผู้อนุมัติใบสำคัญจ่ายรถร่วม บันทึกจ่ายใบนั้นเองได้ (ปิดกฎแบ่งหน้าที่ — สำหรับบริษัทเล็กที่ owner ยอมรับความเสี่ยง) · ค่าเริ่ม ปิด · **แก้ได้เฉพาะ owner** · เปิด = ลดการควบคุม ต้อง step-up',
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
  // ST9-T15 (docs/04 J "เอกสารภาษี ≥ 5 ปี … default 7 ปี"; D-54) — ขั้นต่ำ 5 ปี ค่าเริ่ม 7 ปี · ไม่มี job ลบเอกสารกลุ่มนี้ (ฐานข้อมูลปฏิเสธ DELETE)
  'retention.financeDocumentYears': {
    group: 'retention',
    type: {
      kind: 'int',
      min: FINANCE_DOCUMENT_RETENTION.minYears,
      max: FINANCE_DOCUMENT_RETENTION.maxYears,
    },
    default: FINANCE_DOCUMENT_RETENTION.defaultYears,
    description:
      'ระยะเก็บเอกสารที่ออกเลขแล้ว (ใบแจ้งหนี้ ใบวางบิล ใบสำคัญจ่าย รับชำระ) และ PDF ณ วันออก (ปี) — ขั้นต่ำ 5 ปี ค่าเริ่ม 7 ปี; ระบบไม่ลบเอกสารกลุ่มนี้ระหว่างใช้งาน (ค่านี้ใช้เมื่อมีงานลบ/archive ภายหลัง)',
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
    case 'expiryAlerts':
      return expiryAlertsError(value);
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
  if (t.kind === 'expiryAlerts') return normalizeExpiryAlerts(value as ExpiryAlerts);
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
