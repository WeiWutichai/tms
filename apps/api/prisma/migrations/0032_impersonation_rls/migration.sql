-- ST1-T24: impersonation_session มี tenant_id → เปิด RLS ตามกติกา (role แอปถูก revoke แล้ว; ใช้ผ่าน role platform)
SELECT tms_enable_tenant_rls('impersonation_session');
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE ALL ON impersonation_session FROM tms_app';
  END IF;
END $$;
