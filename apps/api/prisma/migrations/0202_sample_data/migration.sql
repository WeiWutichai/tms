-- P1-ST2-T09: ข้อมูลตัวอย่างสำหรับ trial (docs/02 §2 "มีข้อมูลตัวอย่างบริษัทขนส่งไทยให้ลองทันที" · plan/01 ผู้สมัคร #30)
-- (1) sample_record = ธง "ข้อมูลตัวอย่าง" ต่อแถว (customer / customer_site / carrier / vehicle / rate_card / sales_order)
--     แอปเพิ่มแถวได้ตอนใส่ข้อมูลตัวอย่างเท่านั้น — แก้/ลบตรงไม่ได้ (ลบผ่าน tms_sample_data_purge เท่านั้น)
-- (2) tms_sample_data_purge(): ลบจริงเฉพาะแถวที่มีธงของ tenant ปัจจุบัน และยังไม่ถูกอ้างอิงจากข้อมูลจริง
--     ตารางเหล่านี้ role แอปลบตรงไม่ได้ (MD-004) — ฟังก์ชันนี้เป็นทางเดียว ·
--     แถวที่ถูกใช้ต่อแล้ว (เช่น SO ตัวอย่างที่สร้าง DO / ออกใบแจ้งหนี้ไปแล้ว, ลูกค้าตัวอย่างที่ใบสั่งจริงอ้างถึง) ไม่ลบ คงธงไว้
--     และคืนเหตุผลให้ผู้ใช้เห็น [DECISION — lead 28 พ.ย. 2569, ย้อนได้ — spec/12 §3]
-- (3) รถ active: เที่ยวที่ใช้รถตัวอย่างหรือรถร่วมตัวอย่างไม่ถูกนับ (tms_trip_is_sample) — แทน tms_active_vehicle_recount ของ 0190

CREATE TABLE "sample_record" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "entity_type" VARCHAR(24) NOT NULL,
    "entity_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sample_record_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sample_record_entity_type_check" CHECK ("entity_type" IN
      ('customer', 'customer_site', 'carrier', 'vehicle', 'rate_card', 'sales_order'))
);

CREATE UNIQUE INDEX "sample_record_tenant_id_entity_type_entity_id_key" ON "sample_record"("tenant_id", "entity_type", "entity_id");

ALTER TABLE "sample_record" ADD CONSTRAINT "sample_record_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE;

-- เที่ยวนี้ใช้รถ/รถร่วมตัวอย่างไหม (นิยามเดียว — trigger นับรถ active และ API จำนวนเที่ยว)
CREATE OR REPLACE FUNCTION tms_trip_is_sample(p_tenant uuid, p_vehicle uuid, p_carrier uuid) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE AS
$$
  SELECT (p_vehicle IS NOT NULL OR p_carrier IS NOT NULL) AND EXISTS (
    SELECT 1 FROM sample_record s
     WHERE s.tenant_id = p_tenant
       AND ((s.entity_type = 'vehicle' AND s.entity_id = p_vehicle)
         OR (s.entity_type = 'carrier' AND s.entity_id = p_carrier)))
$$;

