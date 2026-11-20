/**
 * ทะเบียน event สาธารณะ (ST7-T06 — docs/01 §5.3, docs/04 G1 Webhook) — **ที่เดียว** ที่กำหนด
 * ชื่อ event · resource · ระยะ (active / pending) · คำอธิบายไทย · ผู้ยิง · รูปของ `data.object`
 *
 * - `WEBHOOK_EVENT_TYPES` (webhook.ts) = รายชื่อที่สมัครได้ — `Record<WebhookEventType, …>` บังคับให้ทุกชื่อมีแถวที่นี่
 * - **`data.object` = รูปเดียวกับ REST DTO ของ resource** (ชื่อ/ค่า enum/ชนิดเดียวกับ `GET /v1/{resource}/{id}` — DECISION ST7-T06 QA)
 *   ผู้ยิงใช้ตัวแปลง DTO ตัวเดียวกับ REST แล้วตัด field ราคาทุกตัว (`@PriceField`) และ field ที่ขึ้นกับผู้เรียก (`omit`)
 *   · schema ที่เผยแพร่ (`components.schemas.WebhookEvent_*`, `GET /v1/webhooks/event-types`) สร้างจาก component DTO ใน OpenAPI
 *   (ฝั่ง API — event-openapi.ts) และ **เปิด** (เพิ่ม field = non-breaking)
 * - `data.previousAttributes` = ค่าเดิมของ field ระดับบนที่เปลี่ยน (รูปเดียวกับ `data.object`) หรือ {} เมื่อไม่มี
 * - contract test (`apps/api/test/event-contract.test.ts`) รัน flow จริงแล้วตรวจทุก event `phase: 'active'` ว่าถูกยิงและตรง schema (แบบปิด)
 */
import { WEBHOOK_EVENT_TYPES, type WebhookEventType } from './webhook';

/** Schema Object แบบย่อ (OpenAPI 3.0 ∩ JSON Schema) */
export interface EventSchema {
  $ref?: string;
  type?: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean';
  nullable?: boolean;
  description?: string;
  properties?: Record<string, EventSchema>;
  required?: string[];
  additionalProperties?: boolean | EventSchema;
  items?: EventSchema;
  allOf?: EventSchema[];
  oneOf?: EventSchema[];
  minItems?: number;
  enum?: readonly (string | number | boolean | null)[];
  pattern?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  [k: string]: unknown;
}

/** active = เฟส 0 ยิงจริงแล้ว (contract test บังคับ) · pending = โมดูลยังไม่สร้าง (สมัครรอได้ ยังไม่ยิง) */
export type EventPhase = 'active' | 'pending';

/** รูปของ `data.object` = DTO ของ REST (component ใน OpenAPI) − `omit` − field ราคา + `extra` */
export interface EventObjectShape {
  /** ชื่อ component ใน OpenAPI (DTO ของ `GET /v1/{resource}/{id}`) */
  dto: string;
  /** field ของ DTO ที่ไม่ส่ง (ขึ้นกับผู้เรียก เช่น ช่องที่แก้ได้/ผู้ล็อก) — field ราคาตัดอัตโนมัติ */
  omit: readonly string[];
  /** field เพิ่มจาก DTO (เฉพาะ event) */
  extra: Readonly<Record<string, EventSchema>>;
  /** field ที่ event นี้บังคับมี (นอกจาก required ของ DTO) */
  require: readonly string[];
}

export interface EventDefinition {
  type: WebhookEventType;
  /** resource ของ event (ส่วนหน้าจุด) */
  resource: string;
  phase: EventPhase;
  /** task ที่จะเริ่มยิง event นี้ (เฉพาะ pending) */
  pendingTask: string | null;
  /** ความหมาย (ภาษาไทย) */
  description: string;
  /** โค้ดที่ยิง (เอกสารสำหรับทีม — ไม่ส่งออกทาง API) */
  emittedBy: string;
  /** รูปของ `data.object` (null = ยังไม่กำหนด — pending) */
  object: EventObjectShape | null;
}

const DATE_TIME: EventSchema = { type: 'string', format: 'date-time' };
const shape = (dto: string, o: Partial<Omit<EventObjectShape, 'dto'>> = {}): EventObjectShape => ({
  dto,
  omit: o.omit ?? [],
  extra: o.extra ?? {},
  require: o.require ?? [],
});

