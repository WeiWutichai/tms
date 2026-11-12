-- ST2-T13 Rate card ขาขาย (ST2-T14 ขาซื้อใช้ตารางเดียวกัน side = BUY) — docs/01 §3.2 rate_card, docs/04 B Rate card + B1, spec/02 §5
-- โครงแถวเดียวต่อราคาตามต้นแบบ TMS v4 (specRate) — D-29 ให้หัว+บรรทัดตาม spec → [OPEN spec/12 §3] (ย้ายได้: สร้างหัวต่อแถวภายหลัง)
-- key = ฝั่ง + ลูกค้า/รถร่วม + ต้นทาง + ปลายทาง + ประเภทรถ · ช่วงวันของ rate ที่ใช้งาน (APPROVED/PENDING_APPROVAL) ใน key เดียวกันห้ามทับ
--   → exclusion constraint (btree_gist) กันที่ฐานข้อมูล + advisory lock ต่อ key ในแอป (ร่างตรวจในแอป เพราะฉบับแก้ไขทับฉบับเดิมได้จนกว่าจะอนุมัติ)
-- "หมดอายุ" ไม่เก็บเป็นสถานะ — คำนวณจาก valid_to < วันนี้ (API + lookup ไม่ใช้ rate หมดอายุ)

-- rate_card เปิด FORCE RLS (0004) — ปิด row security ช่วงตรวจ/เติมข้อมูล ไม่งั้น query ไม่เห็นแถว (ผ่านทั้งที่ข้อมูลผิด) — แบบ 0044/0047
SET row_security = off;

-- ตรวจก่อน: แถวจาก schema v0 (ถ้ามี) ต้องมีประเภทรถ + ต้นทาง/ปลายทาง (ยังไม่รองรับโซน) → ไม่งั้นหยุดพร้อมข้อความ ให้แก้ข้อมูลก่อน
DO $$
DECLARE r record;
BEGIN
  SELECT tenant_id, id INTO r FROM "rate_card" WHERE vehicle_type_id IS NULL LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0053: rate_card ไม่มีประเภทรถ (tenant %, id %) — ระบุ vehicle_type_id ก่อน migrate', r.tenant_id, r.id; END IF;
  SELECT tenant_id, id INTO r FROM "rate_card" WHERE origin_site_id IS NULL OR dest_site_id IS NULL OR origin_site_id = dest_site_id LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0053: rate_card ต้นทาง/ปลายทางไม่ครบหรือซ้ำกัน (tenant %, id %) — แก้ข้อมูลก่อน migrate', r.tenant_id, r.id; END IF;
  SELECT tenant_id, id INTO r FROM "rate_card" WHERE status IN ('APPROVED', 'PENDING_APPROVAL') AND EXISTS (
    SELECT 1 FROM "rate_card" o WHERE o.id <> "rate_card".id AND o.tenant_id = "rate_card".tenant_id
      AND o.side = "rate_card".side AND COALESCE(o.customer_id, o.carrier_id) = COALESCE("rate_card".customer_id, "rate_card".carrier_id)
      AND o.origin_site_id = "rate_card".origin_site_id AND o.dest_site_id = "rate_card".dest_site_id
      AND o.vehicle_type_id = "rate_card".vehicle_type_id AND o.status IN ('APPROVED', 'PENDING_APPROVAL')
      AND daterange(o.valid_from, o.valid_to, '[]') && daterange("rate_card".valid_from, "rate_card".valid_to, '[]')) LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0053: rate_card ช่วงวันทับกันใน key เดียวกัน (tenant %, id %) — แก้ช่วงวันก่อน migrate', r.tenant_id, r.id; END IF;
  -- PER_UNIT ต้องมีหน่วยนับ (คอลัมน์ unit_id เพิ่มใน migration นี้ — แถวเดิมไม่มี) · เงิน/จำนวนจุดตาม CHECK ใหม่
  SELECT tenant_id, id INTO r FROM "rate_card" WHERE pricing_model = 'PER_UNIT' LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0053: rate_card สูตร PER_UNIT ไม่มีหน่วยนับ (tenant %, id %) — เปลี่ยนสูตรหรือระบุหน่วยหลัง migrate ก่อน', r.tenant_id, r.id; END IF;
  SELECT tenant_id, id INTO r FROM "rate_card" WHERE included_stops NOT BETWEEN 0 AND 99
    OR (min_charge IS NOT NULL AND min_charge < 0) OR (extra_stop_price IS NOT NULL AND extra_stop_price < 0) LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0053: rate_card จำนวนจุด/ขั้นต่ำ/ค่าจุดเพิ่มผิด (tenant %, id %) — แก้ข้อมูลก่อน migrate', r.tenant_id, r.id; END IF;
