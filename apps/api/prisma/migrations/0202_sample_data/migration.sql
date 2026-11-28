-- P1-ST2-T09: ข้อมูลตัวอย่างสำหรับ trial (docs/02 §2 "มีข้อมูลตัวอย่างบริษัทขนส่งไทยให้ลองทันที" · plan/01 ผู้สมัคร #30)
-- (1) sample_record = ธง "ข้อมูลตัวอย่าง" ต่อแถว (customer / customer_site / carrier / vehicle / driver / rate_card / sales_order)
--     role แอปเขียน/แก้/ลบตรงไม่ได้ — ติดธงผ่าน tms_sample_flag() (เฉพาะแถวที่สร้างใน transaction เดียวกันของ tenant นี้)
--     ลบผ่าน tms_sample_data_purge() เท่านั้น (กันติดธงแถวจริงแล้ว hard delete — review S2)
-- (2) tms_sample_data_purge(): ลบจริงเฉพาะแถวที่มีธงของ tenant ปัจจุบัน และยังไม่ถูกอ้างอิงจากข้อมูลจริง
--     ตารางเหล่านี้ role แอปลบตรงไม่ได้ (MD-004) — ฟังก์ชันนี้เป็นทางเดียว ·
--     แถวที่ถูกใช้ต่อแล้ว (เช่น SO ตัวอย่างที่สร้าง DO / ออกใบแจ้งหนี้ไปแล้ว, ลูกค้าตัวอย่างที่ใบสั่งจริงอ้างถึง) ไม่ลบ คงธงไว้
--     และคืนเหตุผลให้ผู้ใช้เห็น [DECISION — lead 28 พ.ย. 2569, ย้อนได้ — spec/12 §3]
-- (3) รถ active: เที่ยวที่ใช้รถ/รถร่วมตัวอย่างไม่ถูกนับ **เฉพาะเมื่อบริษัทยังไม่พ้นช่วงทดลองใช้ ณ เวลาที่เที่ยวเข้าเงื่อนไข**
--     (TRIALING / PENDING_VERIFICATION; sandbox ไม่นับอยู่แล้ว) — พ้น trial แล้วนับปกติทุกคัน (review B1: ธงไม่หมดอายุ = หลบค่าบริการได้)
--     แทน tms_active_vehicle_recount ของ 0190
-- (4) domain_event ระหว่างใส่ข้อมูลตัวอย่าง (ธง tms.suppress_outbox ใน transaction) ไม่ถูกส่งต่อเป็นคำสั่ง outbox (webhook / ERP)

CREATE TABLE "sample_record" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "entity_type" VARCHAR(24) NOT NULL,
    "entity_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sample_record_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sample_record_entity_type_check" CHECK ("entity_type" IN
      ('customer', 'customer_site', 'carrier', 'vehicle', 'driver', 'rate_card', 'sales_order'))
);

CREATE UNIQUE INDEX "sample_record_tenant_id_entity_type_entity_id_key" ON "sample_record"("tenant_id", "entity_type", "entity_id");

ALTER TABLE "sample_record" ADD CONSTRAINT "sample_record_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE;

-- (สิทธิ์ผู้เรียก — RLS จำกัดเฉพาะ tenant ของผู้เรียก; recount เรียกในนามเจ้าของ · review รอบ 2 ข้อ 2)
-- สถานะของบริษัท ณ เวลา p_at (ประวัติ tenant_status_history: แถวล่าสุดก่อน p_at → to_status · ไม่มี → from_status ของแถวแรกหลัง p_at
-- · ไม่มีประวัติ → สถานะปัจจุบัน)
CREATE OR REPLACE FUNCTION tms_tenant_status_at(p_tenant uuid, p_at timestamptz) RETURNS text
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS
$$
  SELECT coalesce(
    (SELECT h.to_status::text FROM public.tenant_status_history h
      WHERE h.tenant_id = p_tenant AND h.at <= p_at ORDER BY h.at DESC, h.seq DESC LIMIT 1),
    (SELECT h.from_status::text FROM public.tenant_status_history h
      WHERE h.tenant_id = p_tenant AND h.at > p_at ORDER BY h.at, h.seq LIMIT 1),
    (SELECT t.status::text FROM public.tenant t WHERE t.id = p_tenant))
$$;

