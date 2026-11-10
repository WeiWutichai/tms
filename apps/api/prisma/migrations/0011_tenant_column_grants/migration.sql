-- review T17: แอปแก้แถว tenant ได้เฉพาะคอลัมน์ที่ค่าตั้งองค์กรใช้ (ชื่อ, รูปแบบปี) — สถานะ/แพ็กเกจแก้ได้จาก platform เท่านั้น
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE UPDATE ON tenant FROM tms_app';
    EXECUTE 'GRANT UPDATE (name, year_style, updated_at) ON tenant TO tms_app';
  END IF;
END $$;
