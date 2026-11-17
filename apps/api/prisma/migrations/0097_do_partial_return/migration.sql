-- ST4-T11 ตีกลับบางส่วน/ทั้งหมด (docs/04 E2; docs/01 §4.3 FAILED → redeliver / RETURNED)
-- ส่งบางส่วนแล้วลูกค้าปฏิเสธรับ: ใบเดิมคงส่งแล้ว (ยอดตามส่งจริง) + ใบส่งซ้ำอ้าง redelivery_of + rejected_from (ไม่นับจัดสรร SO)
-- หรือคืนคลัง (returned_qty ต่อบรรทัด) · ส่งไม่สำเร็จทั้งใบ: ส่งซ้ำ = ใบเดิม CANCELLED (เหมือน ST4-T12) / คืนคลัง = RETURNED

-- AlterTable
ALTER TABLE "delivery_order" ADD COLUMN "redelivery_manual" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "rejected_from_id" UUID;

-- AlterTable
ALTER TABLE "delivery_order_line" ADD COLUMN "returned_qty" DECIMAL(14,3) NOT NULL DEFAULT 0;

-- AddForeignKey
ALTER TABLE "delivery_order" ADD CONSTRAINT "delivery_order_rejected_from_id_fkey" FOREIGN KEY ("rejected_from_id") REFERENCES "delivery_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "delivery_order_tenant_id_rejected_from_id_idx" ON "delivery_order"("tenant_id", "rejected_from_id");

-- ใบส่งซ้ำ (มือ/ของที่ตีกลับ) ต้องอ้างใบที่ส่งซ้ำ
ALTER TABLE "delivery_order"
  ADD CONSTRAINT "delivery_order_redelivery_manual_ref"
    CHECK (NOT "redelivery_manual" OR "redelivery_of_id" IS NOT NULL),
  ADD CONSTRAINT "delivery_order_rejected_from_ref"
    CHECK ("rejected_from_id" IS NULL OR "redelivery_of_id" IS NOT NULL);

-- คืนคลังได้ไม่เกินที่ปฏิเสธรับ (ด่านสุดท้ายหลัง service ตรวจ — แก้หลักฐานส่งให้ปฏิเสธน้อยกว่าที่จัดการแล้วไม่ได้)
ALTER TABLE "delivery_order_line"
  ADD CONSTRAINT "delivery_order_line_returned_qty_range"
    CHECK ("returned_qty" >= 0 AND "returned_qty" <= COALESCE("reject_qty", 0));