-- เที่ยวนี้ข้ามการนับรถ active ไหม: ใช้รถ/รถร่วมตัวอย่าง **และ** บริษัทยังอยู่ช่วงทดลองใช้ ณ เวลาที่เที่ยวเข้าเงื่อนไข
-- (นิยามเดียว — trigger นับรถ active และ API จำนวนเที่ยว)
CREATE OR REPLACE FUNCTION tms_trip_is_sample(p_tenant uuid, p_vehicle uuid, p_carrier uuid, p_at timestamptz)
  RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS
$$
  SELECT (p_vehicle IS NOT NULL OR p_carrier IS NOT NULL) AND p_at IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.sample_record s
        WHERE s.tenant_id = p_tenant
          AND ((s.entity_type = 'vehicle' AND s.entity_id = p_vehicle)
            OR (s.entity_type = 'carrier' AND s.entity_id = p_carrier)))
     AND public.tms_tenant_status_at(p_tenant, p_at) IN ('TRIALING', 'PENDING_VERIFICATION')
$$;

-- ติดธงตัวอย่าง: แถวต้องเป็นของ tenant ปัจจุบันและเวอร์ชันล่าสุดของแถวถูกเขียนใน transaction นี้ (xmin = xid ปัจจุบัน —
-- สร้างหรือแก้ใน tx นี้ก็ผ่าน; ผู้เรียกเดียวคือ SampleDataService ที่สร้างแถวเอง) — ไม่งั้นปฏิเสธทั้งชุด
CREATE OR REPLACE FUNCTION tms_sample_flag(p_type text, p_ids uuid[]) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE
  t uuid := tms_current_tenant();
  x text := (pg_catalog.pg_current_xact_id()::text::bigint % 4294967296)::text;
  ids uuid[] := ARRAY(SELECT DISTINCT u FROM unnest(p_ids) AS u WHERE u IS NOT NULL);
  ok integer;
BEGIN
  IF t IS NULL THEN
    RAISE EXCEPTION 'tms_sample_flag: tenant not set' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_type NOT IN ('customer', 'customer_site', 'carrier', 'vehicle', 'driver', 'rate_card', 'sales_order') THEN
    RAISE EXCEPTION 'tms_sample_flag: bad type %', p_type USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF cardinality(ids) = 0 THEN RETURN 0; END IF;
  EXECUTE format('SELECT count(*)::int FROM public.%I r WHERE r.tenant_id = $1 AND r.id = ANY($2) AND r.xmin::text = $3', p_type)
     INTO ok USING t, ids, x;
  IF ok <> cardinality(ids) THEN
    RAISE EXCEPTION 'tms_sample_flag: rows must belong to this tenant and be written in this transaction'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO public.sample_record (tenant_id, entity_type, entity_id)
  SELECT t, p_type, u FROM unnest(ids) AS u
  ON CONFLICT (tenant_id, entity_type, entity_id) DO NOTHING;
  RETURN ok;
END
$$;

