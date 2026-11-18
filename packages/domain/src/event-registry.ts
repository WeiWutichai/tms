/**
 * ทะเบียน event สาธารณะ (ST7-T06 — docs/01 §5.3, docs/04 G1 Webhook) — **ที่เดียว** ที่กำหนด
 * ชื่อ event · resource · ระยะ (active / pending) · คำอธิบายไทย · ผู้ยิง · JSON schema ของ `data.object` · ตัวอย่าง
 *
 * - `WEBHOOK_EVENT_TYPES` (webhook.ts) = รายชื่อที่สมัครได้ — `Record<WebhookEventType, …>` บังคับให้ทุกชื่อมีแถวที่นี่
 * - `GET /v1/webhooks/event-types` และ OpenAPI (`components.schemas.WebhookEvent_*` + `x-webhooks`) อ่านจากที่นี่
 * - contract test (`apps/api/test/event-contract.test.ts`) รัน flow จริงแล้วตรวจทุก event `phase: 'active'` ว่าถูกยิงและตรง schema
 * - schema เขียนแบบ OpenAPI 3.0 Schema Object (JSON Schema + `nullable`) — ใช้ใน openapi.json ได้ตรง ๆ และ ajv ตรวจได้
 * - `data.object` = มุมมองย่อของ resource ตอนเกิด event (id แบบ prefix ตาม docs/01 §5.1) — **ไม่มีราคาขาย/ซื้อ/ต้นทุน**
 *   (ต้องการรายละเอียดเต็มให้เรียก `GET /v1/{resource}/{id}` ซึ่งตรวจสิทธิ์ราคาตาม scope) · เพิ่ม field = non-breaking
 * - `data.previousAttributes` = ค่าเดิมของ field ที่เปลี่ยน (ชื่อ field ชุดเดียวกับ `data.object`) หรือ null/{} เมื่อไม่มี
 */
import { WEBHOOK_EVENT_TYPES, type WebhookEventType } from './webhook';

/** Schema Object แบบย่อ (OpenAPI 3.0 ∩ JSON Schema) */
export interface EventSchema {
  type?: 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean';
  nullable?: boolean;
  description?: string;
  properties?: Record<string, EventSchema>;
  required?: string[];
  additionalProperties?: boolean | EventSchema;
  items?: EventSchema;
  minItems?: number;
  enum?: readonly (string | null)[];
  pattern?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
}

/** active = เฟส 0 ยิงจริงแล้ว (contract test บังคับ) · pending = โมดูลยังไม่สร้าง (สมัครรอได้ ยังไม่ยิง) */
export type EventPhase = 'active' | 'pending';

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
  /** schema ของ `data.object` (null = ยังไม่กำหนด — pending) */
  schema: EventSchema | null;
  /** ตัวอย่าง `data.object` (ข้อมูลสมมติ ตรง schema — contract test ตรวจ) */
  example: Record<string, unknown>;
}

// ---------- ตัวช่วยสร้าง schema ----------
const HEX = '[0-9a-f]{32}';
const idOf = (prefix: string, nullable = false): EventSchema => ({
  type: 'string',
  pattern: `^${prefix}_${HEX}$`,
  ...(nullable ? { nullable: true } : {}),
});
const str = (nullable = false): EventSchema => ({
  type: 'string',
  ...(nullable ? { nullable } : {}),
});
const int = (nullable = false): EventSchema => ({
  type: 'integer',
  ...(nullable ? { nullable } : {}),
});
const bool = (nullable = false): EventSchema => ({
  type: 'boolean',
  ...(nullable ? { nullable } : {}),
});
/** ทศนิยมเป็นข้อความ (ไม่ใช้ float — docs/01 §5.1) */
const decimal = (nullable = false): EventSchema => ({
  type: 'string',
  pattern: '^-?\\d+(\\.\\d+)?$',
  ...(nullable ? { nullable } : {}),
});
const DATE_RE = '^\\d{4}-\\d{2}-\\d{2}$';
const DT_RE = '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$';
const date = (nullable = false): EventSchema => ({
  type: 'string',
  format: 'date',
  pattern: DATE_RE,
  ...(nullable ? { nullable } : {}),
});
const dateTime = (nullable = false): EventSchema => ({
  type: 'string',
  format: 'date-time',
  pattern: DT_RE,
  ...(nullable ? { nullable } : {}),
});
const oneOf = (values: readonly string[], nullable = false): EventSchema => ({
  type: 'string',
  enum: nullable ? [...values, null] : values,
  ...(nullable ? { nullable } : {}),
});
const arr = (items: EventSchema, minItems?: number): EventSchema => ({
  type: 'array',
  items,
  ...(minItems ? { minItems } : {}),
});
/**
 * object ที่เผยแพร่ = **เปิด** (ไม่ใส่ additionalProperties:false) — docs/04 G1 "เพิ่ม field = non-breaking" ผู้รับต้องข้าม field ที่ไม่รู้จัก
 * contract test ตรวจแบบปิดด้วย `strictEventSchema()` (กัน field ที่ไม่ได้ลงทะเบียนหลุดออกไป) · `optional` = field ที่ไม่บังคับมี
 */
