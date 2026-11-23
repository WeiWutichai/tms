-- ST8-T12 หน้า MISMATCH: ปิดรายการที่ข้อมูลไม่ตรงกับระบบบัญชีได้ 3 ทาง (docs/01 §6.5) — บันทึกคน + เหตุผลทุกทาง (audit ด้วย)
-- (1) แก้ที่ TMS: D-54 ระหว่างรอ = ยกเลิกใบแล้วออกใหม่ (ST5-T10) → resolution FIXED_IN_TMS
-- (2) ส่งทับระบบบัญชีด้วยค่า TMS: ขออนุมัติ (overwrite_status REQUESTED) → ผู้อนุมัติ (≠ ผู้ขอ) อนุมัติ → คำสั่ง REPLACE_DOCUMENT
--     (overwrite_command_id) · รอบเทียบถัดไปตรงกัน = ปิดเอง (resolution ERP_OVERWRITTEN)
-- (3) ยอมรับความต่าง: ช่อง acknowledged_* เดิม (ST7-T21)
-- ตาราง reconcile_result มี RLS อยู่แล้ว (ไม่มีตารางใหม่) · ไม่มี hard delete
ALTER TABLE "reconcile_result"
  ADD COLUMN "resolved_by" TEXT,
  ADD COLUMN "resolution" TEXT,
  ADD COLUMN "resolution_reason" TEXT,
  ADD COLUMN "overwrite_status" TEXT,
  ADD COLUMN "overwrite_requested_by" TEXT,
  ADD COLUMN "overwrite_requested_at" TIMESTAMPTZ(6),
  ADD COLUMN "overwrite_reason" TEXT,
  ADD COLUMN "overwrite_decided_by" TEXT,
  ADD COLUMN "overwrite_decided_at" TIMESTAMPTZ(6),
  ADD COLUMN "overwrite_decision_reason" TEXT,
  ADD COLUMN "overwrite_command_id" UUID;

ALTER TABLE "reconcile_result"
  ADD CONSTRAINT "reconcile_result_resolution_check"
    CHECK ("resolution" IS NULL OR "resolution" IN ('FIXED_IN_TMS', 'ERP_OVERWRITTEN', 'NEXT_RUN_MATCHED')),
  ADD CONSTRAINT "reconcile_result_overwrite_status_check"
    CHECK ("overwrite_status" IS NULL OR "overwrite_status" IN ('REQUESTED', 'APPROVED', 'REJECTED'));

-- แอปแก้ได้เฉพาะคอลัมน์การปิด/ยอมรับ/คำขอส่งทับ (ตัวผลเทียบ + snapshot ยังแก้ไม่ได้ — แนวเดียวกับ 0158)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'GRANT UPDATE (resolved_by, resolution, resolution_reason, overwrite_status, overwrite_requested_by, overwrite_requested_at, overwrite_reason, overwrite_decided_by, overwrite_decided_at, overwrite_decision_reason, overwrite_command_id) ON reconcile_result TO tms_app';
  END IF;
END $$;
