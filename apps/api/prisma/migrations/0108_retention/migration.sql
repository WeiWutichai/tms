-- ST9-T14 Retention (docs/04 J "Audit log 5 ปี, integration log 24 เดือน, login log 1 ปี, ไฟล์ POD 2 ปี, GPS log 90 วัน
-- — ตั้งต่อ tenant ไม่ต่ำกว่าขั้นต่ำ") · ไม่มีตารางใหม่ (ไม่ต้องเปิด RLS เพิ่ม)

-- 1) ไฟล์ที่ลบตามระยะเก็บ: แถว stored_document คงอยู่ (sha256 + metadata เป็นหลักฐานว่าเคยมี) แต่ไม่มีไฟล์แล้ว
ALTER TABLE "stored_document" ADD COLUMN "purged_at" TIMESTAMPTZ(6);
ALTER TABLE "stored_document" DROP CONSTRAINT "stored_document_status_check";
ALTER TABLE "stored_document" ADD CONSTRAINT "stored_document_status_check" CHECK ("status" IN ('PENDING', 'READY', 'PURGED'));
ALTER TABLE "stored_document" ADD CONSTRAINT "stored_document_purged_check"
  CHECK ("status" <> 'PURGED' OR ("file_key" IS NULL AND "purged_at" IS NOT NULL));

-- 2) index สำหรับ retention job
CREATE INDEX "stored_document_kind_created_at_idx" ON "stored_document"("kind", "created_at");
CREATE INDEX "vehicle_position_received_at_idx" ON "vehicle_position"("received_at");
CREATE INDEX "login_attempt_created_at_idx" ON "login_attempt"("created_at");

-- 3) audit log append-only (0007) — ช่องทางเดียวที่ลบได้คือฟังก์ชัน tms_audit_retention_purge() ด้านล่าง
--    trigger ยอม DELETE เฉพาะเมื่อ (ก) ธง tms.audit_retention_purge = on ใน transaction นี้ และ
--    (ข) current_user = เจ้าของตาราง audit_log (= เจ้าของฟังก์ชัน SECURITY DEFINER) — role แอป/platform ตั้งธงเองแล้ว DELETE ตรงไม่ได้
--    UPDATE ปฏิเสธเสมอ (เดิม 0007 เขียนว่า "job ปิด trigger ชั่วคราว" — เปลี่ยนเป็นวิธีนี้ เพราะ DISABLE TRIGGER ล็อกทั้งตารางและข้ามการตรวจทุกแถว)
CREATE OR REPLACE FUNCTION tms_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('tms.audit_retention_purge', true) = 'on'
     AND current_user = (SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'audit_log') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = 'insufficient_privilege';
END $$;

-- ลบ audit log ของ tenant ที่เก่ากว่าระยะเก็บ ทีละไม่เกิน p_limit แถว → คืนจำนวนที่ลบ
-- * ระยะเก็บอ่านจาก tenant_setting `retention.auditLogYears` เอง (ผู้เรียกส่งวันตัดเองไม่ได้) และไม่ต่ำกว่า 5 ปีเสมอ (docs/04 J)
-- * ไม่แตะเหตุการณ์ของเอกสารภาษี/นิติบุคคล/เลขเอกสาร/ค่าตั้ง และบันทึกการลบเอง (entity_type ในรายการ protected)
--   — ระยะเก็บของกลุ่มนี้เป็นของ ST9-T15 (เอกสารภาษี ≥ 5 ปี, default 7 ปี; NFR-404 "เหตุการณ์ของเอกสารภาษีเก็บเท่าตัวเอกสาร")
--   รายการเดียวกับ AUDIT_PROTECTED_ENTITY_TYPES ใน apps/api/src/modules/retention/retention-policy.ts (test ตรวจว่าตรงกัน)
-- * ลบแล้วลง audit_log 1 แถว (action retention.purged) ใน transaction เดียวกัน — ลบโดยไม่มีหลักฐานไม่ได้
CREATE OR REPLACE FUNCTION tms_audit_retention_purge(p_tenant uuid, p_limit integer) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS
$$
DECLARE
  protected text[] := ARRAY[
    'audit_log', 'retention',
    'company', 'branch', 'tenant_setting', 'document_sequence', 'document_series',
    'sales_document', 'invoice', 'tax_invoice', 'receipt', 'credit_note', 'debit_note', 'billing_note',
    'payment', 'wht_certificate', 'settlement', 'platform_invoice', 'platform_payment', 'etax_submission',
    'stored_document'
  ];
  v_years integer;
  v_raw jsonb;
  v_cutoff timestamptz;
  v_n integer;
  v_prev_tenant text := current_setting('app.tenant_id', true);
BEGIN
  IF p_tenant IS NULL OR p_limit IS NULL OR p_limit < 1 OR p_limit > 10000 THEN
    RAISE EXCEPTION 'tms_audit_retention_purge: invalid arguments' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- FORCE RLS: เจ้าของตารางก็ต้องตั้ง tenant (กรณีเจ้าของไม่ใช่ superuser ใน production)
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  SELECT value INTO v_raw FROM tenant_setting WHERE tenant_id = p_tenant AND key = 'retention.auditLogYears';
  IF v_raw IS NOT NULL AND jsonb_typeof(v_raw) = 'number' THEN
    v_years := floor((v_raw #>> '{}')::numeric)::integer;
  END IF;
  v_years := greatest(5, coalesce(v_years, 5));
  v_cutoff := now() - make_interval(years => v_years);
  PERFORM set_config('tms.audit_retention_purge', 'on', true);
  WITH d AS (
    DELETE FROM audit_log
     WHERE id IN (SELECT id FROM audit_log
                   WHERE tenant_id = p_tenant AND at < v_cutoff AND entity_type <> ALL (protected)
                   ORDER BY at LIMIT p_limit)
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_n FROM d;
  PERFORM set_config('tms.audit_retention_purge', 'off', true);
  IF v_n > 0 THEN
    INSERT INTO audit_log (id, tenant_id, actor_id, action, entity_type, entity_id, after, reason)
    VALUES (gen_random_uuid(), p_tenant, 'system:retention', 'retention.purged', 'retention', 'audit_log',
            jsonb_build_object('count', v_n, 'olderThan', v_cutoff, 'years', v_years),
            'ลบตามระยะเก็บ audit log (ST9-T14)');
  END IF;
  PERFORM set_config('app.tenant_id', coalesce(v_prev_tenant, ''), true);
  RETURN v_n;
END
$$;
REVOKE ALL ON FUNCTION tms_audit_retention_purge(uuid, integer) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_platform') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION tms_audit_retention_purge(uuid, integer) TO tms_platform';
  END IF;
END $$;
