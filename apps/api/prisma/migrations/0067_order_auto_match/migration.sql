-- ST3-T06 จับคู่อัตโนมัติ + เรียนรู้ alias (docs/04 C)
-- เลข 0067: 0063–0066 เว้นไว้ให้งาน ST3 อื่นที่ทำคู่ขนาน — prisma migrate deploy เรียงตามชื่อ

-- ผลการจับคู่ของลูกค้า (ระดับใบ) และสถานที่ (ระดับจุด) + รายการแนะนำสำหรับหน้าใบค้าง (ST3-T07)
ALTER TABLE "sales_order" ADD COLUMN "customer_candidates" JSONB,
ADD COLUMN "customer_match_method" TEXT;

ALTER TABLE "sales_order_stop" ADD COLUMN "match_candidates" JSONB,
ADD COLUMN "match_method" TEXT,
ADD COLUMN "match_score" DECIMAL(4,3);

ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_customer_match_method_check"
  CHECK ("customer_match_method" IS NULL OR "customer_match_method" IN ('INPUT', 'EXTERNAL_ID', 'ALIAS', 'MANUAL'));
ALTER TABLE "sales_order_stop" ADD CONSTRAINT "sales_order_stop_match_method_check"
  CHECK ("match_method" IS NULL OR "match_method" IN ('ALIAS', 'NAME', 'FUZZY', 'MANUAL'));
ALTER TABLE "sales_order_stop" ADD CONSTRAINT "sales_order_stop_match_score_check"
  CHECK ("match_score" IS NULL OR ("match_score" >= 0 AND "match_score" <= 1));
-- มีวิธีจับคู่ = ต้องมีผลที่จับคู่ได้
ALTER TABLE "sales_order_stop" ADD CONSTRAINT "sales_order_stop_match_site_check"
  CHECK ("match_method" IS NULL OR "site_id" IS NOT NULL);
ALTER TABLE "sales_order" ADD CONSTRAINT "sales_order_customer_match_check"
  CHECK ("customer_match_method" IS NULL OR "customer_id" IS NOT NULL);

-- alias ลูกค้าที่เรียนรู้จากการจับคู่ของคน
CREATE TABLE "customer_alias" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT '',
    "value" TEXT NOT NULL,
    "value_key" TEXT NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_alias_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "customer_alias_kind_check" CHECK ("kind" IN ('EXTERNAL_ID', 'NAME')),
    CONSTRAINT "customer_alias_key_check" CHECK (length("value_key") BETWEEN 1 AND 500),
    CONSTRAINT "customer_alias_value_check" CHECK (length("value") BETWEEN 1 AND 500),
    -- รหัสลูกค้าผูกกับช่องทาง (source ไม่ว่าง) · ชื่อใช้ทุกช่องทาง (source ว่าง)
    CONSTRAINT "customer_alias_source_check" CHECK (("kind" = 'NAME') = ("source" = ''))
);

CREATE INDEX "customer_alias_tenant_id_customer_id_idx" ON "customer_alias"("tenant_id", "customer_id");
CREATE UNIQUE INDEX "customer_alias_tenant_id_kind_source_value_key_key" ON "customer_alias"("tenant_id", "kind", "source", "value_key");

ALTER TABLE "customer_alias" ADD CONSTRAINT "customer_alias_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

SELECT tms_enable_tenant_rls('customer_alias');

-- ไม่มี hard delete จากแอป (คนจับคู่ใหม่ = UPDATE ย้ายลูกค้า + audit)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE DELETE ON "customer_alias" FROM tms_app';
  END IF;
END $$;
