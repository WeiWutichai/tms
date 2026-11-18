-- ST9-T14 Retention (docs/04 J "Audit log 5 ปี, integration log 24 เดือน, login log 1 ปี, ไฟล์ POD 2 ปี, GPS log 90 วัน
-- — ตั้งต่อ tenant ไม่ต่ำกว่าขั้นต่ำ") · ไม่มีตารางใหม่ (ไม่ต้องเปิด RLS เพิ่ม)

-- 1) ไฟล์หมดระยะเก็บ: แถว stored_document คงอยู่ (sha256 + metadata + file_key เป็นหลักฐาน) สถานะ PURGED ดาวน์โหลดไม่ได้
--    ลบไฟล์จริงเป็นขั้นที่ 2 (file_removed_at) ภายใต้ advisory lock ต่อ key — ดู RetentionService.removePurgedFiles
ALTER TABLE "stored_document" ADD COLUMN "purged_at" TIMESTAMPTZ(6);
ALTER TABLE "stored_document" ADD COLUMN "file_removed_at" TIMESTAMPTZ(6);
ALTER TABLE "stored_document" DROP CONSTRAINT "stored_document_status_check";
ALTER TABLE "stored_document" ADD CONSTRAINT "stored_document_status_check" CHECK ("status" IN ('PENDING', 'READY', 'PURGED'));
ALTER TABLE "stored_document" ADD CONSTRAINT "stored_document_purged_check"
  CHECK (("status" = 'PURGED') = ("purged_at" IS NOT NULL) AND ("file_removed_at" IS NULL OR "status" = 'PURGED'));

-- 2) index สำหรับ retention job (ตารางยังเล็กในเฟส 0 — ไม่ใช้ CONCURRENTLY; ตารางใหญ่ในอนาคตให้สร้างแบบ CONCURRENTLY แยก migration)
CREATE INDEX "stored_document_kind_created_at_idx" ON "stored_document"("kind", "created_at");
CREATE INDEX "stored_document_file_key_idx" ON "stored_document"("file_key");
CREATE INDEX "vehicle_position_received_at_idx" ON "vehicle_position"("received_at");
CREATE INDEX "login_attempt_created_at_idx" ON "login_attempt"("created_at");

