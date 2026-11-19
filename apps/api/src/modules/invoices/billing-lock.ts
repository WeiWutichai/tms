import { isBillable, type BillingStatus } from '@tms/domain';
import { ProblemException } from '../../common/problem';

/**
 * DO ที่อยู่ในใบแจ้งหนี้ที่ active (IN_DRAFT / INVOICED) แก้ราคา/บรรทัดรายได้/ค่าใช้จ่ายหน้างานฝั่งขายไม่ได้
 * (docs/04 F4 IN_DRAFT "แก้ราคาใน order ไม่ได้ (แก้ที่ draft)", INVOICED "ล็อกทุกอย่าง"; spec/05 BIL-024) → 409 `invalid_state_transition`
 */
export function assertNotInInvoice(
  d: { billingStatus: string; status?: string },
  field = 'deliveryOrderId',
): void {
  if (isBillable(d.billingStatus as BillingStatus)) return;
  throw new ProblemException(
    'invalid_state_transition',
    undefined,
    [{ field, code: 'do_in_invoice', message: `delivery order is ${d.billingStatus}` }],
    { billingStatus: d.billingStatus, ...(d.status ? { doStatus: d.status } : {}) },
  );
}
