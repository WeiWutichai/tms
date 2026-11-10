-- ST1-T10 (review): ลบผู้ใช้ต้อง anonymize อีเมลในประวัติ login ได้ — เปิดสิทธิ์แก้เฉพาะคอลัมน์ email (แถวยังห้ามแก้อย่างอื่น)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_platform') THEN
    EXECUTE 'GRANT UPDATE (email) ON login_attempt TO tms_platform';
  END IF;
END $$;
