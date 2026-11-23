import { scopeAllows } from '@tms/domain';
import { ProblemException } from '../../common/problem';
import { requestContext } from '../../common/request-context';

/**
 * ST7-T11 (review M1): scope อ่านของ resource ของ event — `GET /v1/events` เห็นเฉพาะ event ที่ผู้เรียกอ่าน REST ได้
 * (ตรงกับ scope ของ endpoint เจ้าของ object: DO/POD ใช้ orders/trips ตาม A3, connector = settings) · ไม่รู้จัก = ไม่มีใครอ่านได้
 */
const EVENT_READ_SCOPE: Record<string, string> = {
  order: 'orders:read',
  delivery_order: 'orders:read',
  trip: 'trips:read',
  stop: 'trips:read',
  pod: 'trips:read',
  invoice: 'invoices:read',
  credit_note: 'invoices:read',
  debit_note: 'invoices:read',
  payment: 'invoices:read',
  receipt: 'invoices:read',
  wht_certificate: 'invoices:read',
  settlement: 'settlements:read',
  connector: 'settings:read',
  reconcile: 'integrations:read',
  job: 'jobs:read',
};
export function eventReadScope(type: string): string {
  return EVENT_READ_SCOPE[type.split('.')[0]!] ?? 'events:none';
}

/**
 * review G-1 (D68-49 `webhooks:manage` — ทางระมัดระวัง): API key / OAuth client สมัครหรือส่งซ้ำได้เฉพาะ event ที่ key มี
 * scope อ่าน resource ของ event นั้น (ชุดเดียวกับการกรอง `GET /v1/events`) — ไม่งั้น 422 พร้อมรายการชนิดที่ไม่มีสิทธิ์
 * ผู้ใช้ที่ login ไม่ถูกจำกัด (สิทธิ์ตาม role เดิม)
 */
export function assertKeyEventScope(types: readonly string[]): void {
  const ctx = requestContext.require();
  if (ctx.principalType !== 'client') return;
  const scopes = ctx.scopes ?? [];
  const denied = [...new Set(types)].filter((t) => !scopeAllows(scopes, eventReadScope(t)));
  if (denied.length)
    throw new ProblemException(
      'validation_failed',
      undefined,
      denied.map((t) => ({
        field: 'events',
        code: 'event_scope_missing',
        message: `API key needs ${eventReadScope(t)} to receive ${t}`,
      })),
      { eventTypes: denied },
    );
}
