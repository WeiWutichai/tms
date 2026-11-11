-- ST2-T17 เอกสารรถ (vehicle_document) + ค่าใช้จ่ายต่ออายุลง vehicle_cost (docs/01 §3.8, docs/04 B2.1 ส่วน 2, spec/06 FLT-C)
-- ต่ออายุ = แถวใหม่ที่ renews_id ชี้ฉบับเก่า (ฉบับเก่า → SUPERSEDED ไม่ถูกเขียนทับ/ไม่ลบ)
-- ชื่อคอลัมน์คงตาม schema v0; ค่า enum เปลี่ยนตาม docs/01 §3.8 (plan/00a: "ตาม docs")

-- RLS: ตาราง FORCE ROW LEVEL SECURITY — ถ้า migrator ไม่ใช่ superuser/BYPASSRLS การ SELECT ใน pre-check จะถูกกรองเงียบ ๆ
-- (ไม่เจอแถวผิด → ผ่านทั้งที่ข้อมูลผิด) · row_security = off ทำให้ query ที่ RLS จะกรอง "error" แทน → pre-check ไม่หลอกว่าผ่าน
-- (migrator ต้องเป็น owner ที่ BYPASSRLS หรือ superuser — ถ้าไม่ใช่ migration หยุดพร้อม error ชัดเจน)
SET row_security = off;

-- ตรวจก่อน: แถวเดิมจาก schema v0 (ยังไม่มีหน้าจอสร้างก่อน ST2-T17) ที่จะทำให้ข้อจำกัดด้านล่างล้ม → หยุดพร้อมข้อความ
DO $$
DECLARE r record;
BEGIN
  SELECT tenant_id, id INTO r FROM "vehicle_document" d
    WHERE NOT EXISTS (SELECT 1 FROM "vehicle" v WHERE v.id = d.vehicle_id) LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0044: vehicle_document อ้างรถที่ไม่มี (tenant %, id %)', r.tenant_id, r.id; END IF;
  SELECT tenant_id, id INTO r FROM "vehicle_document" d
    WHERE renews_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "vehicle_document" o WHERE o.id = d.renews_id) LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0044: vehicle_document อ้างฉบับก่อนหน้าที่ไม่มี (tenant %, id %)', r.tenant_id, r.id; END IF;
  SELECT tenant_id, id INTO r FROM "vehicle_document" WHERE starts_on IS NULL OR expires_on <= starts_on LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0044: vehicle_document ไม่มีวันเริ่ม หรือวันหมด ≤ วันเริ่ม (tenant %, id %) — แก้ก่อน migrate', r.tenant_id, r.id; END IF;
  SELECT tenant_id, id INTO r FROM "vehicle_document" WHERE file_key IS NOT NULL LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0044: vehicle_document มี file_key (tenant %, id %) — ย้ายไฟล์เป็น stored_document ก่อน migrate', r.tenant_id, r.id; END IF;
  SELECT tenant_id, id INTO r FROM "vehicle_cost" d
    WHERE NOT EXISTS (SELECT 1 FROM "vehicle" v WHERE v.id = d.vehicle_id) LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0044: vehicle_cost อ้างรถที่ไม่มี (tenant %, id %)', r.tenant_id, r.id; END IF;
  SELECT tenant_id, id, category INTO r FROM "vehicle_cost"
    WHERE category NOT IN ('DOCUMENT', 'DEPRECIATION', 'FUEL', 'REPAIR', 'INCIDENT', 'OTHER') LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0044: vehicle_cost หมวดไม่รู้จัก (tenant %, id %, %)', r.tenant_id, r.id, r.category; END IF;
END $$;

-- AlterEnum (docs/01 §3.8)
ALTER TYPE "vehicle_doc_type" RENAME VALUE 'ACT' TO 'COMPULSORY_ACT';
ALTER TYPE "vehicle_doc_type" RENAME VALUE 'OPERATING_LICENCE' TO 'TRANSPORT_LICENSE';
ALTER TYPE "vehicle_doc_type" RENAME VALUE 'GPS_DLT' TO 'GPS_DLT_CERT';

-- AlterTable
ALTER TABLE "vehicle_cost" ADD COLUMN     "created_by" TEXT;

-- AlterTable
ALTER TABLE "vehicle_document" DROP COLUMN "file_key",
ADD COLUMN     "cancel_reason" TEXT,
ADD COLUMN     "cancelled_at" TIMESTAMPTZ(6),
ADD COLUMN     "cost_amount" DECIMAL(14,2),
ADD COLUMN     "created_by" TEXT,
ADD COLUMN     "file_document_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
ADD COLUMN     "is_required_for_dispatch" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "reminder_sent" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "title" TEXT,
ALTER COLUMN "starts_on" SET NOT NULL;

