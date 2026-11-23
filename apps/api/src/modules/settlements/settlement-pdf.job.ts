import type { Tx } from '../../db/db.service';
import type { JobQueue } from '../../jobs/job-queue.service';

/**
 * D-66 (PO 22 พ.ย. 2569): งานเบื้องหลัง render + เก็บ PDF ใบสำคัญจ่าย ฉบับอนุมัติ (`APPROVED`) / ฉบับจ่ายแล้ว (`PAID`)
 * enqueue ใน transaction เดียวกับการอนุมัติ / บันทึกจ่าย (rollback = ไม่มีงาน · process ตายหลัง commit = งานค้างให้ทำต่อ) ·
 * handler อยู่ที่ `SettlementPdfService` (แยกไฟล์ค่าคงที่ — กัน import วนกับ SettlementsService)
 */
export const SETTLEMENT_PDF_JOB = 'settlement.render_pdf';
/** ลองใหม่ (แบบ `invoice.render_pdf`): 10 วิ · 1 นาที · 5 นาที · 15 นาที · 1 ชม. · 3 ชม. · 6 ชม. (รวม 8 ครั้ง) */
export const SETTLEMENT_PDF_RETRY_MS = [
  10_000, 60_000, 300_000, 900_000, 3_600_000, 10_800_000, 21_600_000,
] as const;
export type SettlementPdfVariant = 'APPROVED' | 'PAID';

export function enqueueSettlementPdf(
  queue: JobQueue,
  tx: Tx,
  tenantId: string,
  settlementId: string,
  variant: SettlementPdfVariant,
) {
  return queue.enqueue(tx, {
    tenantId,
    type: SETTLEMENT_PDF_JOB,
    payload: { settlementId, variant },
    maxAttempts: SETTLEMENT_PDF_RETRY_MS.length + 1,
  });
}
