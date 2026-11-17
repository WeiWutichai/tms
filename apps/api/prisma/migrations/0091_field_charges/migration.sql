-- ST4-T13 ค่าใช้จ่ายหน้างาน (docs/04 E2 "บันทึกเหตุล่าช้า / ค่าใช้จ่ายหน้างาน"; docs/01 §3.3 do_surcharge / trip_cost)
-- ฝั่งขาย = do_surcharge (ต่อ DO) · ฝั่งซื้อ = trip_cost (source MANUAL) · รูปหลักฐาน = stored_document (1 ไฟล์ต่อบรรทัด)
-- สถานะยืนยัน: PENDING_CONFIRM → CONFIRMED / REJECTED (Invoicer) / CANCELLED (ผู้บันทึก) — ตัดสินแล้วต้องมีผู้ตัดสิน เวลา และเหตุผล
-- trip_cost เดิม (CARRIER_FEE จากการจ้าง) = CONFIRMED (บรรทัดระบบ)

-- AlterTable
ALTER TABLE "do_surcharge" ADD COLUMN     "created_by" TEXT,
ADD COLUMN     "decided_at" TIMESTAMPTZ(6),
ADD COLUMN     "decided_by" TEXT,
ADD COLUMN     "decision_reason" TEXT,
ADD COLUMN     "description" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "evidence_document_id" UUID,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "service_item_snapshot" JSONB,
ADD COLUMN     "service_item_version" INTEGER,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'PENDING_CONFIRM',
ADD COLUMN     "trip_id" UUID,
ADD COLUMN     "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "trip_cost" ADD COLUMN     "decided_at" TIMESTAMPTZ(6),
ADD COLUMN     "decided_by" TEXT,
ADD COLUMN     "decision_reason" TEXT,
ADD COLUMN     "do_surcharge_id" UUID,
ADD COLUMN     "evidence_document_id" UUID,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'CONFIRMED',
ADD COLUMN     "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "do_surcharge"
  ADD CONSTRAINT "do_surcharge_status_check" CHECK ("status" IN ('PENDING_CONFIRM', 'CONFIRMED', 'REJECTED', 'CANCELLED')),
  ADD CONSTRAINT "do_surcharge_decided_check" CHECK (
    "status" = 'PENDING_CONFIRM'
    OR ("decided_at" IS NOT NULL AND "decided_by" IS NOT NULL AND length(btrim("decision_reason")) >= 10)),
  ADD CONSTRAINT "do_surcharge_amount_check" CHECK ("qty" > 0 AND "unit_price" >= 0 AND "amount" >= 0);

ALTER TABLE "trip_cost"
  ADD CONSTRAINT "trip_cost_status_check" CHECK ("status" IN ('PENDING_CONFIRM', 'CONFIRMED', 'REJECTED', 'CANCELLED')),
  ADD CONSTRAINT "trip_cost_decided_check" CHECK (
    "status" NOT IN ('REJECTED', 'CANCELLED')
    OR ("decided_at" IS NOT NULL AND "decided_by" IS NOT NULL AND length(btrim("decision_reason")) >= 10));

-- ที่มาของบรรทัด (0076): เพิ่ม FIELD (บันทึกหน้างาน ไม่มี source_id) และ DO_SURCHARGE (คู่กับบรรทัดฝั่งขาย)
ALTER TABLE "trip_cost" DROP CONSTRAINT "trip_cost_source_ref";
ALTER TABLE "trip_cost" ADD CONSTRAINT "trip_cost_source_ref" CHECK (
  ("source_type" IS NULL AND "source_id" IS NULL)
  OR ("source_type" = 'SUBCON_OFFER' AND "source_id" IS NOT NULL AND "source_id" = "subcon_offer_id")
  OR ("source_type" = 'FIELD' AND "source_id" IS NULL AND "do_surcharge_id" IS NULL AND "source" = 'MANUAL')
  OR ("source_type" = 'DO_SURCHARGE' AND "source_id" IS NOT NULL AND "source_id" = "do_surcharge_id" AND "source" = 'MANUAL'));

-- CreateIndex
CREATE UNIQUE INDEX "do_surcharge_evidence_document_id_key" ON "do_surcharge"("evidence_document_id");
CREATE UNIQUE INDEX "trip_cost_evidence_document_id_key" ON "trip_cost"("evidence_document_id");
CREATE INDEX "do_surcharge_tenant_id_trip_id_idx" ON "do_surcharge"("tenant_id", "trip_id");
CREATE INDEX "do_surcharge_tenant_id_status_idx" ON "do_surcharge"("tenant_id", "status");
CREATE INDEX "trip_cost_tenant_id_do_surcharge_id_idx" ON "trip_cost"("tenant_id", "do_surcharge_id");

-- AddForeignKey
ALTER TABLE "do_surcharge" ADD CONSTRAINT "do_surcharge_delivery_order_id_fkey" FOREIGN KEY ("delivery_order_id") REFERENCES "delivery_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "do_surcharge" ADD CONSTRAINT "do_surcharge_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "do_surcharge" ADD CONSTRAINT "do_surcharge_evidence_document_id_fkey" FOREIGN KEY ("evidence_document_id") REFERENCES "stored_document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "trip_cost" ADD CONSTRAINT "trip_cost_do_surcharge_id_fkey" FOREIGN KEY ("do_surcharge_id") REFERENCES "do_surcharge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "trip_cost" ADD CONSTRAINT "trip_cost_evidence_document_id_fkey" FOREIGN KEY ("evidence_document_id") REFERENCES "stored_document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ไม่มี hard delete (CLAUDE.md) — ผิด = ปฏิเสธ/ยกเลิก หรือกลับรายการ
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE DELETE ON do_surcharge, trip_cost FROM tms_app';
  END IF;
END $$;

-- ตารางเดิมเปิด RLS แล้วใน 0004 (ไม่มีตารางใหม่) — เรียกซ้ำได้
SELECT tms_enable_tenant_rls('do_surcharge');
SELECT tms_enable_tenant_rls('trip_cost');
