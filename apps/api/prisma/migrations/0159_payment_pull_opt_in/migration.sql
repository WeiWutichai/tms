-- ST7-T21 (แก้ตาม review) Payment status pull เป็น **opt-in**
-- (1) `fetchPaymentStatus` ไม่เปิดเป็นค่าเริ่มต้นอีกต่อไป (เปิดเอง + เหตุผล — ConnectorsService) → ปิดให้ connector ที่ได้ค่าเริ่มต้นเดิมมา
--     (ก่อนหน้านี้ capability นี้ไม่มีผลใด ๆ — ไม่มีรอบดึง; ปิดแล้วพฤติกรรมเท่าเดิม = รับชำระบันทึกมือ)
-- (2) `external_mapping.payment_checked_at` = เวลาถามสถานะรับชำระล่าสุดต่อเอกสาร (เรียงรอบดึง — ใบที่ถามนานสุดก่อน)
-- ย้อนกลับ: ALTER TABLE external_mapping DROP COLUMN payment_checked_at; (ข้อ 1 ย้อนด้วยการเปิด capability เองทีละ connector)

ALTER TABLE "external_mapping" ADD COLUMN "payment_checked_at" TIMESTAMPTZ(6);

-- connector มี FORCE RLS: ผู้รัน migration ที่ไม่ใช่ superuser/BYPASSRLS จะ UPDATE ได้ 0 แถวแบบเงียบ → ปิด row_security
-- ตามแบบ migration อื่น (0116 ฯลฯ) — ถ้าไม่มีสิทธิ์จะ error แทนการข้าม
SET row_security = off;

UPDATE "connector"
   SET "capabilities_enabled" = array_remove("capabilities_enabled", 'fetchPaymentStatus'),
       "version" = "version" + 1,
       "updated_at" = now()
 WHERE 'fetchPaymentStatus' = ANY("capabilities_enabled");

RESET row_security;
