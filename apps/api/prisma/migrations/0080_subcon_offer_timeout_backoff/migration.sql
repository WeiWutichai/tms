-- ST3-T24 (review L2): backoff ของ job หมดเวลาข้อเสนองาน — แถวที่ปิด/แจ้งไม่สำเร็จนับครั้ง (timeout_attempts)
-- และเลื่อนรอบถัดไป (timeout_next_at) · ตัวตั้งเวลาไม่สร้าง job ให้แถวที่ยังไม่ถึงรอบ · ครบ 5 ครั้ง log ระดับ error

ALTER TABLE "subcon_offer"
  ADD COLUMN "timeout_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "timeout_next_at" TIMESTAMPTZ(6);

ALTER TABLE "subcon_offer" ADD CONSTRAINT "subcon_offer_timeout_attempts" CHECK ("timeout_attempts" >= 0);

SELECT tms_enable_tenant_rls('subcon_offer');
