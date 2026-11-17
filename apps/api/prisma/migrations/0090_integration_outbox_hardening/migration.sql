-- ST7-T03 แก้ตาม review (M2, L7)
-- (1) สิทธิ์ของ role แอป: คำสั่ง outbox ถูกเขียนสถานะโดย worker (role platform) เท่านั้น — แอปสร้างได้ (trigger บน domain_event
--     รันด้วยสิทธิ์ของผู้เขียน event + OutboxService.enqueueCommand) และอ่านได้ แต่แก้/ลบไม่ได้ · subscription ไม่มี hard delete
--     (ปิดด้วย active = false) · role platform (worker/admin) ไม่เปลี่ยน
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON integration_outbox FROM tms_app';
    EXECUTE 'REVOKE DELETE ON integration_subscription FROM tms_app';
  END IF;
END $$;

-- (2) index (tenant_id, serialize_key, seq) ซ้ำกับ partial index ของคิวที่ยังไม่จบ (claim ใช้เฉพาะแถวที่ยังไม่จบ)
DROP INDEX IF EXISTS "integration_outbox_tenant_id_serialize_key_seq_idx";
