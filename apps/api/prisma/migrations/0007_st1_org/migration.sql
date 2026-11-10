-- ST1-T14/T15/T22: ชุดเลขเอกสาร, ตัวนับไม่ซ้ำแม้ branch_id เป็น null, audit append-only ระดับ DB

-- CreateTable
CREATE TABLE "document_series" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "doc_type" "doc_type" NOT NULL,
    "prefix" TEXT NOT NULL,
    "reset_policy" "reset_policy" NOT NULL DEFAULT 'MONTHLY',
    "padding" INTEGER NOT NULL DEFAULT 4,
    "per_branch" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_series_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "document_series_tenant_id_doc_type_key" ON "document_series"("tenant_id", "doc_type");


SELECT tms_enable_tenant_rls('document_series');

-- ตัวนับของเอกสารที่ไม่ผูกสาขา (branch_id null) ต้องไม่ซ้ำด้วย — unique ปกติถือว่า null ไม่เท่ากัน
DROP INDEX "document_sequence_tenant_id_doc_type_branch_id_period_key_key";
CREATE UNIQUE INDEX "document_sequence_tenant_id_doc_type_branch_id_period_key_key"
  ON "document_sequence"("tenant_id", "doc_type", "branch_id", "period_key") NULLS NOT DISTINCT;

-- docs/04 A7: audit log append-only — ปฏิเสธ UPDATE/DELETE ทุก role (tms_app ถูก REVOKE แล้วใน 0004)
-- การลบตามอายุเก็บ 5 ปีทำโดย job ของ platform ที่ปิด trigger ชั่วคราวใน transaction ของตัวเอง (ST9)
CREATE OR REPLACE FUNCTION tms_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION tms_audit_append_only();

-- เลขที่ออกแล้วห้ามหาย: แอปเพิ่ม/อัปเดตตัวนับได้ แต่ลบไม่ได้
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE DELETE ON document_sequence, document_series FROM tms_app';
  END IF;
END $$;
