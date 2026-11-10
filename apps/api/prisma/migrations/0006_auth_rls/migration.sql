-- ตาราง auth มี tenant_id → เปิด RLS + FORCE ตามกติกา "ทุกตารางที่มี tenant_id" (กันซ้อนชั้นแม้ tms_app ไม่มีสิทธิ์อยู่แล้ว)
-- tms_platform (BYPASSRLS) ยังใช้งานได้ตามปกติ
SELECT tms_enable_tenant_rls('login_attempt');
SELECT tms_enable_tenant_rls('auth_code');
SELECT tms_enable_tenant_rls('refresh_token');