-- นับใหม่ 1 ทะเบียน × 1 เดือน (เหมือน 0190 ทุกอย่าง + ไม่นับเที่ยวที่ใช้รถ/รถร่วมตัวอย่าง)
CREATE OR REPLACE FUNCTION tms_active_vehicle_recount(p_tenant uuid, p_period text, p_key text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE
  r text := tms_active_vehicle_rule();
  m_start timestamptz;
  m_end timestamptz;
  f record;
BEGIN
  IF p_tenant IS NULL OR p_period IS NULL OR p_key IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM tenant WHERE id = p_tenant AND mode = 'live') THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock_shared(20, hashtext(p_tenant::text || ':' || p_period));
  PERFORM pg_advisory_xact_lock(21, hashtext(p_tenant::text || ':' || p_period || ':' || p_key));
  IF EXISTS (SELECT 1 FROM usage_record u WHERE u.tenant_id = p_tenant AND u.metric = 'vehicles.active'
                AND u.period = p_period AND u.status <> 'open') THEN
    RETURN; -- ปิดยอดแล้ว: แก้ได้เฉพาะ Console การเงิน (PLT-074)
  END IF;
  m_start := ((p_period || '-01')::timestamp) AT TIME ZONE 'Asia/Bangkok';
  m_end := ((p_period || '-01')::timestamp + interval '1 month') AT TIME ZONE 'Asia/Bangkok';
  SELECT x.id, x.plate, x.vehicle_id, x.carrier_id, x.at INTO f
    FROM (SELECT t.id, t.vehicle_plate_snapshot AS plate, t.vehicle_id, t.carrier_id,
                 tms_trip_usage_at(r, t.status::text, t.dispatched_at, t.completed_at) AS at
            FROM trip t
           WHERE t.tenant_id = p_tenant
             AND t.status IN ('DISPATCHED', 'IN_PROGRESS', 'COMPLETED', 'COSTED', 'SETTLED')
             AND tms_trip_usage_key(t.vehicle_plate_snapshot, t.carrier_id, t.driver_id, t.driver_name_snapshot, t.id) = p_key
             AND NOT tms_trip_is_sample(t.tenant_id, t.vehicle_id, t.carrier_id)) x
   WHERE x.at >= m_start AND x.at < m_end
   ORDER BY x.at, x.id LIMIT 1;
  IF f.id IS NULL THEN
    DELETE FROM active_vehicle_usage
     WHERE tenant_id = p_tenant AND period = p_period AND plate_normalized = p_key AND source = 'auto';
    RETURN;
  END IF;
  INSERT INTO active_vehicle_usage AS a (tenant_id, period, plate_normalized, plate, vehicle_id, carrier_id,
                                         subcontract, plate_missing, rule, first_trip_id, first_counted_at)
  VALUES (p_tenant, p_period, p_key, nullif(btrim(f.plate), ''), f.vehicle_id, f.carrier_id,
          f.carrier_id IS NOT NULL, left(p_key, 1) = '?', r, f.id, f.at)
  ON CONFLICT (tenant_id, period, plate_normalized) DO UPDATE
     SET plate = EXCLUDED.plate, vehicle_id = EXCLUDED.vehicle_id, carrier_id = EXCLUDED.carrier_id,
         subcontract = EXCLUDED.subcontract, plate_missing = EXCLUDED.plate_missing, rule = EXCLUDED.rule,
         first_trip_id = EXCLUDED.first_trip_id, first_counted_at = EXCLUDED.first_counted_at, updated_at = now()
   WHERE a.source = 'auto'
     AND (a.first_trip_id IS DISTINCT FROM EXCLUDED.first_trip_id OR a.first_counted_at <> EXCLUDED.first_counted_at
          OR a.rule <> EXCLUDED.rule OR a.vehicle_id IS DISTINCT FROM EXCLUDED.vehicle_id
          OR a.plate IS DISTINCT FROM EXCLUDED.plate);
END
$$;