const obj = (
  properties: Record<string, EventSchema>,
  optional: readonly string[] = [],
  nullable = false,
): EventSchema => ({
  type: 'object',
  properties,
  required: Object.keys(properties).filter((k) => !optional.includes(k)),
  ...(nullable ? { nullable } : {}),
});
/** schema เดิมแต่บังคับ field เพิ่ม (เช่น trip.started ต้องมี startedAt) */
const requiring = (s: EventSchema, ...fields: string[]): EventSchema => ({
  ...s,
  required: [...(s.required ?? []), ...fields.filter((f) => !s.required?.includes(f))],
});

// ---------- enum ของสถานะ (ตรงกับ Prisma enum / docs/01 §4) ----------
const SO_STATUSES = [
  'DRAFT',
  'RECEIVED',
  'ON_HOLD',
  'PLANNED',
  'IN_TRANSIT',
  'PARTIALLY_DELIVERED',
  'DELIVERED',
  'CLOSED',
  'CANCELLED',
] as const;
const TRIP_STATUSES = [
  'PLANNING',
  'OFFERED',
  'ASSIGNED',
  'DISPATCHED',
  'IN_PROGRESS',
  'COMPLETED',
  'COSTED',
  'SETTLED',
  'CANCELLED',
] as const;
const DO_STATUSES = [
  'DRAFT',
  'PLANNED',
  'PICKED_UP',
  'DISPATCHED',
  'DELIVERED',
  'FAILED',
  'RETURNED',
  'POD_PENDING',
  'UNBILLED',
  'BILLED',
  'CANCELLED',
] as const;
const STOP_TYPES = ['PICKUP', 'DELIVERY', 'RETURN'] as const;
const STOP_STATUSES = ['PENDING', 'ARRIVED', 'COMPLETED', 'FAILED', 'SKIPPED'] as const;
const STOP_OUTCOMES = ['DELIVERED', 'PARTIAL', 'FAILED', 'UNDELIVERED_RETAIN'] as const;
const CONNECTOR_STATUSES = ['ACTIVE', 'PAUSED', 'ERROR', 'DISCONNECTED'] as const;

// ---------- schema ต่อ resource ----------
const ORDER = obj({
  id: idOf('ord'),
  soNo: str(true),
  source: str(),
  externalId: str(true),
  status: oneOf(SO_STATUSES),
  holdReason: str(true),
  customerId: idOf('cus', true),
  customerExternalId: str(true),
  customerText: str(true),
  billingCompanyId: idOf('cmp'),
  customerRef: str(true),
  requestedDate: date(),
  vehicleTypeId: idOf('vty', true),
  pricingStatus: oneOf(['AVAILABLE', 'RATE_MISSING', 'CALCULATION_FAILURE'], true),
  stops: arr(
    obj({
      sequence: int(),
      type: oneOf(STOP_TYPES),
      siteId: idOf('loc', true),
      siteText: str(true),
      windowStart: dateTime(true),
      windowEnd: dateTime(true),
    }),
    1,
  ),
  holdNote: str(true),
  sourceChangedAfterPlan: bool(),
  version: int(),
});

