import type { Tx } from '../../db/db.service';

/**
 * ErrorClass กลาง (docs/01 §6.3) — sink/adapter แปลง error ของปลายทางเป็น class นี้ แล้ว core ตัดสิน retry จาก class
 * ไม่ใช่จาก HTTP code ของปลายทาง
 */
export const ERROR_CLASSES = [
  'TRANSIENT',
  'AMBIGUOUS',
  'DUPLICATE',
  'VALIDATION',
  'AUTH',
  'NOT_FOUND',
  'PERIOD_CLOSED',
  'CAPABILITY',
] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

/** error ที่ sink โยนเพื่อบอก class (error อื่นที่ไม่รู้จัก = TRANSIENT) */
export class OutboxSinkError extends Error {
  constructor(
    message: string,
    readonly errorClass: ErrorClass,
    /** รายละเอียดที่เก็บใน last_error (ห้ามมี secret — sink ตัดเองก่อนโยน) */
    readonly detail?: Record<string, unknown>,
    /**
     * sink กำหนดเวลารอก่อนลองใหม่เอง (ms) แทนตาราง retry — ใช้เมื่อ sink ต้องบันทึกเวลาลองครั้งถัดไปให้ตรงกับที่ dispatcher ตั้ง
     * (webhook ST7-T04 เก็บ next_retry_at ใน webhook_delivery) · มีผลกับ TRANSIENT เท่านั้น
     */
    readonly retryInMs?: number,
  ) {
    super(message);
  }
}

/** event ต้นทางของคำสั่ง (แถว domain_event) */
export interface OutboxEvent {
  id: string;
  type: string;
  version: number;
  occurredAt: Date;
  entityType: string;
  localId: string;
  snapshot: unknown;
  previousAttributes: unknown;
  requestId: string | null;
  actorId: string | null;
}

export interface OutboxDelivery {
  id: string;
  tenantId: string;
  kind: 'ADAPTER' | 'WEBHOOK';
  sink: string;
  targetId: string | null;
  operation: string;
  entityType: string;
  localId: string;
  /** ส่งให้ปลายทางกันซ้ำ — หยิบซ้ำหลัง lease หมด (worker ตาย) ได้ key เดิมเสมอ */
  idempotencyKey: string;
  /** ครั้งที่ (1 = ครั้งแรก) */
  attempt: number;
  /** canonical payload ของคำสั่ง (null = ใช้ event.snapshot) */
  payload: unknown;
  event: OutboxEvent | null;
  /** lease ถูกยึดคืน (หมดอายุแล้ว worker อื่นหยิบ) → ควรหยุดงาน */
  signal: AbortSignal;
  /** transaction ใหม่ของ tenant นี้ (RLS ตั้งแล้ว) — ห้ามถือ transaction ค้างระหว่างเรียกปลายทาง */
  withTx: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  /** ST8-T08 (review L1) lease ของรอบนี้ — กั้นการเขียนของ worker ที่ถูกยึดคืนแล้ว (ไม่มี = ไม่กั้น เช่น test เรียก sink ตรง) */
  leaseId?: string;
}

/**
 * ตัวส่งปลายทาง (ST7-T03) — webhook dispatcher (ST7-T04) และ ErpAdapter push (ST7-T13/T16) ลงทะเบียนเป็น sink
 * สัญญา: ต้องส่ง `idempotencyKey` ไปปลายทาง (หรือกันซ้ำเอง) เพราะคำสั่งเดียวอาจถูกส่งมากกว่า 1 ครั้ง (at-least-once)
 */
export interface OutboxSink {
  /** ตรงกับ integration_subscription.sink */
  readonly key: string;
  /** อายุ lease ของคำสั่ง (ms) — ค่าเริ่มต้น 5 นาที (docs/01 §6.2; ใบใหญ่ 15 นาที) */
  readonly leaseMs?: number;
  /** นโยบาย retry ของ sink (ไม่กำหนด = max_attempt ของแถว 7 ครั้ง + 1, 2, 5, 15, 30, 60 นาที — docs/01 §6.3) */
  readonly retry?: { maxAttempts: number; scheduleMin: readonly number[] };
  deliver(d: OutboxDelivery): Promise<{ result?: Record<string, unknown> } | void>;
  /**
   * D-81 · D68-57 คำสั่งจบแบบไม่ถึงปลายทาง (`FAILED_FINAL` / `SKIPPED`) — เรียกหลังบันทึกผลแล้ว (นอก transaction ของการบันทึก)
   * ใช้แจ้งคนให้ทำต่อ (เช่น แจ้งฝ่ายบัญชีว่าเอกสารไม่ถูกส่ง ERP — docs/01 §6.3) · throw ได้ (dispatcher จับแล้ว log — ไม่ย้อนผล)
   */
  onSettled?(c: SettledCommand): Promise<void>;
}

/** คำสั่งที่จบแบบไม่ถึงปลายทาง (ส่งให้ `OutboxSink.onSettled`) */
export interface SettledCommand {
  id: string;
  tenantId: string;
  sink: string;
  targetId: string | null;
  operation: string;
  entityType: string;
  localId: string;
  payload: unknown;
  status: 'FAILED_FINAL' | 'SKIPPED';
  errorClass: string | null;
  /** รหัสปัญหา (`last_error.code`) — null = ไม่มี */
  code: string | null;
}
