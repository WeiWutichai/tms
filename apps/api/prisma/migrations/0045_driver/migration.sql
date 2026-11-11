-- ST2-T08 คนขับ (driver): รหัส DRV-0001, เบอร์บังคับ + normalize (ห้ามซ้ำ), เลขบัตรประชาชนเข้ารหัส + 4 หลักท้าย + blind index (กันซ้ำ),
-- สถานะ พร้อมใช้/ลาพัก/ปิดใช้งาน + เหตุผล, FK รถร่วม/รถประจำ, ใบขับขี่ PERSONAL/T1–T4, externalId + soft delete (MD-004)
-- docs/01 §3.2, docs/04 B คนขับ, spec/06 FLT-P

-- ตรวจก่อน (แถวเดิมจาก schema v0 ถ้ามี — ยังไม่มีหน้าจอสร้างคนขับก่อน ST2-T08) : ข้อมูลที่จะทำให้ NOT NULL/CHECK/FK ด้านล่างล้ม → หยุดพร้อมข้อความ
DO $$
DECLARE r record;
BEGIN
  SELECT tenant_id, name INTO r FROM "driver" WHERE phone IS NULL OR btrim(phone) = '' LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0045: คนขับไม่มีเบอร์โทร (tenant %, ชื่อ %) — ใส่เบอร์ก่อน migrate', r.tenant_id, r.name; END IF;
  SELECT tenant_id, name INTO r FROM "driver" d
    WHERE carrier_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "carrier" c WHERE c.id = d.carrier_id) LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0045: คนขับอ้างรถร่วมที่ไม่มี (tenant %, ชื่อ %)', r.tenant_id, r.name; END IF;
  SELECT tenant_id, name INTO r FROM "driver" d
    WHERE default_vehicle_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "vehicle" v WHERE v.id = d.default_vehicle_id) LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0045: คนขับอ้างรถประจำที่ไม่มี (tenant %, ชื่อ %)', r.tenant_id, r.name; END IF;
  SELECT tenant_id, name INTO r FROM "driver" WHERE employment_type <> 'CARRIER_DRIVER' AND carrier_id IS NOT NULL LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0045: คนขับบริษัทมี carrier_id (tenant %, ชื่อ %) — ล้าง carrier_id ก่อน migrate', r.tenant_id, r.name; END IF;
  SELECT tenant_id, name, licence_class INTO r FROM "driver"
    WHERE licence_class IS NOT NULL AND licence_class NOT IN ('PERSONAL', 'T1', 'T2', 'T3', 'T4') LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0045: ประเภทใบขับขี่ไม่รู้จัก (tenant %, ชื่อ %, ค่า %) — ใช้ PERSONAL/T1/T2/T3/T4', r.tenant_id, r.name, r.licence_class; END IF;
END $$;

-- CreateEnum
CREATE TYPE "driver_status" AS ENUM ('ACTIVE', 'ON_LEAVE', 'INACTIVE');

-- AlterTable (คอลัมน์ใหม่ nullable ก่อน → เติมค่าแถวเดิม → NOT NULL)
ALTER TABLE "driver" ADD COLUMN     "code" TEXT,
ADD COLUMN     "deleted_at" TIMESTAMPTZ(6),
ADD COLUMN     "deleted_external_id" TEXT,
ADD COLUMN     "national_id_enc" TEXT,
ADD COLUMN     "national_id_hash" TEXT,
ADD COLUMN     "national_id_last4" CHAR(4),
ADD COLUMN     "phone_norm" TEXT,
ADD COLUMN     "status_reason" TEXT;

-- สถานะเดิม active_status → driver_status (ACTIVE/INACTIVE ชื่อเดิม)
ALTER TABLE "driver" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "driver" ALTER COLUMN "status" TYPE "driver_status" USING ("status"::text::"driver_status");
ALTER TABLE "driver" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';

-- แถวเดิม: รหัสเรียงตามวันที่สร้างต่อ tenant · เบอร์ normalize สูตรเดียวกับ phoneNorm() ใน drivers.service.ts
UPDATE "driver" d SET "code" = 'DRV-' || lpad(x.rn::text, 4, '0')
  FROM (SELECT id, row_number() OVER (PARTITION BY tenant_id ORDER BY created_at, id) AS rn FROM "driver") x
  WHERE x.id = d.id;
UPDATE "driver" SET "phone_norm" = CASE
    WHEN regexp_replace("phone", '\D', '', 'g') ~ '^66\d{8,9}$' THEN '0' || substr(regexp_replace("phone", '\D', '', 'g'), 3)
    ELSE regexp_replace("phone", '\D', '', 'g') END;