const TRIP = obj(
  {
    id: idOf('trp'),
    tripNo: str(true),
    tripDate: date(),
    status: oneOf(TRIP_STATUSES),
    vehicleId: idOf('veh', true),
    vehiclePlate: str(true),
    vehicleTypeId: idOf('vty', true),
    driverId: idOf('drv', true),
    carrierId: idOf('car', true),
    assignmentStatus: oneOf(['OFFERED', 'ACCEPTED', 'REJECTED', 'EXPIRED'], true),
    stops: arr(
      obj({ id: idOf('stp'), sequence: int(), type: oneOf(STOP_TYPES), siteId: idOf('loc', true) }),
    ),
    deliveryOrderIds: arr(idOf('do')),
    /** trip.started — เวลาเริ่มจริง (event แรกหน้างาน) */
    startedAt: dateTime(),
    /** trip.completed — เวลาจบจริง */
    completedAt: dateTime(),
  },
  ['startedAt', 'completedAt'],
);

const STOP = obj({
  id: idOf('stp'),
  tripId: idOf('trp'),
  sequence: int(),
  type: oneOf(STOP_TYPES),
  siteId: idOf('loc', true),
  status: oneOf(STOP_STATUSES),
  outcome: oneOf(STOP_OUTCOMES, true),
  arrivedAt: dateTime(true),
  departedAt: dateTime(true),
  /** event หน้างานที่เปลี่ยนสถานะล่าสุด (`GET /v1/stops/{id}/events`) */
  lastEventId: idOf('evt', true),
  failReasonCodeId: idOf('rsn', true),
});

const DELIVERY_ORDER = obj({
  id: idOf('do'),
  doNo: str(true),
  status: oneOf(DO_STATUSES),
  orderId: idOf('ord'),
  customerId: idOf('cus'),
  tripId: idOf('trp', true),
  destStopSeq: int(),
  splitFromId: idOf('do', true),
  weightKg: decimal(true),
  cbm: decimal(true),
  lines: arr(
    obj({
      lineNo: int(),
      soLineNo: int(),
      description: str(),
      qty: decimal(true),
      unit: str(),
    }),
  ),
});

const POD = obj({
  deliveryOrderId: idOf('do'),
  doNo: str(true),
  /** ฉบับที่ของ POD (แก้ = ฉบับใหม่) */
  version: int(),
  podStatus: oneOf(['NONE', 'PARTIAL', 'COMPLETE']),
  source: oneOf(['WEB', 'LINK', 'APP', 'API']),
  /** ชุดข้อมูลที่ใช้ตรวจ: ส่งสำเร็จ / ไม่สำเร็จ */
  outcome: oneOf(['SUCCESS', 'FAILURE']),
  photoCount: int(),
  fileCount: int(),
  hasSignature: bool(),
  receiverName: str(true),
  weighedKg: decimal(true),
  lines: arr(
    obj({
      lineNo: int(),
      qtyPlanned: decimal(true),
      qtyActual: decimal(true),
      rejectQty: decimal(true),
      rejectReasonCode: str(true),
    }),
  ),
  /** หลักฐานที่ลูกค้ากำหนดแต่ยังขาด (ว่าง = ครบ) */
  missing: arr(obj({ key: str(), type: str(), code: str() })),
});

const CONNECTOR = obj({
  id: idOf('con'),
  adapterKey: str(),
  displayName: str(true),
  companyId: idOf('cmp', true),
  status: oneOf(CONNECTOR_STATUSES),
  statusReason: str(true),
  statusChangedAt: dateTime(true),
  lastHealthAt: dateTime(true),
  lastHealthOk: bool(true),
  /** ผลทดสอบล่าสุดที่ล้ม (ไม่มีข้อความ/credential ของปลายทาง) */
  lastHealthError: obj({ errorClass: str(), code: str() }, [], true),
});

