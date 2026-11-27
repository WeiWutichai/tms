-- P1-ST1-T06: นับรถ active (spec/01 §7 PLT-070–075 · plan/13 R-05 / D-41 · docs/02 §2 "รถที่มี Trip อย่างน้อย 1 เที่ยวในเดือน")
-- active_vehicle_usage = 1 แถว/ทะเบียน normalize/เดือนปฏิทินเวลาไทย — เขียนโดย trigger ของ trip เท่านั้น (ครอบทุกทางที่เปลี่ยนสถานะเที่ยว)
-- usage_record = ยอดปิดรายเดือน (finalize วันที่ 1 02:00 ไทย — UsageFinalizeService) · หลัง finalize trigger ไม่แตะเดือนนั้น
-- กติกา (ค่าตั้ง usage.activeVehicleRule — P1-ST1-T04):
--   trip_started (ค่าเริ่มต้น — [DECISION — lead 27 พ.ย. 2569, ย้อนได้]): เที่ยวที่ปล่อยรถแล้ว (DISPATCHED ขึ้นไป ไม่รวม CANCELLED) นับตามเดือนของ dispatched_at
--   doc_closed: เที่ยวที่ปิดงานแล้ว (COMPLETED/COSTED/SETTLED) นับตามเดือนของ completed_at
-- ไม่มีเที่ยวเข้าเงื่อนไขเหลือในเดือน (ย้อนสถานะ เช่น DISPATCHED → CANCELLED) → ลบแถว auto ก่อน finalize (PLT-075) · sandbox ไม่นับ (PLT-071)

CREATE TABLE "active_vehicle_usage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "period" CHAR(7) NOT NULL,
    "plate_normalized" TEXT NOT NULL,
    "plate" TEXT,
    "vehicle_id" UUID,
    "carrier_id" UUID,
    "subcontract" BOOLEAN NOT NULL DEFAULT false,
    "plate_missing" BOOLEAN NOT NULL DEFAULT false,
    "rule" VARCHAR(16) NOT NULL,
    "first_trip_id" UUID,
    "first_counted_at" TIMESTAMPTZ(6) NOT NULL,
    "source" VARCHAR(8) NOT NULL DEFAULT 'auto',
    "excluded_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "active_vehicle_usage_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "active_vehicle_usage_period_check" CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    CONSTRAINT "active_vehicle_usage_rule_check" CHECK ("rule" IN ('trip_started', 'doc_closed', 'manual')),
    CONSTRAINT "active_vehicle_usage_source_check" CHECK ("source" IN ('auto', 'console')),
    CONSTRAINT "active_vehicle_usage_key_check" CHECK (length("plate_normalized") BETWEEN 1 AND 120)
);

CREATE TABLE "usage_record" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "metric" VARCHAR(40) NOT NULL,
    "period" CHAR(7) NOT NULL,
    "value" DECIMAL(14,2) NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'open',
    "finalized_at" TIMESTAMPTZ(6),
    "detail" JSONB NOT NULL DEFAULT '{}',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_record_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "usage_record_period_check" CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    CONSTRAINT "usage_record_status_check" CHECK ("status" IN ('open', 'finalized', 'invoiced')),
    CONSTRAINT "usage_record_value_check" CHECK ("value" >= 0),
    CONSTRAINT "usage_record_finalized_check" CHECK ("status" = 'open' OR "finalized_at" IS NOT NULL)
);

CREATE INDEX "active_vehicle_usage_first_trip_id_idx" ON "active_vehicle_usage"("first_trip_id");
CREATE UNIQUE INDEX "active_vehicle_usage_tenant_id_period_plate_normalized_key" ON "active_vehicle_usage"("tenant_id", "period", "plate_normalized");
CREATE INDEX "usage_record_metric_period_idx" ON "usage_record"("metric", "period");
CREATE UNIQUE INDEX "usage_record_tenant_id_metric_period_key" ON "usage_record"("tenant_id", "metric", "period");
CREATE INDEX "trip_tenant_id_dispatched_at_idx" ON "trip"("tenant_id", "dispatched_at");
CREATE INDEX "trip_tenant_id_completed_at_idx" ON "trip"("tenant_id", "completed_at");

