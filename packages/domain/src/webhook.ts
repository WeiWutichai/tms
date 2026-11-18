/**
 * Webhook ขาออก (ST7-T04; docs/04 G1 Webhook; docs/01 §5.3; spec/07 §10)
 *
 * รายการ event สาธารณะ = docs/01 §5.3 (ชื่อของ docs เมื่อซ้ำความหมายกับ spec/07 — plan/00a)
 * + ที่ plan/00a ให้เพิ่มจาก spec: `trip.started`, `trip.cancelled` (`webhook.test` เป็น event ระบบ ไม่ให้สมัคร)
 * event ภายในอื่น ๆ (เช่น `trip.updated`, `customer.*`) ไม่ส่งออกทาง webhook จนกว่าจะเพิ่มที่นี่
 * รายการจริงต่อ API = `GET /v1/webhooks/event-types` (ST7-T05) · ทะเบียนเต็ม (ระยะ/schema/ผู้ยิง) = event-registry.ts (ST7-T06)
 */
export const WEBHOOK_EVENT_TYPES = [
  'order.created',
  'order.updated',
  'order.held',
  'order.released',
  'order.cancelled',
  'trip.assigned',
  'trip.dispatched',
  'trip.started',
  'trip.completed',
  'trip.cancelled',
  'stop.arrived',
  'stop.departed',
  'stop.completed',
  'stop.failed',
  'delivery_order.status_changed',
  'pod.captured',
  'invoice.finalized',
  'invoice.adjusted',
  'invoice.paid',
  'invoice.voided',
  'credit_note.finalized',
  'debit_note.finalized',
  'payment.recorded',
  'payment.reversed',
  'receipt.issued',
  'settlement.approved',
  'settlement.paid',
  'wht_certificate.issued',
  'connector.health_changed',
  'reconcile.mismatch_found',
  'job.completed',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** retry 8 ครั้งหลังครั้งแรก (นาที): 1m, 5m, 30m, 2h, 6h, 12h, 24h, 24h ≈ 3 วัน (docs/04 G1, Q-D6 ยึด docs) */
export const WEBHOOK_RETRY_SCHEDULE_MIN = [1, 5, 30, 120, 360, 720, 1440, 1440] as const;
/** ครั้งแรก + retry 8 ครั้ง */
export const WEBHOOK_MAX_ATTEMPTS = 1 + WEBHOOK_RETRY_SCHEDULE_MIN.length;
/** ปิด endpoint อัตโนมัติเมื่อ event ล้มเหลวขั้นสุดท้ายติดกันครบเท่านี้ (docs/04 G1; benchmark 9.4 "50 events") */
export const WEBHOOK_AUTO_DISABLE_AFTER = 50;
/** ผู้รับควรปฏิเสธลายเซ็นที่ `t` ห่างจากเวลาปัจจุบันเกินนี้ (วินาที) — INT-102 */
export const WEBHOOK_SIGNATURE_TOLERANCE_SEC = 300;
/** หมุน secret แล้วเซ็นด้วย secret เดิมคู่ไปอีก (ชั่วโมง) — INT-102 */
export const WEBHOOK_ROTATION_GRACE_HOURS = 24;
/** header เพิ่มเติมสูงสุดต่อ endpoint (spec/07 §10 extraHeaders ≤ 5) */
export const WEBHOOK_EXTRA_HEADERS_MAX = 5;

/** คำอธิบาย event = `EVENT_REGISTRY` (event-registry.ts — ST7-T06) */

/** เก็บประวัติการส่ง (webhook_delivery) และส่งซ้ำด้วยมือได้ภายใน (วัน) — docs/04 G1 Webhook ops, INT-106 */
export const WEBHOOK_DELIVERY_RETENTION_DAYS = 30;
/** คำสั่งที่พักไว้เพราะบริษัทถูกระงับเกินนี้ (วัน) → ทิ้งพร้อม log — INT-109 */
export const WEBHOOK_PARKED_MAX_DAYS = 30;
