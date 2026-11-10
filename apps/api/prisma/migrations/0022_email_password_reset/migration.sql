-- ST1-T03: อีเมลขาออก (outbox) + token ลืมรหัสผ่าน
-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED');


-- CreateTable
CREATE TABLE "email_outbox" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "to_address" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "text_body" TEXT,
    "html_body" TEXT,
    "status" "EmailStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "run_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_until" TIMESTAMPTZ(6),
    "sent_at" TIMESTAMPTZ(6),
    "provider_message_id" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_token" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "ip" TEXT,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_token_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_outbox_status_run_at_idx" ON "email_outbox"("status", "run_at");

-- CreateIndex
CREATE INDEX "email_outbox_tenant_id_created_at_idx" ON "email_outbox"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_token_token_hash_key" ON "password_reset_token"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_token_email_created_at_idx" ON "password_reset_token"("email", "created_at");

-- CreateIndex
CREATE INDEX "password_reset_token_ip_created_at_idx" ON "password_reset_token"("ip", "created_at");


-- email_outbox: tenant เขียนอีเมลของตัวเองได้ผ่าน RLS (แถว tenant_id NULL = อีเมลระบบ เขียน/อ่านได้เฉพาะ platform)
SELECT tms_enable_tenant_rls('email_outbox');
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE ALL ON email_outbox FROM tms_app';
    EXECUTE 'GRANT SELECT, INSERT ON email_outbox TO tms_app';
    -- token ลืมรหัสผ่านเป็นตาราง platform (ก่อนรู้บริษัท) — แอปแตะไม่ได้
    EXECUTE 'REVOKE ALL ON password_reset_token FROM tms_app';
  END IF;
END $$;
