import { Prisma } from '@prisma/client';
import { invoicePaymentStatus, satangFromDecimal, type InvoiceStatus } from '@tms/domain';
import type { Tx } from '../../db/db.service';

export interface InvoicePaymentChange {
  id: string;
  before: { status: InvoiceStatus; paidAmount: string };
  after: { status: InvoiceStatus; paidAmount: string };
}

/**
 * คำนวณยอดตัดชำระ + สถานะใบแจ้งหนี้จาก `payment_allocation` (ST5-T13 — **ที่เดียว** ที่เขียน `invoice.paid_amount`/สถานะจากการรับชำระ;
 * ST5-T18 ต่อยอดที่นี่: OVERDUE / ธงส่งลูกค้าแล้ว) — ผู้เรียกต้อง**ล็อกใบ (FOR UPDATE) เรียงตาม id ก่อน**ใน transaction เดียวกัน
 *
 * - ยอดตัด = Σ allocation.amount ของ payment ที่ยัง RECORDED (กลับรายการแล้วไม่นับ) — CHECK `invoice_paid_amount_check` กันเกินยอดรวม
 * - สถานะ: `invoicePaymentStatus` (ISSUED ↔ PARTIALLY_PAID ↔ PAID) · เปลี่ยน = version + 1
 * - DO ในใบ: ชำระครบ → `paid_at` (docs/04 F4 timestamp ต่อขั้น) · หลุดจาก PAID (กลับรายการ) → ล้าง `paid_at`
 */
export async function applyInvoicePayments(
  tx: Tx,
  invoiceIds: readonly string[],
  now: Date,
): Promise<InvoicePaymentChange[]> {
  const out: InvoicePaymentChange[] = [];
  for (const id of [...new Set(invoiceIds)].sort()) {
    const inv = await tx.invoice.findUniqueOrThrow({
      where: { id },
      select: { status: true, totalAmount: true, paidAmount: true },
    });
    const agg = await tx.$queryRaw<{ paid: Prisma.Decimal | null }[]>`
      SELECT COALESCE(SUM(a.amount), 0) AS paid
        FROM payment_allocation a JOIN payment p ON p.id = a.payment_id
       WHERE a.invoice_id = ${id}::uuid AND p.status = 'RECORDED'`;
    const paid = new Prisma.Decimal(agg[0]?.paid ?? 0);
    const status = invoicePaymentStatus(
      inv.status as InvoiceStatus,
      satangFromDecimal(inv.totalAmount.toFixed(2)),
      satangFromDecimal(paid.toFixed(2)),
    );
    if (status === inv.status && paid.equals(inv.paidAmount)) continue;
    await tx.invoice.update({
      where: { id },
      data: { paidAmount: paid, status, version: { increment: 1 } },
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
      before: { status: inv.status as InvoiceStatus, paidAmount: inv.paidAmount.toFixed(2) },
      after: { status, paidAmount: paid.toFixed(2) },
    });
  }
  return out;
}
