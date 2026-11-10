-- ST1-T08: ไฟล์แนบแบบ presigned upload (จองก่อน → อัปโหลด → ตรวจ MIME จริง)

-- AlterTable
ALTER TABLE "stored_document" ADD COLUMN     "client_document_id" TEXT,
ADD COLUMN     "filename" TEXT,
ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'READY',
ALTER COLUMN "file_key" DROP NOT NULL,
ALTER COLUMN "sha256" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "stored_document_tenant_id_client_document_id_key" ON "stored_document"("tenant_id", "client_document_id");


ALTER TABLE "stored_document" ADD CONSTRAINT "stored_document_status_check" CHECK ("status" IN ('PENDING', 'READY'));
ALTER TABLE "stored_document" ADD CONSTRAINT "stored_document_ready_check" CHECK ("status" <> 'READY' OR ("file_key" IS NOT NULL AND "sha256" IS NOT NULL));
