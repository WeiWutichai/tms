-- ST3-T09 delivery_order + บรรทัดจาก SO — docs/01 §3.3 (delivery_order/delivery_order_line), §4.3 (state machine DO),
-- docs/04 C แยก/รวม order, spec/03 §3 (ORD-080 1 DO ต่อ 1 จุดส่ง, ORD-084 แยก, ORD-085 SO แก้ → DO ใหม่ทั้งชุด, ORD-086 รวม)
-- ALTER ตาราง schema v0 (0004): FK ทุกตัว RESTRICT (บรรทัด DO → บรรทัด SO) · CHECK · ไม่มีการลบ DO จริง
-- (0060 เว้นให้ ST3-T03 ที่ทำคู่ขนาน)
-- คอลัมน์ NOT NULL ใหม่ไม่มีค่าตั้งต้น: ก่อน T09 ไม่มีโค้ดใดเขียน delivery_order → ต้องว่าง (ตรวจโดยปิด row security แบบ 0059)
SET row_security = off;
DO $$
DECLARE r record;
BEGIN
  SELECT tenant_id, id INTO r FROM "delivery_order" LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0061: delivery_order มีข้อมูลก่อน ST3-T09 (tenant %, id %) — ตรวจที่มาและย้ายข้อมูลเองก่อน migrate', r.tenant_id, r.id; END IF;
  SELECT tenant_id, id INTO r FROM "delivery_order_line" LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0061: delivery_order_line มีข้อมูลก่อน ST3-T09 (tenant %, id %) — ตรวจที่มาและย้ายข้อมูลเองก่อน migrate', r.tenant_id, r.id; END IF;
END $$;
RESET row_security;

-- AlterTable
ALTER TABLE "delivery_order" ADD COLUMN     "dest_stop_seq" INTEGER NOT NULL,
ADD COLUMN     "origin_stop_seq" INTEGER NOT NULL,
ADD COLUMN     "source_hash" TEXT,
ADD COLUMN     "split_from_id" UUID,
ADD COLUMN     "split_index" INTEGER,
ADD COLUMN     "split_root_no" TEXT;

-- AlterTable
ALTER TABLE "delivery_order_line" ADD COLUMN     "cbm" DECIMAL(14,3),
ADD COLUMN     "description" TEXT NOT NULL,
ADD COLUMN     "line_no" INTEGER NOT NULL,
ADD COLUMN     "so_line_no" INTEGER NOT NULL,
ADD COLUMN     "weight_kg" DECIMAL(14,3);

-- CreateIndex
CREATE INDEX "delivery_order_tenant_id_sales_order_id_idx" ON "delivery_order"("tenant_id", "sales_order_id");

