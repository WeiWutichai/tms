import { Prisma } from '@prisma/client';
import {
  invoiceOverdue,
  invoicePaymentStatus,
  satangFromDecimal,
  type InvoiceStatus,
} from '@tms/domain';
import type { Tx } from '../../db/db.service';
import { bangkokToday } from '../vehicle-documents/expiry';

export interface InvoicePaymentState {
  status: InvoiceStatus;
  paidAmount: string;
  /** ST5-T18 เกินกำหนด (ธงแยกจากสถานะ) */
  overdue: boolean;
}

export interface InvoicePaymentChange {
  id: string;
  invoiceNo: string | null;
  /** version ก่อนเปลี่ยน (webhook `previousAttributes`) */
  beforeVersion: number;
  before: InvoicePaymentState;
  after: InvoicePaymentState;
}

/**
 * คำนวณยอดตัดชำระ + สถานะ + ธงเกินกำหนดของใบแจ้งหนี้ (ST5-T13 + ST5-T18 — **ที่เดียว** ที่เขียน `invoice.paid_amount` /
 * สถานะจากการรับชำระ / `overdue_at`) — ผู้เรียกต้อง**ล็อกใบ (FOR UPDATE) เรียงตาม id ก่อน**ใน transaction เดียวกัน
 *
 * ผู้เรียก: บันทึก/กลับรายการรับชำระ (ST5-T13) · job เกินกำหนดรายวัน (ST5-T18) · **รับสถานะชำระจากระบบบัญชี (D-57 — ST8-T16 /
 * ST7-T21 สร้าง `payment` แล้วเรียกฟังก์ชันนี้ ไม่คิดสถานะเอง)**
 *
 * - ยอดตัด = Σ allocation.amount ของ payment ที่ยัง RECORDED (กลับรายการแล้วไม่นับ) — CHECK `invoice_paid_amount_check` กันเกินยอดรวม
 * - สถานะ: `invoicePaymentStatus` (ISSUED ↔ PARTIALLY_PAID ↔ PAID)
 * - เกินกำหนด: `invoiceOverdue` ณ วันของ `now` เวลาไทย — ตั้ง `overdue_at = now` ครั้งแรก · ล้างเมื่อไม่เข้าเงื่อนไข (ชำระครบ ฯลฯ)
 * - มีอะไรเปลี่ยน = version + 1
 * - DO ในใบ: ชำระครบ → `paid_at` (docs/04 F4 timestamp ต่อขั้น) · หลุดจาก PAID (กลับรายการ) → ล้าง `paid_at`
 */
export async function applyInvoicePayments(
  tx: Tx,
  invoiceIds: readonly string[],
  now: Date,
): Promise<InvoicePaymentChange[]> {
  const out: InvoicePaymentChange[] = [];
  const today = bangkokToday(now);
  for (const id of [...new Set(invoiceIds)].sort()) {
    const inv = await tx.invoice.findUniqueOrThrow({
      where: { id },
      select: {
        status: true,
        invoiceNo: true,
        totalAmount: true,
        paidAmount: true,
        dueDate: true,
        overdueAt: true,
        version: true,
      },
    });
    const agg = await tx.$queryRaw<{ paid: Prisma.Decimal | null }[]>`
      SELECT COALESCE(SUM(a.amount), 0) AS paid
        FROM payment_allocation a JOIN payment p ON p.id = a.payment_id
       WHERE a.invoice_id = ${id}::uuid AND p.status = 'RECORDED'`;
    const paid = new Prisma.Decimal(agg[0]?.paid ?? 0);
    const total = satangFromDecimal(inv.totalAmount.toFixed(2));
    const paidS = satangFromDecimal(paid.toFixed(2));
    const status = invoicePaymentStatus(inv.status as InvoiceStatus, total, paidS);
    const overdue = invoiceOverdue(
      status,
      total,
      paidS,
      inv.dueDate ? inv.dueDate.toISOString().slice(0, 10) : null,
      today,
    );
    const wasOverdue = inv.overdueAt !== null;
    if (status === inv.status && paid.equals(inv.paidAmount) && overdue === wasOverdue) continue;
    await tx.invoice.update({
      where: { id },
      data: {
        paidAmount: paid,
        status,
        overdueAt: overdue ? (inv.overdueAt ?? now) : null,
        version: { increment: 1 },
      },
    });
    if (status !== inv.status && (status === 'PAID' || inv.status === 'PAID')) {
      const doIds = (
        await tx.invoiceLine.findMany({
          where: { invoiceId: id, active: true, deliveryOrderId: { not: null } },
          select: { deliveryOrderId: true },
          distinct: ['deliveryOrderId'],
        })
      ).map((l) => l.deliveryOrderId!);
      if (doIds.length)
        await tx.deliveryOrder.updateMany({
          where: { id: { in: doIds } },
          data: { paidAt: status === 'PAID' ? now : null },
        });
    }
    out.push({
      id,
      invoiceNo: inv.invoiceNo,
      beforeVersion: inv.version,
      before: {
        status: inv.status as InvoiceStatus,
        paidAmount: inv.paidAmount.toFixed(2),
        overdue: wasOverdue,
      },
      after: { status, paidAmount: paid.toFixed(2), overdue },
    });
  }
  return out;
}
