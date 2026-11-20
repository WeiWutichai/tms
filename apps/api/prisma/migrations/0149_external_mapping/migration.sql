-- ST8-T16 external_mapping (ส่วนย่อยของ ST7-T15 — docs/01 §3.7, docs/04 G3 "เลขเอกสารสองฝั่ง")
-- เอกสาร TMS ↔ เอกสารฝั่ง ERP ต่อ connector · core เขียนเท่านั้น (push สำเร็จ / webhook ขาเข้า)
CREATE TABLE "external_mapping" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "entity_type" VARCHAR(40) NOT NULL,
    "local_id" UUID NOT NULL,
    "local_number" VARCHAR(60),
    "external_id" VARCHAR(200),
    "external_doc_no" VARCHAR(100),
    "external_status" VARCHAR(30),
    "detail" JSONB,
    "payload_hash" VARCHAR(64),
    "synced_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_mapping_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "external_mapping_entity_type_check" CHECK ("entity_type" IN ('invoice', 'settlement', 'payment')),
    CONSTRAINT "external_mapping_status_check" CHECK ("external_status" IS NULL OR "external_status" IN ('DRAFT', 'POSTED', 'VOIDED', 'PAID'))
);

CREATE UNIQUE INDEX "external_mapping_tenant_id_connector_id_entity_type_local_id_key" ON "external_mapping"("tenant_id", "connector_id", "entity_type", "local_id");
CREATE INDEX "external_mapping_tenant_id_connector_id_entity_type_external_id_idx" ON "external_mapping"("tenant_id", "connector_id", "entity_type", "external_id");
CREATE INDEX "external_mapping_tenant_id_entity_type_local_id_idx" ON "external_mapping"("tenant_id", "entity_type", "local_id");
-- เอกสารฝั่ง ERP 1 ใบ ↔ เอกสาร TMS 1 ใบต่อ connector (รับชำระจาก webhook ซ้ำ = ชนกันที่นี่ ไม่สร้างซ้ำ)
CREATE UNIQUE INDEX "external_mapping_external_unique" ON "external_mapping"("tenant_id", "connector_id", "entity_type", "external_id") WHERE "external_id" IS NOT NULL;

ALTER TABLE "external_mapping" ADD CONSTRAINT "external_mapping_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connector"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ไม่มี hard delete
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE DELETE ON external_mapping FROM tms_app';
  END IF;
END $$;

SELECT tms_enable_tenant_rls('external_mapping');
