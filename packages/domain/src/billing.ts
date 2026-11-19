import type { TransitionTable } from './state-machine';
import type { DoStatus } from './delivery-order';

/**
 * สถานะวางบิลของ DO (ST5-T05; docs/04 F3 "Flag กันวางบิลซ้ำ") — แกนแยกจาก `DoStatus` (docs/01 §4.3 UNBILLED/BILLED คงอยู่)
 * [DECISION spec/12 §3 — ST5-T05]:
 * - `draft`   UNBILLED/CREDITED → IN_DRAFT — ดึงเข้าร่างใบแจ้งหนี้ (ล็อก DO + unique partial บน `invoice_line.delivery_order_id`)
 * - `undraft` IN_DRAFT → UNBILLED — ถอดออกจากร่าง / ยกเลิกร่าง (docs/01 §4.4 DRAFT → CANCELLED "DO กลับ UNBILLED")
 * - `invoice` IN_DRAFT → INVOICED — ใบออกเลข (ST5-T09) · **ย้อนไม่ได้** (docs/04 F4 → ใบลดหนี้)
 * - `credit`  INVOICED → CREDITED — ใบถูกลดหนี้เต็มใบ (VOIDED — docs/01 §4.3 "credit note เต็มใบ" DO วางบิลใหม่ได้)
 * ลดหนี้บางส่วน = คง INVOICED (ใบเป็น ADJUSTED)
 */
export const BILLING_STATUSES = ['UNBILLED', 'IN_DRAFT', 'INVOICED', 'CREDITED'] as const;
export type BillingStatus = (typeof BILLING_STATUSES)[number];

export const BILLING_EVENTS = ['draft', 'undraft', 'invoice', 'credit'] as const;
export type BillingEvent = (typeof BILLING_EVENTS)[number];

export const BILLING_TRANSITIONS: TransitionTable<BillingStatus, BillingEvent> = {
  UNBILLED: { draft: 'IN_DRAFT' },
  CREDITED: { draft: 'IN_DRAFT' },
  IN_DRAFT: { undraft: 'UNBILLED', invoice: 'INVOICED' },
  INVOICED: { credit: 'CREDITED' },
};

/** DO ดึงเข้าร่างใบแจ้งหนี้ได้ (ยังไม่อยู่ในใบที่ active) */
export function isBillable(s: BillingStatus): boolean {
  return s === 'UNBILLED' || s === 'CREDITED';
}

/** สถานะ DO ที่ส่งถึงแล้ว — ดึงเข้าร่างได้ (ความพร้อมเต็มรูป = คิวพร้อมวางบิล ST5-T04 ตรวจซ้ำตอนดึง — ST5-T07) */
export const BILLABLE_DO_STATUSES: readonly DoStatus[] = ['DELIVERED', 'POD_PENDING', 'UNBILLED'];

/** สถานะใบแจ้งหนี้ (docs/01 §4.4 — ไม่มี SENT/ACCEPTED/MISMATCH: สถานะซิงก์แยก plan/00a §4.4) */
export const INVOICE_STATUSES = [
  'DRAFT',
  'ISSUED',
  'PARTIALLY_PAID',
  'PAID',
  'ADJUSTED',
  'VOIDED',
  'CANCELLED',
] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** ใบที่บรรทัดยังนับเป็นการวางบิล DO (docs/01 §3.4 "where invoice.status ≠ CANCELLED" + VOIDED ตาม §4.3) */
export function isInvoiceActive(s: InvoiceStatus): boolean {
  return s !== 'CANCELLED' && s !== 'VOIDED';
}

/**
 * ขั้นของ DO ตาม lifecycle docs/04 F4 (DELIVERED → RELEASED → IN_DRAFT → INVOICED → PAID/CREDITED) — **คำนวณ ไม่เก็บ**
 * จาก `DoStatus` (ส่งถึงแล้ว) + `released_at` (ST5-T04) + `billingStatus` (ST5-T05) + สถานะใบ (ชำระ — ST5-T22)
 * null = ยังไม่ส่งถึง / ยกเลิก · กฎย้อน/สิทธิ์ต่อขั้น = ST5-T06
 */
export type BillingStage =
  'DELIVERED' | 'RELEASED' | 'IN_DRAFT' | 'INVOICED' | 'PARTIALLY_PAID' | 'PAID' | 'CREDITED';

export function billingStage(
  d: { status: DoStatus; billingStatus: BillingStatus; releasedAt: Date | string | null },
  invoiceStatus?: InvoiceStatus | null,
): BillingStage | null {
  if (d.billingStatus === 'CREDITED') return 'CREDITED';
  if (d.billingStatus === 'INVOICED') {
    if (invoiceStatus === 'PAID') return 'PAID';
    if (invoiceStatus === 'PARTIALLY_PAID') return 'PARTIALLY_PAID';
    return 'INVOICED';
  }
  if (d.billingStatus === 'IN_DRAFT') return 'IN_DRAFT';
  if (!BILLABLE_DO_STATUSES.includes(d.status) && d.status !== 'BILLED') return null;
  return d.releasedAt ? 'RELEASED' : 'DELIVERED';
}
