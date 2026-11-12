-- ST3-T01 sales_order + บรรทัด + upsertOrder() — docs/04 C (Source ของ order, key idempotent (source, externalId)),
-- docs/01 §3.3 (sales_order/sales_order_line), §4.1 (state machine SO + ON_HOLD + reason_code), D-21 (ร่าง), D-22 (ตารางจุดแยก)
-- ALTER ตาราง schema v0 (0004): FK ทุกตัว RESTRICT · CHECK · บรรทัดราคา snapshot (MD-117) · ไม่มีการลบ SO จริง
-- sales_order เปิด FORCE RLS (0004) — ปิด row security ช่วงตรวจข้อมูลเดิม (แบบ 0053) ไม่งั้นมองไม่เห็นแถว
SET row_security = off;
DO $$
DECLARE r record;
BEGIN
  SELECT tenant_id, id INTO r FROM "sales_order" WHERE status = 'ON_HOLD' AND hold_reason_code_id IS NULL LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0059: sales_order ON_HOLD ไม่มี reason code (tenant %, id %) — ใส่เหตุผลก่อน migrate', r.tenant_id, r.id; END IF;
  SELECT tenant_id, id INTO r FROM "sales_order" WHERE status <> 'DRAFT' AND so_no IS NULL LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0059: sales_order พ้นร่างแต่ไม่มีเลข SO (tenant %, id %) — ออกเลขก่อน migrate', r.tenant_id, r.id; END IF;
  SELECT tenant_id, id INTO r FROM "sales_order" WHERE source = 'CONNECTOR' LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0059: sales_order จาก connector ไม่มีรหัส connector (tenant %, id %) — ระบุ source_connector ก่อน migrate', r.tenant_id, r.id; END IF;
END $$;
RESET row_security;

-- CreateEnum
CREATE TYPE "pricing_status" AS ENUM ('AVAILABLE', 'RATE_MISSING', 'CALCULATION_FAILURE');

-- CreateEnum
CREATE TYPE "order_charge_kind" AS ENUM ('FREIGHT', 'EXTRA_STOP', 'ACCESSORIAL');

-- DropIndex
DROP INDEX "sales_order_tenant_id_external_id_key";

-- AlterTable
ALTER TABLE "sales_order" ADD COLUMN     "customer_external_id" TEXT,
ADD COLUMN     "customer_text" TEXT,
ADD COLUMN     "input_hash" TEXT,
ADD COLUMN     "price_total" DECIMAL(14,2),
ADD COLUMN     "priced_at" TIMESTAMPTZ(6),
ADD COLUMN     "pricing_detail" JSONB,
ADD COLUMN     "pricing_status" "pricing_status" NOT NULL DEFAULT 'RATE_MISSING',
ADD COLUMN     "source_connector" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "sales_order_line" ADD COLUMN     "product_id" UUID,
ADD COLUMN     "unit_id" UUID;

-- CreateTable
CREATE TABLE "sales_order_charge" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "kind" "order_charge_kind" NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'RATE_CARD',
    "service_item_id" UUID NOT NULL,
    "service_item_version" INTEGER NOT NULL,
    "service_item_snapshot" JSONB NOT NULL,
    "description" TEXT NOT NULL,
    "qty" DECIMAL(18,4) NOT NULL,
    "qty_exact" TEXT NOT NULL,
    "unit_price" DECIMAL(14,2) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "calculated_amount" DECIMAL(14,2) NOT NULL,
    "min_charge_applied" BOOLEAN NOT NULL DEFAULT false,
    "vat_type" "vat_type" NOT NULL,
    "wht_rate" DECIMAL(5,2) NOT NULL,
    "rate_card_id" UUID,
    "rate_card_code" TEXT,
    "rate_card_revision" INTEGER,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_order_charge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sales_order_charge_tenant_id_service_item_id_idx" ON "sales_order_charge"("tenant_id", "service_item_id");

