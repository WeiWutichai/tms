-- ST5-T21 ส่งเอกสารทางอีเมลถึงลูกค้า (docs/04 F3 "พิมพ์/ส่งเอกสาร"; spec/05 BIL-041) [DECISION spec/12 §3 แถว ST5-T21]
-- (1) email_outbox.attachments: ไฟล์แนบอ้าง key ใน FileStore [{fileKey, filename, contentType}] — worker อ่านไฟล์ตอนส่ง
-- (2) document_email: 1 แถว = ผู้รับ 1 คนของการส่งเอกสาร 1 ครั้ง · สถานะการส่งแยกจากสถานะเอกสาร (spec/05 §3 ข้อ 8)

-- AlterTable
ALTER TABLE "email_outbox" ADD COLUMN "attachments" JSONB;

-- CreateTable
CREATE TABLE "document_email" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "document_no" TEXT NOT NULL,
    "to_address" TEXT NOT NULL,
    "attachment_document_id" UUID NOT NULL,
    "email_outbox_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "failed_reason" TEXT,
    "sent_at" TIMESTAMPTZ(6),
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "document_email_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "document_email_entity_type_check" CHECK ("entity_type" IN ('invoice', 'billing_note')),
    CONSTRAINT "document_email_purpose_check" CHECK ("purpose" IN ('DOCUMENT', 'PAYMENT_REMINDER')),
    CONSTRAINT "document_email_status_check" CHECK ("status" IN ('QUEUED', 'SENT', 'FAILED'))
);

-- CreateIndex
CREATE INDEX "document_email_tenant_id_entity_type_entity_id_created_at_idx" ON "document_email"("tenant_id", "entity_type", "entity_id", "created_at");

-- CreateIndex
CREATE INDEX "document_email_email_outbox_id_idx" ON "document_email"("email_outbox_id");

SELECT tms_enable_tenant_rls('document_email');
-- role แอป: อ่าน/สร้างเท่านั้น · สถานะเขียนโดย worker ด้วย role platform (แบบ notification) · ไม่มี hard delete
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE ALL ON document_email FROM tms_app';
    EXECUTE 'GRANT SELECT, INSERT ON document_email TO tms_app';
  END IF;
END $$;
