-- ST2-T11 ค่าบริการเสริม (service_item = accessorial catalog): หน่วยคิด, ราคาตั้งต้น, ราคาน้ำมันอ้างอิง, เงื่อนไข, ฝั่ง (ขาย/ซื้อ/ทั้งคู่),
-- แถวค่าเริ่มต้นของระบบ, externalId, soft delete, version — docs/01 §3.2, docs/04 B Accessorial catalog, spec/02 §6
-- vat_type / wht_rate ยังอยู่ที่ catalog เป็น "ค่าตั้งต้น" และถูก snapshot ลงบรรทัดเอกสาร (src/modules/service-items/snapshot.ts)
-- คู่ VAT × WHT ที่ยอมรับตรวจใน @tms/domain (serviceItemTaxProblem) ไม่ใส่เป็น CHECK — กฎรอนักบัญชี (ACC-3) ต้องแก้ได้โดยไม่ต้อง migrate
-- ค่าเริ่มต้นภาษาไทยไม่อยู่ใน migration — เขียนโดย bootstrap ขั้น `service-items` (db:migrate เรียกต่อท้ายให้ทุก tenant)

-- ตรวจก่อน (แถวเดิมจาก schema v0 ถ้ามี): ข้อมูลที่จะทำให้ index/CHECK ด้านล่างล้ม → หยุดพร้อมข้อความชัด ให้แก้ข้อมูลก่อน
DO $$
DECLARE r record;
BEGIN
  SELECT tenant_id, upper(code) AS c, count(*) AS n INTO r FROM "service_item"
    GROUP BY tenant_id, upper(code) HAVING count(*) > 1 LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0050: service_item มีรหัสซ้ำเมื่อไม่สนตัวพิมพ์ (tenant %, รหัส %, % แถว) — แก้รหัสให้ไม่ซ้ำก่อน migrate', r.tenant_id, r.c, r.n; END IF;
  SELECT tenant_id, lower(name_th) AS c, count(*) AS n INTO r FROM "service_item"
    GROUP BY tenant_id, lower(name_th) HAVING count(*) > 1 LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0050: service_item มีชื่อซ้ำเมื่อไม่สนตัวพิมพ์ (tenant %, ชื่อ "%", % แถว) — เปลี่ยนชื่อให้ไม่ซ้ำก่อน migrate', r.tenant_id, r.c, r.n; END IF;
  SELECT tenant_id, code, wht_rate INTO r FROM "service_item" WHERE wht_rate NOT IN (0, 1, 3) LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0050: service_item อัตราหัก ณ ที่จ่ายไม่ใช่ 0/1/3 (tenant %, รหัส %, อัตรา %) — แก้ให้ถูกก่อน migrate', r.tenant_id, r.code, r.wht_rate; END IF;
END $$;

-- CreateEnum
CREATE TYPE "service_item_side" AS ENUM ('SELL', 'BUY', 'BOTH');

-- AlterTable (calc_unit เพิ่มแบบมีค่าตั้งต้นก่อน แล้วถอด default — แถวเดิมจาก schema v0 = ต่อเที่ยว)
ALTER TABLE "service_item" ADD COLUMN     "calc_unit" TEXT NOT NULL DEFAULT 'PER_TRIP',
ADD COLUMN     "condition_text" TEXT,
ADD COLUMN     "default_price" DECIMAL(14,2),
ADD COLUMN     "deleted_at" TIMESTAMPTZ(6),
ADD COLUMN     "deleted_external_id" TEXT,
ADD COLUMN     "external_id" TEXT,
ADD COLUMN     "fuel_ref_price" DECIMAL(14,2),
ADD COLUMN     "side" "service_item_side" NOT NULL DEFAULT 'BOTH',
ADD COLUMN     "system_key" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "service_item" ALTER COLUMN "calc_unit" DROP DEFAULT;
UPDATE "service_item" SET "code" = upper("code") WHERE "code" <> upper("code");

-- CreateIndex
CREATE INDEX "service_item_tenant_id_updated_at_id_idx" ON "service_item"("tenant_id", "updated_at", "id");
CREATE UNIQUE INDEX "service_item_tenant_id_external_id_key" ON "service_item"("tenant_id", "external_id");
CREATE UNIQUE INDEX "service_item_tenant_id_system_key_key" ON "service_item"("tenant_id", "system_key");
-- รหัสไม่สนตัวพิมพ์ (MD-002)
CREATE UNIQUE INDEX "service_item_tenant_code_upper_uq" ON "service_item"("tenant_id", upper("code"));
-- ชื่อห้ามซ้ำ (ต้นแบบ cfAx: "มีรายการนี้แล้ว") — ไม่นับที่ลบแล้ว
CREATE UNIQUE INDEX "service_item_tenant_name_uq" ON "service_item"("tenant_id", lower("name_th")) WHERE "deleted_at" IS NULL;

-- หน่วยคิดจากรายการของระบบ (ต้นแบบ cfAx: ต่อเที่ยว/ต่อชั่วโมง/ต่อคืน/ต่อจุด/% ของค่าขนส่ง/ตามจริง)
ALTER TABLE "service_item" ADD CONSTRAINT "service_item_calc_unit" CHECK ("calc_unit" IN ('PER_TRIP', 'PER_HOUR', 'PER_NIGHT', 'PER_STOP', 'PERCENT_OF_FREIGHT', 'ACTUAL'));
-- หัก ณ ที่จ่าย: ไม่หัก / 1% (ค่าขนส่ง ท.ป.4/2528 ข้อ 12/4) / 3% (ค่าบริการ ข้อ 12/1)
ALTER TABLE "service_item" ADD CONSTRAINT "service_item_wht_rate" CHECK ("wht_rate" IN (0, 1, 3));
-- ราคา ≥ 0 · % ของค่าขนส่ง ≤ 100 · ตามจริง = ไม่มีราคาตั้งต้น (ตามใบเสร็จ)
ALTER TABLE "service_item" ADD CONSTRAINT "service_item_price" CHECK (
  ("default_price" IS NULL OR "default_price" >= 0)
  AND ("calc_unit" <> 'PERCENT_OF_FREIGHT' OR "default_price" IS NULL OR "default_price" <= 100)
  AND ("calc_unit" <> 'ACTUAL' OR "default_price" IS NULL));
-- ราคาน้ำมันอ้างอิงใช้กับ % ของค่าขนส่งเท่านั้น
ALTER TABLE "service_item" ADD CONSTRAINT "service_item_fuel_ref" CHECK (
  "fuel_ref_price" IS NULL OR ("calc_unit" = 'PERCENT_OF_FREIGHT' AND "fuel_ref_price" > 0));

-- ตาราง service_item เปิด RLS แล้วตั้งแต่ 0004 (schema v0) — เรียกซ้ำได้ (idempotent)
SELECT tms_enable_tenant_rls('service_item');

-- ไม่มีการลบจริง (D7 / MD-004): "ลบ" = ตั้ง deleted_at
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE DELETE ON "service_item" FROM tms_app';
  END IF;
END $$;
