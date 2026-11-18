/**
 * ระยะเก็บข้อมูล (ST9-T14; docs/04 J "Audit log 5 ปี, integration log 24 เดือน, login log 1 ปี, ไฟล์ POD 2 ปี, GPS log 90 วัน
 * — ตั้งต่อ tenant ไม่ต่ำกว่าขั้นต่ำ"; plan/05 D-18 ค่า docs = ขั้นต่ำ)
 *
 * ไม่มีในนี้โดยตั้งใจ: เอกสารภาษี/เอกสารบัญชี (ST9-T15 — ห้าม hard delete, ≥ 5 ปี default 7) — retention job ไม่แตะตารางกลุ่มนั้นเลย
 */
export const RETENTION_MIN = {
  auditLogYears: 5,
  integrationLogMonths: 24,
  loginLogMonths: 12,
  podFileYears: 2,
  gpsLogDays: 90,
} as const;

/**
 * เพดานที่ตั้งได้ — ไม่มีในเอกสาร (กันพิมพ์ผิด เช่น 500 ปี) [DECISION ST9-T14 — ตามคำแนะนำ, ย้อนได้]
 * ตั้งยาวกว่านี้ได้ด้วยการแก้ค่าในโค้ด ไม่มีข้อมูลหาย
 */
export const RETENTION_MAX = {
  auditLogYears: 20,
  integrationLogMonths: 120,
  loginLogMonths: 120,
  podFileYears: 20,
  gpsLogDays: 3650,
} as const;

/** ไฟล์ส่งออก (ST9-T10) ดาวน์โหลดได้ 7 วัน แล้วลบไฟล์ — ไม่ใช่ค่าตั้งของ tenant */
export const EXPORT_FILE_RETENTION_DAYS = 7;

/** ชนิด stored_document ที่นับเป็น "ไฟล์ POD" (POD_PHOTO / POD_SIGNATURE / POD_FILE — ST4) */
export const POD_FILE_KINDS = ['POD_PHOTO', 'POD_SIGNATURE', 'POD_FILE'] as const;

/**
 * entity_type ของ audit log ที่ retention job ไม่ลบ (ฟังก์ชัน DB `tms_audit_retention_purge` มีรายการเดียวกัน — migration 0108)
 * เอกสารภาษี/การเงิน/นิติบุคคล/เลขเอกสาร/ค่าตั้ง (มีค่าตั้งภาษี) + บันทึกการลบเอง + ไฟล์ (PDF เอกสารภาษีเป็น stored_document)
 * ระยะเก็บของกลุ่มนี้ = ST9-T15 (NFR-404: เหตุการณ์ของเอกสารภาษีเก็บเท่าตัวเอกสาร)
 * entity ใหม่ที่เกี่ยวกับภาษี/การเงิน **ต้องเพิ่มที่นี่และใน migration ใหม่** — test/retention.test.ts ตรวจชื่อที่เข้าข่าย
 */
export const AUDIT_PROTECTED_ENTITY_TYPES = [
  'audit_log',
  'retention',
  'company',
  'branch',
  'tenant_setting',
  'document_sequence',
  'document_series',
  'sales_document',
  'invoice',
  'tax_invoice',
  'receipt',
  'credit_note',
  'debit_note',
  'billing_note',
  'payment',
  'wht_certificate',
  'settlement',
  'platform_invoice',
  'platform_payment',
  'etax_submission',
  'stored_document',
] as const;
