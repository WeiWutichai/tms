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

/**
 * ประเภทเอกสารที่ connector อาจรับ (ST7-T14) — ใช้ตัดสินว่า flow ของเอกสารนั้น "มีขั้น sync" ไหม
 * (docs/01 §6.1 ตาราง "ถ้า adapter ไม่มี capability")
 */
export const ERP_SYNC_DOCUMENTS = ['invoice', 'creditNote', 'debitNote', 'settlement'] as const;
export type ErpSyncDocument = (typeof ERP_SYNC_DOCUMENTS)[number];

/**
 * โหมด sync ของเอกสาร 1 ประเภทภายใต้ capability ที่ใช้ได้จริง (ST7-T14; docs/01 §6.1; spec/07 INT-011/INT-020)
 * - `NOT_APPLICABLE` = ไม่มีขั้น sync เลย (Standalone / connector ไม่รองรับ / tenant ปิด) — เอกสารเดินสถานะใน TMS เอง
 *   (invoice: `ISSUED → PAID` ตรง ไม่มี `SENT`) และหน้าจอไม่แสดงสถานะ sync (ไม่ใช่ "รอส่ง")
 * - `PUSH` = ส่งด้วย method ของประเภทนั้น · `REPLACE` = ใบลด/เพิ่มหนี้ส่งเป็น "ภาพรวมหลังปรับ" ผ่าน `replaceDocument`
 * - `MANUAL` = มี connector ส่งต้นฉบับได้แต่ส่งใบปรับไม่ได้ → คำสั่ง SKIPPED + แจ้งบัญชีทำมือ (docs/01 §6.3 CAPABILITY)
 * สถานะเอกสารแยกจากสถานะ sync เสมอ — ผลนี้ไม่เปลี่ยนสถานะเอกสาร (spec/07 INT-020)
 */
export type ErpSyncMode = 'NOT_APPLICABLE' | 'PUSH' | 'REPLACE' | 'MANUAL';

export function documentSyncMode(
  capabilities: readonly string[],
  doc: ErpSyncDocument,
): ErpSyncMode {
  const has = (c: ErpCapability) => capabilities.includes(c);
  switch (doc) {
    case 'invoice':
      return has('pushInvoice') ? 'PUSH' : 'NOT_APPLICABLE';
    case 'settlement':
      return has('pushSettlement') ? 'PUSH' : 'NOT_APPLICABLE';
    case 'creditNote':
    case 'debitNote':
      if (has('pushCreditNote')) return 'PUSH';
      if (has('replaceDocument')) return 'REPLACE';
      // ใบแจ้งหนี้ต้นฉบับอยู่ใน ERP แล้ว แต่ใบปรับส่งไม่ได้ → บัญชีต้องปรับมือ (ไม่ใช่ "ไม่เกี่ยว")
      return has('pushInvoice') ? 'MANUAL' : 'NOT_APPLICABLE';
  }
}

/** โหมด sync ของทุกประเภทเอกสาร (ใช้ใน `GET /connectors/effective`) */
export function documentSyncModes(
  capabilities: readonly string[],
): Record<ErpSyncDocument, ErpSyncMode> {
  return Object.fromEntries(
    ERP_SYNC_DOCUMENTS.map((d) => [d, documentSyncMode(capabilities, d)]),
  ) as Record<ErpSyncDocument, ErpSyncMode>;
}

/**
 * ผังรหัส ERP (ST7-T18; docs/04 B "ผังรหัส ERP (master code)", docs/01 §7.4 `erp_master_code`) — ชนิดรหัสที่ connector ยอมรับ
 * ไม่ผูก ERP ใด: adapter ประกาศชนิดที่ดึงได้ (`masterCodeKinds`) · ที่ดึงไม่ได้นำเข้าไฟล์แทน
 * `VAT_RATE` = รหัส/อัตรา VAT ฝั่ง ERP สำหรับ adapter ใช้แปลงค่า — **ไม่เปลี่ยนการคำนวณภาษีของ TMS** (vat_type อยู่ที่บรรทัดเสมอ)
 */
export const ERP_MASTER_CODE_KINDS = [
  'UNIT',
  'SALESPERSON',
  'ACCOUNT',
  'ITEM',
  'VAT_RATE',
] as const;
export type ErpMasterCodeKind = (typeof ERP_MASTER_CODE_KINDS)[number];

