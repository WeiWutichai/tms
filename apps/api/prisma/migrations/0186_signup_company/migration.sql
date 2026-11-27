-- P1-ST2-T04 สมัครขั้น 2 "ข้อมูลบริษัท" (spec/01 §2 ขั้น 2, PLT-020–023; research/company-verification §7)
-- signup_session + คอลัมน์ขั้น 2 · company_lookup (cache ผล RD) · company_lookup_log (log การส่งเลขออก — PDPA)
-- ตาราง platform ไม่มี tenant_id (ก่อนมีบริษัท) → ไม่เปิด RLS แต่ REVOKE จาก tms_app (เข้าถึงผ่าน tms_platform เท่านั้น)

-- AlterTable
ALTER TABLE "signup_session" ADD COLUMN     "accounting_software" TEXT,
ADD COLUMN     "address" JSONB,
ADD COLUMN     "branch_code" CHAR(5),
ADD COLUMN     "certificate_bytes" INTEGER,
ADD COLUMN     "certificate_file_key" TEXT,
ADD COLUMN     "certificate_filename" TEXT,
ADD COLUMN     "certificate_mime" TEXT,
ADD COLUMN     "certificate_uploaded_at" TIMESTAMPTZ(6),
ADD COLUMN     "company_lookup_id" UUID,
ADD COLUMN     "company_submitted_at" TIMESTAMPTZ(6),
ADD COLUMN     "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "fleet_size_own" INTEGER,
ADD COLUMN     "fleet_size_subcon" INTEGER,
ADD COLUMN     "join_request_kind" TEXT,
ADD COLUMN     "join_requested_at" TIMESTAMPTZ(6),
ADD COLUMN     "join_tenant_id" UUID,
ADD COLUMN     "legal_name" TEXT,
ADD COLUMN     "lookup_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "marketing_opt_in" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "privacy_version" TEXT,
ADD COLUMN     "tax_id" CHAR(13),
ADD COLUMN     "terms_accepted_at" TIMESTAMPTZ(6),
ADD COLUMN     "terms_accepted_ip" TEXT,
ADD COLUMN     "terms_version" TEXT,
ADD COLUMN     "verification_reason" TEXT,
ADD COLUMN     "verification_source" TEXT,
ADD COLUMN     "verification_status" TEXT;

ALTER TABLE "signup_session"
  ADD CONSTRAINT "signup_session_tax_id_shape" CHECK ("tax_id" IS NULL OR "tax_id" ~ '^[0-9]{13}$'),
  ADD CONSTRAINT "signup_session_branch_code_shape" CHECK ("branch_code" IS NULL OR "branch_code" ~ '^[0-9]{5}$'),
  -- spec/01 §2: fleetSizeOwn / fleetSizeSubcon 0–5000
  ADD CONSTRAINT "signup_session_fleet_range" CHECK (
    ("fleet_size_own" IS NULL OR "fleet_size_own" BETWEEN 0 AND 5000) AND
    ("fleet_size_subcon" IS NULL OR "fleet_size_subcon" BETWEEN 0 AND 5000)),
  ADD CONSTRAINT "signup_session_accounting_software" CHECK ("accounting_software" IS NULL OR
    "accounting_software" IN ('none', 'express', 'flow_account', 'krs', 'peak', 'sap_b1', 'other')),
  ADD CONSTRAINT "signup_session_verification_status" CHECK ("verification_status" IS NULL OR
    "verification_status" IN ('auto_vat', 'pending_manual', 'pending_verification')),
  ADD CONSTRAINT "signup_session_verification_source" CHECK ("verification_source" IS NULL OR
    "verification_source" IN ('rd_vat', 'rd_tin')),
  ADD CONSTRAINT "signup_session_join_request_kind" CHECK ("join_request_kind" IS NULL OR
    "join_request_kind" IN ('join', 'contact')),
  ADD CONSTRAINT "signup_session_lookup_count_nonneg" CHECK ("lookup_count" >= 0),
  -- ส่งขั้น 2 แล้ว (company_submitted) ต้องมีข้อมูลบริษัท + การยอมรับข้อกำหนด/นโยบาย (เวอร์ชัน + เวลา)
  ADD CONSTRAINT "signup_session_company_submitted" CHECK ("status" <> 'company_submitted' OR (
    "tax_id" IS NOT NULL AND "branch_code" IS NOT NULL AND "legal_name" IS NOT NULL AND "address" IS NOT NULL
    AND "fleet_size_own" IS NOT NULL AND "fleet_size_subcon" IS NOT NULL AND "accounting_software" IS NOT NULL
    AND "verification_status" IS NOT NULL AND "terms_version" IS NOT NULL AND "privacy_version" IS NOT NULL
    AND "terms_accepted_at" IS NOT NULL AND "company_submitted_at" IS NOT NULL)),
  -- pending_manual ต้องมีหนังสือรับรอง (spec/01 §2 certificateFile "เมื่อ pending_manual")
  ADD CONSTRAINT "signup_session_manual_certificate" CHECK ("status" <> 'company_submitted'
    OR "verification_status" <> 'pending_manual' OR "certificate_file_key" IS NOT NULL),
  -- ลบข้อมูลส่วนบุคคลแล้ว: ข้อมูลขั้น 2 (เลขบุคคลธรรมดา/ที่อยู่/IP/ไฟล์) ต้องว่างด้วย
  ADD CONSTRAINT "signup_session_erased_company_empty" CHECK ("personal_data_erased_at" IS NULL OR
    ("tax_id" IS NULL AND "legal_name" IS NULL AND "address" IS NULL AND "terms_accepted_ip" IS NULL
     AND "certificate_file_key" IS NULL AND "certificate_filename" IS NULL));

