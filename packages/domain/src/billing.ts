import type { TransitionTable } from './state-machine';
import type { DoStatus } from './delivery-order';

/**
 * สถานะวางบิลของ DO (ST5-T05; docs/04 F3 "Flag กันวางบิลซ้ำ") — แกนแยกจาก `DoStatus` (docs/01 §4.3 UNBILLED/BILLED คงอยู่)
 * [DECISION spec/12 §3 — ST5-T05]:
 * - `draft`   UNBILLED/CREDITED → IN_DRAFT — ดึงเข้าร่างใบแจ้งหนี้ (ล็อก DO + unique partial บน `invoice_line.delivery_order_id`)
 * - `undraft` IN_DRAFT → UNBILLED — ถอดออกจากร่าง / ยกเลิกร่าง (docs/01 §4.4 DRAFT → CANCELLED "DO กลับ UNBILLED")
 * - `invoice` IN_DRAFT → INVOICED — ใบออกเลข (ST5-T09) · **ย้อนไม่ได้** (docs/04 F4 → ใบลดหนี้)
 * - `credit`  INVOICED → CREDITED — ใบถูกลดหนี้เต็มใบ (VOIDED — docs/01 §4.3 "credit note เต็มใบ" DO วางบิลใหม่ได้)
 * - `uninvoice` INVOICED → UNBILLED — ใบที่ออกแล้วถูกยกเลิก (ST5-T10; docs/04 F3 "ยกเลิกใบ" ยังไม่รับชำระ — DO กลับรอวางบิล)
 * ลดหนี้บางส่วน = คง INVOICED (ใบเป็น ADJUSTED)
 */
export const BILLING_STATUSES = ['UNBILLED', 'IN_DRAFT', 'INVOICED', 'CREDITED'] as const;
export type BillingStatus = (typeof BILLING_STATUSES)[number];

export const BILLING_EVENTS = ['draft', 'undraft', 'invoice', 'credit', 'uninvoice'] as const;
export type BillingEvent = (typeof BILLING_EVENTS)[number];

export const BILLING_TRANSITIONS: TransitionTable<BillingStatus, BillingEvent> = {
  UNBILLED: { draft: 'IN_DRAFT' },
  CREDITED: { draft: 'IN_DRAFT' },
  IN_DRAFT: { undraft: 'UNBILLED', invoice: 'INVOICED' },
  INVOICED: { credit: 'CREDITED', uninvoice: 'UNBILLED' },
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

/**
 * ใบที่ "ออกเลขแล้วและไม่ถูกยกเลิก" (finalize แล้ว) — ชุดเดียวกับ "ออกใบแจ้งหนี้เดือนนี้" ของ Dashboard บิล (ST9-T02)
 * และรายงานรายได้ (ST9-T05) · ไม่รวม DRAFT / CANCELLED / VOIDED · ADJUSTED ไม่เกิดในเฟส 0 (ใบลดหนี้อยู่ AccountSystem — D-54)
 */
export const ISSUED_INVOICE_STATUSES: readonly InvoiceStatus[] = [
  'ISSUED',
  'PARTIALLY_PAID',
  'PAID',
  'ADJUSTED',
];

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
  d: {
    status: DoStatus;
    billingStatus: BillingStatus;
    releasedAt: Date | string | null;
    /** ST5-T06 เวลารับชำระครบ (ST5-T22 เขียน) — มีค่า = PAID เมื่อไม่ส่งสถานะใบ */
    paidAt?: Date | string | null;
  },
  invoiceStatus?: InvoiceStatus | null,
): BillingStage | null {
  if (d.billingStatus === 'CREDITED') return 'CREDITED';
  if (d.billingStatus === 'INVOICED') {
    if (invoiceStatus === 'PAID' || (!invoiceStatus && d.paidAt)) return 'PAID';
    if (invoiceStatus === 'PARTIALLY_PAID') return 'PARTIALLY_PAID';
    return 'INVOICED';
  }
  if (d.billingStatus === 'IN_DRAFT') return 'IN_DRAFT';
  if (!BILLABLE_DO_STATUSES.includes(d.status) && d.status !== 'BILLED') return null;
  return d.releasedAt ? 'RELEASED' : 'DELIVERED';
}

/**
 * กฎย้อนขั้นของ lifecycle (ST5-T06; docs/04 F4 คอลัมน์ "ย้อนได้โดย" + "permission ต่อ transition กำหนดใน role")
 * [DECISION spec/12 §3] — scope ตาม docs/04 A3:
 * - DELIVERED → ส่งไม่สำเร็จ (`POST /delivery-orders/{id}/revert-delivery`): `trips:close` (Dispatcher) ภายใน 24 ชม. นับจากเวลาที่ DO
 *   เป็นส่งถึง · เกิน 24 ชม. ต้องมี `deliveries:revert` (owner/admin — F4 "Admin" เคร่งครัด)
 * - RELEASED → DELIVERED (`POST /delivery-orders/{id}/unrelease`): `invoices:draft` (Invoicer — ผู้ส่งบัญชี)
 * - IN_DRAFT → ถอดออกจากร่าง (ST5-T07): `invoices:draft`
 * - INVOICED / PARTIALLY_PAID / PAID: ย้อนไม่ได้ → ใบลดหนี้ (ST5-T12) · CREDITED: ไม่มีขั้นให้ย้อน
 * ทุกการย้อนต้องมีเหตุผล (≥ 10 ตัวอักษร) + audit · RELEASED ขึ้นไปแก้จุดแวะ/ยอดส่งจริงไม่ได้ (409)
 */
