-- ST2-T06 รถ (vehicle): ทะเบียน normalize + unique เฉพาะคันที่ยังไม่ปลดระวาง (FLT-001), หัวลาก ↔ หาง, ทะเบียนรถขยาย (docs/01 §3.8),
-- ต้นทุนซื้อ/ค่าเสื่อม, รูปรถ, เหตุผลสถานะ/วันปลดระวาง, externalId + soft delete, ประวัติเลขไมล์ (spec/06 FLT-O)

-- ตรวจก่อน (แถวเดิมจาก schema v0 ถ้ามี — ยังไม่มีหน้าจอสร้างรถก่อน ST2-T06) : ข้อมูลที่จะทำให้ CHECK/FK ด้านล่างล้ม → หยุดพร้อมข้อความ
DO $$
DECLARE r record;
BEGIN
  SELECT tenant_id, plate INTO r FROM "vehicle" v
    WHERE NOT EXISTS (SELECT 1 FROM "vehicle_type" t WHERE t.id = v.vehicle_type_id) LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0042: vehicle อ้างประเภทรถที่ไม่มี (tenant %, ทะเบียน %) — แก้ vehicle_type_id ก่อน migrate', r.tenant_id, r.plate; END IF;
  SELECT tenant_id, plate INTO r FROM "vehicle" v
    WHERE carrier_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "carrier" c WHERE c.id = v.carrier_id) LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0042: vehicle อ้างรถร่วมที่ไม่มี (tenant %, ทะเบียน %)', r.tenant_id, r.plate; END IF;
  SELECT tenant_id, plate INTO r FROM "vehicle" WHERE ownership = 'OWN' AND carrier_id IS NOT NULL LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0042: รถบริษัทมี carrier_id (tenant %, ทะเบียน %) — ล้าง carrier_id ก่อน migrate', r.tenant_id, r.plate; END IF;
  SELECT tenant_id, plate INTO r FROM "vehicle" WHERE paired_vehicle_id IS NOT NULL LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0042: มีรถที่จับคู่หัวลาก-หางไว้ก่อน (tenant %, ทะเบียน %) — ล้าง paired_vehicle_id ก่อน migrate', r.tenant_id, r.plate; END IF;
  -- ข้อมูลที่จะชน unique/CHECK ด้านล่าง (review ST2-T06)
  SELECT tenant_id, upper(regexp_replace(plate, '[\s\-.]', '', 'g')) AS p, plate_province, count(*) AS n INTO r FROM "vehicle"
    WHERE status <> 'RETIRED' GROUP BY 1, 2, 3 HAVING count(*) > 1 LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0042: ทะเบียนซ้ำเมื่อตัดช่องว่าง/ขีด (tenant %, ทะเบียน % จังหวัด %, % คัน) — ปลดระวาง/แก้ทะเบียนก่อน migrate', r.tenant_id, r.p, r.plate_province, r.n; END IF;
  SELECT tenant_id, upper(chassis_no) AS c, count(*) AS n INTO r FROM "vehicle"
    WHERE chassis_no IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1 LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0042: เลขตัวถังซ้ำ (ไม่สนตัวพิมพ์) (tenant %, เลข %, % คัน)', r.tenant_id, r.c, r.n; END IF;
  SELECT tenant_id, lower(gps_provider) AS g, gps_device_id, count(*) AS n INTO r FROM "vehicle"
    WHERE gps_device_id IS NOT NULL AND status <> 'RETIRED' GROUP BY 1, 2, 3 HAVING count(*) > 1 LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0042: เลขอุปกรณ์ GPS ซ้ำ (tenant %, ค่าย %, เลข %, % คัน)', r.tenant_id, r.g, r.gps_device_id, r.n; END IF;
  SELECT tenant_id, plate, fuel_type INTO r FROM "vehicle"
    WHERE fuel_type IS NOT NULL AND fuel_type NOT IN ('DIESEL', 'GASOLINE', 'NGV', 'LPG', 'EV', 'HYBRID') LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0042: ชนิดเชื้อเพลิงไม่รู้จัก (tenant %, ทะเบียน %, ค่า %) — ใช้ DIESEL/GASOLINE/NGV/LPG/EV/HYBRID', r.tenant_id, r.plate, r.fuel_type; END IF;
  SELECT tenant_id, plate, year INTO r FROM "vehicle" WHERE year IS NOT NULL AND year NOT BETWEEN 1950 AND 2200 LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0042: ปีผลิตผิด (tenant %, ทะเบียน %, ปี %)', r.tenant_id, r.plate, r.year; END IF;
  SELECT tenant_id, plate, capacity_kg, capacity_cbm INTO r FROM "vehicle"
    WHERE capacity_kg <= 0 OR capacity_cbm < 0 OR purchase_cost < 0 LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0042: น้ำหนัก/ปริมาตร/ราคาซื้อผิด (tenant %, ทะเบียน %, น้ำหนัก %, ปริมาตร %)', r.tenant_id, r.plate, r.capacity_kg, r.capacity_cbm; END IF;
