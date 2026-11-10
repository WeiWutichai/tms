-- สิทธิ์ของ role แอป (role สร้างโดย infra: infra/postgres/init/01-roles.sql หรือ IaC)
-- default privileges เป็นของแต่ละฐานข้อมูล จึงต้องอยู่ใน migration ไม่ใช่แค่ใน init script
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO tms_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tms_app';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO tms_app';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_platform') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA public TO tms_platform';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tms_platform';
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO tms_platform';
  END IF;
END $$;

-- ตารางที่สร้างใน 0001 ก่อนมี default privileges ในฐานข้อมูลนี้
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tms_app';
    EXECUTE 'REVOKE UPDATE, DELETE ON doc_status_history, domain_event FROM tms_app';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_platform') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tms_platform';
  END IF;
END $$;
