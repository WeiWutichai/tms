-- ST7-T16 Push pipeline (docs/01 §6.3–6.4; docs/04 G3)
-- 1) `erp_sync_log`: 1 แถวต่อ 1 HTTP call ไปยังระบบบัญชี (docs/01 §6.4) — ตัด credential / เลขบัตรประชาชนก่อนเก็บ (ฝั่งแอป)
--    แอปเพิ่มได้อย่างเดียว (ไม่แก้ ไม่ลบ) · retention 24 เดือนแล้ว archive (docs/01 §6.4 — งาน archive ยังไม่ทำ: เก็บไว้ทั้งหมดไปก่อน)
-- 2) `external_mapping.last_synced_parts`: hash แยกตามกลุ่ม field ของ payload ล่าสุดที่ส่งสำเร็จ (ตัดสิน `fieldChangePolicy` ตอนส่งใหม่)
-- ย้อนกลับ: DROP TABLE erp_sync_log; ALTER TABLE external_mapping DROP COLUMN last_synced_parts; (ไม่มีข้อมูลอื่นอ้างถึง)

-- AlterTable
ALTER TABLE "external_mapping" ADD COLUMN "last_synced_parts" JSONB;

-- CreateTable
CREATE TABLE "erp_sync_log" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "outbox_id" UUID,
    "attempt" INTEGER,
    "operation" VARCHAR(60) NOT NULL,
    "entity_type" VARCHAR(40),
    "local_id" UUID,
    "local_number" VARCHAR(60),
    "direction" VARCHAR(3) NOT NULL DEFAULT 'OUT',
    "method" VARCHAR(10) NOT NULL,
    "url" VARCHAR(500) NOT NULL,
    "status_code" INTEGER,
    "error_code" VARCHAR(60),
    "duration_ms" INTEGER NOT NULL,
    "request_body" TEXT,
    "response_body" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "erp_sync_log_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "erp_sync_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "erp_sync_log_direction_check" CHECK ("direction" IN ('OUT', 'IN')),
    CONSTRAINT "erp_sync_log_duration_check" CHECK ("duration_ms" >= 0)
);

-- CreateIndex
CREATE INDEX "erp_sync_log_tenant_id_connector_id_occurred_at_id_idx" ON "erp_sync_log"("tenant_id", "connector_id", "occurred_at" DESC, "id");
CREATE INDEX "erp_sync_log_outbox_id_idx" ON "erp_sync_log"("outbox_id");
CREATE INDEX "erp_sync_log_connector_id_local_number_idx" ON "erp_sync_log"("connector_id", "local_number");

-- AddForeignKey
ALTER TABLE "erp_sync_log" ADD CONSTRAINT "erp_sync_log_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connector"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- บันทึกแก้/ลบไม่ได้จากแอป (หลักฐานการส่ง — docs/01 §6.4)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON erp_sync_log FROM tms_app';
  END IF;
END $$;

SELECT tms_enable_tenant_rls('erp_sync_log');
