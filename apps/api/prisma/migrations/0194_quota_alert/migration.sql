-- P1-ST1-T08 แจ้งเตือนโควตา 80/90/100% ครั้งเดียวต่อระดับต่อเดือน (spec/01 PLT-082)
-- role แอป INSERT ได้ (แถว + แจ้งเตือนใน transaction เดียวกันของ tenant — RLS) · แก้/ลบไม่ได้
CREATE TABLE "quota_alert" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "metric" VARCHAR(40) NOT NULL,
    "period" CHAR(7) NOT NULL,
    "level" SMALLINT NOT NULL,
    "used" INTEGER NOT NULL,
    "limit" INTEGER NOT NULL,
    "notified_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quota_alert_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "quota_alert_level_check" CHECK ("level" IN (80, 90, 100)),
    CONSTRAINT "quota_alert_period_check" CHECK ("period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
    CONSTRAINT "quota_alert_values_check" CHECK ("used" >= 0 AND "limit" >= 0)
);

CREATE UNIQUE INDEX "quota_alert_tenant_id_metric_period_level_key" ON "quota_alert"("tenant_id", "metric", "period", "level");

ALTER TABLE "quota_alert" ADD CONSTRAINT "quota_alert_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON quota_alert FROM tms_app';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_platform') THEN
    EXECUTE 'REVOKE TRUNCATE ON quota_alert FROM tms_platform';
  END IF;
END $$;

SELECT tms_enable_tenant_rls('quota_alert');
