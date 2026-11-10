-- ST1-T09: โปรไฟล์ผู้ใช้ (ภาษา, timezone, ลายเซ็น)

-- AlterTable
ALTER TABLE "app_user" ADD COLUMN     "locale" TEXT NOT NULL DEFAULT 'th',
ADD COLUMN     "signature_document_id" UUID,
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'Asia/Bangkok';


ALTER TABLE "app_user" ADD CONSTRAINT "app_user_locale_check" CHECK ("locale" IN ('th', 'en', 'zh'));