END $$;

-- btree_gist (trusted extension — เจ้าของฐานสร้างได้) สำหรับ exclusion constraint ที่มีคอลัมน์ uuid/enum
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- AlterTable (code เพิ่มแบบ nullable → เติมรหัสให้แถวเดิม → NOT NULL)
ALTER TABLE "rate_card" ADD COLUMN     "approved_at" TIMESTAMPTZ(6),
ADD COLUMN     "approved_by_id" UUID,
ADD COLUMN     "code" TEXT,
ADD COLUMN     "deleted_at" TIMESTAMPTZ(6),
ADD COLUMN     "deleted_external_id" TEXT,
ADD COLUMN     "external_id" TEXT,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "parent_id" UUID,
ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "unit_id" UUID,
ALTER COLUMN "vehicle_type_id" SET NOT NULL,
ALTER COLUMN "included_stops" SET DEFAULT 2;
UPDATE "rate_card" r SET "code" = (CASE r.side WHEN 'SELL' THEN 'RC-S-' ELSE 'RC-B-' END) || lpad(x.n::text, 4, '0')
  FROM (SELECT id, row_number() OVER (PARTITION BY tenant_id, side ORDER BY created_at, id) AS n FROM "rate_card") x
  WHERE x.id = r.id;
ALTER TABLE "rate_card" ALTER COLUMN "code" SET NOT NULL;
RESET row_security;
-- ยกเลิกฉบับแก้ไขที่อนุมัติแล้ว → คืนวันหมด/สถานะเดิมให้ฉบับเดิม (เก็บค่าก่อนปิดไว้ที่ฉบับแก้ไข)
ALTER TABLE "rate_card" ADD COLUMN "parent_closed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "parent_prev_valid_to" DATE,
ADD COLUMN "parent_prev_status" "rate_status";

-- CreateTable
CREATE TABLE "rate_card_accessorial" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "rate_card_id" UUID NOT NULL,
    "service_item_id" UUID NOT NULL,
    "price" DECIMAL(14,2) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_card_accessorial_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rate_card_accessorial_tenant_id_service_item_id_idx" ON "rate_card_accessorial"("tenant_id", "service_item_id");
CREATE UNIQUE INDEX "rate_card_accessorial_rate_card_id_service_item_id_key" ON "rate_card_accessorial"("rate_card_id", "service_item_id");
CREATE INDEX "rate_card_tenant_id_updated_at_id_idx" ON "rate_card"("tenant_id", "updated_at", "id");
CREATE INDEX "rate_card_tenant_id_origin_site_id_dest_site_id_vehicle_typ_idx" ON "rate_card"("tenant_id", "origin_site_id", "dest_site_id", "vehicle_type_id");
CREATE UNIQUE INDEX "rate_card_tenant_id_external_id_key" ON "rate_card"("tenant_id", "external_id");
-- รหัสไม่สนตัวพิมพ์ (MD-002) — ฉบับแก้ไขใช้รหัสเดิม จึง unique ต่อ (รหัส, ฉบับที่)
CREATE UNIQUE INDEX "rate_card_tenant_code_revision_uq" ON "rate_card"("tenant_id", upper("code"), "revision");

