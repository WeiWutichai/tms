import { ProblemException } from '../../common/problem';
import type { Tx } from '../../db/db.service';

/**
 * ห้ามออกใบแจ้งหนี้ให้ลูกค้าตัวอย่าง (P1-ST2-T09) — 422 field `customerId` code `sample_customer`
 * (review M4 — conservative: ข้อมูลสมมติไม่ควรมีเลขเอกสารจริง) [DECISION — lead 28 พ.ย. 2569, ย้อนได้]
 */
export async function assertNotSampleCustomer(tx: Tx, customerId: string): Promise<void> {
  const hit = await tx.sampleRecord.findFirst({
    where: { entityType: 'customer', entityId: customerId },
    select: { id: true },
  });
  if (hit)
    throw new ProblemException('validation_failed', undefined, [
      {
        field: 'customerId',
        code: 'sample_customer',
        message: 'sample-data customer — documents cannot be issued',
      },
    ]);
}
