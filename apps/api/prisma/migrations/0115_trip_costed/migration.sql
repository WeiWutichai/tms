-- ST6-T01 ปิดต้นทุนเที่ยว (COMPLETED → COSTED — docs/01 §4.2): เวลา/ผู้ปิดต้นทุน
-- ไม่มี CHECK คู่กับสถานะ (แถวทดสอบเดิมตั้ง COSTED ตรง) — บริการเขียนคู่กันเสมอ
ALTER TABLE "trip"
ADD COLUMN     "costed_at" TIMESTAMPTZ(6),
ADD COLUMN     "costed_by" TEXT;
