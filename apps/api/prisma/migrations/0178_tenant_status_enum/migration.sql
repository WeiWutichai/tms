-- P1-ST1-T03 (R-10, spec/01 PLT-010): สถานะ tenant 7 ค่า
-- pending_verification · trialing · active · past_due · read_only · suspended · cancelled
-- TRIAL → TRIALING เปลี่ยนชื่อค่าในที่ (แถวเดิมตามไปเอง — ไม่ต้อง backfill; D-76 ยังไม่มี tenant จริง)
-- ADD VALUE ใช้ในธุรกรรมเดียวกันไม่ได้ → ค่าใหม่ถูกใช้ตั้งแต่ 0179
ALTER TYPE "tenant_status" RENAME VALUE 'TRIAL' TO 'TRIALING';
ALTER TYPE "tenant_status" ADD VALUE IF NOT EXISTS 'PENDING_VERIFICATION' BEFORE 'TRIALING';
ALTER TYPE "tenant_status" ADD VALUE IF NOT EXISTS 'PAST_DUE' AFTER 'ACTIVE';
ALTER TYPE "tenant_status" ADD VALUE IF NOT EXISTS 'READ_ONLY' AFTER 'PAST_DUE';
ALTER TABLE "tenant" ALTER COLUMN "status" SET DEFAULT 'TRIALING';
