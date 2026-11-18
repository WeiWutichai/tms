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

/** [DECISION ST9-T10] ไฟล์ส่งออกดาวน์โหลดได้ 7 วัน แล้วลบไฟล์ — ไม่ใช่ค่าตั้งของ tenant (exports.service ใช้ค่าเดียวกัน) */
export const EXPORT_RETENTION_DAYS = 7;

/** ชนิด stored_document ที่นับเป็น "ไฟล์ POD" (POD_PHOTO / POD_SIGNATURE / POD_FILE — ST4) */
export const POD_FILE_KINDS = ['POD_PHOTO', 'POD_SIGNATURE', 'POD_FILE'] as const;

/**
 * [OPEN — PO/นักบัญชี] ไฟล์ POD เป็นเอกสารประกอบใบแจ้งหนี้/ใบกำกับ → ต้องเก็บ ≥ 5 ปีตาม ม.87/3 หรือไม่
 * (research/thai-tax-docs-research.md "เอกสารประกอบ") — จนกว่าจะตัดสิน retention job **ไม่ลบไฟล์ POD** (ค่าตั้ง/ขั้นต่ำยังมี)
 */
export const POD_FILE_PURGE_HELD = true;

/**
 * entity_type ของ audit log ที่ retention job ไม่ลบ (ฟังก์ชัน DB `tms_audit_retention_purge` มีรายการเดียวกัน — migration 0108)
 * เทียบแบบไม่สนตัวพิมพ์ (`INVOICE` = `invoice`) · เอกสารภาษี/การเงิน + ทุกอย่างที่เป็นฐานของใบแจ้งหนี้/ใบกำกับ/การจ่ายรถร่วม/
 * หัก ณ ที่จ่าย (ราคา, ใบสั่ง, DO, เที่ยว, ค่าใช้จ่าย, ลูกค้า/รถร่วม, นิติบุคคล/สาขา, ค่าตั้ง) + บันทึกการลบเอง + ไฟล์
 * ระยะเก็บกลุ่มนี้ = [OPEN — นักบัญชี] (spec/12 §3) / ST9-T15 (NFR-404: เหตุการณ์ของเอกสารภาษีเก็บเท่าตัวเอกสาร)
 * entity ใหม่ที่เกี่ยวกับเงิน/ภาษี **ต้องเพิ่มที่นี่และใน migration ใหม่** — test/retention.test.ts ตรวจชื่อที่เข้าข่าย
 */
export const AUDIT_PROTECTED_ENTITY_TYPES = [
  'audit_log',
  'retention',
  'tenant',
  'tenant_setting',
  'company',
  'legal_entity',
  'branch',
  'document_sequence',
  'document_series',
  'customer',
  'customer_site',
  'carrier',
  'service_item',
  'rate_card',
  'rate_card_accessorial',
  'rate_card_line',
  'sales_order',
  'sales_order_line',
  'sales_order_charge',
  'sales_order_stop',
  'order_charge',
  'delivery_order',
  'delivery_order_line',
  'delivery_order_pod',
  'do_surcharge',
  'field_charge',
  'trip',
  'trip_stop',
  'trip_cost',
  'subcon_offer',
  'stop_event',
  'vehicle',
  'vehicle_cost',
  'depreciation',
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
  'settlement_line',
  'advance',
  'cod',
  'expense',
  'platform_invoice',
  'platform_payment',
  'etax_submission',
  'stored_document',
] as const;
