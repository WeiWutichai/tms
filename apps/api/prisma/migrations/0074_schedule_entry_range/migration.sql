-- ST3-T19 (QA L4): ช่วงยาวสุด 366 วัน "รวมสองปลาย" = ends_on - starts_on <= 365 (0073 ยอม 366 = 367 วัน)
-- ไม่ลบ/ไม่แก้แถวเดิม: ใช้กับรายการที่ยังไม่ยกเลิกเท่านั้น (ยกเลิกแถวที่ยาวเกินได้เสมอ) · เพิ่มแบบ NOT VALID แล้วตรวจย้อนหลัง
-- เฉพาะเมื่อไม่มีแถวที่ยังไม่ยกเลิกเกินช่วง (ฐานที่มีแถวเก่าเกิน: ยกเลิกผ่าน API ก่อน แล้ว VALIDATE ภายหลังได้)
ALTER TABLE "schedule_entry" DROP CONSTRAINT "schedule_entry_range";
ALTER TABLE "schedule_entry" ADD CONSTRAINT "schedule_entry_range" CHECK (
  "ends_on" >= "starts_on" AND ("cancelled_at" IS NOT NULL OR "ends_on" - "starts_on" <= 365)) NOT VALID;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "schedule_entry"
    WHERE "ends_on" < "starts_on" OR ("cancelled_at" IS NULL AND "ends_on" - "starts_on" > 365)
  ) THEN
    ALTER TABLE "schedule_entry" VALIDATE CONSTRAINT "schedule_entry_range";
  END IF;
END $$;