-- CreateTable
CREATE TABLE "company_lookup" (
    "id" UUID NOT NULL,
    "tax_id" CHAR(13) NOT NULL,
    "branch_code" CHAR(5) NOT NULL,
    "result" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "data" JSONB,
    "raw_response" TEXT,
    "raw_purged_at" TIMESTAMPTZ(6),
    "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "company_lookup_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "company_lookup_result" CHECK ("result" IN ('vat_found', 'tin_exists', 'not_found')),
    CONSTRAINT "company_lookup_source" CHECK ("source" IN ('rd_vat', 'rd_tin')),
    CONSTRAINT "company_lookup_tax_id_shape" CHECK ("tax_id" ~ '^0[0-9]{12}$'),
    CONSTRAINT "company_lookup_branch_code_shape" CHECK ("branch_code" ~ '^[0-9]{5}$'),
    CONSTRAINT "company_lookup_expiry" CHECK ("expires_at" > "fetched_at")
);

-- CreateTable
CREATE TABLE "company_lookup_log" (
    "id" UUID NOT NULL,
    "agency" TEXT NOT NULL,
    "service" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "tax_id" CHAR(13) NOT NULL,
    "branch_code" CHAR(5),
    "outcome" TEXT NOT NULL,
    "http_status" INTEGER,
    "duration_ms" INTEGER NOT NULL,
    "error_code" TEXT,
    "signup_session_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_lookup_log_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "company_lookup_log_service" CHECK ("service" IN ('vat', 'tin')),
    CONSTRAINT "company_lookup_log_outcome" CHECK ("outcome" IN ('found', 'not_found', 'error')),
    CONSTRAINT "company_lookup_log_duration" CHECK ("duration_ms" >= 0)
);

-- CreateIndex
CREATE INDEX "company_lookup_tax_id_branch_code_expires_at_idx" ON "company_lookup"("tax_id", "branch_code", "expires_at");

-- CreateIndex
CREATE INDEX "company_lookup_fetched_at_idx" ON "company_lookup"("fetched_at");

-- CreateIndex
CREATE INDEX "company_lookup_log_agency_created_at_idx" ON "company_lookup_log"("agency", "created_at");

-- CreateIndex
CREATE INDEX "company_lookup_log_tax_id_idx" ON "company_lookup_log"("tax_id");

-- CreateIndex
CREATE INDEX "signup_session_tax_id_branch_code_idx" ON "signup_session"("tax_id", "branch_code");

-- log การส่งเลขออก = append-only (PDPA accountability) — แก้/ลบไม่ได้แม้จาก role platform
CREATE OR REPLACE FUNCTION tms_company_lookup_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'company_lookup_log is append-only';
END $$;
CREATE TRIGGER company_lookup_log_append_only BEFORE UPDATE OR DELETE ON "company_lookup_log"
  FOR EACH ROW EXECUTE FUNCTION tms_company_lookup_log_append_only();

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE ALL ON company_lookup FROM tms_app';
    EXECUTE 'REVOKE ALL ON company_lookup_log FROM tms_app';
  END IF;
END $$;
