-- ST1-T05: 2FA TOTP, backup code, จำอุปกรณ์ 30 วัน

-- AlterTable
ALTER TABLE "app_user" ADD COLUMN     "totp_enabled_at" TIMESTAMPTZ(6),
ADD COLUMN     "totp_last_step" BIGINT;

-- CreateTable
CREATE TABLE "mfa_challenge" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "code_challenge" TEXT NOT NULL,
    "pending_secret" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_challenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backup_code" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backup_code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trusted_device" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_version" INTEGER NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "user_agent" TEXT,
    "ip" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trusted_device_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mfa_challenge_token_hash_key" ON "mfa_challenge"("token_hash");

-- CreateIndex
CREATE INDEX "mfa_challenge_user_id_idx" ON "mfa_challenge"("user_id");

-- CreateIndex
CREATE INDEX "backup_code_tenant_id_user_id_idx" ON "backup_code"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "trusted_device_token_hash_key" ON "trusted_device"("token_hash");

-- CreateIndex
CREATE INDEX "trusted_device_user_id_idx" ON "trusted_device"("user_id");


-- ตาราง auth ขั้นที่ 2 ใช้ผ่าน role platform เท่านั้น (เหมือน 0005); RLS ซ้อนตามกติกา harness
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE ALL ON mfa_challenge, backup_code, trusted_device FROM tms_app';
  END IF;
END $$;
SELECT tms_enable_tenant_rls('mfa_challenge');
SELECT tms_enable_tenant_rls('backup_code');
SELECT tms_enable_tenant_rls('trusted_device');