-- AddForeignKey
ALTER TABLE "rate_card" ADD CONSTRAINT "rate_card_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "rate_card"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "rate_card" ADD CONSTRAINT "rate_card_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "rate_card" ADD CONSTRAINT "rate_card_carrier_id_fkey" FOREIGN KEY ("carrier_id") REFERENCES "carrier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "rate_card" ADD CONSTRAINT "rate_card_origin_site_id_fkey" FOREIGN KEY ("origin_site_id") REFERENCES "customer_site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "rate_card" ADD CONSTRAINT "rate_card_dest_site_id_fkey" FOREIGN KEY ("dest_site_id") REFERENCES "customer_site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "rate_card" ADD CONSTRAINT "rate_card_vehicle_type_id_fkey" FOREIGN KEY ("vehicle_type_id") REFERENCES "vehicle_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "rate_card" ADD CONSTRAINT "rate_card_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "rate_card" ADD CONSTRAINT "rate_card_service_item_id_fkey" FOREIGN KEY ("service_item_id") REFERENCES "service_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "rate_card_accessorial" ADD CONSTRAINT "rate_card_accessorial_rate_card_id_fkey" FOREIGN KEY ("rate_card_id") REFERENCES "rate_card"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "rate_card_accessorial" ADD CONSTRAINT "rate_card_accessorial_service_item_id_fkey" FOREIGN KEY ("service_item_id") REFERENCES "service_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- กติกาที่ฐานข้อมูลบังคับ
-- เฟส 0 ต้นทาง/ปลายทางเป็นสถานที่ (โซน = P1/เฟส 2) และต้องต่างกัน
ALTER TABLE "rate_card" ADD CONSTRAINT "rate_card_sites" CHECK (
  "origin_site_id" IS NOT NULL AND "dest_site_id" IS NOT NULL AND "origin_site_id" <> "dest_site_id");
-- เงิน ≥ 0 · จุดที่รวมในราคา 0–99 · ฉบับที่ ≥ 1 · ฉบับแก้ไข (revision > 1) ต้องชี้ฉบับเดิม
ALTER TABLE "rate_card" ADD CONSTRAINT "rate_card_amounts" CHECK (
  ("min_charge" IS NULL OR "min_charge" >= 0) AND ("extra_stop_price" IS NULL OR "extra_stop_price" >= 0)
  AND "included_stops" BETWEEN 0 AND 99 AND "revision" >= 1 AND ("revision" = 1 OR "parent_id" IS NOT NULL));
-- ราคาต่อหน่วยนับ (PER_UNIT) ต้องระบุหน่วย — สูตรอื่นไม่มีหน่วย
ALTER TABLE "rate_card" ADD CONSTRAINT "rate_card_unit" CHECK (("pricing_model" = 'PER_UNIT') = ("unit_id" IS NOT NULL));
ALTER TABLE "rate_card_accessorial" ADD CONSTRAINT "rate_card_accessorial_price" CHECK ("price" >= 0);
-- เกณฑ์ตรวจรับ ST2-T13: ช่วงวันของ rate ที่ใช้งานใน key เดียวกันห้ามทับ (valid_to null = ไม่มีวันหมด)
ALTER TABLE "rate_card" ADD CONSTRAINT "rate_card_no_overlap" EXCLUDE USING gist (
  "tenant_id" WITH =, "side" WITH =, (COALESCE("customer_id", "carrier_id")) WITH =,
  "origin_site_id" WITH =, "dest_site_id" WITH =, "vehicle_type_id" WITH =,
  daterange("valid_from", "valid_to", '[]') WITH &&
) WHERE ("status" IN ('APPROVED', 'PENDING_APPROVAL') AND "deleted_at" IS NULL);

SELECT tms_enable_tenant_rls('rate_card');
SELECT tms_enable_tenant_rls('rate_card_accessorial');

-- ไม่มีการลบจริงของ rate card (D7 / MD-004): "ลบ" ร่าง = ตั้ง deleted_at · ราคาเฉพาะของร่างแทนทั้งชุดได้ (ลบแถวลูก)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE DELETE ON "rate_card" FROM tms_app';
  END IF;
END $$;
