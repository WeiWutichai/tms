-- ST1-T03 (review): role แอปเขียนอีเมลลง outbox ได้อย่างเดียว — อ่านเนื้ออีเมล (มี token ลิงก์ เช่น คำเชิญ T07) ไม่ได้
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE ALL ON email_outbox FROM tms_app';
    EXECUTE 'GRANT INSERT ON email_outbox TO tms_app';
  END IF;
END $$;
