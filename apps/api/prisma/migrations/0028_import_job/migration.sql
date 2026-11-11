-- ST1-T19: งานนำเข้า Excel/CSV (dry-run → ยืนยัน)
-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('VALIDATING', 'VALIDATED', 'IMPORTING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED');




-- CreateTable
CREATE TABLE "import_job" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "document_id" UUID NOT NULL,
    "file_name" TEXT,
    "status" "ImportStatus" NOT NULL DEFAULT 'VALIDATING',
    "mode" TEXT NOT NULL DEFAULT 'create_only',
    "error_policy" TEXT NOT NULL DEFAULT 'all_or_nothing',
    "headers" JSONB NOT NULL DEFAULT '[]',
    "mapping" JSONB NOT NULL DEFAULT '{}',
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "ok_rows" INTEGER NOT NULL DEFAULT 0,
    "error_rows" INTEGER NOT NULL DEFAULT 0,
    "imported_rows" INTEGER NOT NULL DEFAULT 0,
    "issues" JSONB NOT NULL DEFAULT '[]',
    "sample" JSONB NOT NULL DEFAULT '[]',
    "file_error" TEXT,
    "job_id" UUID,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_job_tenant_id_created_at_idx" ON "import_job"("tenant_id", "created_at");


SELECT tms_enable_tenant_rls('import_job');
-- ประวัติการนำเข้า: ไม่มี hard delete
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE DELETE ON import_job FROM tms_app';
  END IF;
END $$;
