-- ST3-T16 Multi-drop: ระยะ/เวลาของช่วงวิ่งต่อจุด + ยอดรวมของเที่ยว (คำนวณใหม่ทุกครั้งที่จุดแวะเปลี่ยน)
-- ไม่มีตารางใหม่ (RLS ของ trip / trip_stop ครอบอยู่แล้ว)
ALTER TABLE "trip" ADD COLUMN "planned_duration_min" INTEGER;
ALTER TABLE "trip" ADD CONSTRAINT "trip_planned_duration_min_nonneg" CHECK ("planned_duration_min" IS NULL OR "planned_duration_min" >= 0);
ALTER TABLE "trip" ADD CONSTRAINT "trip_planned_distance_km_nonneg" CHECK ("planned_distance_km" IS NULL OR "planned_distance_km" >= 0);

ALTER TABLE "trip_stop" ADD COLUMN "leg_distance_km" DECIMAL(10,1);
ALTER TABLE "trip_stop" ADD COLUMN "leg_minutes" INTEGER;
ALTER TABLE "trip_stop" ADD COLUMN "leg_source" TEXT;
ALTER TABLE "trip_stop" ADD CONSTRAINT "trip_stop_leg_source_check"
  CHECK ("leg_source" IS NULL OR "leg_source" IN ('ROUTE', 'ESTIMATE', 'SAME_SITE'));
ALTER TABLE "trip_stop" ADD CONSTRAINT "trip_stop_leg_nonneg"
  CHECK (("leg_distance_km" IS NULL OR "leg_distance_km" >= 0) AND ("leg_minutes" IS NULL OR "leg_minutes" >= 0));
