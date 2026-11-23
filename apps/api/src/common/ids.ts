import { ProblemException } from './problem';

/**
 * ID opaque prefix ใน API (docs/01 §5.1) — DB เก็บ uuid, API แสดง `<prefix>_<hex32>`
 * prefix ต้องลงทะเบียนที่นี่ที่เดียว (กันชนกัน)
 */
export const ID_PREFIX = {
  company: 'cmp',
  job: 'job',
  event: 'evt',
  tenant: 'ten',
  user: 'usr',
  role: 'rol',
  branch: 'brn',
  sequence: 'seq',
  audit: 'aud',
  document: 'doc',
  invitation: 'inv',
  notification: 'ntf',
  import: 'imp',
  customer: 'cus',
  site: 'loc',
  vehicleType: 'vty',
  carrier: 'car',
  vehicle: 'veh',
  odometerReading: 'odo',
  vehicleDocument: 'vdoc',
  driver: 'drv',
  route: 'rte',
  unit: 'unt',
  product: 'prd',
  serviceItem: 'svc',
  reasonCode: 'rsn',
  rateCard: 'rcd',
  trip: 'trp',
  tripStop: 'stp',
  salesOrder: 'ord',
  orderTemplate: 'otp',
  deliveryOrder: 'do',
  /** D-81 · D68-52 บรรทัด DO (delivery_order_line — docs/01 §3.9/§5.5 `doLineId`; docs ไม่ได้ระบุ prefix → `dol` ตามแบบ `ivl`/`stln`) */
  deliveryOrderLine: 'dol',
  orderSourceChange: 'osc',
  magicLink: 'mlk',
  carrierDocSubmission: 'cds',
  messageDelivery: 'msg',
  scheduleEntry: 'sch',
  subconOffer: 'sco',
  apiKey: 'key',
  /** docs/01 §3.7 webhook_endpoint (`whe_`) — spec/07 INT-052 เขียน `whk_` แต่ docs มาก่อน */
  webhookEndpoint: 'whe',
  /** ST7-T05 บันทึกการส่ง webhook 1 ครั้ง (webhook_delivery) */
  webhookDelivery: 'whd',
  doSurcharge: 'dsc', // ST4-T13 ค่าใช้จ่ายหน้างานฝั่งขาย
  tripCost: 'tco', // ST4-T13 ต้นทุนเที่ยว (ค่าใช้จ่ายหน้างานฝั่งซื้อ)
  /** ST7-T13 การตั้งค่า ErpAdapter ต่อ tenant (docs/01 §3.7 `con_`) */
  connector: 'con',
  /** ST7-T21 ผลกระทบยอดกับระบบภายนอก (reconcile_result — docs/01 §3.7) */
  reconcileResult: 'rec',
  /** ST7-T22 webhook ขาเข้า 1 event (processed_webhook_event) */
  inboundEvent: 'ibe',
  /** ST9-T11 มุมมองที่บันทึกไว้ของตาราง (saved_view) */
  savedView: 'svw',
  /** ST9-T19 alert ถึงทีม Innovera (monitor_alert — Platform Console เท่านั้น) */
  monitorAlert: 'alr',
  /** ST7-T20 คำสั่ง 1 รายการใน integration_outbox (แสดงในบันทึกการซิงก์ของ connector) */
  outboxCommand: 'obx',
  /** ST5-T01 บรรทัดรายได้ (revenue_line) */
  revenueLine: 'rvl',
  /** ST5-T01 บรรทัดราคาของใบสั่ง (sales_order_charge) — ใช้เป็น `sourceId` ของบรรทัดรายได้ SO_CHARGE */
  orderCharge: 'och',
  /** ST6-T03 ใบสำคัญจ่ายรถร่วม (carrier_settlement — docs/01 §3.6 `stl_`) */
  settlement: 'stl',
  /** ST6-T03 บรรทัดใบสำคัญจ่าย (settlement_line) */
  settlementLine: 'stln',
  /**
   * ST5-T07 ใบแจ้งหนี้ — docs/01 §3.4 ใช้ `inv_` แต่ `inv` เป็นของคำเชิญผู้ใช้แล้ว (ลิงก์/ลูกค้า API ที่มีอยู่)
   * → `ivc` [DECISION spec/12 §3 — ย้อนได้ก่อนเปิดใช้จริง]
   */
  invoice: 'ivc',
  /** ST5-T07 บรรทัดใบแจ้งหนี้ (invoice_line) */
  invoiceLine: 'ivl',
  /** ST5-T13 การรับชำระ (payment — docs/01 §3.4 `pay_`) */
  payment: 'pay',
  /** ST5-T11 ใบวางบิล (billing_note — docs/01 §3.4 `bn_`) */
  billingNote: 'bn',
  /** ST5-T21 การส่งเอกสารทางอีเมลถึงผู้รับ 1 คน (document_email) */
  documentEmail: 'dem',
} as const;
export type IdKind = keyof typeof ID_PREFIX;

const HEX32 = /^[0-9a-f]{32}$/;

export function encodeId(kind: IdKind, uuid: string): string {
  return `${ID_PREFIX[kind]}_${uuid.replace(/-/g, '')}`;
}

/** คืน uuid หรือ null ถ้ารูปแบบผิด/prefix ไม่ตรง */
export function tryDecodeId(kind: IdKind, value: string): string | null {
  const prefix = `${ID_PREFIX[kind]}_`;
  if (!value.startsWith(prefix)) return null;
  const hex = value.slice(prefix.length).toLowerCase();
  if (!HEX32.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** id ที่ผิดรูปแบบตอบ 404 เหมือนไม่พบ — ไม่บอกใบ้ว่ามีอยู่หรือไม่ */
export function decodeIdOr404(kind: IdKind, value: string): string {
  const id = tryDecodeId(kind, value);
  if (!id) throw new ProblemException('not_found');
  return id;
}
