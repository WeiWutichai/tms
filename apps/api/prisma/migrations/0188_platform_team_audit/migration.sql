-- P1-ST4-T06 Console ทีมงาน + Audit log (spec/01 §10.8, §11.5; docs/02 §5 Audit log)
-- 1) คำเชิญทีมงาน Innovera: token (sha256) + วันหมดอายุ บน platform_user · สถานะใหม่ INVITED (คอลัมน์ text เดิม)
-- 2) platform_audit_log (สร้างใน 0175 — P1-ST1-T01): เพิ่ม trigger append-only ระดับฐาน (ชั้นที่สองต่อจาก REVOKE ของ 0175)
--    ใช้บันทึกเชิญ/ปิดทีมงาน, รับคำเชิญ, ส่งออก audit ด้วย
-- 3) partial index ของ audit_log เฉพาะแถวที่ทีม Innovera ทำ (actor/act = `platform:<id>`) — หน้า Audit log ข้าม tenant
-- ย้อนกลับ: DROP INDEX "audit_log_platform_actor_idx"; DROP TRIGGER "platform_audit_log_append_only" ON "platform_audit_log";
--           DROP INDEX "platform_user_invite_token_hash_key";
--           ALTER TABLE "platform_user" DROP COLUMN "invite_token_hash", DROP COLUMN "invite_expires_at", DROP COLUMN "invited_by", DROP COLUMN "deactivated_at";

-- AlterTable
ALTER TABLE "platform_user" ADD COLUMN     "deactivated_at" TIMESTAMPTZ(6),
ADD COLUMN     "invite_expires_at" TIMESTAMPTZ(6),
ADD COLUMN     "invite_token_hash" TEXT,
ADD COLUMN     "invited_by" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "platform_user_invite_token_hash_key" ON "platform_user"("invite_token_hash");

-- หน้า Audit log ของ Console: เฉพาะแถวที่ทีม Innovera ทำ (ไม่อยู่ใน schema.prisma — partial index แบบ 0172)
CREATE INDEX "audit_log_platform_actor_idx" ON "audit_log" ("at" DESC)
  WHERE "actor_id" LIKE 'platform:%' OR "act_as" LIKE 'platform:%';

-- append-only ระดับฐาน (มีผลทุก role รวมเจ้าของตาราง) — ใช้ฟังก์ชันเดียวกับ audit_log (0007/0108):
-- UPDATE ปฏิเสธเสมอ · DELETE ได้เฉพาะงานล้างตามอายุที่ตั้งธง tms.audit_retention_purge ในนามเจ้าของตาราง (ยังไม่มีงานนี้สำหรับตารางนี้)
CREATE TRIGGER "platform_audit_log_append_only"
  BEFORE UPDATE OR DELETE ON "platform_audit_log"
  FOR EACH ROW EXECUTE FUNCTION tms_audit_append_only();
