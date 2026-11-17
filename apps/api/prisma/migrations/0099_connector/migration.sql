-- ST7-T13 ErpAdapter framework: การตั้งค่า connector ต่อ tenant (docs/01 §3.7 `connector`, §6.1; docs/04 G3)
-- ไม่มีแถว = Standalone (ทุก flow เดินใน TMS เอง) · ไม่มี enum ของ ERP ใน schema (adapter_key = ErpAdapter.key ในโค้ด)
-- routing ตามนิติบุคคล: company_id = Invoice As / Tender As ของเอกสาร · null = ค่าเริ่มต้นทุกนิติบุคคลที่ไม่มีของตัวเอง
-- credential เข้ารหัส (FieldCipher) · ไม่มี hard delete (ยกเลิกการเชื่อม = DISCONNECTED)

CREATE TYPE "ConnectorStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ERROR', 'DISCONNECTED');

CREATE TABLE "connector" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "adapter_key" VARCHAR(32) NOT NULL,
    "company_id" UUID,
    "erp_company_code" VARCHAR(64),
    "branch_map" JSONB NOT NULL DEFAULT '{}',
    "capabilities_enabled" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "settings" JSONB NOT NULL DEFAULT '{}',
    "credentials_enc" TEXT,
    "credential_keys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "credentials_updated_at" TIMESTAMPTZ(6),
    "sync_from_date" DATE,
    "status" "ConnectorStatus" NOT NULL DEFAULT 'PAUSED',
    "status_reason" TEXT,
    "status_changed_at" TIMESTAMPTZ(6),
    "last_health_at" TIMESTAMPTZ(6),
    "last_health_ok" BOOLEAN,
    "last_health_error" JSONB,
    "activated_at" TIMESTAMPTZ(6),
    "disconnected_at" TIMESTAMPTZ(6),
    "created_by" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connector_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "connector_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "connector_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "connector_adapter_key_check" CHECK ("adapter_key" ~ '^[a-z0-9][a-z0-9_-]{0,31}$'),
    CONSTRAINT "connector_branch_map_check" CHECK (jsonb_typeof("branch_map") = 'object'),
    CONSTRAINT "connector_settings_check" CHECK (jsonb_typeof("settings") = 'object'),
    CONSTRAINT "connector_disconnected_check" CHECK (("status" = 'DISCONNECTED') = ("disconnected_at" IS NOT NULL))
);

CREATE INDEX "connector_tenant_id_created_at_id_idx" ON "connector"("tenant_id", "created_at", "id");
CREATE INDEX "connector_tenant_id_company_id_idx" ON "connector"("tenant_id", "company_id");
-- 1 connector ที่ยังไม่ยกเลิกต่อขอบเขต (tenant, นิติบุคคล) — null = ขอบเขต "ทุกนิติบุคคล" ของ tenant (ตัวเดียว)
CREATE UNIQUE INDEX "connector_one_live_per_scope_key" ON "connector"
    ("tenant_id", coalesce("company_id", '00000000-0000-0000-0000-000000000000'::uuid))
    WHERE "status" <> 'DISCONNECTED';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE DELETE ON connector FROM tms_app';
  END IF;
END $$;

SELECT tms_enable_tenant_rls('connector');
