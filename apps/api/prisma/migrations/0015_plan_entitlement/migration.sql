-- ST1-T18: แพ็กเกจ + feature matrix + override ต่อ tenant

-- AlterTable
ALTER TABLE "tenant" ADD COLUMN     "plan_code" TEXT NOT NULL DEFAULT 'std';

-- CreateTable
CREATE TABLE "plan" (
    "code" TEXT NOT NULL,
    "name_th" TEXT NOT NULL,
    "name_en" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "plan_entitlement" (
    "plan_code" TEXT NOT NULL,
    "feature_key" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "limit" INTEGER,

    CONSTRAINT "plan_entitlement_pkey" PRIMARY KEY ("plan_code","feature_key")
);

-- CreateTable
CREATE TABLE "tenant_entitlement_override" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "feature_key" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "limit" INTEGER,
    "reason" TEXT NOT NULL,
    "approved_by" TEXT,
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_entitlement_override_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_entitlement_override_tenant_id_feature_key_key" ON "tenant_entitlement_override"("tenant_id", "feature_key");


-- ข้อมูลแพ็กเกจตัวอย่างจาก design/prototype/plans.js (v3 · 1 ต.ค. 2569 — ราคา/โควตายังไม่สรุป: PROGRESS คำถามค้าง) — แก้ได้จาก Platform Console (T24)
INSERT INTO plan (code, name_th, name_en) VALUES
  ('start', 'เริ่มต้น', 'Starter'), ('std', 'มาตรฐาน', 'Standard'), ('ent', 'องค์กร', 'Enterprise');
INSERT INTO plan_entitlement (plan_code, feature_key, mode, "limit") VALUES
  ('start', 'so', 'included', NULL),
  ('std', 'so', 'included', NULL),
  ('ent', 'so', 'included', NULL),
  ('start', 'plan', 'included', NULL),
  ('std', 'plan', 'included', NULL),
  ('ent', 'plan', 'included', NULL),
  ('start', 'driver', 'included', NULL),
  ('std', 'driver', 'included', NULL),
  ('ent', 'driver', 'included', NULL),
  ('start', 'trips', 'included', NULL),
  ('std', 'trips', 'included', NULL),
  ('ent', 'trips', 'included', NULL),
  ('start', 'sub', 'not_available', NULL),
  ('std', 'sub', 'included', NULL),
  ('ent', 'sub', 'included', NULL),
  ('start', 'track', 'not_available', NULL),
  ('std', 'track', 'included', NULL),
  ('ent', 'track', 'included', NULL),
  ('start', 'exc', 'not_available', NULL),
  ('std', 'exc', 'included', NULL),
  ('ent', 'exc', 'included', NULL),
  ('start', 'bill', 'included', NULL),
  ('std', 'bill', 'included', NULL),
  ('ent', 'bill', 'included', NULL),
  ('start', 'settle', 'not_available', NULL),
  ('std', 'settle', 'included', NULL),
  ('ent', 'settle', 'included', NULL),
  ('start', 'adv', 'included', NULL),
  ('std', 'adv', 'included', NULL),
  ('ent', 'adv', 'included', NULL),
  ('start', 'conn', 'not_available', NULL),
  ('std', 'conn', 'included', 1),
  ('ent', 'conn', 'included', NULL),
  ('start', 'multi', 'not_available', NULL),
  ('std', 'multi', 'not_available', NULL),
  ('ent', 'multi', 'included', NULL),
  ('start', 'fleet', 'not_available', NULL),
  ('std', 'fleet', 'included', NULL),
  ('ent', 'fleet', 'included', NULL),
  ('start', 'fleetx', 'not_available', NULL),
  ('std', 'fleetx', 'addon', NULL),
  ('ent', 'fleetx', 'included', NULL),
  ('start', 'report', 'not_available', NULL),
  ('std', 'report', 'included', NULL),
  ('ent', 'report', 'included', NULL),
  ('start', 'portal', 'not_available', NULL),
  ('std', 'portal', 'addon', NULL),
  ('ent', 'portal', 'included', NULL),
  ('start', 'api', 'not_available', NULL),
  ('std', 'api', 'included', 300),
  ('ent', 'api', 'included', 1000),
  ('start', 'webhook', 'not_available', NULL),
  ('std', 'webhook', 'included', 3),
  ('ent', 'webhook', 'included', NULL),
  ('start', 'cf', 'included', 5),
  ('std', 'cf', 'included', 20),
  ('ent', 'cf', 'included', NULL),
  ('start', 'veh', 'included', 20),
  ('std', 'veh', 'included', 80),
  ('ent', 'veh', 'included', NULL),
  ('start', 'users', 'included', NULL),
  ('std', 'users', 'included', NULL),
  ('ent', 'users', 'included', NULL);

-- ข้อมูลแพ็กเกจ/override แก้ได้เฉพาะ role platform (แอปอ่านได้อย่างเดียว)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON plan, plan_entitlement, tenant_entitlement_override FROM tms_app';
    EXECUTE 'REVOKE UPDATE (plan_code) ON tenant FROM tms_app';
  END IF;
END $$;
SELECT tms_enable_tenant_rls('tenant_entitlement_override');
