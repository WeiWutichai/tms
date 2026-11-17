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
