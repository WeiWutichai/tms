-- ST3-T10: ต้นทางแก้ SO หลังวางแผน → ไม่ทับอัตโนมัติ เก็บชุดการเปลี่ยนแปลง + diff รอคนรับ/ไม่รับ
-- (docs/01 §3.3 source_changed_after_plan/source_diff + §4.1 "ไม่ overwrite แต่เก็บ diff ... ไม่เปลี่ยนสถานะ", docs/04 C ยกเลิก/คืนสถานะ)

-- CreateEnum
CREATE TYPE "source_change_status" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'SUPERSEDED');

-- CreateTable
CREATE TABLE "order_source_change" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "status" "source_change_status" NOT NULL DEFAULT 'PENDING',
    "source" "order_source" NOT NULL,
    "source_connector" TEXT NOT NULL DEFAULT '',
    "order_status" "so_status" NOT NULL,
    "base_version" INTEGER NOT NULL,
    "base_input_hash" TEXT,
    "input" JSONB NOT NULL,
    "input_hash" TEXT NOT NULL,
    "changes" JSONB NOT NULL,
    "raw_payload" JSONB,
    "decided_by" TEXT,
    "decided_at" TIMESTAMPTZ(6),
    "decision_reason" TEXT,
    "superseded_by_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_source_change_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_source_change_tenant_id_sales_order_id_created_at_idx" ON "order_source_change"("tenant_id", "sales_order_id", "created_at");

-- AddForeignKey
ALTER TABLE "order_source_change" ADD CONSTRAINT "order_source_change_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "order_source_change" ADD CONSTRAINT "order_source_change_superseded_by_id_fkey" FOREIGN KEY ("superseded_by_id") REFERENCES "order_source_change"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ชุดที่รอตัดสินได้ครั้งละ 1 ชุดต่อ SO (ต้นทางส่งชุดใหม่ = ชุดเดิม SUPERSEDED)
CREATE UNIQUE INDEX "order_source_change_one_pending" ON "order_source_change"("sales_order_id") WHERE "status" = 'PENDING';

-- คนรับ/ไม่รับต้องมีผู้ตัดสิน + เวลา + เหตุผล ≥ 10 ตัวอักษร (CLAUDE.md: ทุก override/อนุมัติต้องมีเหตุผล) · รอตัดสิน = ยังไม่มีผลตัดสิน
-- SUPERSEDED = ระบบปิดเอง (มีเวลา + ข้อความระบบ, ไม่มีผู้ตัดสินก็ได้)
ALTER TABLE "order_source_change" ADD CONSTRAINT "order_source_change_decision" CHECK (
  CASE "status"
    WHEN 'PENDING' THEN "decided_at" IS NULL AND "decided_by" IS NULL AND "decision_reason" IS NULL AND "superseded_by_id" IS NULL
    WHEN 'SUPERSEDED' THEN "decided_at" IS NOT NULL AND "decision_reason" IS NOT NULL
    ELSE "decided_at" IS NOT NULL AND "decided_by" IS NOT NULL AND "decision_reason" IS NOT NULL
         AND char_length(btrim("decision_reason")) >= 10 AND "superseded_by_id" IS NULL
  END);
ALTER TABLE "order_source_change" ADD CONSTRAINT "order_source_change_values" CHECK (
  "base_version" >= 1 AND length("input_hash") > 0 AND jsonb_typeof("changes") = 'array'
  AND jsonb_typeof("input") = 'object'
  AND (("source" = 'CONNECTOR') = ("source_connector" <> '')));

SELECT tms_enable_tenant_rls('order_source_change');
-- ไม่มีการลบจริง (ประวัติการตัดสิน)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE DELETE ON "order_source_change" FROM tms_app';
  END IF;
END $$;

-- ยกเลิกร่างได้โดยไม่ออกเลข (D-21 ร่างไม่กินเลข; docs/01 §4.1 DRAFT → CANCELLED) — ใบที่พ้นร่างแล้วมีเลขเสมอ (โค้ดไม่ล้าง so_no)
ALTER TABLE "sales_order" DROP CONSTRAINT "sales_order_number";
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_number" CHECK ("status" IN ('DRAFT', 'CANCELLED') OR "so_no" IS NOT NULL);
-- ธงต้นทางแก้หลังวางแผน ⇔ มี diff (docs/01 §3.3)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "sales_order" WHERE "source_changed_after_plan" AND "source_diff" IS NULL) THEN
    RAISE EXCEPTION 'sales_order: source_changed_after_plan without source_diff — fix data before 0069';
  END IF;
END $$;
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_source_diff" CHECK (NOT "source_changed_after_plan" OR "source_diff" IS NOT NULL);

-- เลข SO ออกแล้วไม่หาย (ยกเลิก/แก้ทีหลังก็คงเลขเดิม — ล้างหรือเปลี่ยนไม่ได้)
CREATE OR REPLACE FUNCTION tms_sales_order_keep_number() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."so_no" IS NOT NULL AND NEW."so_no" IS DISTINCT FROM OLD."so_no" THEN
    RAISE EXCEPTION 'sales_order_number_immutable: so_no % cannot change', OLD."so_no";
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "sales_order_keep_number" BEFORE UPDATE OF "so_no" ON "sales_order"
  FOR EACH ROW EXECUTE FUNCTION tms_sales_order_keep_number();
