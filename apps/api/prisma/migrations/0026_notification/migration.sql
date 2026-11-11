-- ST1-T23: แกนแจ้งเตือน (in-app + อีเมล; ช่องทางอื่นเสียบภายหลัง)
-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('QUEUED', 'SENT', 'READ', 'FAILED');



-- CreateTable
CREATE TABLE "notification" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "template_code" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" "NotificationStatus" NOT NULL DEFAULT 'QUEUED',
    "email_outbox_id" UUID,
    "sent_at" TIMESTAMPTZ(6),
    "read_at" TIMESTAMPTZ(6),
    "failed_reason" TEXT,
    "related_entity_type" TEXT,
    "related_entity_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_tenant_id_recipient_id_channel_created_at_idx" ON "notification"("tenant_id", "recipient_id", "channel", "created_at");

-- CreateIndex
CREATE INDEX "notification_email_outbox_id_idx" ON "notification"("email_outbox_id");


SELECT tms_enable_tenant_rls('notification');
-- role แอป: อ่าน/สร้างได้ แก้ได้เฉพาะสถานะการอ่าน · ไม่มี hard delete
-- (สถานะช่องอีเมลเขียนโดย worker ด้วย role platform)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE ALL ON notification FROM tms_app';
    EXECUTE 'GRANT SELECT, INSERT ON notification TO tms_app';
    EXECUTE 'GRANT UPDATE (status, read_at, updated_at) ON notification TO tms_app';
  END IF;
END $$;
