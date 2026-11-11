-- ST2-T02 สถานที่ / จุดรับส่ง (customer_site): รหัส, ประเภท, รัศมี geofence, รถเข้าได้สูงสุด, หมายเหตุ, alias ค้นได้, soft delete
-- docs/01 §3.2 + plan/00a (customer_id nullable + kind + geofence_radius_m), spec/02 §2

CREATE TYPE "site_kind" AS ENUM ('PICKUP', 'DROPOFF', 'WAREHOUSE');

ALTER TABLE "customer_site" ADD COLUMN     "alias_search" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "code" TEXT,
ADD COLUMN     "deleted_at" TIMESTAMPTZ(6),
ADD COLUMN     "deleted_external_id" TEXT,
ADD COLUMN     "geofence_radius_m" INTEGER NOT NULL DEFAULT 200,
ADD COLUMN     "kind" "site_kind" NOT NULL DEFAULT 'DROPOFF',
ADD COLUMN     "max_vehicle_class" TEXT,
ADD COLUMN     "notes" TEXT;

-- แถวเดิม (ถ้ามี) ได้รหัส LOC-00001… ต่อ tenant ตามลำดับสร้าง + alias/ประเภทรถไม่เป็น null
UPDATE "customer_site" s SET "code" = x.code
FROM (
  SELECT id, 'LOC-' || lpad((row_number() OVER (PARTITION BY tenant_id ORDER BY created_at, id))::text, 5, '0') AS code
  FROM "customer_site"
) x
WHERE s.id = x.id AND s."code" IS NULL;
UPDATE "customer_site" SET "aliases" = ARRAY[]::TEXT[] WHERE "aliases" IS NULL;
UPDATE "customer_site" SET "vehicle_type_allowed" = ARRAY[]::TEXT[] WHERE "vehicle_type_allowed" IS NULL;
UPDATE "customer_site" SET "alias_search" = E'\n' || lower(array_to_string("aliases", E'\n')) || E'\n'
  WHERE cardinality("aliases") > 0;

ALTER TABLE "customer_site" ALTER COLUMN "code" SET NOT NULL,
ALTER COLUMN "aliases" SET DEFAULT ARRAY[]::TEXT[],
ALTER COLUMN "aliases" SET NOT NULL,
ALTER COLUMN "vehicle_type_allowed" SET DEFAULT ARRAY[]::TEXT[],
ALTER COLUMN "vehicle_type_allowed" SET NOT NULL;

CREATE UNIQUE INDEX "customer_site_tenant_id_code_key" ON "customer_site"("tenant_id", "code");
-- รหัสไม่สนตัวพิมพ์ (MD-002) — API เก็บเป็นตัวใหญ่
CREATE UNIQUE INDEX "customer_site_tenant_code_upper_uq" ON "customer_site"("tenant_id", upper("code"));

ALTER TABLE "customer_site" ADD CONSTRAINT "customer_site_geofence_range" CHECK ("geofence_radius_m" BETWEEN 50 AND 2000);
ALTER TABLE "customer_site" ADD CONSTRAINT "customer_site_lat_range" CHECK ("lat" IS NULL OR "lat" BETWEEN -90 AND 90);
ALTER TABLE "customer_site" ADD CONSTRAINT "customer_site_lng_range" CHECK ("lng" IS NULL OR "lng" BETWEEN -180 AND 180);
ALTER TABLE "customer_site" ADD CONSTRAINT "customer_site_latlng_pair" CHECK (("lat" IS NULL) = ("lng" IS NULL));
ALTER TABLE "customer_site" ADD CONSTRAINT "customer_site_open_time_format" CHECK ("open_time" IS NULL OR "open_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
ALTER TABLE "customer_site" ADD CONSTRAINT "customer_site_close_time_format" CHECK ("close_time" IS NULL OR "close_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
ALTER TABLE "customer_site" ADD CONSTRAINT "customer_site_dwell_range" CHECK ("avg_dwell_min" IS NULL OR "avg_dwell_min" BETWEEN 0 AND 720);
ALTER TABLE "customer_site" ADD CONSTRAINT "customer_site_free_time_range" CHECK ("free_time_min" IS NULL OR "free_time_min" BETWEEN 0 AND 1440);
ALTER TABLE "customer_site" ADD CONSTRAINT "customer_site_max_vehicle_class" CHECK ("max_vehicle_class" IS NULL OR "max_vehicle_class" IN ('6W', '10W', 'TRAILER', 'SEMI_TRAILER'));

CREATE INDEX "customer_site_tenant_kind_idx" ON "customer_site"("tenant_id", "kind");

-- ตาราง customer_site เปิด RLS แล้วตั้งแต่ 0004 (schema v0) — เรียกซ้ำได้ (idempotent)
SELECT tms_enable_tenant_rls('customer_site');

-- ไม่มีการลบจริง (D7 / MD-004): "ลบ" = ตั้ง deleted_at
REVOKE DELETE ON "customer_site" FROM tms_app;
