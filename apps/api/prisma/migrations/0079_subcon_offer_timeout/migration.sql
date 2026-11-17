-- ST3-T24 หมดเวลาข้อเสนองานรถร่วม (docs/04 D3 "ไม่ตอบใน N ชม. → แจ้งเตือน + ปุ่มส่งรายถัดไป"; docs/01 §4.2
-- "OFFERED → PLANNING : ปฏิเสธ/หมดอายุ → SO กลับ ON_HOLD(CARRIER_REJECTED)"; spec/03 PLN-154)
-- response_due_at = เวลาเสนอ + N ชม. (ค่าตั้งองค์กร ณ ตอนจ้าง) · timeout_notified_at = แจ้งผู้จัดรถแล้ว (ครั้งเดียวต่อข้อเสนอ)

ALTER TABLE "subcon_offer"
  ADD COLUMN "response_due_at" TIMESTAMPTZ(6),
  ADD COLUMN "timeout_notified_at" TIMESTAMPTZ(6);

-- ข้อเสนอเดิม: N = ค่าเริ่มต้น 2 ชม.
UPDATE "subcon_offer" SET "response_due_at" = "offered_at" + interval '2 hours' WHERE "response_due_at" IS NULL;

-- job ตรวจหมดเวลา (ทุก 1 นาที — PLN-154) อ่านเฉพาะข้อเสนอที่รอตอบ
CREATE INDEX IF NOT EXISTS "subcon_offer_open_due_idx" ON "subcon_offer"("response_due_at", "expires_at") WHERE "status" = 'OFFERED';

SELECT tms_enable_tenant_rls('subcon_offer');
