/**
 * ErpAdapter framework (ST7-T13; docs/01 §3.7 `connector`, §6.1 `ErpAdapter` + capabilities; docs/04 G3)
 *
 * กฎกลางที่ไม่ผูกกับ ERP ใด: รายการ capability, สถานะ connector, คำสั่ง outbox ↔ capability,
 * capability ที่ใช้ได้จริง (adapter ประกาศ ∩ tenant เปิด) — ใช้ทั้ง API (core) และหน้าจอ (ST7-T20 "แสดงเฉพาะที่รองรับ")
 * Standalone-first: ไม่มี connector = ไม่มี capability ใด → ทุก flow เดินใน TMS เอง (docs/01 §1 #1, spec/07 INT-011)
 */

/** docs/01 §6.1 `Capability` — ชื่อตาม docs ทุกตัว (ห้ามเพิ่มชื่อเฉพาะ ERP) */
export const ERP_CAPABILITIES = [
  'pullOrders',
  'pushInvoice',
  'pushCreditNote',
  'pushSettlement',
  'fetchDocument',
  'fetchPaymentStatus',
  'listDocuments',
  /** ERP ที่แก้ด้วย PUT ทั้งใบ (fallback เมื่อไม่มี pushCreditNote) */
  'replaceDocument',
  /** ERP บอกได้ว่าลง GL แล้ว (ธง — ไม่มี method) */
  'postedStatus',
  /** ERP ออกเลขเอง เรารับ external_doc_no กลับ (ธง — ไม่มี method) */
  'ownsDocumentNumber',
] as const;
export type ErpCapability = (typeof ERP_CAPABILITIES)[number];

/** capability ที่เป็นธงบอกคุณสมบัติ (ไม่มี method ใน ErpAdapter) */
export const ERP_FLAG_CAPABILITIES: readonly ErpCapability[] = [
  'postedStatus',
  'ownsDocumentNumber',
];

export function isErpCapability(v: unknown): v is ErpCapability {
  return typeof v === 'string' && (ERP_CAPABILITIES as readonly string[]).includes(v);
}

/**
 * สถานะ connector (docs/01 §3.7 ACTIVE/PAUSED/ERROR + DISCONNECTED จาก spec/07 §1.6 "ยกเลิกการเชื่อม" เพราะไม่มี hard delete)
 * - PAUSED: สร้างใหม่ (= `configuring` ของ spec) หรือผู้ดูแลกดหยุด — คำสั่งใหม่รอคิว ไม่ส่ง
 * - ACTIVE: ส่ง/ดึงตาม capability ที่เปิด (เปิดได้เมื่อ healthCheck ผ่าน — spec/07 INT-015)
 * - ERROR: ระบบหยุดเอง (AUTH / healthCheck ล้ม) — คำสั่งใหม่รอคิว ไม่ส่ง
 * - DISCONNECTED: ยกเลิกการเชื่อม (สถานะสุดท้าย) — ไม่ส่ง/ไม่ดึง; กลับไปใช้ Standalone (INT-016)
 */
export const CONNECTOR_STATUSES = ['ACTIVE', 'PAUSED', 'ERROR', 'DISCONNECTED'] as const;
export type ConnectorStatus = (typeof CONNECTOR_STATUSES)[number];

/** การเปลี่ยนสถานะที่ผู้ใช้สั่งได้ (ระบบเปลี่ยน ACTIVE ↔ ERROR เองตามผล healthCheck/AUTH) */
export const CONNECTOR_TRANSITIONS: Record<
  'resume' | 'pause' | 'disconnect',
  readonly ConnectorStatus[]
> = {
  resume: ['PAUSED', 'ERROR'],
  pause: ['ACTIVE', 'ERROR'],
  disconnect: ['ACTIVE', 'PAUSED', 'ERROR'],
};

export function canConnectorTransition(
  action: keyof typeof CONNECTOR_TRANSITIONS,
  from: ConnectorStatus,
): boolean {
  return CONNECTOR_TRANSITIONS[action].includes(from);
}

/**
 * คำสั่งใน integration_outbox (kind ADAPTER — docs/01 §3.7 `operation`) → capability ที่ต้องมี
 * adapter ไม่มี capability → outbox `SKIPPED` (ErrorClass CAPABILITY — docs/01 §6.3)
 */
export const ERP_OPERATION_CAPABILITY = {
  PUSH_INVOICE: 'pushInvoice',
  PUSH_CREDIT_NOTE: 'pushCreditNote',
  PUSH_SETTLEMENT: 'pushSettlement',
  REPLACE_DOCUMENT: 'replaceDocument',
  FETCH_DOCUMENT: 'fetchDocument',
  FETCH_PAYMENT_STATUS: 'fetchPaymentStatus',
} as const satisfies Record<string, ErpCapability>;
export type ErpOperation = keyof typeof ERP_OPERATION_CAPABILITY;

export function isErpOperation(v: unknown): v is ErpOperation {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(ERP_OPERATION_CAPABILITY, v);
}

/**
 * capability ที่ใช้ได้จริงของ connector = ที่ adapter ประกาศ ∩ ที่ tenant เปิด (`capabilities_enabled`)
 * DISCONNECTED / ไม่มี connector = ว่าง (Standalone) · PAUSED/ERROR ยังคืนชุดเดิม (เอกสารใหม่เข้าคิวรอ — spec/07 §1.6)
 * ผลเรียงตามลำดับ ERP_CAPABILITIES
 */
export function effectiveCapabilities(
  adapterCapabilities: Iterable<string>,
  enabled: Iterable<string>,
  status: ConnectorStatus | null,
): ErpCapability[] {
  if (!status || status === 'DISCONNECTED') return [];
  const a = new Set(adapterCapabilities);
  const e = new Set(enabled);
  return ERP_CAPABILITIES.filter((c) => a.has(c) && e.has(c));
}

/** ค่า capabilities_enabled ที่ adapter ไม่รองรับ (ตอนบันทึก → 422) */
export function unsupportedCapabilities(
  adapterCapabilities: Iterable<string>,
  requested: Iterable<string>,
): string[] {
  const a = new Set(adapterCapabilities);
  return [...new Set(requested)].filter((c) => !isErpCapability(c) || !a.has(c));
}