ALTER TABLE "active_vehicle_usage" ADD CONSTRAINT "active_vehicle_usage_first_trip_id_fkey" FOREIGN KEY ("first_trip_id") REFERENCES "trip"("id") ON DELETE SET NULL ON UPDATE CASCADE;
-- FK tenant (SQL อย่างเดียว เหมือนตารางอื่นของ tenant)
ALTER TABLE "active_vehicle_usage" ADD CONSTRAINT "active_vehicle_usage_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE;
ALTER TABLE "usage_record" ADD CONSTRAINT "usage_record_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE;

-- ───────────────────────── ฟังก์ชันนับ ─────────────────────────

-- ทะเบียน normalize — สูตรเดียวกับ plateNorm() ใน vehicles.service.ts: เลขไทย → อารบิก · ตัดช่องว่างทุกแบบ (รวม NBSP / ช่องว่าง Unicode /
-- zero-width) ขีดทุกแบบ (- ‐ ‑ ‒ – — ― −) และจุด · ตัวใหญ่
CREATE OR REPLACE FUNCTION tms_plate_normalize(p text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT upper(regexp_replace(translate(coalesce(p, ''), '๐๑๒๓๔๕๖๗๘๙', '0123456789'),
                               '[\s   -​‐-―−  　﻿.-]', '', 'g')) $$;

-- ตัวนับของเที่ยว: ทะเบียน normalize · ไม่มีทะเบียน (เอกสารรถร่วม) → "?<carrier|own>:<driver|ชื่อคนขับ|trip>" + ธง plate_missing (spec/01 §7 ข้อ 8)
CREATE OR REPLACE FUNCTION tms_trip_usage_key(plate text, carrier uuid, driver uuid, driver_name text, trip uuid) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$
  SELECT CASE WHEN tms_plate_normalize(plate) <> '' THEN left(tms_plate_normalize(plate), 120)
         ELSE left('?' || coalesce(carrier::text, 'own') || ':' ||
                   coalesce(driver::text, nullif(lower(btrim(driver_name)), ''), trip::text), 120) END
$$;

-- recount ค้นเที่ยวของทะเบียนด้วยดัชนีนิพจน์นี้ (ไม่ขึ้นกับว่ามี dispatched_at หรือไม่ — review M3/L3) · เฉพาะเที่ยวที่ปล่อยรถแล้วขึ้นไป
CREATE INDEX "trip_usage_key_idx" ON "trip" ("tenant_id",
  tms_trip_usage_key("vehicle_plate_snapshot", "carrier_id", "driver_id", "driver_name_snapshot", "id"))
  WHERE "status" IN ('DISPATCHED', 'IN_PROGRESS', 'COMPLETED', 'COSTED', 'SETTLED');

-- กติกาที่มีผล (ค่าตั้งแพลตฟอร์ม usage.activeVehicleRule — ไม่มีแถว/ค่าผิด = trip_started)
CREATE OR REPLACE FUNCTION tms_active_vehicle_rule() RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$
  SELECT COALESCE(
    (SELECT s.value #>> '{}' FROM platform_setting s
      WHERE s.key = 'usage.activeVehicleRule' AND s.value #>> '{}' IN ('trip_started', 'doc_closed')),
    'trip_started')
$$;

-- เวลาที่เที่ยวเข้าเงื่อนไข (null = ไม่เข้า) — ใช้ทั้ง trigger, recount และ API (นิยามเดียว)
CREATE OR REPLACE FUNCTION tms_trip_usage_at(rule text, status text, dispatched_at timestamptz, completed_at timestamptz)
  RETURNS timestamptz LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$
  SELECT CASE
    WHEN rule = 'doc_closed' THEN
      CASE WHEN status IN ('COMPLETED', 'COSTED', 'SETTLED') THEN coalesce(completed_at, dispatched_at) END
    ELSE
      CASE WHEN status IN ('DISPATCHED', 'IN_PROGRESS', 'COMPLETED', 'COSTED', 'SETTLED') THEN coalesce(dispatched_at, completed_at) END
  END
$$;

-- เดือนปฏิทินเวลาไทยของเวลา (เที่ยวคร่อมเที่ยงคืนสิ้นเดือนใช้เวลาที่เข้าเงื่อนไขตามเวลาไทย — spec/01 §7 ข้อ 8)
CREATE OR REPLACE FUNCTION tms_bkk_period(ts timestamptz) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
$$ SELECT to_char(ts AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM') $$;

-- นับใหม่ 1 ทะเบียน × 1 เดือน: หาเที่ยวแรกที่เข้าเงื่อนไข (tms_trip_usage_at เดียวกับ trigger) → upsert แถว auto · ไม่มี → ลบแถว auto
-- lock: (20, tenant:เดือน) แบบ shared — finalize ถือแบบ exclusive · (21, tenant:เดือน:ทะเบียน) กันสองเที่ยวนับทะเบียนเดียวพร้อมกัน
-- ผู้เรียกที่นับหลายทะเบียนใน transaction เดียวต้องเรียงตาม (เดือน, ทะเบียน) กัน deadlock · deadlock ที่ยังเกิด (40P01) = 409
-- concurrent_update ที่ลองส่งใหม่ได้
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

-- นับใหม่ทั้งเดือน (ทุก tenant live): ทะเบียนที่มีแถว auto อยู่ ∪ ทะเบียนของเที่ยวที่เข้าเงื่อนไขในเดือนตามกติกาใดก็ได้
-- ใช้ตอน backfill (ท้าย migration นี้) และเมื่อ Console เปลี่ยน usage.activeVehicleRule (เดือนที่ยังไม่ปิดยอด — review M2/L7)
-- เรียงตาม (tenant, ทะเบียน) กัน deadlock กับ trigger · คืนจำนวนคู่ที่นับ
CREATE OR REPLACE FUNCTION tms_active_vehicle_recount_all(p_period text) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE
  m_start timestamptz := ((p_period || '-01')::timestamp) AT TIME ZONE 'Asia/Bangkok';
  m_end timestamptz := ((p_period || '-01')::timestamp + interval '1 month') AT TIME ZONE 'Asia/Bangkok';
  k record;
  n integer := 0;
BEGIN
  FOR k IN
    SELECT DISTINCT tenant_id, key FROM (
      SELECT a.tenant_id, a.plate_normalized AS key FROM active_vehicle_usage a
       WHERE a.period = p_period AND a.source = 'auto'
      UNION
      SELECT t.tenant_id,
             tms_trip_usage_key(t.vehicle_plate_snapshot, t.carrier_id, t.driver_id, t.driver_name_snapshot, t.id)
        FROM trip t JOIN tenant tn ON tn.id = t.tenant_id AND tn.mode = 'live'
       WHERE ((t.dispatched_at >= m_start AND t.dispatched_at < m_end)
              OR (t.completed_at >= m_start AND t.completed_at < m_end))
         AND t.status IN ('DISPATCHED', 'IN_PROGRESS', 'COMPLETED', 'COSTED', 'SETTLED')
    ) c ORDER BY tenant_id, key
  LOOP
    PERFORM tms_active_vehicle_recount(k.tenant_id, p_period, k.key);
    n := n + 1;
  END LOOP;
  RETURN n;
END
$$;

-- trigger ของ trip: นับใหม่ทั้งคู่ (ทะเบียน/เดือน) เดิมและใหม่เมื่อสถานะ/เวลา/ทะเบียน/รถเปลี่ยน
-- เรียกตามลำดับ (เดือน, ทะเบียน) เสมอ กัน deadlock ระหว่างสองเที่ยวที่สลับทะเบียนกัน (review L1)
CREATE OR REPLACE FUNCTION tms_trip_active_vehicle() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE
  r text := tms_active_vehicle_rule();
  nk text := tms_trip_usage_key(NEW.vehicle_plate_snapshot, NEW.carrier_id, NEW.driver_id, NEW.driver_name_snapshot, NEW.id);
  na timestamptz := tms_trip_usage_at(r, NEW.status::text, NEW.dispatched_at, NEW.completed_at);
  np text := tms_bkk_period(na);
  ok text;
  oa timestamptz;
  op text;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    ok := tms_trip_usage_key(OLD.vehicle_plate_snapshot, OLD.carrier_id, OLD.driver_id, OLD.driver_name_snapshot, OLD.id);
    oa := tms_trip_usage_at(r, OLD.status::text, OLD.dispatched_at, OLD.completed_at);
    op := tms_bkk_period(oa);
    IF op IS NOT DISTINCT FROM np AND ok IS NOT DISTINCT FROM nk AND oa IS NOT DISTINCT FROM na
       AND OLD.vehicle_id IS NOT DISTINCT FROM NEW.vehicle_id
       AND OLD.vehicle_plate_snapshot IS NOT DISTINCT FROM NEW.vehicle_plate_snapshot THEN
      RETURN NULL; -- ไม่มีอะไรที่มีผลต่อการนับเปลี่ยน (เช่น COMPLETED → COSTED)
    END IF;
    IF op IS NOT NULL AND (np IS NULL OR (op, ok) < (np, nk)) THEN
      PERFORM tms_active_vehicle_recount(OLD.tenant_id, op, ok);
      op := NULL;
    END IF;
  END IF;
  IF np IS NOT NULL THEN PERFORM tms_active_vehicle_recount(NEW.tenant_id, np, nk); END IF;
  IF op IS NOT NULL AND (op, ok) IS DISTINCT FROM (np, nk) THEN
    PERFORM tms_active_vehicle_recount(OLD.tenant_id, op, ok);
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER trip_active_vehicle
  AFTER INSERT OR UPDATE OF status, dispatched_at, completed_at, vehicle_id, vehicle_plate_snapshot, carrier_id, driver_id, driver_name_snapshot
  ON trip FOR EACH ROW EXECUTE FUNCTION tms_trip_active_vehicle();

-- ───────────────────────── สิทธิ์ ─────────────────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    -- แอปอ่านอย่างเดียว (นับด้วย trigger SECURITY DEFINER · ปิดยอด/แก้หลังปิดยอด = role platform)
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON active_vehicle_usage, usage_record FROM tms_app';
    EXECUTE 'REVOKE EXECUTE ON FUNCTION tms_active_vehicle_recount(uuid, text, text) FROM PUBLIC';
    EXECUTE 'REVOKE EXECUTE ON FUNCTION tms_active_vehicle_recount_all(text) FROM PUBLIC';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_platform') THEN
    -- ไม่มีการลบยอดปิด · แถวรถหลังปิดยอด "ตัดออก" ด้วย excluded_at (ไม่ลบ)
    EXECUTE 'REVOKE DELETE, TRUNCATE ON usage_record FROM tms_platform';
    EXECUTE 'REVOKE TRUNCATE ON active_vehicle_usage FROM tms_platform';
    -- Console เปลี่ยนกติกาการนับ → นับใหม่เดือนที่ยังเปิด (platform-settings.controller)
    EXECUTE 'GRANT EXECUTE ON FUNCTION tms_active_vehicle_recount_all(text) TO tms_platform';
  END IF;
END $$;

SELECT tms_enable_tenant_rls('active_vehicle_usage');
SELECT tms_enable_tenant_rls('usage_record');

-- backfill (review M2): เที่ยวที่ปล่อยรถ/ปิดงานแล้วก่อน migration นี้ — นับเดือนนี้และเดือนก่อน (ยังไม่มีเดือนใดปิดยอด;
-- เดือนก่อนจะถูกปิดยอดย้อนหลังโดย UsageFinalizeService รอบแรก)
SELECT tms_active_vehicle_recount_all(tms_bkk_period(now() - interval '1 month'));
SELECT tms_active_vehicle_recount_all(tms_bkk_period(now()));