ALTER TABLE "driver" ALTER COLUMN "code" SET NOT NULL;
ALTER TABLE "driver" ALTER COLUMN "phone" SET NOT NULL;
ALTER TABLE "driver" ALTER COLUMN "phone_norm" SET NOT NULL;

-- ตรวจซ้ำหลังเติมค่า (unique ด้านล่าง)
DO $$
DECLARE r record;
BEGIN
  SELECT tenant_id, name, phone INTO r FROM "driver" WHERE phone_norm !~ '^0\d{8,9}$' LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0045: เบอร์คนขับรูปแบบผิด (tenant %, ชื่อ %, เบอร์ %) — ใช้เบอร์ไทย 9–10 หลัก', r.tenant_id, r.name, r.phone; END IF;
  SELECT tenant_id, phone_norm, count(*) AS n INTO r FROM "driver"
    WHERE status <> 'INACTIVE' GROUP BY 1, 2 HAVING count(*) > 1 LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0045: เบอร์คนขับซ้ำ (tenant %, เบอร์ %, % คน) — ปิดใช้งาน/แก้เบอร์ก่อน migrate', r.tenant_id, r.phone_norm, r.n; END IF;
END $$;

-- CreateIndex
CREATE INDEX "driver_tenant_id_carrier_id_idx" ON "driver"("tenant_id", "carrier_id");
CREATE INDEX "driver_tenant_id_default_vehicle_id_idx" ON "driver"("tenant_id", "default_vehicle_id");
CREATE INDEX "driver_tenant_id_licence_expires_at_idx" ON "driver"("tenant_id", "licence_expires_at");
CREATE UNIQUE INDEX "driver_tenant_id_code_key" ON "driver"("tenant_id", "code");
-- spec/06 FLT-P: เบอร์ห้ามซ้ำในคนขับที่ยังใช้งาน (ใช้ login แอป) — ปิดใช้งาน/ลบแล้วนำเบอร์ไปใช้ใหม่ได้ (เปลี่ยนสังกัดรถร่วม = ปิด record เดิม สร้างใหม่)
CREATE UNIQUE INDEX "driver_tenant_phone_active_uq" ON "driver"("tenant_id", "phone_norm")
  WHERE "deleted_at" IS NULL AND "status" <> 'INACTIVE';
-- เลขบัตรประชาชนซ้ำไม่ได้ (เทียบด้วย blind index) — เงื่อนไขเดียวกับเบอร์
CREATE UNIQUE INDEX "driver_tenant_national_id_active_uq" ON "driver"("tenant_id", "national_id_hash")
  WHERE "deleted_at" IS NULL AND "status" <> 'INACTIVE' AND "national_id_hash" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "driver" ADD CONSTRAINT "driver_carrier_id_fkey" FOREIGN KEY ("carrier_id") REFERENCES "carrier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "driver" ADD CONSTRAINT "driver_default_vehicle_id_fkey" FOREIGN KEY ("default_vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- กติกาที่ฐานข้อมูลบังคับ (ซ้ำกับ service — กันข้อมูลผิดจากทางอื่น) · CARRIER_DRIVER ต้องมี carrier_id มีอยู่แล้วตั้งแต่ 0004
ALTER TABLE "driver" ADD CONSTRAINT "driver_employee_no_carrier" CHECK ("employment_type" = 'CARRIER_DRIVER' OR "carrier_id" IS NULL);
ALTER TABLE "driver" ADD CONSTRAINT "driver_licence_class" CHECK ("licence_class" IS NULL OR "licence_class" IN ('PERSONAL', 'T1', 'T2', 'T3', 'T4'));
ALTER TABLE "driver" ADD CONSTRAINT "driver_national_id" CHECK (
  ("national_id_enc" IS NULL AND "national_id_last4" IS NULL AND "national_id_hash" IS NULL)
  OR ("national_id_enc" IS NOT NULL AND "national_id_last4" ~ '^\d{4}$'));
ALTER TABLE "driver" ADD CONSTRAINT "driver_phone_norm" CHECK ("phone_norm" ~ '^0\d{8,9}$');

SELECT tms_enable_tenant_rls('driver');

-- ไม่มีการลบจริง (D7 / MD-004): "ลบ" = ตั้ง deleted_at
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE DELETE ON "driver" FROM tms_app';
  END IF;
END $$;