// ---------- รูปต่อ resource ----------
/** order: ไม่ส่ง editableFields/editLock (ตามผู้เรียก) และ sellBilling (ราคา) */
const ORDER = shape('OrderDto', { omit: ['editableFields', 'editLock', 'sellBilling'] });
/** trip: + `startedAt` (trip.started — เวลา event หน้างานแรก ยังไม่มีใน TripDto) */
const TRIP = shape('TripDto', {
  extra: {
    startedAt: { ...DATE_TIME, description: 'trip.started: เวลาเริ่มจริง (event หน้างานแรก)' },
  },
});
/** stop: จุดเดียวกับ `GET /v1/trips/{id}` → `stops[]` + `tripId` */
const STOP = shape('TripStopDto', {
  extra: { tripId: { type: 'string', example: 'trp_…', description: 'เที่ยวของจุดนี้' } },
  require: ['tripId'],
});
const DELIVERY_ORDER = shape('DeliveryOrderDto');
/** pod: รูปเดียวกับ `GET /v1/delivery-orders/{id}/pod` */
const POD = shape('DeliveryOrderPodDto');
const CONNECTOR = shape('ConnectorDto', { omit: ['systemOfRecord'] }); // ST7-T17: ค่าตั้ง SoR ไม่ใช่เรื่องสุขภาพการเชื่อมต่อ
/** settlement: `GET /v1/settlements/{id}` − บรรทัด − id ผู้ใช้ − ข้อความอิสระ (`note`, `cancelReason`) (ยอด `buy*` ตัดอัตโนมัติ — ดูยอดผ่าน REST ด้วยสิทธิ์ `prices.buy:read`) */
const SETTLEMENT = shape('SettlementDto', {
  omit: ['lines', 'createdBy', 'approvedBy', 'cancelledBy', 'cancelReason', 'note', 'sentBy'],
});
const JOB = shape('JobDto');
/**
 * invoice (ST5-T09; D-54 ใบแจ้งหนี้ ไม่ใช่ใบกำกับภาษี): `GET /v1/invoices/{id}` − บรรทัด (`lines`/`printLines` — ดูผ่าน REST) − id ผู้ใช้ −
 * ข้อความอิสระ (`note`, `cancelReason`) − `pdf` (render หลัง commit) · ยอด `sell*` ตัดอัตโนมัติ (ดูยอดผ่าน REST ด้วย `prices.sell:read`)
 */
const INVOICE = shape('InvoiceDto', {
  omit: ['lines', 'printLines', 'createdBy', 'issuedBy', 'cancelReason', 'note', 'pdf'],
  require: ['invoiceNo', 'issueDate', 'dueDate', 'issuedAt'],
});
/**
 * payment (ST5-T13; D-57 รับเงิน/เช็คบันทึกใน TMS — ไม่ออกใบเสร็จ D-56): `GET /v1/payments/{id}` − id ผู้ใช้ − ข้อความอิสระ ·
 * ยอด `sell*` ตัดอัตโนมัติ (ดูยอดผ่าน REST ด้วย `prices.sell:read`)
 */
const PAYMENT = shape('PaymentDto', {
  omit: ['createdBy', 'reversedBy', 'reverseReason', 'differenceReason', 'note'],
});

const active = (
  resource: string,
  description: string,
  emittedBy: string,
  object: EventObjectShape,
): Omit<EventDefinition, 'type'> => ({
  resource,
  phase: 'active',
  pendingTask: null,
  description,
  emittedBy,
  object,
});

const pending = (
  resource: string,
  description: string,
  task: string,
): Omit<EventDefinition, 'type'> => ({
  resource,
  phase: 'pending',
  pendingTask: task,
  description,
  emittedBy: `ยังไม่สร้าง (${task})`,
  object: null,
});

