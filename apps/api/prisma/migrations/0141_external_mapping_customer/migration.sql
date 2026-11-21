-- ST8-T05 (docs/01 §3.7 external_mapping, A.4 SO poller; docs/04 C "ยกเลิก / คืนสถานะ")
-- (1) external_mapping ตาม docs/01 §3.7 + คอลัมน์ source_code (เพิ่ม — รหัสของ entity ในข้อมูลขาเข้าของ connector เช่น รหัสลูกค้า NSF ใน SO
--     ของ KRS; external_id = รหัสฝั่งระบบบัญชีที่ใช้ส่งเอกสาร เช่น custOrSuppCode ของ PP) — ST8-T05 ใช้กับ CUSTOMER ·
--     ST7-T15 ใช้ตารางเดียวกันกับเอกสาร (hash / เลขเอกสารฝั่ง ERP) · ไม่มี hard delete
-- (2) sales_order.source_cancelled_at — ต้นทางยกเลิกใบนี้แล้ว (ยกเลิกอัตโนมัติ / แจ้งเตือนเมื่อมี DO แล้ว)

-- CreateEnum
CREATE TYPE "ExternalEntityType" AS ENUM ('CUSTOMER', 'CARRIER', 'SERVICE_ITEM', 'SALES_ORDER', 'DELIVERY_ORDER', 'INVOICE', 'CREDIT_NOTE', 'DEBIT_NOTE', 'RECEIPT', 'SETTLEMENT');

-- CreateEnum
CREATE TYPE "ExternalMappingStatus" AS ENUM ('SYNCED', 'PENDING', 'FAILED', 'MISMATCH', 'RETIRED');

-- AlterTable
ALTER TABLE "sales_order" ADD COLUMN     "source_cancelled_at" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "external_mapping" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "entity_type" "ExternalEntityType" NOT NULL,
    "local_id" UUID NOT NULL,
    "external_id" TEXT,
    "external_doc_no" TEXT,
    "external_version" TEXT,
    "source_code" TEXT,
    "last_synced_hash" TEXT,
    "last_synced_at" TIMESTAMPTZ(6),
    "status" "ExternalMappingStatus" NOT NULL DEFAULT 'PENDING',
    "last_error" JSONB,
    "created_by" TEXT,
    "updated_by" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_mapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "external_mapping_tenant_id_entity_type_local_id_idx" ON "external_mapping"("tenant_id", "entity_type", "local_id");

-- CreateIndex
CREATE UNIQUE INDEX "external_mapping_connector_id_entity_type_local_id_key" ON "external_mapping"("connector_id", "entity_type", "local_id");

-- CreateIndex
CREATE UNIQUE INDEX "external_mapping_connector_id_entity_type_external_id_key" ON "external_mapping"("connector_id", "entity_type", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "external_mapping_connector_id_entity_type_source_code_key" ON "external_mapping"("connector_id", "entity_type", "source_code");

-- AddForeignKey
ALTER TABLE "external_mapping" ADD CONSTRAINT "external_mapping_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connector"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- รหัสไม่ว่าง/ไม่ยาวเกิน (ค่ามาจากคนกรอกและจากต้นทาง)
ALTER TABLE "external_mapping" ADD CONSTRAINT "external_mapping_external_id_check"
  CHECK ("external_id" IS NULL OR (btrim("external_id") <> '' AND length("external_id") <= 100));
ALTER TABLE "external_mapping" ADD CONSTRAINT "external_mapping_source_code_check"
  CHECK ("source_code" IS NULL OR (btrim("source_code") <> '' AND length("source_code") <= 100));

SELECT tms_enable_tenant_rls('external_mapping');
