-- แก้ test ที่ล้มบน main (24 พ.ย. 2569): 0163 ให้ tms_app UPDATE (title, body, payload) ตรง ๆ ทำให้ข้อ ST1-T23
-- "role แอปแก้เนื้อหาแจ้งเตือนไม่ได้ (แก้ได้แค่สถานะการอ่าน)" ไม่จริงอีกต่อไป → ถอนสิทธิ์คอลัมน์คืน
-- แล้วให้การรวมกลุ่มแจ้งเตือน (D-81 · D68-57 review M1 / D68-61) ทำผ่านฟังก์ชัน SECURITY DEFINER ที่แคบ:
--   tenant = ของ transaction ผู้เรียก (app.tenant_id; RLS แบบ FORCE ยังบังคับ) · เฉพาะแถว in_app ที่ยังไม่อ่าน
--   · เฉพาะ template ที่รวมกลุ่มได้ · แก้ได้เฉพาะ title/body/payload (+ updated_at)
-- ย้อนกลับ: DROP FUNCTION tms_notification_regroup(uuid, text, text, jsonb); GRANT UPDATE (title, body, payload) ON notification TO tms_app;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE UPDATE (title, body, payload) ON notification FROM tms_app';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION tms_notification_regroup(p_id uuid, p_title text, p_body text, p_payload jsonb) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  v_tenant uuid := NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid;
  v_n integer;
BEGIN
  IF v_tenant IS NULL OR p_id IS NULL OR p_title IS NULL OR p_body IS NULL OR p_payload IS NULL THEN
    RAISE EXCEPTION 'tms_notification_regroup: tenant, id, title, body and payload are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE public.notification
     SET title = p_title, body = p_body, payload = p_payload, updated_at = pg_catalog.now()
   WHERE id = p_id
     AND tenant_id = v_tenant
     AND channel = 'in_app'
     AND read_at IS NULL
     AND template_code IN ('connector.document_not_sent', 'reconcile.document_mismatch_found');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END
$$;
REVOKE ALL ON FUNCTION tms_notification_regroup(uuid, text, text, jsonb) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION tms_notification_regroup(uuid, text, text, jsonb) TO tms_app';
  END IF;
END $$;
