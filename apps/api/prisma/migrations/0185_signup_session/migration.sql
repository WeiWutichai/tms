-- P1-ST2-T03 สมัครขั้น 1 "สร้างบัญชี" — signup_session (spec/01 §2 ข้อ 6, 8)
-- ตาราง platform ไม่มี tenant_id (ก่อนมีบริษัท) → ไม่เปิด RLS แต่ REVOKE จาก tms_app (เข้าถึงผ่าน tms_platform เท่านั้น)

-- CreateEnum
CREATE TYPE "signup_session_status" AS ENUM ('account_pending_otp', 'account_verified', 'company_submitted', 'completed', 'abandoned');

-- CreateTable
CREATE TABLE "signup_session" (
    "id" UUID NOT NULL,
    "status" "signup_session_status" NOT NULL DEFAULT 'account_pending_otp',
    "full_name" TEXT,
    "email" TEXT,
    "mobile" TEXT,
    "password_hash" TEXT,
    "resume_token_hash" TEXT,
    "otp_channel" TEXT,
    "otp_hash" TEXT,
    "otp_sent_at" TIMESTAMPTZ(6),
    "otp_expires_at" TIMESTAMPTZ(6),
    "otp_failed_count" INTEGER NOT NULL DEFAULT 0,
    "otp_locked_until" TIMESTAMPTZ(6),
    "otp_send_count" INTEGER NOT NULL DEFAULT 0,
    "ip" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'th',
    "verified_at" TIMESTAMPTZ(6),
    "last_activity_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "abandoned_at" TIMESTAMPTZ(6),
    "personal_data_erased_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "signup_session_pkey" PRIMARY KEY ("id"),
    -- OTP เก็บเฉพาะ HMAC-SHA256 (base64url 43 ตัว) — กันการเผลอเก็บรหัสดิบ
    CONSTRAINT "signup_session_otp_hash_shape" CHECK ("otp_hash" IS NULL OR "otp_hash" ~ '^[A-Za-z0-9_-]{43}$'),
    -- ลบข้อมูลส่วนบุคคลแล้ว = ไม่เหลือข้อมูลส่วนบุคคล/ความลับ
    CONSTRAINT "signup_session_erased_empty" CHECK ("personal_data_erased_at" IS NULL OR
      ("full_name" IS NULL AND "email" IS NULL AND "mobile" IS NULL AND "password_hash" IS NULL
       AND "resume_token_hash" IS NULL AND "otp_hash" IS NULL AND "ip" IS NULL))
);

-- CreateIndex
CREATE UNIQUE INDEX "signup_session_resume_token_hash_key" ON "signup_session"("resume_token_hash");

-- CreateIndex
CREATE INDEX "signup_session_email_status_idx" ON "signup_session"("email", "status");

-- CreateIndex
CREATE INDEX "signup_session_status_last_activity_at_idx" ON "signup_session"("status", "last_activity_at");

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE ALL ON signup_session FROM tms_app';
  END IF;
END $$;
