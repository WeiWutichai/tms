import type { Tx } from '../../db/db.service';

/**
 * กลับรายการบรรทัดค่าจ้างรถร่วม (ST3-T22; ใช้ต่อใน ST3-T23/T24/T25) — เฉพาะบรรทัด CARRIER_FEE ที่**เกิดจากการจ้าง**
 * (`subcon_offer_id` ไม่ว่าง — ไม่แตะบรรทัดที่ ST6 จะเพิ่มเอง) ของการจ้างที่ปิดแล้ว (ไม่ใช่ OFFERED/ACCEPTED),
 * ยอดบวก, ยังไม่จ่าย (`settlement_line_id` ว่าง) และยังไม่ถูกกลับ → บรรทัดยอดติดลบอ้าง `reversal_of_id`
 * (ไม่ลบ/ไม่แก้ยอดเดิม · unique `reversal_of_id` กันกลับซ้ำแม้เรียกพร้อมกัน) · คืนจำนวนบรรทัดที่กลับ
 */
export async function reverseCarrierFees(
  tx: Tx,
  tripId: string,
  actor: string | null,
  description: string,
): Promise<number> {
  const rows = await tx.tripCost.findMany({
    where: {
      tripId,
      costType: 'CARRIER_FEE',
      amount: { gt: 0 },
      settlementLineId: null,
      reversedBy: null,
      subconOfferId: { not: null },
      subconOffer: { status: { notIn: ['OFFERED', 'ACCEPTED'] } },
    },
    orderBy: { createdAt: 'asc' },
  });
  for (const r of rows)
    await tx.tripCost.create({
      data: {
        tenantId: r.tenantId,
        tripId,
        costType: 'CARRIER_FEE',
        amount: r.amount.neg(),
        vatAmount: r.vatAmount.neg(),
        source: r.source,
        carrierId: r.carrierId,
        serviceItemId: r.serviceItemId,
        vatType: r.vatType,
        whtRate: r.whtRate,
        description,
        subconOfferId: r.subconOfferId,
        sourceType: r.sourceType,
        sourceId: r.sourceId,
        reversalOfId: r.id,
        createdBy: actor,
      },
    });
  return rows.length;
}
