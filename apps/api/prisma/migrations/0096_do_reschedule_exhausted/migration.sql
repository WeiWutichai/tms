-- ST4-T12 (แก้ตาม review M1/L): DO ที่เกิดจากนัดส่งใหม่ครั้งที่เกินค่าตั้ง dispatch.maxAutoReschedules
-- ใช้เป็นเหตุรอง RESCHEDULES_EXHAUSTED ของใบสั่ง (ไม่ทับเหตุค้างของทางเข้า) และแสดงบนไทม์ไลน์เที่ยว
ALTER TABLE "delivery_order" ADD COLUMN "reschedule_exhausted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "delivery_order" ADD CONSTRAINT "delivery_order_reschedule_exhausted_check"
  CHECK (NOT "reschedule_exhausted" OR "reschedule_count" > 0);