export interface BillingRevertRule {
  scope: string;
  /** ช่วงเวลาที่ `scope` ย้อนได้ (ชม.) — เกินต้องมี `overrideScope` */
  windowHours?: number;
  overrideScope?: string;
}
export const BILLING_REVERT_RULES: Record<BillingStage, BillingRevertRule | null> = {
  DELIVERED: { scope: 'trips:close', windowHours: 24, overrideScope: 'deliveries:revert' },
  RELEASED: { scope: 'invoices:draft' },
  IN_DRAFT: { scope: 'invoices:draft' },
  INVOICED: null,
  PARTIALLY_PAID: null,
  PAID: null,
  CREDITED: null,
};

/** ช่วงที่ผู้จัดรถย้อนผลส่งถึงเองได้ (docs/04 F4 "ภายใน 24 ชม.") */
export const REVERT_DELIVERY_WINDOW_MS = 24 * 3600_000;

/** เส้นตายย้อนผลส่งถึงของผู้จัดรถ — `now` ≤ เส้นตาย = ภายในช่วง (เวลาเป็นช่วงต่อเนื่อง ไม่ขึ้นกับวันปฏิทิน) */
export function revertDeliveryWindow(
  deliveredAt: Date,
  now: Date,
): { deadline: Date; within: boolean } {
  const deadline = new Date(deliveredAt.getTime() + REVERT_DELIVERY_WINDOW_MS);
  return { deadline, within: now.getTime() <= deadline.getTime() };
}

/** ใบที่รับชำระได้ (ST5-T13) — ออกเลขแล้วและยังมียอดค้าง (ร่าง/ยกเลิก/ปรับยอด/ชำระครบ ไม่รับ) */
export const PAYABLE_INVOICE_STATUSES: readonly InvoiceStatus[] = ['ISSUED', 'PARTIALLY_PAID'];
/** สถานะที่ "สถานะจากการรับชำระ" คำนวณได้ (ISSUED / PARTIALLY_PAID / PAID สลับกันตามยอดตัด) */
const PAYMENT_DRIVEN: readonly InvoiceStatus[] = ['ISSUED', 'PARTIALLY_PAID', 'PAID'];

/**
 * สถานะใบแจ้งหนี้จากยอดรับชำระ (ST5-T13 — **ที่เดียว**; docs/01 §4.4 "PARTIALLY_PAID / PAID ตาม payment_allocation",
 * docs/04 F5 "สถานะ invoice คำนวณจาก Payment") — หน่วยสตางค์ (ไม่ใช้ float)
 * - ยอดตัดรวม (เงินรับ + WHT ที่ถูกหัก + ค่าธรรมเนียม + ส่วนต่าง ที่ตัดใบนี้ — เฉพาะ payment ที่ยังไม่กลับรายการ) = 0 → ISSUED
 * - 0 < ยอดตัด < ยอดรวม → PARTIALLY_PAID · ยอดตัด ≥ ยอดรวม → PAID
 * - สถานะอื่น (DRAFT / CANCELLED / VOIDED / ADJUSTED) ไม่เปลี่ยน
 * ST5-T18: "เกินกำหนด" เป็นธงแยก (`invoiceOverdue`) ไม่ใช่สถานะ — plan/11 #5, plan/00a §2.4.5 · ธง "ส่งลูกค้าแล้ว" = `sent_to_customer_at`
 */
export function invoicePaymentStatus(
  current: InvoiceStatus,
  totalSatang: bigint,
  paidSatang: bigint,
): InvoiceStatus {
  if (!PAYMENT_DRIVEN.includes(current)) return current;
  if (paidSatang <= 0n) return 'ISSUED';
  return paidSatang >= totalSatang ? 'PAID' : 'PARTIALLY_PAID';
}

/**
 * เกินกำหนดชำระ (ST5-T18 — **ที่เดียว**; docs/04 F5 "OVERDUE … คำนวณจาก Payment", spec/05 BIL-040 `dueDate < today และ outstanding > 0`)
 * - เป็น**ธงแยกจากสถานะ** (plan/11 #5 · plan/00a §2.4.5 "เกินกำหนด = ค่าคำนวณ ไม่เป็นสถานะ") — ใบชำระบางส่วนที่เลยกำหนดยังเป็น
 *   PARTIALLY_PAID + ธงเกินกำหนด (หน้าจอแสดง "เกินกำหนด" ก่อน — ต้นแบบ invSt)
 * - ใช้กับสถานะ **หลังคำนวณจากยอดตัด** (`invoicePaymentStatus`) — ค้างรับ (ISSUED/PARTIALLY_PAID) + ยอดตัด < ยอดรวม + ครบกำหนด < วันนี้
 * - `dueDate` / `today` = YYYY-MM-DD เวลาไทย (Asia/Bangkok) · ครบกำหนดวันนี้ = ยังไม่เกิน
 */