-- ล้างข้อมูลตัวอย่างของ tenant ปัจจุบัน (app.tenant_id — ผู้เรียกระบุ tenant อื่นไม่ได้)
-- ลำดับ: SO → rate card → รถ → รถร่วม → สถานที่ → ลูกค้า (ลูกก่อนแม่) · ทีละแถวใน sub-transaction:
--   ถูกอ้างอิง (FK RESTRICT) / บรรทัดรายได้ที่ล็อกแล้วหรือคนเพิ่มเอง (trigger revenue_line_guard) → ย้อนเฉพาะแถวนั้น คงธงไว้ คืน in_use
-- SO: ลบได้เมื่อยังอยู่ขั้นรับงาน (DRAFT/RECEIVED/ON_HOLD/CANCELLED) และ DO ทุกใบยังเป็นร่าง/ยกเลิกที่ไม่เคยลงเที่ยว —
--   ลบบรรทัดรายได้ / DO (สร้างอัตโนมัติตอนรับใบ) / ราคา / สินค้า / จุดรับส่ง / ชุดเปลี่ยนจากต้นทาง ของใบนั้นก่อน (ล็อกแก้ไขลบตาม FK CASCADE)
--   DO ที่มี POD / ค่าใช้จ่ายหน้างาน / อยู่ในใบแจ้งหนี้ → FK/trigger ปฏิเสธ = in_use
--   ประวัติสถานะ (doc_status_history), domain_event และ audit_log เป็นบันทึกแบบ append-only — ไม่ลบ
CREATE OR REPLACE FUNCTION tms_sample_data_purge()
  RETURNS TABLE (entity_type text, entity_id uuid, removed boolean, reason text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE
  t uuid := tms_current_tenant();
  s record;
  ord text[] := ARRAY['sales_order', 'rate_card', 'vehicle', 'carrier', 'customer_site', 'customer'];
BEGIN
  IF t IS NULL THEN
    RAISE EXCEPTION 'tms_sample_data_purge: tenant not set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOR s IN
    SELECT r.entity_type AS et, r.entity_id AS eid FROM sample_record r
     WHERE r.tenant_id = t
     ORDER BY array_position(ord, r.entity_type::text), r.created_at, r.entity_id
  LOOP
    BEGIN
      IF s.et = 'sales_order' THEN
        -- ใช้งานต่อแล้ว = ใบสั่งพ้นขั้นรับงาน หรือ DO (สร้างอัตโนมัติตอนรับใบ) ถูกจัดลงเที่ยว/เดินสถานะไปแล้ว
        IF EXISTS (SELECT 1 FROM sales_order o WHERE o.tenant_id = t AND o.id = s.eid
                      AND o.status NOT IN ('DRAFT', 'RECEIVED', 'ON_HOLD', 'CANCELLED'))
           OR EXISTS (SELECT 1 FROM delivery_order d WHERE d.tenant_id = t AND d.sales_order_id = s.eid
                         AND (d.status NOT IN ('DRAFT', 'CANCELLED') OR d.trip_id IS NOT NULL
                              OR d.trip_stop_id IS NOT NULL OR d.pickup_trip_stop_id IS NOT NULL)) THEN
          RAISE EXCEPTION 'sample order % in use', s.eid USING ERRCODE = 'check_violation';
        END IF;
        DELETE FROM revenue_line WHERE tenant_id = t AND sales_order_id = s.eid;
        DELETE FROM delivery_order_line l USING delivery_order d
         WHERE l.tenant_id = t AND d.id = l.delivery_order_id AND d.sales_order_id = s.eid;
        -- DO ที่แตก/ส่งซ้ำจาก DO อื่นของใบเดียวกันก่อน (self FK)
        DELETE FROM delivery_order d WHERE d.tenant_id = t AND d.sales_order_id = s.eid
           AND (d.split_from_id IS NOT NULL OR d.redelivery_of_id IS NOT NULL OR d.rejected_from_id IS NOT NULL);
        DELETE FROM delivery_order d WHERE d.tenant_id = t AND d.sales_order_id = s.eid;
        DELETE FROM sales_order_charge WHERE tenant_id = t AND sales_order_id = s.eid;
        DELETE FROM sales_order_line WHERE tenant_id = t AND sales_order_id = s.eid;
        DELETE FROM sales_order_stop WHERE tenant_id = t AND sales_order_id = s.eid;
        DELETE FROM order_source_change WHERE tenant_id = t AND sales_order_id = s.eid;
        DELETE FROM sales_order WHERE tenant_id = t AND id = s.eid;
      ELSIF s.et = 'rate_card' THEN
        DELETE FROM rate_card_accessorial WHERE tenant_id = t AND rate_card_id = s.eid;
        DELETE FROM rate_card WHERE tenant_id = t AND id = s.eid;
      ELSIF s.et = 'vehicle' THEN
        DELETE FROM vehicle WHERE tenant_id = t AND id = s.eid;
      ELSIF s.et = 'carrier' THEN
        DELETE FROM carrier WHERE tenant_id = t AND id = s.eid;
      ELSIF s.et = 'customer_site' THEN
        DELETE FROM customer_site WHERE tenant_id = t AND id = s.eid;
      ELSIF s.et = 'customer' THEN
        DELETE FROM customer WHERE tenant_id = t AND id = s.eid;
      END IF;
      DELETE FROM sample_record r WHERE r.tenant_id = t AND r.entity_type = s.et AND r.entity_id = s.eid;
      entity_type := s.et; entity_id := s.eid; removed := true; reason := NULL;
      RETURN NEXT;
    EXCEPTION WHEN foreign_key_violation OR check_violation OR insufficient_privilege THEN
      entity_type := s.et; entity_id := s.eid; removed := false; reason := 'in_use';
      RETURN NEXT;
    END;
  END LOOP;
END
$$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    -- ธงเพิ่มได้ (ตอนใส่ข้อมูลตัวอย่าง) แต่แก้/ลบตรงไม่ได้ — ลบผ่านฟังก์ชันด้านบนเท่านั้น (กันติดธงแถวจริงแล้วลบ: ฟังก์ชันลบเฉพาะแถวที่ไม่ถูกอ้างอิง)
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON sample_record FROM tms_app';
    EXECUTE 'REVOKE EXECUTE ON FUNCTION tms_sample_data_purge() FROM PUBLIC';
    EXECUTE 'GRANT EXECUTE ON FUNCTION tms_sample_data_purge() TO tms_app';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_platform') THEN
    EXECUTE 'REVOKE TRUNCATE ON sample_record FROM tms_platform';
  END IF;
END $$;

SELECT tms_enable_tenant_rls('sample_record');