-- แถวเดิม (schema v0): ฉบับที่ถูกต่ออายุแล้ว (มีแถวอื่นชี้มาที่ renews_id) → SUPERSEDED ก่อนสร้าง unique "ฉบับปัจจุบัน"
UPDATE "vehicle_document" o SET "status" = 'SUPERSEDED'
  WHERE EXISTS (SELECT 1 FROM "vehicle_document" n WHERE n.renews_id = o.id);

DO $$
DECLARE r record;
BEGIN
  SELECT tenant_id, vehicle_id, doc_type, count(*) AS n INTO r FROM "vehicle_document"
    WHERE status IN ('ACTIVE', 'EXPIRING', 'EXPIRED') AND doc_type <> 'OTHER'
    GROUP BY 1, 2, 3 HAVING count(*) > 1 LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0044: รถมีเอกสารฉบับปัจจุบันประเภทเดียวกันหลายฉบับ (tenant %, vehicle %, %, % ฉบับ) — ตั้ง renews_id ให้ฉบับใหม่ชี้ฉบับเก่าก่อน migrate', r.tenant_id, r.vehicle_id, r.doc_type, r.n; END IF;
  SELECT tenant_id, renews_id, count(*) AS n INTO r FROM "vehicle_document"
    WHERE renews_id IS NOT NULL GROUP BY 1, 2 HAVING count(*) > 1 LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0044: เอกสารฉบับเดียวถูกต่ออายุหลายครั้ง (tenant %, renews_id %, % ฉบับ)', r.tenant_id, r.renews_id, r.n; END IF;
END $$;

-- CHECK: วันหมด > วันเริ่ม (spec/06 FLT-C "expiry > start"), เงิน ≥ 0, สถานะที่รู้จัก, ยกเลิกต้องมีเหตุผล
ALTER TABLE "vehicle_document"
  ADD CONSTRAINT "vehicle_document_period" CHECK ("expires_on" > "starts_on"),
  ADD CONSTRAINT "vehicle_document_money" CHECK (
    ("sum_insured" IS NULL OR "sum_insured" >= 0) AND ("premium" IS NULL OR "premium" >= 0)
    AND ("cost_amount" IS NULL OR "cost_amount" >= 0)),
  ADD CONSTRAINT "vehicle_document_status" CHECK ("status" IN ('ACTIVE', 'EXPIRING', 'EXPIRED', 'SUPERSEDED', 'CANCELLED')),
  ADD CONSTRAINT "vehicle_document_cancel" CHECK (("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL)),
  ADD CONSTRAINT "vehicle_document_not_self" CHECK ("renews_id" IS NULL OR "renews_id" <> "id");
ALTER TABLE "vehicle_cost"
  ADD CONSTRAINT "vehicle_cost_category" CHECK ("category" IN ('DOCUMENT', 'DEPRECIATION', 'FUEL', 'REPAIR', 'INCIDENT', 'OTHER'));

-- ฉบับปัจจุบัน (ยังไม่ถูกต่ออายุ/ยกเลิก) ได้ 1 ฉบับต่อรถต่อประเภท — OTHER มีได้หลายฉบับ
CREATE UNIQUE INDEX "vehicle_document_current_uq" ON "vehicle_document"("tenant_id", "vehicle_id", "doc_type")
  WHERE "status" IN ('ACTIVE', 'EXPIRING', 'EXPIRED') AND "doc_type" <> 'OTHER';
-- ฉบับหนึ่งถูกต่ออายุได้ครั้งเดียว (ฉบับต่ออายุที่ยกเลิกแล้วไม่นับ)
CREATE UNIQUE INDEX "vehicle_document_renews_uq" ON "vehicle_document"("renews_id")
  WHERE "renews_id" IS NOT NULL AND "status" <> 'CANCELLED';

-- CreateIndex
CREATE INDEX "vehicle_cost_tenant_id_source_type_source_id_idx" ON "vehicle_cost"("tenant_id", "source_type", "source_id");

-- CreateIndex
CREATE INDEX "vehicle_document_tenant_id_expires_on_id_idx" ON "vehicle_document"("tenant_id", "expires_on", "id");

-- AddForeignKey
ALTER TABLE "vehicle_document" ADD CONSTRAINT "vehicle_document_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_document" ADD CONSTRAINT "vehicle_document_renews_id_fkey" FOREIGN KEY ("renews_id") REFERENCES "vehicle_document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_cost" ADD CONSTRAINT "vehicle_cost_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ไม่มี hard delete ของเอกสารรถ (ยกเลิก = status CANCELLED + เหตุผล) — vehicle_cost ถูก REVOKE UPDATE/DELETE แล้วใน 0004
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE DELETE ON vehicle_document FROM tms_app';
  END IF;
END $$;

-- RLS (ตารางเดิมเปิดแล้วใน 0004 — เรียกซ้ำได้)
SELECT tms_enable_tenant_rls('vehicle_document');
SELECT tms_enable_tenant_rls('vehicle_cost');

RESET row_security;
