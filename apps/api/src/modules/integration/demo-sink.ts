import { Logger } from '@nestjs/common';
import type { OutboxDelivery, OutboxSink } from './outbox.types';

export interface DemoReceived {
  idempotencyKey: string;
  tenantId: string;
  operation: string;
  eventId: string | null;
  attempt: number;
  receivedAt: Date;
}

/**
 * Sink ตัวอย่าง (ST7-T03): จำลองปลายทางที่กันซ้ำด้วย idempotency key — key เดิมส่งมาอีกได้ผลเดิม ไม่บันทึกซ้ำ
 * ใช้ใน test/dev ให้ webhook (T04) และ ERP push (T13/T16) เสียบ sink จริงแทนได้ · ไม่มีอะไรสร้าง subscription `demo` ใน production
 * `fail` ใช้ฉีด error ใน test
 */
export class DemoSink implements OutboxSink {
  private readonly logger = new Logger('DemoSink');
  /** สิ่งที่ "ปลายทาง" รับแล้ว (ต่อ idempotency key = 1 รายการ) */
  readonly received = new Map<string, DemoReceived>();
  /** ทุกครั้งที่ถูกเรียก (รวมครั้งที่ซ้ำ) */
  calls = 0;
  fail?: (d: OutboxDelivery) => Error | undefined;
  /** หน่วงก่อนตอบ (test ลำดับ/การแย่งงาน) */
  delayMs = 0;

  constructor(
    readonly leaseMs?: number,
    readonly key: string = 'demo',
  ) {}

  async deliver(d: OutboxDelivery): Promise<{ result?: Record<string, unknown> }> {
    this.calls++;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const err = this.fail?.(d);
    if (err) throw err;
    const prev = this.received.get(d.idempotencyKey);
    if (prev) return { result: { duplicate: true, receivedAt: prev.receivedAt.toISOString() } };
    const rec: DemoReceived = {
      idempotencyKey: d.idempotencyKey,
      tenantId: d.tenantId,
      operation: d.operation,
      eventId: d.event?.id ?? null,
      attempt: d.attempt,
      receivedAt: new Date(),
    };
    this.received.set(d.idempotencyKey, rec);
    this.logger.log(`demo sink received ${d.operation} (${d.idempotencyKey})`);
    return { result: { duplicate: false, receivedAt: rec.receivedAt.toISOString() } };
  }

  reset(): void {
    this.received.clear();
    this.calls = 0;
    this.fail = undefined;
    this.delayMs = 0;
  }
}
