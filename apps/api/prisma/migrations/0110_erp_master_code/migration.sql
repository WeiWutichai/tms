-- ST7-T18 Sync master ลงมา (docs/04 G3 + B "ผังรหัส ERP", docs/01 §7.4)
-- erp_master_code: รหัสที่ connector ยอมรับ (หน่วย พนักงานขาย ผังบัญชี รหัสสินค้า/บริการ อัตรา VAT) ต่อ connector
--   มาจาก adapter หรือนำเข้าไฟล์ · ไม่มี hard delete (รหัสที่หายจาก ERP = active false)
-- erp_code_mapping: ค่าบริการ TMS (service_item) ↔ รหัสสินค้า ERP ต่อ connector — ไม่ครบ = คำสั่ง push FAILED_FINAL(VALIDATION)
CREATE TABLE "erp_master_code" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "kind" VARCHAR(16) NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(200),
    "rate" DECIMAL(5,2),
    "source" VARCHAR(8) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "synced_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "erp_master_code_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "erp_master_code_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "erp_master_code_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connector"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "erp_master_code_kind_check" CHECK ("kind" IN ('UNIT', 'SALESPERSON', 'ACCOUNT', 'ITEM', 'VAT_RATE')),
    CONSTRAINT "erp_master_code_source_check" CHECK ("source" IN ('ADAPTER', 'IMPORT')),
    CONSTRAINT "erp_master_code_code_check" CHECK (length(btrim("code")) > 0),
    CONSTRAINT "erp_master_code_rate_check" CHECK ("rate" IS NULL OR ("kind" = 'VAT_RATE' AND "rate" >= 0 AND "rate" <= 100))
);
-- รหัสเดียวกันต่อ connector + ประเภท ห้ามซ้ำ (ไม่สนตัวพิมพ์)
CREATE UNIQUE INDEX "erp_master_code_connector_kind_code_key" ON "erp_master_code"("connector_id", "kind", lower("code"));
CREATE INDEX "erp_master_code_tenant_id_connector_id_kind_active_idx" ON "erp_master_code"("tenant_id", "connector_id", "kind", "active");

CREATE TABLE "erp_code_mapping" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "service_item_id" UUID NOT NULL,
    "item_code" VARCHAR(64),
    "updated_by" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "erp_code_mapping_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "erp_code_mapping_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "erp_code_mapping_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connector"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "erp_code_mapping_service_item_id_fkey" FOREIGN KEY ("service_item_id") REFERENCES "service_item"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "erp_code_mapping_item_code_check" CHECK ("item_code" IS NULL OR length(btrim("item_code")) > 0)
);
CREATE UNIQUE INDEX "erp_code_mapping_connector_id_service_item_id_key" ON "erp_code_mapping"("connector_id", "service_item_id");
CREATE INDEX "erp_code_mapping_tenant_id_connector_id_idx" ON "erp_code_mapping"("tenant_id", "connector_id");

SELECT tms_enable_tenant_rls('erp_master_code');
SELECT tms_enable_tenant_rls('erp_code_mapping');
