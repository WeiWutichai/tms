-- ST1-T21 (review): ขั้นที่ผู้ใช้ยืนยันค่าเริ่มต้นแล้ว




ALTER TABLE "setup_checklist_state" ADD COLUMN     "reviewed_steps" TEXT[] DEFAULT ARRAY[]::TEXT[];