const JOB = obj({
  id: idOf('job'),
  type: str(),
  status: oneOf(['succeeded', 'failed']),
  progress: { type: 'integer', minimum: 0, maximum: 100 },
  attempts: int(),
  createdAt: dateTime(),
  finishedAt: dateTime(true),
});

// ---------- ตัวอย่าง (ข้อมูลสมมติ) ----------
const z = (prefix: string, n = 0) => `${prefix}_${String(n).padStart(32, '0')}`;
const T0 = '2026-11-18T02:30:00.000Z';
const EX_ORDER = {
  id: z('ord'),
  soNo: 'SO2611-0001',
  source: 'API',
  externalId: 'PO-1001',
  status: 'RECEIVED',
  holdReason: null,
  customerId: z('cus'),
  customerExternalId: 'C-001',
  customerText: null,
  billingCompanyId: z('cmp'),
  customerRef: 'PO-1001',
  requestedDate: '2026-11-18',
  vehicleTypeId: z('vty'),
  pricingStatus: 'AVAILABLE',
  stops: [
    {
      sequence: 1,
      type: 'PICKUP',
      siteId: z('loc', 1),
      siteText: null,
      windowStart: null,
      windowEnd: null,
    },
    {
      sequence: 2,
      type: 'DELIVERY',
      siteId: z('loc', 2),
      siteText: null,
      windowStart: '2026-11-18T02:00:00.000Z',
      windowEnd: '2026-11-18T05:00:00.000Z',
    },
  ],
  holdNote: null,
  sourceChangedAfterPlan: false,
  version: 1,
};
const EX_TRIP = {
  id: z('trp'),
  tripNo: 'TR2611-0001',
  tripDate: '2026-11-18',
  status: 'ASSIGNED',
  vehicleId: z('veh'),
  vehiclePlate: '70-1234 กรุงเทพมหานคร',
  vehicleTypeId: z('vty'),
  driverId: z('drv'),
  carrierId: null,
  assignmentStatus: null,
  stops: [
    { id: z('stp', 1), sequence: 1, type: 'PICKUP', siteId: z('loc', 1) },
    { id: z('stp', 2), sequence: 2, type: 'DELIVERY', siteId: z('loc', 2) },
  ],
  deliveryOrderIds: [z('do')],
};
const EX_STOP = {
  id: z('stp', 2),
  tripId: z('trp'),
  sequence: 2,
  type: 'DELIVERY',
  siteId: z('loc', 2),
  status: 'ARRIVED',
  outcome: null,
  arrivedAt: T0,
  departedAt: null,
  lastEventId: z('evt'),
  failReasonCodeId: null,
};
const EX_DO = {
  id: z('do'),
  doNo: 'DO2611-0001',
  status: 'DISPATCHED',
  orderId: z('ord'),
  customerId: z('cus'),
  tripId: z('trp'),
  destStopSeq: 2,
  splitFromId: null,
  weightKg: '2000',
  cbm: null,
  lines: [{ lineNo: 1, soLineNo: 1, description: 'ปูนซีเมนต์', qty: '2', unit: 'TON' }],
};
const EX_POD = {
  deliveryOrderId: z('do'),
  doNo: 'DO2611-0001',
  version: 1,
  podStatus: 'COMPLETE',
  source: 'WEB',
  outcome: 'SUCCESS',
  photoCount: 1,
  fileCount: 0,
  hasSignature: true,
  receiverName: 'สมชาย ใจดี',
  weighedKg: null,
  lines: [{ lineNo: 1, qtyPlanned: '2', qtyActual: '2', rejectQty: '0', rejectReasonCode: null }],
  missing: [],
};
const EX_CONNECTOR = {
  id: z('con'),
  adapterKey: 'krs',
  displayName: 'KRS',
  companyId: null,
  status: 'ERROR',
  statusReason: 'auth_failed',
  statusChangedAt: T0,
  lastHealthAt: T0,
  lastHealthOk: false,
  lastHealthError: { errorClass: 'AUTH', code: 'auth_failed' },
};
const EX_JOB = {
  id: z('job'),
  type: 'import.commit',
  status: 'succeeded',
  progress: 100,
  attempts: 1,
  createdAt: T0,
  finishedAt: T0,
};

