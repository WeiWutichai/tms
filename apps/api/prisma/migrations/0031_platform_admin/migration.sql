-- ST1-T24: admin portal (ทีม Innovera, เข้าใช้งานแทน, quota รถ)
-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('SUPER_ADMIN', 'SUPPORT', 'BILLING');





ALTER TABLE "tenant" ADD COLUMN     "vehicle_quota" INTEGER;

-- CreateTable
CREATE TABLE "platform_user" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "PlatformRole" NOT NULL,
    "password_hash" TEXT NOT NULL,
    "totp_secret" TEXT NOT NULL,
    "totp_last_step" BIGINT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "token_version" INTEGER NOT NULL DEFAULT 0,
    "failed_logins" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "impersonation_session" (
    "id" UUID NOT NULL,
    "platform_user_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "as_user_id" UUID NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'read_only',
    "reason" TEXT NOT NULL,
    "ticket_ref" TEXT,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "end_reason" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "impersonation_session_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_user_email_key" ON "platform_user"("email");

-- CreateIndex
CREATE INDEX "impersonation_session_tenant_id_started_at_idx" ON "impersonation_session"("tenant_id", "started_at");

-- AddForeignKey
ALTER TABLE "impersonation_session" ADD CONSTRAINT "impersonation_session_platform_user_id_fkey" FOREIGN KEY ("platform_user_id") REFERENCES "platform_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ตาราง platform: role แอป (tms_app) เข้าไม่ได้เลย — ใช้ผ่าน role platform เท่านั้น
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE ALL ON platform_user, impersonation_session FROM tms_app';
  END IF;
END $$;
