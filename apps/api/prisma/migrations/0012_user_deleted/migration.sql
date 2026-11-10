-- ST1-T10: ลบผู้ใช้แบบ anonymize

-- AlterEnum
ALTER TYPE "user_status" ADD VALUE 'DELETED';

-- AlterTable
ALTER TABLE "app_user" ADD COLUMN     "deleted_at" TIMESTAMPTZ(6);