-- 3) audit log append-only (0007) — ช่องทางเดียวที่ลบได้คือฟังก์ชัน tms_audit_retention_purge() ด้านล่าง
--    trigger ยอม DELETE เฉพาะเมื่อ (ก) ธง tms.audit_retention_purge = on ใน transaction นี้ และ
--    (ข) current_user = เจ้าของตาราง audit_log (= เจ้าของฟังก์ชัน SECURITY DEFINER) — role แอป/platform ตั้งธงเองแล้ว DELETE ตรงไม่ได้
--    อ้าง catalog แบบระบุ schema + search_path คงที่ (กันสร้าง temp view ชื่อ pg_tables มาหลอก — review ST9-T14)
--    UPDATE ปฏิเสธเสมอ (เดิม 0007 เขียนว่า "job ปิด trigger ชั่วคราว" — เปลี่ยนเป็นวิธีนี้ เพราะ DISABLE TRIGGER ล็อกทั้งตารางและข้ามการตรวจทุกแถว)
CREATE OR REPLACE FUNCTION tms_audit_append_only() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND pg_catalog.current_setting('tms.audit_retention_purge', true) = 'on'
     AND current_user = (SELECT pg_catalog.pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = 'insufficient_privilege';
END $$;

-- role platform ไม่ต้องลบ/แก้ audit_log ตรง (ฟังก์ชันด้านล่างทำในนามเจ้าของ)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_platform') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON "audit_log" FROM tms_platform';
  END IF;
END $$;

-- ลบ audit log ของ tenant ที่เก่ากว่าระยะเก็บ ทีละไม่เกิน p_limit แถว → คืนจำนวนที่ลบ
-- * ระยะเก็บอ่านจาก tenant_setting `retention.auditLogYears` เอง (ผู้เรียกส่งวันตัดเองไม่ได้) และไม่ต่ำกว่า 5 ปีเสมอ (docs/04 J)
-- * ไม่แตะเหตุการณ์ของ entity ในรายการ protected (เทียบแบบไม่สนตัวพิมพ์) — เอกสารภาษี/การเงิน และทุกอย่างที่เป็นฐานของ
--   ใบแจ้งหนี้/ใบกำกับ/การจ่ายรถร่วม/หัก ณ ที่จ่าย (ราคา, ใบสั่ง, DO, เที่ยว, ค่าใช้จ่าย, ลูกค้า/รถร่วม, นิติบุคคล/สาขา, ค่าตั้ง)
--   + บันทึกการลบเอง · ระยะเก็บกลุ่มนี้รอนักบัญชียืนยัน [OPEN] (spec/12 §3) / ST9-T15
--   รายการเดียวกับ AUDIT_PROTECTED_ENTITY_TYPES ใน apps/api/src/modules/retention/retention-policy.ts (test ตรวจว่าตรงกัน)
-- * ลบแล้วลง audit_log 1 แถว (action retention.purged) ใน transaction เดียวกัน — ลบโดยไม่มีหลักฐานไม่ได้
CREATE OR REPLACE FUNCTION tms_audit_retention_purge(p_tenant uuid, p_limit integer) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  protected text[] := ARRAY[
    'audit_log', 'retention',
    'tenant', 'tenant_setting', 'company', 'legal_entity', 'branch', 'document_sequence', 'document_series',
    'customer', 'customer_site', 'carrier', 'service_item',
    'rate_card', 'rate_card_accessorial', 'rate_card_line',
    'sales_order', 'sales_order_line', 'sales_order_charge', 'sales_order_stop', 'order_charge',
    'delivery_order', 'delivery_order_line', 'delivery_order_pod', 'do_surcharge', 'field_charge',
    'trip', 'trip_stop', 'trip_cost', 'subcon_offer', 'stop_event',
    'vehicle', 'vehicle_cost', 'depreciation',
    'sales_document', 'invoice', 'tax_invoice', 'receipt', 'credit_note', 'debit_note', 'billing_note',
    'payment', 'wht_certificate', 'settlement', 'settlement_line', 'advance', 'cod', 'expense',
    'platform_invoice', 'platform_payment', 'etax_submission',
    'stored_document'
  ];
  v_years integer;
  v_raw jsonb;
  v_cutoff timestamptz;
  v_n integer;
  v_prev_tenant text := pg_catalog.current_setting('app.tenant_id', true);
BEGIN
  IF p_tenant IS NULL OR p_limit IS NULL OR p_limit < 1 OR p_limit > 10000 THEN
    RAISE EXCEPTION 'tms_audit_retention_purge: invalid arguments' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- FORCE RLS: เจ้าของตารางก็ต้องตั้ง tenant (กรณีเจ้าของไม่ใช่ superuser ใน production)
  PERFORM pg_catalog.set_config('app.tenant_id', p_tenant::text, true);
  SELECT value INTO v_raw FROM public.tenant_setting WHERE tenant_id = p_tenant AND key = 'retention.auditLogYears';
  IF v_raw IS NOT NULL AND pg_catalog.jsonb_typeof(v_raw) = 'number' THEN
    v_years := pg_catalog.floor((v_raw #>> '{}')::numeric)::integer;
  END IF;
  v_years := greatest(5, coalesce(v_years, 5));
  v_cutoff := pg_catalog.now() - pg_catalog.make_interval(years => v_years);
  PERFORM pg_catalog.set_config('tms.audit_retention_purge', 'on', true);
  WITH d AS (
    DELETE FROM public.audit_log
     WHERE id IN (SELECT id FROM public.audit_log
                   WHERE tenant_id = p_tenant AND at < v_cutoff
                     AND pg_catalog.lower(entity_type) <> ALL (protected)
                   ORDER BY at LIMIT p_limit)
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_n FROM d;
  PERFORM pg_catalog.set_config('tms.audit_retention_purge', 'off', true);
  IF v_n > 0 THEN
    INSERT INTO public.audit_log (id, tenant_id, actor_id, action, entity_type, entity_id, after, reason)
    VALUES (pg_catalog.gen_random_uuid(), p_tenant, 'system:retention', 'retention.purged', 'retention', 'audit_log',
            pg_catalog.jsonb_build_object('count', v_n, 'olderThan', v_cutoff, 'years', v_years),
            'ลบตามระยะเก็บ audit log (ST9-T14)');
  END IF;
  PERFORM pg_catalog.set_config('app.tenant_id', coalesce(v_prev_tenant, ''), true);
  RETURN v_n;
END
$$;
REVOKE ALL ON FUNCTION tms_audit_retention_purge(uuid, integer) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_platform') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION tms_audit_retention_purge(uuid, integer) TO tms_platform';
  END IF;
END $$;
