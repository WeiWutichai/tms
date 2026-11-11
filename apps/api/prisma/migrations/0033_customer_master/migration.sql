-- ST2-T01 ลูกค้า (slice ต้นแบบของ master): ฟิลด์ที่ยังขาดตาม backlog + soft delete (spec/02 MD-004)
ALTER TABLE "customer" ADD COLUMN     "contacts" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "deleted_at" TIMESTAMPTZ(6),
ADD COLUMN     "etax_capable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "free_time_min" INTEGER,
ADD COLUMN     "sales_owner_user_id" UUID,
ADD COLUMN     "vat_registered" BOOLEAN NOT NULL DEFAULT true,
ALTER COLUMN "billing_address" DROP NOT NULL;

-- MD-020: เลขผู้เสียภาษี + สาขา ห้ามซ้ำใน tenant (เฉพาะที่มีเลข และยังไม่ถูกลบ)
CREATE UNIQUE INDEX "customer_tenant_tax_branch_uq" ON "customer"("tenant_id", "tax_id", "branch_code")
  WHERE "tax_id" IS NOT NULL AND "deleted_at" IS NULL;

ALTER TABLE "customer" ADD CONSTRAINT "customer_payment_term_days_range" CHECK ("payment_term_days" BETWEEN 0 AND 365);
ALTER TABLE "customer" ADD CONSTRAINT "customer_free_time_min_range" CHECK ("free_time_min" IS NULL OR "free_time_min" BETWEEN 0 AND 1440);
ALTER TABLE "customer" ADD CONSTRAINT "customer_branch_code_format" CHECK ("branch_code" IS NULL OR "branch_code" ~ '^[0-9]{5}$');
ALTER TABLE "customer" ADD CONSTRAINT "customer_tax_id_format" CHECK ("tax_id" IS NULL OR "tax_id" ~ '^[0-9]{13}$');

-- ตาราง customer เปิด RLS แล้วตั้งแต่ 0004 (schema v0) — เรียกซ้ำได้ (idempotent)
SELECT tms_enable_tenant_rls('customer');

-- ไม่มีการลบจริง (D7 / MD-004): "ลบ" = ตั้ง deleted_at
REVOKE DELETE ON "customer" FROM tms_app;
