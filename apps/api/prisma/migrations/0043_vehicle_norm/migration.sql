-- ST2-T06 review: ทะเบียน/เลขตัวถัง normalize แยกคอลัมน์
-- plate_norm = ทะเบียนอย่างเดียว (เลขไทย ๐-๙ → 0-9, ตัดช่องว่าง/ขีด/จุด, ตัวใหญ่) — ใช้ค้นหา (เดิมค้นใน plate_key ซึ่งมีรหัสจังหวัดติดมา)
-- plate_key = plate_norm || '|' || จังหวัด (คำนวณใหม่ให้รวมเลขไทย) · chassis_norm = เลขตัวถังตัดช่องว่าง/ขีด/จุด/ทับ ตัวใหญ่ (MNT-123ABC = MNT123ABC)
-- สูตรเดียวกับ plateNorm()/chassisNorm() ใน src/modules/vehicles/vehicles.service.ts

ALTER TABLE "vehicle" ADD COLUMN "plate_norm" TEXT, ADD COLUMN "chassis_norm" TEXT;

UPDATE "vehicle" SET
  "plate_norm" = upper(regexp_replace(translate("plate", '๐๑๒๓๔๕๖๗๘๙', '0123456789'), '[\s\-.]', '', 'g')),
  "chassis_norm" = CASE WHEN "chassis_no" IS NULL THEN NULL
    ELSE upper(regexp_replace("chassis_no", '[\s\-./]', '', 'g')) END;
UPDATE "vehicle" SET "plate_key" = "plate_norm" || '|' || "plate_province";

DO $$
DECLARE r record;
BEGIN
  SELECT tenant_id, plate_key, count(*) AS n INTO r FROM "vehicle"
    WHERE deleted_at IS NULL AND status <> 'RETIRED' GROUP BY 1, 2 HAVING count(*) > 1 LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0043: ทะเบียนซ้ำเมื่อแปลงเลขไทย/ตัดขีด (tenant %, %, % คัน) — แก้ทะเบียนก่อน migrate', r.tenant_id, r.plate_key, r.n; END IF;
  SELECT tenant_id, chassis_norm, count(*) AS n INTO r FROM "vehicle"
    WHERE deleted_at IS NULL AND chassis_norm IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1 LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0043: เลขตัวถังซ้ำเมื่อตัดขีด/ช่องว่าง (tenant %, %, % คัน)', r.tenant_id, r.chassis_norm, r.n; END IF;
  SELECT tenant_id, plate, year INTO r FROM "vehicle" WHERE year IS NOT NULL AND year < 1980 LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0043: ปีผลิตก่อน 1980 (tenant %, ทะเบียน %, ปี %) — spec/06 FLT-A', r.tenant_id, r.plate, r.year; END IF;
END $$;

ALTER TABLE "vehicle" ALTER COLUMN "plate_norm" SET NOT NULL;
CREATE INDEX "vehicle_tenant_id_plate_norm_idx" ON "vehicle"("tenant_id", "plate_norm");

DROP INDEX "vehicle_tenant_chassis_uq";
CREATE UNIQUE INDEX "vehicle_tenant_chassis_uq" ON "vehicle"("tenant_id", "chassis_norm")
  WHERE "deleted_at" IS NULL AND "chassis_norm" IS NOT NULL;
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_chassis_norm" CHECK (("chassis_no" IS NULL) = ("chassis_norm" IS NULL));

-- spec/06 FLT-A: ปีผลิต 1980 – ปีปัจจุบัน + 1 (ขอบบนตรวจที่ service)
ALTER TABLE "vehicle" DROP CONSTRAINT "vehicle_year";
ALTER TABLE "vehicle" ADD CONSTRAINT "vehicle_year" CHECK ("year" IS NULL OR "year" BETWEEN 1980 AND 2200);
