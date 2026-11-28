-- P1-ST4-T05: Console "การใช้งาน API" (spec/01 §10.7 PLT-115) — ปิด/เปิด Open API ราย tenant + สถิติคำขอรายวัน
-- (1) tenant.api_disabled_at/by: ไม่ null = API key / OAuth client ทุกตัวของบริษัท (รวม sandbox) ได้ 403 `api_disabled_by_platform` — key ไม่ถูกลบ
-- (2) api_traffic_daily: คำขอ / 4xx / 5xx / 429 / histogram เวลาตอบ ต่อบริษัทต่อวัน (เวลาไทย) — ApiTrafficMeter บวกเพิ่มทุก 30 วิ
--     เขียนโดย role platform เท่านั้น · sandbox ไม่มีแถว

ALTER TABLE "tenant" ADD COLUMN "api_disabled_at" TIMESTAMPTZ(6),
ADD COLUMN "api_disabled_by" UUID;

-- ปิดโดยมีผู้ปิดเสมอ (เปิดกลับ = ล้างทั้งคู่)
ALTER TABLE "tenant" ADD CONSTRAINT "tenant_api_disabled_check"
  CHECK (("api_disabled_at" IS NULL) = ("api_disabled_by" IS NULL));

CREATE TABLE "api_traffic_daily" (
    "tenant_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,
    "errors_4xx" INTEGER NOT NULL DEFAULT 0,
    "errors_5xx" INTEGER NOT NULL DEFAULT 0,
    "throttled" INTEGER NOT NULL DEFAULT 0,
    "latency_hist" INTEGER[],
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_traffic_daily_pkey" PRIMARY KEY ("tenant_id","date"),
    CONSTRAINT "api_traffic_daily_counts_check" CHECK (
      "requests" >= 0 AND "errors_4xx" >= 0 AND "errors_5xx" >= 0 AND "throttled" >= 0)
);

CREATE INDEX "api_traffic_daily_date_idx" ON "api_traffic_daily"("date");

ALTER TABLE "api_traffic_daily" ADD CONSTRAINT "api_traffic_daily_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON api_traffic_daily FROM tms_app';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_platform') THEN
    EXECUTE 'REVOKE TRUNCATE ON api_traffic_daily FROM tms_platform';
  END IF;
END $$;

SELECT tms_enable_tenant_rls('api_traffic_daily');
