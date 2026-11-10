-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "tenant_status" AS ENUM ('TRIAL', 'ACTIVE', 'SUSPENDED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "company_status" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "job_status" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "tenant" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "tenant_status" NOT NULL DEFAULT 'TRIAL',
    "year_style" TEXT NOT NULL DEFAULT 'BE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "legal_name" TEXT NOT NULL,
    "legal_name_en" TEXT,
    "tax_id" CHAR(13) NOT NULL,
    "vat_registered" BOOLEAN NOT NULL DEFAULT true,
    "status" "company_status" NOT NULL DEFAULT 'ACTIVE',
    "external_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_key" (
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "locked_until" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("tenant_id","key","path")
);

-- CreateTable
CREATE TABLE "doc_status_history" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "doc_type" TEXT NOT NULL,
    "doc_id" UUID NOT NULL,
    "from_status" TEXT NOT NULL,
    "to_status" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "actor_id" TEXT,
    "reason_code_id" UUID,
    "note" TEXT,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "doc_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "domain_event" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "entity_type" TEXT NOT NULL,
    "local_id" UUID NOT NULL,
    "snapshot" JSONB NOT NULL,
    "previous_attributes" JSONB,
    "request_id" TEXT,
    "actor_id" TEXT,

    CONSTRAINT "domain_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "status" "job_status" NOT NULL DEFAULT 'PENDING',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "progress" INTEGER NOT NULL DEFAULT 0,
    "result" JSONB,
    "error" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "run_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "locked_until" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "company_tenant_id_updated_at_id_idx" ON "company"("tenant_id", "updated_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "company_tenant_id_tax_id_key" ON "company"("tenant_id", "tax_id");

-- CreateIndex
CREATE UNIQUE INDEX "company_tenant_id_external_id_key" ON "company"("tenant_id", "external_id");

-- CreateIndex
CREATE INDEX "idempotency_key_expires_at_idx" ON "idempotency_key"("expires_at");

-- CreateIndex
CREATE INDEX "doc_status_history_tenant_id_doc_type_doc_id_at_idx" ON "doc_status_history"("tenant_id", "doc_type", "doc_id", "at");

-- CreateIndex
CREATE INDEX "domain_event_tenant_id_occurred_at_idx" ON "domain_event"("tenant_id", "occurred_at");

-- CreateIndex
CREATE INDEX "domain_event_tenant_id_entity_type_local_id_idx" ON "domain_event"("tenant_id", "entity_type", "local_id");

-- CreateIndex
CREATE INDEX "job_status_run_at_idx" ON "job"("status", "run_at");

-- CreateIndex
CREATE INDEX "job_tenant_id_created_at_idx" ON "job"("tenant_id", "created_at");


-- =====================================================================
-- Multi-tenant RLS (ST0-T04, docs/01 §1 ข้อ 3, plan/02 T-05)
-- ทุกตารางที่มี tenant_id ต้องเรียก tms_enable_tenant_rls('<table>') ใน migration ที่สร้างตาราง
-- session var: app.tenant_id ตั้งด้วย set_config(..., true) ภายใน transaction ต่อ request
-- ไม่ตั้ง → NULL → ไม่เห็นแถวใดเลย และเขียนไม่ได้
-- =====================================================================
CREATE OR REPLACE FUNCTION tms_current_tenant() RETURNS uuid
  LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION tms_enable_tenant_rls(tbl regclass, col text DEFAULT 'tenant_id') RETURNS void
  LANGUAGE plpgsql AS
$$
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %s', tbl);
  EXECUTE format(
    'CREATE POLICY tenant_isolation ON %s USING (%I = tms_current_tenant()) WITH CHECK (%I = tms_current_tenant())',
    tbl, col, col);
END
$$;

SELECT tms_enable_tenant_rls('tenant', 'id');
SELECT tms_enable_tenant_rls('company');
SELECT tms_enable_tenant_rls('idempotency_key');
SELECT tms_enable_tenant_rls('doc_status_history');
SELECT tms_enable_tenant_rls('domain_event');
SELECT tms_enable_tenant_rls('job');

-- ประวัติและ event เป็น append-only สำหรับ role แอป (ไม่มี hard delete / แก้ย้อนหลัง)
REVOKE UPDATE, DELETE ON doc_status_history, domain_event FROM tms_app;
