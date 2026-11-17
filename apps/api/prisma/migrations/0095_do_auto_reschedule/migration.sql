-- ST4-T12 Undelivered-retain + auto-reschedule (docs/04 E2; docs/01 §4.3 FAILED → redeliver: DO เดิม CANCELLED + DO ใหม่อ้าง redelivery_of)
-- ตัวนับครั้งที่นัดส่งใหม่อัตโนมัติต่อสายงาน (ใบใหม่ = ใบเดิม + 1) — เกินค่าตั้ง dispatch.maxAutoReschedules → SO ค้าง RESCHEDULES_EXHAUSTED

-- AlterTable
ALTER TABLE "delivery_order" ADD COLUMN "reschedule_count" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "delivery_order" ADD CONSTRAINT "delivery_order_reschedule_count_check"
  CHECK ("reschedule_count" >= 0 AND ("reschedule_count" = 0 OR "redelivery_of_id" IS NOT NULL));

-- หา DO ที่นัดส่งใหม่จากใบเดิม (ไทม์ไลน์เที่ยว: จุดที่ไม่สำเร็จ → DO ใบใหม่)
CREATE INDEX "delivery_order_tenant_id_redelivery_of_id_idx" ON "delivery_order"("tenant_id", "redelivery_of_id");