export function isErpMasterCodeKind(v: unknown): v is ErpMasterCodeKind {
  return typeof v === 'string' && (ERP_MASTER_CODE_KINDS as readonly string[]).includes(v);
}

/** สถานะการจับคู่ค่าบริการ 1 รายการกับรหัสสินค้า ERP (ST7-T18) */
export type ErpItemMappingStatus = 'MAPPED' | 'UNMAPPED' | 'CODE_UNKNOWN';

/**
 * ตัดสินสถานะการจับคู่ (กฎกลาง — ใช้ทั้งหน้า mapping และประตูก่อนส่ง ERP)
 * - ไม่มีรหัส → UNMAPPED
 * - connector **เคยมี** ผังรหัสสินค้า (ITEM — แถวใดก็ได้ รวมที่ปิดใช้แล้ว) แต่รหัสที่จับคู่ไม่อยู่ในรายการที่ใช้งาน → CODE_UNKNOWN
 *   (ERP ปฏิเสธรหัสที่ไม่รู้จัก — ผังที่ถูกปิดหมดไม่ทำให้กลับไป "เชื่อรหัสที่กรอก")
 * - ไม่เคยมีผังรหัสสินค้าเลย → เชื่อรหัสที่กรอก (ERP ตรวจเองตอนรับ — ผลขึ้นคิวเป็น VALIDATION)
 * `activeItemCodes` = รหัส ITEM ที่ active ของ connector (ตัวพิมพ์เล็ก) · `catalogueExists` = มีแถว ITEM ของ connector อย่างน้อย 1 แถว
 */
export function erpItemMappingStatus(
  itemCode: string | null | undefined,
  activeItemCodes: ReadonlySet<string>,
  catalogueExists: boolean = activeItemCodes.size > 0,
): ErpItemMappingStatus {
  const c = itemCode?.trim();
  if (!c) return 'UNMAPPED';
  if ((catalogueExists || activeItemCodes.size > 0) && !activeItemCodes.has(c.toLowerCase()))
    return 'CODE_UNKNOWN';
  return 'MAPPED';
}

/** รหัส 1 ตัวในผังรหัส ERP ที่ใช้งานอยู่ (สำหรับ `resolveErpMasterCode`) */
export interface ErpMasterCodeOption {
  code: string;
  name?: string | null;
}

/** ผลการหาค่าในผังรหัส ERP — `code` = รหัสตามตัวพิมพ์ในผัง */
export type ErpMasterCodeResolution =
  { status: 'FOUND'; code: string } | { status: 'MISSING' | 'UNKNOWN' | 'AMBIGUOUS' };

/**
 * ST8-T06 หาค่าจากเอกสารในผังรหัส ERP ชนิดหนึ่ง (กฎกลาง — ไม่ผูก ERP ใด; docs/01 §7.4 "validate ก่อนเข้า outbox")
 * - ไม่มีค่า → MISSING
 * - ตรงกับ **รหัส** (ไม่สนตัวพิมพ์/ช่องว่างหัวท้าย) → FOUND รหัสนั้น
 * - ไม่ตรงรหัสแต่ตรงกับ **ชื่อ** ของรหัสเดียวพอดี → FOUND (เช่น หน่วย "เที่ยว" ↔ รหัส `TRIP` ชื่อ "เที่ยว")
 *   ชื่อซ้ำหลายรหัส → AMBIGUOUS (ไม่เดา)
 * - อื่น ๆ → UNKNOWN
 * `options` = รหัสที่ใช้งาน (active) ของชนิดนั้นเท่านั้น
 */
export function resolveErpMasterCode(
  value: string | null | undefined,
  options: readonly ErpMasterCodeOption[],
): ErpMasterCodeResolution {
  const v = value?.trim().toLowerCase();
  if (!v) return { status: 'MISSING' };
  const byCode = options.find((o) => o.code.trim().toLowerCase() === v);
  if (byCode) return { status: 'FOUND', code: byCode.code };
  const byName = options.filter((o) => o.name?.trim().toLowerCase() === v);
  if (byName.length === 1) return { status: 'FOUND', code: byName[0]!.code };
  return { status: byName.length ? 'AMBIGUOUS' : 'UNKNOWN' };
}