/** ตัวอย่างของ event ที่ยังไม่มี schema (pending) — โครงเดียวกับ webhook.test เดิม */
function pendingExample(type: string): Record<string, unknown> {
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
    id: z(prefix[entity] ?? 'obj'),
    object: entity,
    status: type.split('.')[1] ?? 'updated',
    updatedAt: T0,
  };
}

const active = (
  resource: string,
  description: string,
  emittedBy: string,
  schema: EventSchema,
  example: Record<string, unknown>,
) => ({
  resource,
  phase: 'active' as const,
  pendingTask: null,
  description,
  emittedBy,
  schema,
  example,
});

const pending = (resource: string, description: string, task: string) => ({
  resource,
  phase: 'pending' as const,
  pendingTask: task,
  description,
  emittedBy: `ยังไม่สร้าง (${task})`,
  schema: null,
});

const DEFS: Record<
  WebhookEventType,
  Omit<EventDefinition, 'type' | 'example'> & {
    example?: Record<string, unknown>;
  }
> = {
  'order.created': active(
    'order',
    'สร้างใบสั่งงานใหม่ (หน้าจอ, Open API, นำเข้าไฟล์)',
    'OrderIntakeService.upsertOrder (ใบใหม่ / พ้นร่าง submit)',
    ORDER,
    EX_ORDER,
  ),
  'order.updated': active(
    'order',
    'แก้ไขข้อมูลใบสั่งงาน',
    'OrderIntakeService (แก้ข้อมูล/ราคา) · OrderStateService.syncFromDeliveryOrders (สถานะตาม DO)',
    ORDER,
    { ...EX_ORDER, status: 'PLANNED', version: 2 },
  ),
  'order.held': active(
    'order',
    'พักใบสั่งงาน (เช่น ข้อมูลไม่ครบ เกินวงเงิน)',
    'OrderIntakeService (ใบค้างทางเข้า) · OrderStateService.holdSystem (รถร่วมปฏิเสธ/นัดส่งใหม่เกิน/คืนคลังทั้งหมด)',
    ORDER,
    { ...EX_ORDER, status: 'ON_HOLD', holdReason: 'RATE_MISSING', pricingStatus: 'RATE_MISSING' },
  ),
  'order.released': active(
    'order',
    'ปล่อยใบสั่งงานที่พักไว้ให้วางแผนต่อ',
    'OrderIntakeService (เหตุค้างหมด) · OrderStateService.syncFromDeliveryOrders (จัดรถใบที่ค้าง)',
    ORDER,
    EX_ORDER,
  ),
  'order.cancelled': active(
    'order',
    'ยกเลิกใบสั่งงาน',
    'OrderStateService.cancel · OrderIntakeService (ต้นทางยกเลิก)',
    ORDER,
    { ...EX_ORDER, status: 'CANCELLED' },
  ),
  'trip.assigned': active(
    'trip',
    'จัดรถ/คนขับ หรือรถร่วมให้เที่ยววิ่ง',
    'TripService (assign / reassign / รถร่วมรับงาน)',
    TRIP,
    EX_TRIP,
  ),
  'trip.dispatched': active('trip', 'ปล่อยเที่ยววิ่งให้คนขับ', 'TripService.dispatch', TRIP, {
    ...EX_TRIP,
    status: 'DISPATCHED',
  }),
  'trip.started': active(
    'trip',
    'คนขับเริ่มเที่ยววิ่ง',
    'TripService.applyExecution (event หน้างานแรก)',
    requiring(TRIP, 'startedAt'),
    { ...EX_TRIP, status: 'IN_PROGRESS', startedAt: T0 },
  ),
  'trip.completed': active(
    'trip',
    'เที่ยววิ่งจบครบทุกจุด',
    'TripService.applyExecution (ทุกจุดปิด)',
    requiring(TRIP, 'completedAt'),
    { ...EX_TRIP, status: 'COMPLETED', completedAt: T0 },
  ),
  'trip.cancelled': active('trip', 'ยกเลิกเที่ยววิ่ง', 'TripService.cancel', TRIP, {
    ...EX_TRIP,
    status: 'CANCELLED',
  }),
  'stop.arrived': active(
    'stop',
    'รถถึงจุดรับ/ส่ง',
    'StopProjectionService.writeStop',
    STOP,
    EX_STOP,
  ),
  'stop.departed': active('stop', 'รถออกจากจุดรับ/ส่ง', 'StopProjectionService.writeStop', STOP, {
    ...EX_STOP,
    status: 'COMPLETED',
    outcome: 'DELIVERED',
    departedAt: T0,
  }),
  'stop.completed': active(
    'stop',
    'ปิดงานที่จุดรับ/ส่งสำเร็จ',
    'StopProjectionService.writeStop',
    STOP,
    { ...EX_STOP, status: 'COMPLETED', outcome: 'DELIVERED', departedAt: T0 },
  ),
  'stop.failed': active(
    'stop',
    'งานที่จุดรับ/ส่งไม่สำเร็จ (มีเหตุผล)',
    'StopProjectionService.writeStop',
    STOP,
    { ...EX_STOP, status: 'FAILED', outcome: 'FAILED', failReasonCodeId: z('rsn') },
  ),
  'delivery_order.status_changed': active(
    'delivery_order',
    'สถานะใบส่งของ (DO) เปลี่ยน',
    'DeliveryOrderService (สร้าง/ทุก transition ผ่าน StateService)',
    DELIVERY_ORDER,
    EX_DO,
  ),
  'pod.captured': active(
    'pod',
    'บันทึกหลักฐานการส่ง (POD)',
    'PodService.save (เว็บ / ลิงก์รถร่วม / API)',
    POD,
    EX_POD,
  ),
  'invoice.finalized': pending('invoice', 'ออกเลขใบแจ้งหนี้/ใบกำกับภาษีแล้ว', 'ST5-T09'),
  'invoice.adjusted': pending('invoice', 'ปรับยอดใบแจ้งหนี้ด้วยใบลดหนี้/เพิ่มหนี้', 'ST5-T19'),
  'invoice.paid': pending('invoice', 'ใบแจ้งหนี้ได้รับชำระครบ', 'ST5-T18'),
  'invoice.voided': pending('invoice', 'ยกเลิกใบแจ้งหนี้', 'ST5-T10'),
  'credit_note.finalized': pending('credit_note', 'ออกเลขใบลดหนี้แล้ว', 'ST5-T19'),
  'debit_note.finalized': pending('debit_note', 'ออกเลขใบเพิ่มหนี้แล้ว', 'ST5-T20'),
  'payment.recorded': pending('payment', 'บันทึกรับชำระเงิน', 'ST5-T13'),
  'payment.reversed': pending('payment', 'กลับรายการรับชำระเงิน', 'ST5-T13'),
  'receipt.issued': pending('receipt', 'ออกใบเสร็จรับเงินแล้ว', 'ST5-T14'),
  'settlement.approved': pending('settlement', 'อนุมัติใบสรุปค่าขนส่งรถร่วม', 'ST6-T07'),
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
    EX_CONNECTOR,
  ),
  'reconcile.mismatch_found': pending(
    'reconcile',
    'พบข้อมูลไม่ตรงกันจากการกระทบยอดกับระบบภายนอก',
    'ST8-T11',
  ),
  'job.completed': active(
    'job',
    'งานเบื้องหลัง (นำเข้า/ส่งออก/รอบวางบิล) เสร็จ',
    'JobQueue.runOnce (งานที่ลงทะเบียน publicEvent — นำเข้าไฟล์)',
    JOB,
    EX_JOB,
  ),
};

/** ทะเบียนเรียงตาม `WEBHOOK_EVENT_TYPES` */
export const EVENT_REGISTRY: readonly EventDefinition[] = WEBHOOK_EVENT_TYPES.map((type) => {
  const d = DEFS[type];
  return { ...d, type, example: d.example ?? pendingExample(type) };
});

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
    out.additionalProperties = false;
  }
  if (s.items) out.items = strictEventSchema(s.items);
  return out;
}