END $$;

-- DropIndex (แทนด้วย unique แบบ normalize ด้านล่าง)
DROP INDEX "vehicle_tenant_id_plate_plate_province_key";

-- AlterTable
ALTER TABLE "vehicle" ADD COLUMN     "deleted_at" TIMESTAMPTZ(6),
ADD COLUMN     "deleted_external_id" TEXT,
ADD COLUMN     "depreciation_method" TEXT,
ADD COLUMN     "depreciation_years" INTEGER,
ADD COLUMN     "gross_weight_kg" DECIMAL(10,2),
ADD COLUMN     "odometer_source" TEXT,
ADD COLUMN     "odometer_updated_at" TIMESTAMPTZ(6),
ADD COLUMN     "photo_document_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
ADD COLUMN     "plate_key" TEXT,
ADD COLUMN     "retired_at" TIMESTAMPTZ(6),
ADD COLUMN     "salvage_value" DECIMAL(14,2),
ADD COLUMN     "status_reason" TEXT,
ADD COLUMN     "tank_capacity_l" INTEGER,
ADD COLUMN     "tare_weight_kg" DECIMAL(10,2),
ADD COLUMN     "unit_role" TEXT NOT NULL DEFAULT 'SINGLE';

-- แถวเดิม: plate_key จากทะเบียน (ตัดช่องว่าง/ขีด/จุด, ตัวใหญ่) + จังหวัด — สูตรเดียวกับ plateKey() ใน vehicles.service.ts
UPDATE "vehicle" SET "plate_key" = upper(regexp_replace("plate", '[\s\-.]', '', 'g')) || '|' || "plate_province";
ALTER TABLE "vehicle" ALTER COLUMN "plate_key" SET NOT NULL;
UPDATE "vehicle" SET "retired_at" = "updated_at" WHERE "status" = 'RETIRED' AND "retired_at" IS NULL;

-- CreateTable
CREATE TABLE "vehicle_odometer_reading" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "reading_km" DECIMAL(10,1) NOT NULL,
    "read_at" TIMESTAMPTZ(6) NOT NULL,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACCEPTED',
    "reason_type" TEXT,
    "note" TEXT,
    "original_reading_id" UUID,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_odometer_reading_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vehicle_odometer_reading_tenant_id_vehicle_id_read_at_idx" ON "vehicle_odometer_reading"("tenant_id", "vehicle_id", "read_at");
CREATE UNIQUE INDEX "vehicle_paired_vehicle_id_key" ON "vehicle"("paired_vehicle_id");
CREATE INDEX "vehicle_tenant_id_plate_key_id_idx" ON "vehicle"("tenant_id", "plate_key", "id");
CREATE INDEX "vehicle_tenant_id_vehicle_type_id_idx" ON "vehicle"("tenant_id", "vehicle_type_id");
CREATE INDEX "vehicle_tenant_id_carrier_id_idx" ON "vehicle"("tenant_id", "carrier_id");

-- FLT-001: ทะเบียน + จังหวัดซ้ำไม่ได้ เว้นแต่คันเดิมปลดระวาง (หรือลบแล้ว)
CREATE UNIQUE INDEX "vehicle_tenant_plate_active_uq" ON "vehicle"("tenant_id", "plate_key")
  WHERE "deleted_at" IS NULL AND "status" <> 'RETIRED';
-- docs/01 §3.8: เลขตัวถัง unique ต่อ tenant เมื่อมีค่า (ไม่สนตัวพิมพ์) — ไม่นับที่ลบ
CREATE UNIQUE INDEX "vehicle_tenant_chassis_uq" ON "vehicle"("tenant_id", upper("chassis_no"))
  WHERE "deleted_at" IS NULL AND "chassis_no" IS NOT NULL;
