-- ST8-T03: เวลาที่ healthCheck เริ่มล้มแบบ TRANSIENT ต่อเนื่อง — ล้ม ≥ 30 นาที → ERROR (spec/07 §1) · ผ่าน = ล้างค่า
-- ตาราง connector มี tenant_id + RLS อยู่แล้ว (ไม่มีตารางใหม่)
ALTER TABLE "connector" ADD COLUMN "health_failing_since" TIMESTAMPTZ(6);
