-- ST2-T22 ค่าเสื่อมรายเดือน (เส้นตรง) ลง vehicle_cost ด้วย job (docs/04 B2.1 ส่วน 1, docs/01 §3.8, spec/06 FLT-004)
-- เดือนที่คิด = period_month (วันที่ 1 ของเดือน) · unique ต่อ tenant + รถ + หมวด + เดือน → รัน job ซ้ำ/พร้อมกันไม่เกิดแถวซ้ำ (ON CONFLICT DO NOTHING)
-- หมวดอื่น period_month = NULL (NULL ไม่ชนกันใน unique index) — แถว DOCUMENT ของ ST2-T17 ไม่กระทบ

-- RLS: ตาราง FORCE ROW LEVEL SECURITY — row_security = off ให้ pre-check "error" แทนการถูกกรองเงียบ ๆ (แบบเดียวกับ 0044)
SET row_security = off;

-- กันข้อมูลเดิมที่ขัด CHECK (ยังไม่มีผู้เขียนหมวด DEPRECIATION ก่อน T22 — ถ้ามีให้หยุดและตรวจด้วยมือ)
DO $$
DECLARE r record;
BEGIN
  SELECT tenant_id, id INTO r FROM "vehicle_cost" WHERE "category" = 'DEPRECIATION' LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0056: มีแถว DEPRECIATION ก่อน ST2-T22 (tenant %, id %) — ตรวจก่อน migrate', r.tenant_id, r.id; END IF;
END $$;

-- AlterTable
ALTER TABLE "vehicle_cost" ADD COLUMN     "period_month" DATE;

-- CreateIndex
CREATE UNIQUE INDEX "vehicle_cost_tenant_id_vehicle_id_category_period_month_key" ON "vehicle_cost"("tenant_id", "vehicle_id", "category", "period_month");

-- DEPRECIATION ⇔ มี period_month และเป็นวันที่ 1 ของเดือน
ALTER TABLE "vehicle_cost"
  ADD CONSTRAINT "vehicle_cost_period_month" CHECK (
    ("category" = 'DEPRECIATION') = ("period_month" IS NOT NULL)
    AND ("period_month" IS NULL OR EXTRACT(DAY FROM "period_month") = 1)
  );

-- ตารางเดิม (RLS เปิดแล้วใน 0004/0044) — เรียกซ้ำได้ (idempotent) ตามกติกา migration
SELECT tms_enable_tenant_rls('vehicle_cost');

RESET row_security;
