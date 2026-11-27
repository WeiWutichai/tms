-- P1-ST4-T06 Console ทีมงาน + Audit log (spec/01 §10.8, §11.5; docs/02 §5 Audit log)
-- 1) คำเชิญทีมงาน Innovera: token (sha256) + วันหมดอายุ บน platform_user · สถานะใหม่ INVITED (คอลัมน์ text เดิม)
-- 2) platform_audit_log: การกระทำของทีมงานที่ไม่ผูก tenant (เชิญ/ปิดทีมงาน, ส่งออก audit) — append-only
--    ตารางระดับแพลตฟอร์ม ไม่มี tenant_id (เหมือน platform_user) → ไม่ใช้ RLS · role แอป (tms_app) เข้าไม่ได้เลย
-- 3) partial index ของ audit_log เฉพาะแถวที่ทีม Innovera ทำ (actor/act = `platform:<id>`) — หน้า Audit log ข้าม tenant
-- ย้อนกลับ: DROP INDEX "audit_log_platform_actor_idx"; DROP TABLE "platform_audit_log";
--           ALTER TABLE "platform_user" DROP COLUMN "invite_token_hash", DROP COLUMN "invite_expires_at", DROP COLUMN "invited_by", DROP COLUMN "deactivated_at";

-- AlterTable
ALTER TABLE "platform_user" ADD COLUMN     "deactivated_at" TIMESTAMPTZ(6),
ADD COLUMN     "invite_expires_at" TIMESTAMPTZ(6),
ADD COLUMN     "invite_token_hash" TEXT,
ADD COLUMN     "invited_by" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "platform_user_invite_token_hash_key" ON "platform_user"("invite_token_hash");

-- CreateTable
CREATE TABLE "platform_audit_log" (
    "id" UUID NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "request_id" TEXT,
    "ip" TEXT,
    "seq" BIGSERIAL NOT NULL,

    CONSTRAINT "platform_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_audit_log_at_idx" ON "platform_audit_log"("at");

-- หน้า Audit log ของ Console: เฉพาะแถวที่ทีม Innovera ทำ (ไม่อยู่ใน schema.prisma — partial index แบบ 0172)
CREATE INDEX "audit_log_platform_actor_idx" ON "audit_log" ("at" DESC)
  WHERE "actor_id" LIKE 'platform:%' OR "act_as" LIKE 'platform:%';

-- สิทธิ์: append-only (PLT-126) — platform อ่าน/เพิ่มได้ ไม่มี UPDATE/DELETE · tms_app ไม่แตะเลย
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE ALL ON platform_audit_log FROM tms_app';
    EXECUTE 'REVOKE ALL ON SEQUENCE platform_audit_log_seq_seq FROM tms_app';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_platform') THEN
    EXECUTE 'GRANT SELECT, INSERT ON platform_audit_log TO tms_platform';
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON platform_audit_log FROM tms_platform';
  END IF;
END $$;