-- CreateIndex
CREATE INDEX "delivery_order_line_tenant_id_sales_order_line_id_idx" ON "delivery_order_line"("tenant_id", "sales_order_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_order_line_tenant_id_delivery_order_id_line_no_key" ON "delivery_order_line"("tenant_id", "delivery_order_id", "line_no");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_order_line_tenant_id_delivery_order_id_sales_order_key" ON "delivery_order_line"("tenant_id", "delivery_order_id", "sales_order_line_id");

-- AddForeignKey
ALTER TABLE "delivery_order" ADD CONSTRAINT "delivery_order_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_order" ADD CONSTRAINT "delivery_order_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_order" ADD CONSTRAINT "delivery_order_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_order" ADD CONSTRAINT "delivery_order_trip_stop_id_fkey" FOREIGN KEY ("trip_stop_id") REFERENCES "trip_stop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_order" ADD CONSTRAINT "delivery_order_origin_site_id_fkey" FOREIGN KEY ("origin_site_id") REFERENCES "customer_site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_order" ADD CONSTRAINT "delivery_order_dest_site_id_fkey" FOREIGN KEY ("dest_site_id") REFERENCES "customer_site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_order" ADD CONSTRAINT "delivery_order_redelivery_of_id_fkey" FOREIGN KEY ("redelivery_of_id") REFERENCES "delivery_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_order" ADD CONSTRAINT "delivery_order_split_from_id_fkey" FOREIGN KEY ("split_from_id") REFERENCES "delivery_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_order_line" ADD CONSTRAINT "delivery_order_line_delivery_order_id_fkey" FOREIGN KEY ("delivery_order_id") REFERENCES "delivery_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_order_line" ADD CONSTRAINT "delivery_order_line_sales_order_line_id_fkey" FOREIGN KEY ("sales_order_line_id") REFERENCES "sales_order_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_order_line" ADD CONSTRAINT "delivery_order_line_reject_reason_code_id_fkey" FOREIGN KEY ("reject_reason_code_id") REFERENCES "reason_code"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- เลข DO ออกตอนสร้างเสมอ (เอกสารปฏิบัติการ — spec/03 §0 ข้ามเลขได้)
ALTER TABLE "delivery_order" ADD CONSTRAINT "delivery_order_number" CHECK ("do_no" IS NOT NULL AND length(btrim("do_no")) > 0);
-- พ้น DRAFT แล้ว (ยกเว้นยกเลิก) ต้องอยู่ในเที่ยว (docs/01 §4.3: PLANNED = อยู่ใน trip ที่ ASSIGNED)
ALTER TABLE "delivery_order" ADD CONSTRAINT "delivery_order_trip" CHECK ("status" IN ('DRAFT', 'CANCELLED') OR "trip_id" IS NOT NULL);
ALTER TABLE "delivery_order" ADD CONSTRAINT "delivery_order_split" CHECK (
  ("split_index" IS NULL) = ("split_root_no" IS NULL) AND ("split_index" IS NULL OR "split_index" >= 1)
  AND ("split_from_id" IS NULL OR "split_index" IS NOT NULL) AND ("split_from_id" IS NULL OR "split_from_id" <> "id"));
ALTER TABLE "delivery_order" ADD CONSTRAINT "delivery_order_values" CHECK (
  "origin_stop_seq" >= 1 AND "dest_stop_seq" >= 1 AND "origin_stop_seq" <> "dest_stop_seq"
  AND ("weight_kg" IS NULL OR "weight_kg" >= 0) AND ("cbm" IS NULL OR "cbm" >= 0)
  AND ("revenue_amount" IS NULL OR "revenue_amount" >= 0) AND ("allocated_cost_amount" IS NULL OR "allocated_cost_amount" >= 0)
  AND "pod_status" IN ('NONE', 'PARTIAL', 'COMPLETE', 'REJECTED')
  AND ("redelivery_of_id" IS NULL OR "redelivery_of_id" <> "id"));
-- ปริมาณ > 0 ต่อบรรทัด (ผลรวมต่อบรรทัด SO ≤ ที่สั่ง ตรวจใน DeliveryOrderService ภายใต้ล็อก SO + test)
ALTER TABLE "delivery_order_line" ADD CONSTRAINT "delivery_order_line_values" CHECK (
  "line_no" >= 1 AND "so_line_no" >= 1 AND "qty_planned" > 0
  AND ("qty_actual" IS NULL OR "qty_actual" >= 0) AND ("reject_qty" IS NULL OR "reject_qty" >= 0)
  AND ("weight_kg" IS NULL OR "weight_kg" >= 0) AND ("cbm" IS NULL OR "cbm" >= 0) AND length(btrim("unit")) > 0);

-- RLS เปิดแล้วใน 0004 (tms_enable_tenant_rls idempotent — เรียกซ้ำตามกติกา)
SELECT tms_enable_tenant_rls('delivery_order');
SELECT tms_enable_tenant_rls('delivery_order_line');
-- ไม่มีการลบ DO จริง (ยกเลิก = CANCELLED + เหตุผล + ประวัติ)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE DELETE ON "delivery_order", "delivery_order_line" FROM tms_app';
  END IF;
END $$;
