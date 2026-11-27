-- P1-ST1-T03 วงจรสถานะ tenant (spec/01 §1 PLT-010–019 · plan/13 R-10, D-45)
-- tenant: เวลา/เหตุผลของสถานะล่าสุด + วัน 0 ของ dunning + วันยกเลิก/วันครบเก็บข้อมูล
ALTER TABLE "tenant" ADD COLUMN "status_changed_at" TIMESTAMPTZ(6),
ADD COLUMN "status_reason" TEXT,
ADD COLUMN "past_due_since" DATE,
ADD COLUMN "dunning_kind" VARCHAR(8),
ADD COLUMN "cancelled_at" TIMESTAMPTZ(6),
ADD COLUMN "data_purge_at" TIMESTAMPTZ(6);
ALTER TABLE "tenant" ADD CONSTRAINT "tenant_dunning_kind_check"
  CHECK ("dunning_kind" IS NULL OR "dunning_kind" IN ('invoice', 'trial'));
-- dunning ต้องมีวัน 0 คู่กันเสมอ
ALTER TABLE "tenant" ADD CONSTRAINT "tenant_dunning_pair_check"
  CHECK (("dunning_kind" IS NULL) = ("past_due_since" IS NULL));

-- ประวัติสถานะ (PLT-019) — append-only
CREATE TABLE "tenant_status_history" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "from_status" "tenant_status",
    "to_status" "tenant_status" NOT NULL,
    "reason" TEXT NOT NULL,
    "actor_type" VARCHAR(16) NOT NULL,
    "actor_id" TEXT,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seq" BIGSERIAL NOT NULL,

    CONSTRAINT "tenant_status_history_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tenant_status_history_actor_type_check" CHECK ("actor_type" IN ('system', 'platform_user', 'tenant_user')),
    CONSTRAINT "tenant_status_history_reason_check" CHECK (length(btrim("reason")) > 0),
    CONSTRAINT "tenant_status_history_changed_check" CHECK ("from_status" IS DISTINCT FROM "to_status")
);
CREATE INDEX "tenant_status_history_tenant_id_seq_idx" ON "tenant_status_history"("tenant_id", "seq");
ALTER TABLE "tenant_status_history" ADD CONSTRAINT "tenant_status_history_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- สิทธิ์: แอปอ่านได้เฉพาะของ tenant ตัวเอง (RLS) · เขียนผ่าน role platform (บริการเปลี่ยนสถานะ/cron/Console) · ไม่มีแก้/ลบย้อนหลัง
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON tenant_status_history FROM tms_app';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_platform') THEN
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON tenant_status_history FROM tms_platform';
  END IF;
END $$;

SELECT tms_enable_tenant_rls('tenant_status_history');
