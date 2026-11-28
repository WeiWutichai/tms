-- P1-ST2-T06 คิวอนุมัติการสมัคร (spec/01 §10.3 PLT-105–107)

-- tenant_verification: ผลตรวจ/การตัดสินของคิว (1 แถวต่อ tenant)
CREATE TABLE "tenant_verification" (
    "tenant_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "source" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "snapshot_rd" JSONB,
    "snapshot_dbd" JSONB,
    "diff_fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reason" TEXT,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "waiting_since" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_verification_pkey" PRIMARY KEY ("tenant_id"),
    CONSTRAINT "tenant_verification_status_check"
      CHECK ("status" IN ('pending', 'approved', 'rejected', 'info_requested')),
    -- PLT-105: ปฏิเสธ/ขอข้อมูลเพิ่มต้องมีเหตุผล ≥ 10 ตัว
    CONSTRAINT "tenant_verification_reason_check"
      CHECK ("status" IN ('pending', 'approved') OR char_length(btrim("reason")) >= 10)
);

CREATE INDEX "tenant_verification_status_waiting_since_idx" ON "tenant_verification"("status", "waiting_since");

ALTER TABLE "tenant_verification" ADD CONSTRAINT "tenant_verification_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- tenant_join_request: คำขอเข้าร่วมบริษัทเดิม (tenant_id = บริษัทเดิม)
CREATE TABLE "tenant_join_request" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "applicant_name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "mobile" TEXT,
    "tax_id" CHAR(13) NOT NULL,
    "branch_code" CHAR(5) NOT NULL,
    "ip" TEXT,
    "signup_session_id" UUID,
    "owner_due_at" TIMESTAMPTZ(6),
    "reason" TEXT,
    "decided_by_type" TEXT,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "invited_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_join_request_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tenant_join_request_kind_check" CHECK ("kind" IN ('join', 'contact')),
    CONSTRAINT "tenant_join_request_status_check"
      CHECK ("status" IN ('pending_owner', 'pending', 'info_requested', 'approved', 'rejected')),
    CONSTRAINT "tenant_join_request_decided_by_type_check"
      CHECK ("decided_by_type" IS NULL OR "decided_by_type" IN ('tenant_user', 'platform_user')),
    CONSTRAINT "tenant_join_request_reason_check"
      CHECK ("status" IN ('pending_owner', 'pending', 'approved') OR char_length(btrim("reason")) >= 10)
);

CREATE INDEX "tenant_join_request_tenant_id_status_idx" ON "tenant_join_request"("tenant_id", "status");
CREATE INDEX "tenant_join_request_status_created_at_idx" ON "tenant_join_request"("status", "created_at");
-- คำขอที่ยังเปิดอยู่: 1 คำขอต่ออีเมลต่อบริษัท (ส่งซ้ำ = ใช้คำขอเดิม)
CREATE UNIQUE INDEX "tenant_join_request_open_key" ON "tenant_join_request"("tenant_id", "email")
  WHERE "status" IN ('pending_owner', 'pending', 'info_requested');

ALTER TABLE "tenant_join_request" ADD CONSTRAINT "tenant_join_request_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- สิทธิ์: ไม่มีลบทั้งสองตาราง · tenant_verification แอปอ่านอย่างเดียว · tenant_join_request แอปอ่าน + แก้ (owner ตัดสิน) ไม่สร้างเอง
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON tenant_verification FROM tms_app';
    EXECUTE 'REVOKE INSERT, DELETE, TRUNCATE ON tenant_join_request FROM tms_app';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_platform') THEN
    EXECUTE 'REVOKE DELETE, TRUNCATE ON tenant_verification FROM tms_platform';
    EXECUTE 'REVOKE DELETE, TRUNCATE ON tenant_join_request FROM tms_platform';
  END IF;
END $$;

SELECT tms_enable_tenant_rls('tenant_verification');
SELECT tms_enable_tenant_rls('tenant_join_request');
