-- ST4-T03 แก้ตาม review/QA
-- (1) ธงใหม่ของ stop_event (projection): pickup_pending = ปิดงานส่งขณะจุดรับยังไม่ปิด (ไม่นับจนกว่ารับของเสร็จ/ผู้จัดรถ "ใช้")
--     · outcome_mismatch = ผลปิดจุดขัดกับ DO ที่ไล่ไปแล้ว (ธงแจ้ง ให้ผู้จัดรถรับทราบ) — แอปแก้ได้เฉพาะสองคอลัมน์นี้เพิ่ม
-- (2) เลิกเก็บเลขไมล์ประมาณในประวัติเลขไมล์ (ไม่ให้ค่าประมาณขวางเลขไมล์จริง) → ลบ trip_id ที่ 0086 เพิ่ม
--     (ค่าประมาณอยู่ที่ vehicle.odometer_km แหล่ง TRIP เท่านั้น — เลขไมล์จริงที่บันทึกภายหลังแทนที่เสมอ)

ALTER TABLE "stop_event" ADD COLUMN "pickup_pending" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "stop_event" ADD COLUMN "outcome_mismatch" BOOLEAN NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION tms_stop_event_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'stop_event is append-only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (to_jsonb(NEW) - 'attachments_pending' - 'sequence_conflict' - 'applied_at' - 'resolution_id'
        - 'pickup_pending' - 'outcome_mismatch')
     IS DISTINCT FROM (to_jsonb(OLD) - 'attachments_pending' - 'sequence_conflict' - 'applied_at' - 'resolution_id'
        - 'pickup_pending' - 'outcome_mismatch') THEN
    RAISE EXCEPTION 'stop_event is append-only (only attachments_pending, sequence_conflict, applied_at, resolution_id, pickup_pending, outcome_mismatch may change)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'GRANT UPDATE (pickup_pending, outcome_mismatch) ON stop_event TO tms_app';
  END IF;
END $$;

DROP INDEX IF EXISTS "vehicle_odometer_reading_tenant_id_trip_id_key";
ALTER TABLE "vehicle_odometer_reading" DROP CONSTRAINT IF EXISTS "vehicle_odometer_reading_trip_id_fkey";
ALTER TABLE "vehicle_odometer_reading" DROP COLUMN IF EXISTS "trip_id";
