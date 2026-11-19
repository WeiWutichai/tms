-- ST5-T04 คิว "พร้อมวางบิล" (docs/04 F3, F4 RELEASED; spec/05 §1 requirePodForBilling, §2)
-- (1) ค่าตั้งลูกค้า "ไม่มี POD ไม่วางบิล" — ค่าเริ่มต้นเปิด (spec/05 ค่าเริ่มต้นเข้มสุด; เทียบ carrier.require_pod_to_pay)
--     ปิด = DO ที่ส่งแล้วแต่หลักฐานส่งยังไม่ครบตาม checklist ขึ้นคิวได้ (แสดงว่า POD ไม่ครบ)
-- (2) ขั้นส่งบัญชี (RELEASED — docs/04 F4) เก็บเป็นเวลา + ผู้ทำบน DO (สถานะ DO คงตาม docs/01 §4.3 — UNBILLED)
--     lifecycle/ย้อนกลับเต็มรูป = ST5-T06 · ตารางเดิมมี RLS แล้ว (ไม่มีตารางใหม่)

ALTER TABLE "customer" ADD COLUMN "require_pod_to_bill" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "delivery_order" ADD COLUMN "released_at" TIMESTAMPTZ(6);
ALTER TABLE "delivery_order" ADD COLUMN "released_by" TEXT;
ALTER TABLE "delivery_order" ADD CONSTRAINT "delivery_order_released_check"
  CHECK (("released_at" IS NULL) = ("released_by" IS NULL));