-- นับใหม่ 1 ทะเบียน × 1 เดือน (เหมือน 0190 ทุกอย่าง + ไม่นับเที่ยวที่ใช้รถ/รถร่วมตัวอย่างช่วงทดลองใช้)
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
             AND tms_trip_usage_key(t.vehicle_plate_snapshot, t.carrier_id, t.driver_id, t.driver_name_snapshot, t.id) = p_key) x
   WHERE x.at >= m_start AND x.at < m_end
     AND NOT tms_trip_is_sample(p_tenant, x.vehicle_id, x.carrier_id, x.at)
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
-- ลำดับ: SO → rate card → คนขับ → รถ → รถร่วม → สถานที่ → ลูกค้า (ลูกก่อนแม่) · ทีละแถวใน sub-transaction:
--   ถูกอ้างอิง (FK RESTRICT) / ตัวอ้างอิงที่ไม่มี FK (ไฟล์แนบ, อีเมลเอกสาร, แจ้งเตือนหมดอายุ, การจับคู่/คิว connector, ตำแหน่ง GPS,
--   ต้นทุนเที่ยวของรถร่วม) / trigger ปฏิเสธ (บรรทัดรายได้ล็อก, POD append-only ฯลฯ) → ย้อนเฉพาะแถวนั้น คงธงไว้ คืน in_use
-- ล็อกแถว SO/DO (FOR UPDATE) ก่อนตรวจสถานะ — กันจัดลงเที่ยวพร้อมกันระหว่างตรวจ→ลบ (review S1)
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
  ord text[] := ARRAY['sales_order', 'rate_card', 'driver', 'vehicle', 'carrier', 'customer_site', 'customer'];
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
      -- ล็อกแถวแม่ (ทุกชนิด) + DO ของ SO ก่อนตรวจ — กันถูกอ้างอิง/จัดลงเที่ยวพร้อมกันระหว่างตรวจ→ลบ (review S1 / รอบ 2 ข้อ 4)
      EXECUTE format('SELECT 1 FROM public.%I WHERE tenant_id = $1 AND id = $2 FOR UPDATE', s.et) USING t, s.eid;
      IF s.et = 'sales_order' THEN
        PERFORM 1 FROM delivery_order d WHERE d.tenant_id = t AND d.sales_order_id = s.eid FOR UPDATE;
      END IF;
      -- ตัวอ้างอิงที่ไม่มี FK (review S4) — ของ SO รวม DO ของใบนั้นด้วย
      IF EXISTS (SELECT 1 FROM stored_document x WHERE x.tenant_id = t AND (x.entity_id = s.eid OR (s.et = 'sales_order'
                   AND x.entity_id IN (SELECT d.id FROM delivery_order d WHERE d.tenant_id = t AND d.sales_order_id = s.eid))))
         OR EXISTS (SELECT 1 FROM document_email x WHERE x.tenant_id = t AND (x.entity_id = s.eid OR (s.et = 'sales_order'
                   AND x.entity_id IN (SELECT d.id FROM delivery_order d WHERE d.tenant_id = t AND d.sales_order_id = s.eid))))
         OR EXISTS (SELECT 1 FROM expiry_reminder x WHERE x.tenant_id = t AND x.entity_id = s.eid)
         OR EXISTS (SELECT 1 FROM external_mapping x WHERE x.tenant_id = t AND x.local_id = s.eid)
         OR EXISTS (SELECT 1 FROM integration_outbox x WHERE x.tenant_id = t AND x.local_id = s.eid)
         OR (s.et = 'vehicle' AND EXISTS (SELECT 1 FROM vehicle_position x WHERE x.tenant_id = t AND x.vehicle_id = s.eid))
         OR (s.et = 'carrier' AND EXISTS (SELECT 1 FROM trip_cost x WHERE x.tenant_id = t AND x.carrier_id = s.eid)) THEN
        RAISE EXCEPTION 'sample % % referenced', s.et, s.eid USING ERRCODE = 'foreign_key_violation';
      END IF;
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
      ELSIF s.et = 'driver' THEN
        DELETE FROM driver WHERE tenant_id = t AND id = s.eid;
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
    EXCEPTION WHEN OTHERS THEN
      -- deadlock / serialization / ล็อกไม่ได้ = ไม่ใช่ "ถูกใช้ต่อ" → ล้มทั้งคำขอ (API ตอบ 409 ให้ลองใหม่) (รอบ 2 ข้อ 3)
      IF SQLSTATE LIKE '40%' OR SQLSTATE = '55P03' THEN RAISE; END IF;
      -- FK / CHECK / trigger ที่ปฏิเสธ (P0001, 42501 …) = ถูกใช้ต่อแล้ว — ย้อนเฉพาะแถวนี้ ไม่ทำให้ทั้งคำขอล้ม (review M2)
      entity_type := s.et; entity_id := s.eid; removed := false;
      reason := CASE WHEN SQLSTATE IN ('23503', '23514', '42501', 'P0001') THEN 'in_use' ELSE 'in_use:' || SQLSTATE END;
      RETURN NEXT;
    END;
  END LOOP;
END
$$;

-- event ที่เกิดระหว่างใส่ข้อมูลตัวอย่าง (เขียนโดย trigger ด้านล่าง) — ซ่อนจาก feed / ห้ามส่งซ้ำ · คงอยู่แม้ล้างข้อมูลตัวอย่างแล้ว
CREATE TABLE "sample_event" (
    "tenant_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sample_event_pkey" PRIMARY KEY ("tenant_id", "event_id")
);
ALTER TABLE "sample_event" ADD CONSTRAINT "sample_event_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE;

