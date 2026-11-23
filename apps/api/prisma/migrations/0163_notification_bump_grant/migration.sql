-- D-81 · D68-57 (review M1): รวมกลุ่มแจ้ง "เอกสารไม่ถูกส่งเข้าระบบบัญชี" ที่ยังไม่อ่าน (เพิ่มจำนวน + ตัวอย่างเลข) ใน transaction ของ tenant (RLS)
-- role แอปแก้ได้เพิ่มเฉพาะข้อความ (title, body) และค่าที่ใช้ render (payload) — ผู้รับ / tenant / ช่องทาง / template / ลิงก์ ยังแก้ไม่ได้
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'GRANT UPDATE (title, body, payload) ON notification TO tms_app';
  END IF;
END $$;