export function invoiceOverdue(
  status: InvoiceStatus,
  totalSatang: bigint,
  paidSatang: bigint,
  dueDate: string | null,
  today: string,
): boolean {
  if (!PAYABLE_INVOICE_STATUSES.includes(status)) return false;
  if (paidSatang >= totalSatang) return false;
  return !!dueDate && dueDate < today;
}

/** ช่องทางที่ทำให้ใบ "ส่งลูกค้าแล้ว" (ST5-T18): ทำเครื่องหมายเอง · ออกใบวางบิล · ส่งอีเมล (ST5-T21) */
export const INVOICE_SENT_CHANNELS = ['MANUAL', 'BILLING_NOTE', 'EMAIL'] as const;
export type InvoiceSentChannel = (typeof INVOICE_SENT_CHANNELS)[number];

/**
 * อายุลูกหนี้ (ST5-T22; docs/04 F5 "Aging 0–30 / 31–60 / 61–90 / > 90 ต่อลูกค้า"; spec/05 §10 + spec/09 §3 `daysPastDue = asOf − dueDate`
 * "≤ 0 = ยังไม่ครบกำหนด"; ต้นแบบ TMS v4 agingB) — 5 ช่วง: ยังไม่ครบกำหนด · 1–30 · 31–60 · 61–90 · เกิน 90 วัน
 * [DECISION spec/12 §3 แถว ST5-T22 — นับจากวันครบกำหนด ไม่ใช่วันที่ออก]
 */
export const AGING_BUCKETS = [
  'NOT_DUE',
  'DAYS_1_30',
  'DAYS_31_60',
  'DAYS_61_90',
  'DAYS_OVER_90',
] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

/** ขอบล่าง/บนของ daysPastDue ต่อช่วง (รวมขอบ · null = ไม่จำกัด) */
export const AGING_BUCKET_RANGE: Record<AgingBucket, readonly [number | null, number | null]> = {
  NOT_DUE: [null, 0],
  DAYS_1_30: [1, 30],
  DAYS_31_60: [31, 60],
  DAYS_61_90: [61, 90],
  DAYS_OVER_90: [91, null],
};

/** จำนวนวันที่เลยกำหนด ณ `asOf` (YYYY-MM-DD เวลาไทย) — ไม่มีวันครบกำหนด = 0 (ยังไม่ครบกำหนด) · ติดลบ = ยังไม่ถึง */
export function daysPastDue(dueDate: string | null, asOf: string): number {
  if (!dueDate) return 0;
  return Math.round(
    (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) / 86_400_000,
  );
}

export function agingBucketOf(days: number): AgingBucket {
  if (days <= 0) return 'NOT_DUE';
  if (days <= 30) return 'DAYS_1_30';
  if (days <= 60) return 'DAYS_31_60';
  if (days <= 90) return 'DAYS_61_90';
  return 'DAYS_OVER_90';
}

/**
 * ระดับเตือนครบกำหนดชำระ (ST5-T22; spec/05 BIL-121 "ก่อนครบกำหนด 3 วัน, วันครบกำหนด, เกิน 7/30 วัน") — ช่วงต่อเนื่องของ daysPastDue
 * แต่ละระดับเตือนครั้งเดียวต่อใบต่อวันครบกำหนด (สมุดเตือน) · job หยุดไปหลายวัน = ส่งระดับของวันนี้ (ไม่ส่งย้อนระดับที่ข้ามไป)
 * เกิน 30 วันเตือนถึงวันที่ 59 เท่านั้น — เปิดใช้ครั้งแรกไม่เตือนหนี้เก่าทั้งก้อน (แบบ EXPIRED_NOTICE_WINDOW_DAYS ของ ST2-T18)
 */
export const PAYMENT_DUE_LEVELS = ['DUE_IN_3', 'DUE_TODAY', 'OVERDUE_7', 'OVERDUE_30'] as const;
export type PaymentDueLevel = (typeof PAYMENT_DUE_LEVELS)[number];
export const PAYMENT_DUE_WINDOW: Record<PaymentDueLevel, readonly [number, number]> = {
  DUE_IN_3: [-3, -1],
  DUE_TODAY: [0, 6],
  OVERDUE_7: [7, 29],
  OVERDUE_30: [30, 59],
};

export function paymentDueLevel(days: number): PaymentDueLevel | null {
  for (const l of PAYMENT_DUE_LEVELS) {
    const [lo, hi] = PAYMENT_DUE_WINDOW[l];
    if (days >= lo && days <= hi) return l;
  }
  return null;
}
