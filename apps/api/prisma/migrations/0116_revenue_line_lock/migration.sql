-- ST5-T01 แก้ตาม review: ล็อกบรรทัดรายได้ปลดตรงไม่ได้ · ใบสั่งยกเลิก = บรรทัด VOIDED · qty 0 ได้ตามแหล่ง
-- (1) trigger: แถวที่ล็อกแล้ว — เนื้อหาเปลี่ยนไม่ได้เลย · คอลัมน์ล็อกเปลี่ยน (ปลด/ย้ายเอกสาร) ได้เฉพาะในฟังก์ชัน
--     tms_revenue_line_unlock() (ธง tms.revenue_line_unlock = on ใน transaction + current_user = เจ้าของตาราง — แบบเดียวกับ
--     tms_audit_retention_purge ของ 0108) · ล็อกครั้งแรก (NULL → ค่า) ทำได้ตามปกติ (ST5-T09)
CREATE OR REPLACE FUNCTION tms_revenue_line_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  skip text[] := ARRAY['locked_at', 'locked_document_id', 'updated_at', 'version'];
  unlocking boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.locked_at IS NOT NULL THEN
      RAISE EXCEPTION 'revenue_line % is locked (issued document) — cannot delete', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'revenue_line_locked';
    END IF;
    IF OLD.is_user_added THEN
      RAISE EXCEPTION 'revenue_line % was added by a user — void it instead of deleting', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'revenue_line_user_added';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.locked_at IS NULL THEN
    RETURN NEW;
  END IF;
  IF (pg_catalog.to_jsonb(NEW) - skip) IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - skip) THEN
    RAISE EXCEPTION 'revenue_line % is locked (issued document) — content cannot change', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'revenue_line_locked';
  END IF;
  IF NEW.locked_at IS DISTINCT FROM OLD.locked_at OR NEW.locked_document_id IS DISTINCT FROM OLD.locked_document_id THEN
    unlocking := coalesce(pg_catalog.current_setting('tms.revenue_line_unlock', true), '') = 'on'
      AND current_user = (SELECT pg_catalog.pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID);
    IF unlocking IS NOT TRUE THEN
      RAISE EXCEPTION 'revenue_line % is locked — unlock only via tms_revenue_line_unlock()', OLD.id
        USING ERRCODE = 'insufficient_privilege', CONSTRAINT = 'revenue_line_locked';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- (2) ปลดล็อกบรรทัดของเอกสารหนึ่งใบ (ทางของการยกเลิกใบแจ้งหนี้ ST5-T10) → คืนจำนวนแถว
--     tenant = ของ transaction ผู้เรียก (app.tenant_id) · เหตุผล ≥ 10 · ลง audit_log ต่อใบสั่ง ใน transaction เดียวกัน
CREATE OR REPLACE FUNCTION tms_revenue_line_unlock(p_document uuid, p_actor text, p_reason text) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  v_tenant uuid := NULLIF(pg_catalog.current_setting('app.tenant_id', true), '')::uuid;
  v_n integer;
BEGIN
  IF v_tenant IS NULL OR p_document IS NULL OR p_reason IS NULL OR pg_catalog.length(pg_catalog.btrim(p_reason)) < 10 THEN
    RAISE EXCEPTION 'tms_revenue_line_unlock: tenant, document and reason (>= 10 chars) are required'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM pg_catalog.set_config('tms.revenue_line_unlock', 'on', true);
  WITH u AS (
    UPDATE public.revenue_line
       SET locked_at = NULL, locked_document_id = NULL, version = version + 1, updated_at = pg_catalog.now()
     WHERE tenant_id = v_tenant AND locked_document_id = p_document
    RETURNING sales_order_id, id
  ), a AS (
    INSERT INTO public.audit_log (id, tenant_id, actor_id, action, entity_type, entity_id, before, after, reason)
    SELECT pg_catalog.gen_random_uuid(), v_tenant, p_actor, 'sales_order.revenue_lines_unlocked', 'sales_order',
           u.sales_order_id::text,
           pg_catalog.jsonb_build_object('lockedDocumentId', p_document),
           pg_catalog.jsonb_build_object('lockedDocumentId', NULL, 'count', pg_catalog.count(*)),
           p_reason
      FROM u GROUP BY u.sales_order_id
    RETURNING 1
  )
  SELECT (SELECT pg_catalog.count(*) FROM u)::integer INTO v_n;
  PERFORM pg_catalog.set_config('tms.revenue_line_unlock', 'off', true);
  RETURN v_n;
END
$$;
REVOKE ALL ON FUNCTION tms_revenue_line_unlock(uuid, text, text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION tms_revenue_line_unlock(uuid, text, text) TO tms_app';
  END IF;
END $$;

-- (3) ยกเลิกได้ทั้งบรรทัดระบบ (ใบสั่งถูกยกเลิก) และบรรทัดที่คนเพิ่ม — ต้องมีผู้ยกเลิก เวลา เหตุผล ≥ 10
ALTER TABLE "revenue_line" DROP CONSTRAINT "revenue_line_void_check";
ALTER TABLE "revenue_line" ADD CONSTRAINT "revenue_line_void_check" CHECK (
  "status" = 'ACTIVE'
  OR ("voided_at" IS NOT NULL AND "voided_by" IS NOT NULL AND length(btrim("void_reason")) >= 10));

-- (4) qty 0 ได้เหมือนแหล่ง (sales_order_charge / do_surcharge) — กัน backfill/rebuild ล้ม
ALTER TABLE "revenue_line" DROP CONSTRAINT "revenue_line_amount_check";
ALTER TABLE "revenue_line" ADD CONSTRAINT "revenue_line_amount_check" CHECK ("qty" >= 0 AND "unit_price" >= 0 AND "amount" >= 0);

-- (5) แหล่งเดียว = บรรทัดที่ยังใช้บรรทัดเดียว (บรรทัด VOIDED เก็บเป็นประวัติ)
DROP INDEX "revenue_line_source_key";
CREATE UNIQUE INDEX "revenue_line_source_key" ON "revenue_line"("tenant_id", "source_type", "source_id")
  WHERE "source_id" IS NOT NULL AND "status" = 'ACTIVE';

-- (6) ข้อมูลเดิม: ใบสั่งที่ยกเลิกแล้ว → บรรทัดที่ยังใช้และยังไม่ล็อกเป็น VOIDED (ไม่ลบ)
SET row_security = off;
UPDATE "revenue_line" l
   SET "status" = 'VOIDED', "voided_at" = now(), "voided_by" = 'system:migration',
       "void_reason" = 'ใบสั่งถูกยกเลิกก่อนมีบรรทัดรายได้ (migration 0116)', "version" = l."version" + 1
  FROM "sales_order" s
 WHERE s."id" = l."sales_order_id" AND s."status" = 'CANCELLED' AND l."status" = 'ACTIVE' AND l."locked_at" IS NULL;
RESET row_security;
