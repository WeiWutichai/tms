-- ST2-T04 ประเภทรถ (vehicle_type): ชั้นรถ, capability tags, ห้องเย็น (อุณหภูมิ), แถวค่าเริ่มต้นของระบบ, externalId, soft delete, version
-- spec/02 §4 + plan/00a (master ตาม spec, คง enum ของ docs เป็นชั้นรถ), docs/04 B (capability tags: ห้องเย็น ติดเครน ลากตู้)
-- ค่าเริ่มต้นภาษาไทยไม่อยู่ใน migration — เขียนโดย bootstrap (src/modules/tenants/bootstrap.ts) ซึ่ง `db:migrate` เรียกต่อท้ายให้ทุก tenant

ALTER TABLE "vehicle_type" ADD COLUMN     "capability_tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "deleted_at" TIMESTAMPTZ(6),
ADD COLUMN     "deleted_external_id" TEXT,
ADD COLUMN     "external_id" TEXT,
ADD COLUMN     "system_key" TEXT,
ADD COLUMN     "temp_max_c" DECIMAL(4,1),
ADD COLUMN     "temp_min_c" DECIMAL(4,1),
ADD COLUMN     "vehicle_class" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- แถวเดิม (ถ้ามี — schema v0 ยังไม่มีหน้าจอสร้าง) : ชั้นรถเดาจากรหัส ไม่ตรง = 6W · รหัสตัวใหญ่
UPDATE "vehicle_type" SET "vehicle_class" = CASE
    WHEN upper("code") IN ('4W', 'PICKUP') THEN '4W'
    WHEN upper("code") IN ('10W') THEN '10W'
    WHEN upper("code") IN ('TRL', 'TRAILER') THEN 'TRAILER'
    WHEN upper("code") IN ('TRC', 'SEMI_TRAILER') THEN 'SEMI_TRAILER'
    ELSE '6W' END
  WHERE "vehicle_class" IS NULL;
UPDATE "vehicle_type" SET "code" = upper("code") WHERE "code" <> upper("code");
UPDATE "vehicle_type" SET "min_licence_class" = NULL
  WHERE "min_licence_class" IS NOT NULL AND "min_licence_class" NOT IN ('PERSONAL', 'T1', 'T2', 'T3', 'T4');
ALTER TABLE "vehicle_type" ALTER COLUMN "vehicle_class" SET NOT NULL;

CREATE INDEX "vehicle_type_tenant_id_updated_at_id_idx" ON "vehicle_type"("tenant_id", "updated_at", "id");
CREATE UNIQUE INDEX "vehicle_type_tenant_id_external_id_key" ON "vehicle_type"("tenant_id", "external_id");
CREATE UNIQUE INDEX "vehicle_type_tenant_id_system_key_key" ON "vehicle_type"("tenant_id", "system_key");
-- รหัสไม่สนตัวพิมพ์ (MD-002)
CREATE UNIQUE INDEX "vehicle_type_tenant_code_upper_uq" ON "vehicle_type"("tenant_id", upper("code"));
-- ชื่อห้ามซ้ำ (ต้นแบบ cfVt: "มีประเภทนี้แล้ว") — ไม่นับที่ลบแล้ว
CREATE UNIQUE INDEX "vehicle_type_tenant_name_uq" ON "vehicle_type"("tenant_id", lower("name_th")) WHERE "deleted_at" IS NULL;

ALTER TABLE "vehicle_type" ADD CONSTRAINT "vehicle_type_class" CHECK ("vehicle_class" IN ('4W', '6W', '10W', 'TRAILER', 'SEMI_TRAILER'));
ALTER TABLE "vehicle_type" ADD CONSTRAINT "vehicle_type_licence" CHECK ("min_licence_class" IS NULL OR "min_licence_class" IN ('PERSONAL', 'T1', 'T2', 'T3', 'T4'));
ALTER TABLE "vehicle_type" ADD CONSTRAINT "vehicle_type_capacity_kg" CHECK ("capacity_kg" IS NULL OR "capacity_kg" > 0);
ALTER TABLE "vehicle_type" ADD CONSTRAINT "vehicle_type_capacity_cbm" CHECK ("capacity_cbm" IS NULL OR "capacity_cbm" >= 0);
-- ป้ายจากรายการของระบบเท่านั้น (เพิ่มป้ายใหม่ = migration ใหม่ + VEHICLE_CAPABILITIES ใน vehicle-type.dto.ts)
ALTER TABLE "vehicle_type" ADD CONSTRAINT "vehicle_type_tags" CHECK ("capability_tags" <@ ARRAY['REFRIGERATED', 'CRANE', 'CONTAINER', 'HAZMAT']::TEXT[]);
-- ห้องเย็นต้องมีช่วงอุณหภูมิ (spec/02 §4: tempMinC/tempMaxC บังคับเมื่อ refrigerated, min < max) · ไม่ใช่ห้องเย็น = ไม่มีอุณหภูมิ
ALTER TABLE "vehicle_type" ADD CONSTRAINT "vehicle_type_temp" CHECK (
  (('REFRIGERATED' = ANY("capability_tags")) AND "temp_min_c" IS NOT NULL AND "temp_max_c" IS NOT NULL AND "temp_min_c" < "temp_max_c")
  OR (NOT ('REFRIGERATED' = ANY("capability_tags")) AND "temp_min_c" IS NULL AND "temp_max_c" IS NULL));

-- ตาราง vehicle_type เปิด RLS แล้วตั้งแต่ 0004 (schema v0) — เรียกซ้ำได้ (idempotent)
SELECT tms_enable_tenant_rls('vehicle_type');

-- ไม่มีการลบจริง (D7 / MD-004): "ลบ" = ตั้ง deleted_at
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE DELETE ON "vehicle_type" FROM tms_app';
  END IF;
END $$;
