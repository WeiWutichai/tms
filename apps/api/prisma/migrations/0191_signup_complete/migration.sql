-- P1-ST2-T05 สมัครขั้น 3 "เลือกแพ็กเกจ" + สร้าง tenant ในธุรกรรมเดียว (spec/01 §2 PLT-022, PLT-025)

-- signup_session (ตาราง platform — lane B): แพ็กเกจที่เลือก / ขอนัด demo / tenant ที่สร้าง
-- ชื่อคอลัมน์ไม่ใช่ tenant_id — ตาราง platform ไม่มี RLS (harness แยก tenant ถือว่าคอลัมน์ tenant_id = ตารางของ tenant)
ALTER TABLE "signup_session" ADD COLUMN     "completed_at" TIMESTAMPTZ(6),
ADD COLUMN     "demo_requested_at" TIMESTAMPTZ(6),
ADD COLUMN     "plan_code" TEXT,
ADD COLUMN     "created_tenant_id" UUID;
ALTER TABLE "signup_session" ADD CONSTRAINT "signup_session_completed_check"
  CHECK ("status" <> 'completed' OR ("created_tenant_id" IS NOT NULL AND "completed_at" IS NOT NULL));

-- tenant_signup: ข้อมูลการสมัครที่คัดลอกเข้า tenant ก่อน session ถูกลบวันที่ 30
CREATE TABLE "tenant_signup" (
    "tenant_id" UUID NOT NULL,
    "signup_session_id" UUID NOT NULL,
    "verification_status" TEXT NOT NULL,
    "verification_source" TEXT,
    "verification_reason" TEXT,
    "approval_policy" TEXT NOT NULL,
    "flags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "company_lookup_id" UUID,
    "accounting_software" TEXT,
    "fleet_size_own" INTEGER,
    "fleet_size_subcon" INTEGER,
    "plan_code" TEXT NOT NULL,
    "terms_version" TEXT NOT NULL,
    "privacy_version" TEXT NOT NULL,
    "terms_accepted_at" TIMESTAMPTZ(6) NOT NULL,
    "terms_accepted_ip" TEXT,
    "marketing_opt_in" BOOLEAN NOT NULL DEFAULT false,
    "certificate_document_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_signup_pkey" PRIMARY KEY ("tenant_id"),
    CONSTRAINT "tenant_signup_verification_status_check"
      CHECK ("verification_status" IN ('auto_vat', 'pending_manual', 'pending_verification')),
    CONSTRAINT "tenant_signup_approval_policy_check"
      CHECK ("approval_policy" IN ('auto_when_verified', 'manual_all'))
);

CREATE UNIQUE INDEX "tenant_signup_signup_session_id_key" ON "tenant_signup"("signup_session_id");

ALTER TABLE "tenant_signup" ADD CONSTRAINT "tenant_signup_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- สิทธิ์: แอปอ่านได้เฉพาะของ tenant ตัวเอง (RLS) · เขียนผ่าน role platform (หน้าสมัคร / Console) เท่านั้น · ไม่มีลบ
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON tenant_signup FROM tms_app';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_platform') THEN
    EXECUTE 'REVOKE DELETE, TRUNCATE ON tenant_signup FROM tms_platform';
  END IF;
END $$;

SELECT tms_enable_tenant_rls('tenant_signup');
