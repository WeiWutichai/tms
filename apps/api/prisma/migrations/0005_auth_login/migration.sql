-- ST1-T01/T04: ตาราง auth ระดับ platform (ใช้ก่อนรู้ tenant) — ไม่มี RLS; tms_app อ่าน/เขียนไม่ได้ ใช้ผ่าน role tms_platform เท่านั้น

-- CreateTable
CREATE TABLE "login_attempt" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "user_agent" TEXT,
    "tenant_id" UUID,
    "user_id" UUID,
    "success" BOOLEAN NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_code" (
    "id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "code_challenge" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_token" (
    "id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "family_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_version" INTEGER NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "idle_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "user_agent" TEXT,
    "ip" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_token_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "login_attempt_email_created_at_idx" ON "login_attempt"("email", "created_at");

-- CreateIndex
CREATE INDEX "login_attempt_ip_created_at_idx" ON "login_attempt"("ip", "created_at");

-- CreateIndex
CREATE INDEX "login_attempt_tenant_id_created_at_idx" ON "login_attempt"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "auth_code_code_hash_key" ON "auth_code"("code_hash");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_token_token_hash_key" ON "refresh_token"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_token_family_id_idx" ON "refresh_token"("family_id");

-- CreateIndex
CREATE INDEX "refresh_token_user_id_idx" ON "refresh_token"("user_id");


-- tms_app ห้ามแตะ (default privileges ของ 0002 ให้สิทธิ์ไว้ → ถอนออก)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE ALL ON login_attempt, auth_code, refresh_token FROM tms_app';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_platform') THEN
    -- ประวัติ login เป็น append-only (ลบได้เฉพาะ job ลบข้อมูลเกิน 1 ปี — ST1-T11)
    EXECUTE 'REVOKE UPDATE ON login_attempt FROM tms_platform';
  END IF;
END $$;