-- spec/06 FLT-A: เลขอุปกรณ์ GPS unique ต่อค่าย — ไม่นับที่ลบ/ปลดระวาง
CREATE UNIQUE INDEX "vehicle_tenant_gps_uq" ON "vehicle"("tenant_id", lower("gps_provider"), "gps_device_id")
  WHERE "deleted_at" IS NULL AND "status" <> 'RETIRED' AND "gps_device_id" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_vehicle_type_id_fkey" FOREIGN KEY ("vehicle_type_id") REFERENCES "vehicle_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_carrier_id_fkey" FOREIGN KEY ("carrier_id") REFERENCES "carrier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_paired_vehicle_id_fkey" FOREIGN KEY ("paired_vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vehicle_odometer_reading" ADD CONSTRAINT "vehicle_odometer_reading_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- กติกาที่ฐานข้อมูลบังคับ (ซ้ำกับ service — กันข้อมูลผิดจากทางอื่น)
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_own_no_carrier" CHECK ("ownership" = 'SUBCONTRACT' OR "carrier_id" IS NULL);
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_unit_role" CHECK ("unit_role" IN ('SINGLE', 'TRACTOR', 'TRAILER'));
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_pair_not_self" CHECK ("paired_vehicle_id" IS NULL OR "paired_vehicle_id" <> "id");
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_pair_role" CHECK ("paired_vehicle_id" IS NULL OR "unit_role" IN ('TRACTOR', 'TRAILER'));
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_fuel_type" CHECK ("fuel_type" IS NULL OR "fuel_type" IN ('DIESEL', 'GASOLINE', 'NGV', 'LPG', 'EV', 'HYBRID'));
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_odometer_source" CHECK ("odometer_source" IS NULL OR "odometer_source" IN ('MANUAL', 'TRIP', 'GPS', 'FUEL_LOG', 'WORK_ORDER'));
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_year" CHECK ("year" IS NULL OR "year" BETWEEN 1950 AND 2200);
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_weights" CHECK (
  ("capacity_kg" IS NULL OR "capacity_kg" > 0) AND ("capacity_cbm" IS NULL OR "capacity_cbm" >= 0)
  AND ("tare_weight_kg" IS NULL OR "tare_weight_kg" > 0) AND ("gross_weight_kg" IS NULL OR "gross_weight_kg" > 0));
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_tank" CHECK ("tank_capacity_l" IS NULL OR "tank_capacity_l" BETWEEN 1 AND 5000);
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_money" CHECK (
  ("purchase_cost" IS NULL OR "purchase_cost" >= 0) AND ("salvage_value" IS NULL OR "salvage_value" >= 0));
-- ค่าเสื่อมเส้นตรง: ต้องมีจำนวนปีและราคาซื้อ · ซากไม่เกินราคาซื้อ (FLT-004)
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_depreciation" CHECK (
  ("depreciation_method" IS NULL AND "depreciation_years" IS NULL AND "salvage_value" IS NULL)
  OR ("depreciation_method" = 'STRAIGHT_LINE' AND "depreciation_years" BETWEEN 1 AND 30 AND "purchase_cost" IS NOT NULL
      AND ("salvage_value" IS NULL OR "salvage_value" <= "purchase_cost")));
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_retired_at" CHECK (("status" = 'RETIRED') = ("retired_at" IS NOT NULL));
ALTER TABLE "vehicle_odometer_reading" ADD CONSTRAINT "vehicle_odometer_reading_km" CHECK ("reading_km" >= 0);
ALTER TABLE "vehicle_odometer_reading" ADD CONSTRAINT "vehicle_odometer_reading_status" CHECK ("status" IN ('ACCEPTED', 'SUPERSEDED'));
ALTER TABLE "vehicle_odometer_reading" ADD CONSTRAINT "vehicle_odometer_reading_reason" CHECK (
  "reason_type" IS NULL OR "reason_type" IN ('TYPO', 'METER_REPLACED', 'GPS_ERROR', 'MISSED_ENTRY', 'OTHER'));

SELECT tms_enable_tenant_rls('vehicle');
SELECT tms_enable_tenant_rls('vehicle_odometer_reading');

-- ไม่มีการลบจริง (D7 / FLT-008): "ลบ" = ตั้ง deleted_at · ประวัติเลขไมล์ไม่ลบ (แก้ = แถวใหม่)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE DELETE ON "vehicle", "vehicle_odometer_reading" FROM tms_app';
  END IF;
END $$;
