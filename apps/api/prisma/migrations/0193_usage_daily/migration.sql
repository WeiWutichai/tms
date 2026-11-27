-- P1-ST1-T07: ยอดการใช้งานรายวัน (spec/01 §7 `UsageDaily` · docs/02 §5 Usage & Billing · plan/13 R-17)
-- เมตริกสะสม (do.created, invoices.issued, api.calls[rest|mcp]) → ยอดเดือน = ผลรวมรายวัน (usage_record ตอนปิดยอด)
-- เมตริกค่า ณ วัน (storage.pod_gb, connectors.accounting, users.active) → ยอดเดือน = ค่าของวันล่าสุดในเดือน
-- เขียนโดย role platform เท่านั้น (worker rollup ทุก 10 นาที + ApiUsageMeter flush แบบบวกเพิ่ม) · sandbox ไม่มีแถว

CREATE TABLE "usage_daily" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "metric" VARCHAR(40) NOT NULL,
    "source" VARCHAR(16) NOT NULL DEFAULT '',
    "value" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_daily_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "usage_daily_value_check" CHECK ("value" >= 0),
    CONSTRAINT "usage_daily_source_check" CHECK ("source" IN ('', 'rest', 'mcp'))
);

CREATE INDEX "usage_daily_metric_date_idx" ON "usage_daily"("metric", "date");
CREATE UNIQUE INDEX "usage_daily_tenant_id_date_metric_source_key" ON "usage_daily"("tenant_id", "date", "metric", "source");

ALTER TABLE "usage_daily" ADD CONSTRAINT "usage_daily_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON usage_daily FROM tms_app';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_platform') THEN
    EXECUTE 'REVOKE TRUNCATE ON usage_daily FROM tms_platform';
  END IF;
END $$;

SELECT tms_enable_tenant_rls('usage_daily');
