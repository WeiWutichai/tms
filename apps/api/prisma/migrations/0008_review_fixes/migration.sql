-- review 10 พ.ย. 2569
-- ข้อ 6: audit log แบ่งหน้าด้วยลำดับที่เพิ่มขึ้นเสมอ (แถวใน transaction เดียวมี at เท่ากันถึงระดับ microsecond)
ALTER TABLE "audit_log" ADD COLUMN "seq" BIGSERIAL NOT NULL;
CREATE INDEX "audit_log_tenant_id_seq_idx" ON "audit_log"("tenant_id", "seq");
CREATE INDEX "audit_log_tenant_id_entity_type_entity_id_seq_idx" ON "audit_log"("tenant_id", "entity_type", "entity_id", "seq");

-- ข้อ 7: สาขาออกเอกสาร default ได้ 1 สาขาต่อนิติบุคคล (กันกรณีกดพร้อมกัน) — Prisma แสดง partial index ไม่ได้ ดู test/schema-constraints.test.ts
CREATE UNIQUE INDEX "branch_one_default_issuer_per_company" ON "branch"("company_id") WHERE "is_default_issuer";

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE audit_log_seq_seq TO tms_app';
  END IF;
END $$;