-- CreateIndex
CREATE INDEX "sales_order_charge_tenant_id_rate_card_id_idx" ON "sales_order_charge"("tenant_id", "rate_card_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_charge_tenant_id_sales_order_id_line_no_key" ON "sales_order_charge"("tenant_id", "sales_order_id", "line_no");

-- CreateIndex
CREATE INDEX "sales_order_tenant_id_customer_id_idx" ON "sales_order"("tenant_id", "customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_tenant_id_source_source_connector_external_id_key" ON "sales_order"("tenant_id", "source", "source_connector", "external_id");

-- CreateIndex
CREATE INDEX "sales_order_stop_tenant_id_site_id_idx" ON "sales_order_stop"("tenant_id", "site_id");

-- AddForeignKey
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_billing_company_id_fkey" FOREIGN KEY ("billing_company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_vehicle_type_id_fkey" FOREIGN KEY ("vehicle_type_id") REFERENCES "vehicle_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_hold_reason_code_id_fkey" FOREIGN KEY ("hold_reason_code_id") REFERENCES "reason_code"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_stop" ADD CONSTRAINT "sales_order_stop_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_stop" ADD CONSTRAINT "sales_order_stop_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "customer_site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_line" ADD CONSTRAINT "sales_order_line_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_line" ADD CONSTRAINT "sales_order_line_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_line" ADD CONSTRAINT "sales_order_line_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_charge" ADD CONSTRAINT "sales_order_charge_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_charge" ADD CONSTRAINT "sales_order_charge_service_item_id_fkey" FOREIGN KEY ("service_item_id") REFERENCES "service_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_order_charge" ADD CONSTRAINT "sales_order_charge_rate_card_id_fkey" FOREIGN KEY ("rate_card_id") REFERENCES "rate_card"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- กติกาที่ฐานข้อมูลบังคับ
-- ช่องทาง CONNECTOR ต้องมีรหัส connector (ERP:{connector}) ตัวเล็ก/ตัวเลข/-/_ ≤ 32; ช่องทางอื่นไม่มี
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_source_connector" CHECK (
  ("source" = 'CONNECTOR') = ("source_connector" <> '') AND "source_connector" ~ '^([a-z0-9][a-z0-9_-]{0,31})?$');
-- externalRef ว่างไม่ได้ (ใช้ null แทน)
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_external_id_nonempty" CHECK ("external_id" IS NULL OR length(btrim("external_id")) > 0);
-- docs/01 §4.1: สถานะค้างทุกแบบ = ON_HOLD + reason code เดียว (ST3-T07 "ไม่มี order ค้างที่ไม่มี reason code") — และพ้นค้างแล้วไม่เหลือเหตุ
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_hold_reason" CHECK (("status" = 'ON_HOLD') = ("hold_reason_code_id" IS NOT NULL));
-- ร่างไม่กินเลข (docs/01 §3.5) · พ้นร่างต้องมีเลข SO
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_number" CHECK ("status" = 'DRAFT' OR "so_no" IS NOT NULL);
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_price_total" CHECK ("price_total" IS NULL OR "price_total" >= 0);
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_priced" CHECK (("pricing_status" = 'AVAILABLE') = ("price_total" IS NOT NULL));
ALTER TABLE "sales_order_stop" ADD CONSTRAINT "sales_order_stop_sequence" CHECK ("sequence" >= 1);
ALTER TABLE "sales_order_stop" ADD CONSTRAINT "sales_order_stop_window" CHECK ("window_end" IS NULL OR "window_start" IS NULL OR "window_end" >= "window_start");
ALTER TABLE "sales_order_line" ADD CONSTRAINT "sales_order_line_amounts" CHECK (
  "line_no" >= 1 AND "qty_ordered" > 0 AND ("weight_kg" IS NULL OR "weight_kg" >= 0) AND ("cbm" IS NULL OR "cbm" >= 0)
  AND ("temp_min" IS NULL OR "temp_max" IS NULL OR "temp_min" <= "temp_max"));
ALTER TABLE "sales_order_charge" ADD CONSTRAINT "sales_order_charge_values" CHECK (
  "line_no" >= 1 AND "origin" IN ('RATE_CARD', 'MANUAL') AND "qty" >= 0 AND "unit_price" >= 0 AND "amount" >= 0
  AND "calculated_amount" >= 0 AND "wht_rate" IN (0.00, 1.00, 3.00));

SELECT tms_enable_tenant_rls('sales_order_charge');
-- ไม่มีการลบ SO จริง (ยกเลิก = CANCELLED + เหตุผล) · จุด/สินค้า/บรรทัดราคาของ SO ที่ยังแก้ได้ แทนทั้งชุดได้ (ลบแถวลูก)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE DELETE ON "sales_order" FROM tms_app';
  END IF;
END $$;
