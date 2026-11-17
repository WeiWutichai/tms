-- ST4-T03 ไล่สถานะจาก stop event → trip_stop → trip → DO → SO
-- (1) stop_event.applied_at = เวลาที่ event ถูกนับใน projection ล่าสุด (null = ไม่นับ/ยังไม่ลง) — แอปแก้ได้เฉพาะคอลัมน์นี้เพิ่ม
-- (2) vehicle_odometer_reading.trip_id = เลขไมล์ประมาณเมื่อจบเที่ยว (source TRIP) 1 แถวต่อเที่ยว (กันบันทึกซ้ำเมื่อคำนวณใหม่)

ALTER TABLE "vehicle_odometer_reading" ADD COLUMN "trip_id" UUID;
ALTER TABLE "vehicle_odometer_reading" ADD CONSTRAINT "vehicle_odometer_reading_trip_id_fkey"
  FOREIGN KEY ("trip_id") REFERENCES "trip"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE UNIQUE INDEX "vehicle_odometer_reading_tenant_id_trip_id_key"
  ON "vehicle_odometer_reading"("tenant_id", "trip_id") WHERE "trip_id" IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'GRANT UPDATE (applied_at) ON stop_event TO tms_app';
  END IF;
END $$;