-- domain_event → integration_outbox (0093) + ข้ามเมื่อ transaction ตั้งธง tms.suppress_outbox = on (ใส่ข้อมูลตัวอย่าง — review S3)
CREATE OR REPLACE FUNCTION tms_domain_event_to_outbox() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  cust text;
BEGIN
  IF pg_catalog.current_setting('tms.suppress_outbox', true) = 'on' THEN
    -- จำไว้ว่าเป็น event ของข้อมูลตัวอย่าง → ไม่แสดงใน GET /v1/events และส่งซ้ำไม่ได้ (รอบ 2 ข้อ 1)
    INSERT INTO sample_event (tenant_id, event_id) VALUES (NEW.tenant_id, NEW.id) ON CONFLICT DO NOTHING;
    RETURN NULL;
  END IF;
  cust := tms_outbox_customer_key(NEW.entity_type, NEW.local_id, NEW.snapshot);
  INSERT INTO integration_outbox (tenant_id, kind, sink, target_id, subscription_id, operation, entity_type,
                                  local_id, event_id, event_type, serialize_key, idempotency_key, max_attempt, updated_at)
  SELECT NEW.tenant_id, s.kind, s.sink, s.target_id, s.id, coalesce(s.operation, NEW.type), NEW.entity_type,
         NEW.local_id, NEW.id, NEW.type,
         s.sink || ':' || coalesce(s.target_id, '-') || ':' ||
           CASE WHEN s.kind = 'WEBHOOK' THEN 'evt:' || NEW.id::text
                WHEN cust IS NOT NULL THEN 'cus:' || cust
                ELSE NEW.entity_type || ':' || NEW.local_id::text END,
         s.sink || ':' || coalesce(s.target_id, '-') || ':' || coalesce(s.operation, NEW.type) || ':' || NEW.id::text,
         CASE WHEN s.kind = 'WEBHOOK' THEN 9 ELSE 7 END,
         now()
    FROM integration_subscription s
   WHERE s.tenant_id = NEW.tenant_id
     AND s.active
     AND (NEW.type = ANY (s.event_types)
          OR '*' = ANY (s.event_types)
          OR (split_part(NEW.type, '.', 1) || '.*') = ANY (s.event_types))
  ON CONFLICT (tenant_id, idempotency_key) DO NOTHING;
  RETURN NULL;
END
$$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    -- อ่านได้อย่างเดียว — ติดธงผ่าน tms_sample_flag() · ลบผ่าน tms_sample_data_purge() (review S2)
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON sample_record FROM tms_app';
    EXECUTE 'REVOKE EXECUTE ON FUNCTION tms_sample_data_purge() FROM PUBLIC';
    EXECUTE 'GRANT EXECUTE ON FUNCTION tms_sample_data_purge() TO tms_app';
    EXECUTE 'REVOKE EXECUTE ON FUNCTION tms_sample_flag(text, uuid[]) FROM PUBLIC';
    EXECUTE 'GRANT EXECUTE ON FUNCTION tms_sample_flag(text, uuid[]) TO tms_app';
    -- sample_event: แอปเพิ่มได้ (ผ่าน trigger ของ domain_event ในนามผู้เขียน) อ่านได้ แก้/ลบไม่ได้
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON sample_event FROM tms_app';
    -- ฟังก์ชันช่วยนับ (สิทธิ์ผู้เรียก + RLS) — ไม่เปิดให้ PUBLIC ตามแบบ 0190
    EXECUTE 'REVOKE EXECUTE ON FUNCTION tms_tenant_status_at(uuid, timestamptz) FROM PUBLIC';
    EXECUTE 'REVOKE EXECUTE ON FUNCTION tms_trip_is_sample(uuid, uuid, uuid, timestamptz) FROM PUBLIC';
    EXECUTE 'GRANT EXECUTE ON FUNCTION tms_tenant_status_at(uuid, timestamptz) TO tms_app';
    EXECUTE 'GRANT EXECUTE ON FUNCTION tms_trip_is_sample(uuid, uuid, uuid, timestamptz) TO tms_app';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_platform') THEN
    EXECUTE 'REVOKE TRUNCATE ON sample_record, sample_event FROM tms_platform';
    EXECUTE 'GRANT EXECUTE ON FUNCTION tms_tenant_status_at(uuid, timestamptz) TO tms_platform';
    EXECUTE 'GRANT EXECUTE ON FUNCTION tms_trip_is_sample(uuid, uuid, uuid, timestamptz) TO tms_platform';
  END IF;
END $$;

SELECT tms_enable_tenant_rls('sample_record');
SELECT tms_enable_tenant_rls('sample_event');