const DEFS: Record<WebhookEventType, Omit<EventDefinition, 'type'>> = {
  'order.created': active(
    'order',
    'สร้างใบสั่งงานใหม่ (หน้าจอ, Open API, นำเข้าไฟล์)',
    'OrderIntakeService.upsertOrder (ใบใหม่ / พ้นร่าง submit)',
    ORDER,
  ),
  'order.updated': active(
    'order',
    'แก้ไขข้อมูลใบสั่งงาน',
    'OrderIntakeService (แก้ข้อมูล/ราคา) · OrderStateService.syncFromDeliveryOrders (สถานะตาม DO)',
    ORDER,
  ),
  'order.held': active(
    'order',
    'พักใบสั่งงาน (เช่น ข้อมูลไม่ครบ เกินวงเงิน)',
    'OrderIntakeService (ใบค้างทางเข้า) · OrderStateService.holdSystem (รถร่วมปฏิเสธ/นัดส่งใหม่เกิน/คืนคลังทั้งหมด)',
    ORDER,
  ),
  'order.released': active(
    'order',
    'ปล่อยใบสั่งงานที่พักไว้ให้วางแผนต่อ',
    'OrderIntakeService (เหตุค้างหมด) · OrderStateService.syncFromDeliveryOrders (จัดรถใบที่ค้าง)',
    ORDER,
  ),
  'order.cancelled': active(
    'order',
    'ยกเลิกใบสั่งงาน',
    'OrderStateService.cancel · OrderIntakeService (ต้นทางยกเลิก)',
    ORDER,
  ),
  'trip.assigned': active(
    'trip',
    'จัดรถ/คนขับ หรือรถร่วมให้เที่ยววิ่ง',
    'TripService (assign / reassign / รถร่วมรับงาน)',
    TRIP,
  ),
  'trip.dispatched': active('trip', 'ปล่อยเที่ยววิ่งให้คนขับ', 'TripService.dispatch', TRIP),
  'trip.started': active(
    'trip',
    'คนขับเริ่มเที่ยววิ่ง',
    'TripService.applyExecution (event หน้างานแรก)',
    { ...TRIP, require: ['startedAt'] },
  ),
  'trip.completed': active(
    'trip',
    'เที่ยววิ่งจบครบทุกจุด',
    'TripService.applyExecution (ทุกจุดปิด)',
    { ...TRIP, require: ['completedAt'] },
  ),
  'trip.cancelled': active('trip', 'ยกเลิกเที่ยววิ่ง', 'TripService.cancel', TRIP),
  'stop.arrived': active('stop', 'รถถึงจุดรับ/ส่ง', 'StopProjectionService.writeStop', STOP),
  'stop.departed': active('stop', 'รถออกจากจุดรับ/ส่ง', 'StopProjectionService.writeStop', STOP),
  'stop.completed': active(
    'stop',
    'ปิดงานที่จุดรับ/ส่งสำเร็จ',
    'StopProjectionService.writeStop',
    STOP,
  ),
  'stop.failed': active(
    'stop',
    'งานที่จุดรับ/ส่งไม่สำเร็จ (มีเหตุผล)',
    'StopProjectionService.writeStop',
    STOP,
  ),
  'delivery_order.status_changed': active(
    'delivery_order',
    'สถานะใบส่งของ (DO) เปลี่ยน',
    'DeliveryOrderService (สร้าง/ทุก transition ผ่าน StateService)',
    DELIVERY_ORDER,
  ),
  'pod.captured': active(
    'pod',
    'บันทึกหลักฐานการส่ง (POD)',
    'PodService.save (เว็บ / ลิงก์รถร่วม / API)',
    POD,
  ),
  'invoice.finalized': active(
    'invoice',
    'ออกเอกสารใบแจ้งหนี้แล้ว (ออกเลข + ล็อก — ใบแจ้งหนี้ ไม่ใช่ใบกำกับภาษี D-54)',
    'InvoiceFinalizeService.finalize',
    INVOICE,
  ),
  'invoice.adjusted': pending('invoice', 'ปรับยอดใบแจ้งหนี้ด้วยใบลดหนี้/เพิ่มหนี้', 'ST5-T19'),
  'invoice.paid': active(
    'invoice',
    'ใบแจ้งหนี้ได้รับชำระครบ (ยอดตัดรวม WHT ที่ถูกหัก = ยอดรวม) — `data.object` = ใบหลังชำระ (`status` PAID) · ' +
      '`previousAttributes` = { status, version } ก่อนชำระ · ยิงทุกครั้งที่ใบเปลี่ยนเป็น PAID — กลับรายการ (`payment.reversed`) แล้วรับชำระครบอีกครั้ง = ยิงอีกครั้ง · ' +
      'สถานะชำระจากระบบบัญชี (D-57) ยิงผ่านทางเดียวกัน',
    'InvoiceStatusService.apply (รับชำระ / ระบบบัญชี)',
    INVOICE,
  ),
  'invoice.voided': active(
    'invoice',
    'ยกเลิกใบแจ้งหนี้ที่ออกแล้ว (`POST /invoices/{id}/void`) — `data.object` = ใบหลังยกเลิก: `status` CANCELLED + `invoiceNo` เดิม + ' +
      '`cancelledAt` (ไม่มีเหตุผล/ผู้ยกเลิก — ข้อความอิสระ) · `replacedByInvoice` = null เสมอตอนยิง (ร่างฉบับใหม่แทนสร้างหลัง event — ' +
      'ดูผ่าน GET) · `previousAttributes` = { status: ISSUED, version } · ระบบบัญชีที่รับใบไปแล้วยกเลิกตาม (ST8-T16)',
    'InvoiceCancelService.void',
    INVOICE,
  ),
  'credit_note.finalized': pending('credit_note', 'ออกเลขใบลดหนี้แล้ว', 'ST5-T19'),
  'debit_note.finalized': pending('debit_note', 'ออกเลขใบเพิ่มหนี้แล้ว', 'ST5-T20'),
  'payment.recorded': active(
    'payment',
    'บันทึกรับชำระเงิน (ตัดยอดใบแจ้งหนี้ — ไม่ออกใบเสร็จ D-56)',
    'PaymentsService.record',
    PAYMENT,
  ),
  'payment.reversed': active(
    'payment',
    'กลับรายการรับชำระเงิน (รวมเช็คคืน — `chequeStatus` = BOUNCED) ยอดค้างของใบกลับมา',
    'PaymentsService.reverse / bounceCheque',
    PAYMENT,
  ),
  'receipt.issued': pending('receipt', 'ออกใบเสร็จรับเงินแล้ว', 'ST5-T14'),
  'settlement.approved': active(
    'settlement',
    'อนุมัติใบสำคัญจ่ายรถร่วม (ออกเลข STL แล้ว — ผู้อนุมัติไม่ใช่ผู้สร้าง)',
    'SettlementsService.approve',
    SETTLEMENT,
  ),
  'settlement.paid': pending('settlement', 'จ่ายเงินตามใบสรุปค่าขนส่งรถร่วมแล้ว', 'ST6-T09'),
  'wht_certificate.issued': pending(
    'wht_certificate',
    'ออกหนังสือรับรองการหักภาษี ณ ที่จ่ายแล้ว',
    'ST6-T10',
  ),
  'connector.health_changed': active(
    'connector',
    'สถานะการเชื่อมต่อระบบภายนอกเปลี่ยน',
    'ConnectorsService (ทดสอบ/เปิด/พัก/ยกเลิก/ระบบหยุดเพราะ AUTH)',
    CONNECTOR,
  ),
  'reconcile.mismatch_found': pending(
    'reconcile',
    'พบข้อมูลไม่ตรงกันจากการกระทบยอดกับระบบภายนอก',
    'ST8-T11',
  ),
  'job.completed': active(
    'job',
    'งานเบื้องหลัง (นำเข้า/bulk/ส่งออก/รอบวางบิล) เสร็จ',
    'JobQueue.runOnce (งานที่ลงทะเบียน publicEvent — นำเข้าไฟล์, orders:bulk แบบ async)',
    JOB,
  ),
};

