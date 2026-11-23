-- ST7-T19 คิวเชื่อมระบบบัญชีที่ลูกค้าจัดการเอง (docs/01 §6.4 error queue; docs/04 G3 "Error queue ลูกค้าดูเอง")
-- `connector_queue_resolution`: คนจัดการคำสั่งที่ล้มเหลว/ต้องมีคนทำ (ส่งซ้ำ / ข้ามพร้อมเหตุผล / กรอกเลขฝั่งระบบบัญชีเอง)
-- แยกจาก integration_outbox เพราะแอปแก้แถวคิวไม่ได้ (0090) · 1 คำสั่งจัดการได้ครั้งเดียว (unique outbox_id) · แอปเพิ่มได้อย่างเดียว
-- ย้อนกลับ: DROP TABLE connector_queue_resolution; DROP TYPE "QueueResolutionKind"; (ไม่มีข้อมูลอื่นอ้างถึง)

-- CreateEnum
CREATE TYPE "QueueResolutionKind" AS ENUM ('RETRIED', 'SKIPPED', 'MANUAL_EXTERNAL_ID');

-- CreateTable
CREATE TABLE "connector_queue_resolution" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "outbox_id" UUID NOT NULL,
    "kind" "QueueResolutionKind" NOT NULL,
    "reason" TEXT,
    "superseded_by" UUID,
    "external_id" TEXT,
    "resolved_by" TEXT,
    "resolved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connector_queue_resolution_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "connector_queue_resolution_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "connector_queue_resolution_outbox_id_fkey" FOREIGN KEY ("outbox_id") REFERENCES "integration_outbox"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "connector_queue_resolution_reason_check" CHECK ("kind" = 'RETRIED' OR char_length(btrim("reason")) >= 10)
);

-- CreateIndex
CREATE UNIQUE INDEX "connector_queue_resolution_outbox_id_key" ON "connector_queue_resolution"("outbox_id");
CREATE INDEX "connector_queue_resolution_tenant_id_connector_id_idx" ON "connector_queue_resolution"("tenant_id", "connector_id");

-- AddForeignKey
ALTER TABLE "connector_queue_resolution" ADD CONSTRAINT "connector_queue_resolution_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connector"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- หลักฐานการจัดการ — แอปแก้/ลบไม่ได้
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON connector_queue_resolution FROM tms_app';
  END IF;
END $$;

SELECT tms_enable_tenant_rls('connector_queue_resolution');
