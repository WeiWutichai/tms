-- ST7-T21 Payment status pull (docs/04 G3 "Payment status pull", F5 "Payment status จาก ERP"; docs/01 §3.7 `reconcile_result`, §6.1 `fetchPaymentStatus`)
-- ตาราง `reconcile_result` ตาม docs/01 §3.7 (ทั่วไป ไม่ผูก ERP ใด) — ST7-T21 ใช้เก็บ "ยอดรับชำระฝั่ง ERP ≠ TMS" (MISMATCH severity MONEY)
-- เครื่อง reconcile เต็ม (4 รอบ / เทียบรายบรรทัด) = ST8-T11 · หน้า MISMATCH + ปิดรายการ = ST8-T12 (ใช้ตารางนี้ต่อ)
-- เพิ่มจาก docs: local_number (แสดงผล), resolved_at (ระบบปิดเมื่อรอบถัดไปตรง/ส่วนต่างเปลี่ยน), last_seen_at (ส่วนต่างเดิมไม่สร้างแถวซ้ำ)
-- เลข migration 0158 = สูงสุดบน origin/main (0153) + 5 กันชนกับ branch อื่น
-- ย้อนกลับ: DROP TABLE reconcile_result; DROP TYPE reconcile_source, reconcile_outcome, reconcile_severity; (ไม่มีข้อมูลอื่นอ้างถึง)

-- CreateEnum
CREATE TYPE "reconcile_source" AS ENUM ('AFTER_PUSH', 'NIGHTLY', 'PRE_CLOSE', 'MANUAL');
CREATE TYPE "reconcile_outcome" AS ENUM ('MATCH', 'MISMATCH', 'REMOTE_MISSING', 'ERP_UNREACHABLE');
CREATE TYPE "reconcile_severity" AS ENUM ('MONEY', 'FIELD', 'INFO');

-- CreateTable
CREATE TABLE "reconcile_result" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "entity_type" "ExternalEntityType" NOT NULL,
    "local_id" UUID NOT NULL,
    "local_number" TEXT,
    "run_at" TIMESTAMPTZ(6) NOT NULL,
    "source" "reconcile_source" NOT NULL,
    "local_snapshot" JSONB NOT NULL,
    "remote_snapshot" JSONB NOT NULL,
    "diff" JSONB NOT NULL,
    "diff_hash" CHAR(64) NOT NULL,
    "result" "reconcile_outcome" NOT NULL,
    "severity" "reconcile_severity" NOT NULL,
    "acknowledged_by" TEXT,
    "acknowledged_at" TIMESTAMPTZ(6),
    "ack_reason" TEXT,
    "resolved_at" TIMESTAMPTZ(6),
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconcile_result_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reconcile_result_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "reconcile_result_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connector"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    -- ยอมรับความต่าง = ต้องมีคน + เวลา + เหตุผลครบ (docs/01 §6.5 "บันทึกคนและเหตุผลทุกครั้ง")
    CONSTRAINT "reconcile_result_ack_check" CHECK (
      ("acknowledged_at" IS NULL AND "acknowledged_by" IS NULL AND "ack_reason" IS NULL)
      OR ("acknowledged_at" IS NOT NULL AND "acknowledged_by" IS NOT NULL AND length(btrim("ack_reason")) >= 10)
    )
);

-- CreateIndex
CREATE INDEX "reconcile_result_tenant_id_updated_at_id_idx" ON "reconcile_result"("tenant_id", "updated_at", "id");
CREATE INDEX "reconcile_result_tenant_id_entity_type_local_id_idx" ON "reconcile_result"("tenant_id", "entity_type", "local_id");
CREATE INDEX "reconcile_result_connector_id_entity_type_local_id_idx" ON "reconcile_result"("connector_id", "entity_type", "local_id");
-- กันแจ้งซ้ำ (docs/01 §6.5 "รอบถัดไปไม่แจ้งซ้ำถ้า diff_hash เท่าเดิม"): ส่วนต่างเดิมที่ระบบยังไม่ปิด มีได้แถวเดียว (รวมแถวที่คนยอมรับแล้ว)
CREATE UNIQUE INDEX "reconcile_result_open_diff_uq"
  ON "reconcile_result"("connector_id", "entity_type", "local_id", "diff_hash") WHERE "resolved_at" IS NULL;

-- แอปลบไม่ได้ · แก้ได้เฉพาะคอลัมน์การปิด/ยอมรับ (ตัวผลเทียบ + snapshot แก้ไม่ได้)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON reconcile_result FROM tms_app';
    EXECUTE 'GRANT UPDATE (acknowledged_by, acknowledged_at, ack_reason, resolved_at, last_seen_at, updated_at) ON reconcile_result TO tms_app';
  END IF;
END $$;

SELECT tms_enable_tenant_rls('reconcile_result');