/** ทะเบียนเรียงตาม `WEBHOOK_EVENT_TYPES` */
export const EVENT_REGISTRY: readonly EventDefinition[] = WEBHOOK_EVENT_TYPES.map((type) => ({
  ...DEFS[type],
  type,
}));

/** ตัวอย่าง `data.object` ของ event ที่ยังไม่มีรูป (pending) — สำหรับ webhook.test */
export function pendingExample(type: string): Record<string, unknown> {
  const prefix: Record<string, string> = {
    invoice: 'inv',
    credit_note: 'cn',
    debit_note: 'dn',
    payment: 'pay',
    receipt: 'rcp',
    settlement: 'stl',
    wht_certificate: 'wht',
    reconcile: 'rec',
  };
  const entity = type.split('.')[0]!;
  return {
    id: `${prefix[entity] ?? 'obj'}_${'0'.repeat(32)}`,
    object: entity,
    status: type.split('.')[1] ?? 'updated',
    updatedAt: '2026-11-18T02:30:00.000Z',
  };
}

export function eventDefinition(type: string): EventDefinition | undefined {
  return EVENT_REGISTRY.find((d) => d.type === type);
}

/** event ที่เฟส 0 ยิงจริง (contract test ต้องเห็นครบ) */
export const ACTIVE_EVENT_TYPES = EVENT_REGISTRY.filter((d) => d.phase === 'active').map(
  (d) => d.type,
);
/** event ที่รอโมดูล (ไม่อยู่ในเกณฑ์ตรวจรับ ST7-T06) */
export const PENDING_EVENT_TYPES = EVENT_REGISTRY.filter((d) => d.phase === 'pending').map(
  (d) => d.type,
);

/** คำอธิบายไทยต่อ event (`GET /v1/webhooks/event-types`) */
export const WEBHOOK_EVENT_DESCRIPTIONS = Object.fromEntries(
  EVENT_REGISTRY.map((d) => [d.type, d.description]),
) as Record<WebhookEventType, string>;

/** ชื่อ component ใน OpenAPI ของ `data.object` */
export function eventSchemaName(type: string): string {
  return `WebhookEvent_${type.replace(/\./g, '_')}`;
}

/**
 * schema แบบปิด (ทุก object ที่มี properties → additionalProperties:false) — ใช้ใน contract test เท่านั้น
 * เพื่อจับ field ที่ผู้ยิงส่งออกโดยไม่ได้ลงทะเบียน (schema ที่เผยแพร่เปิดไว้ให้เพิ่ม field ได้)
 */
export function strictEventSchema(s: EventSchema): EventSchema {
  const out: EventSchema = { ...s };
  if (s.properties) {
    out.properties = Object.fromEntries(
      Object.entries(s.properties).map(([k, v]) => [k, strictEventSchema(v)]),
    );
    if (s.additionalProperties === undefined) out.additionalProperties = false;
  }
  if (s.items) out.items = strictEventSchema(s.items);
  if (s.allOf) out.allOf = s.allOf.map(strictEventSchema);
  return out;
}
