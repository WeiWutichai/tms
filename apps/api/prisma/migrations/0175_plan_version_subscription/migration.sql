-- P1-ST1-T01: Feature catalog + PlanVersion (immutable หลัง publish) + Subscription ต่อ tenant + audit ระดับแพลตฟอร์ม
-- spec/01 §6 (PLT-060–062) · docs/02 §2 · plan/13 R-06 (seed 4 tier ราคาตั้งต้น) · R-07 (ฟีเจอร์ปิดเดือน = isBasic ทุกแพ็กเกจ)
-- ยังไม่มี tenant จริง (D-76) → ย้าย plan_entitlement จาก plan_code → plan_version_id ในที่เดียว ไม่ต้อง backfill ข้อมูลลูกค้า

-- ───────────────────────── plan: สถานะ/ลำดับ/แสดงบนเว็บ ─────────────────────────
ALTER TABLE "plan" ADD COLUMN     "badge" TEXT,
ADD COLUMN     "is_contact_sales" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "show_on_web" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "sort_order" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "status" VARCHAR(10) NOT NULL DEFAULT 'active';
ALTER TABLE "plan" ADD CONSTRAINT "plan_status_check" CHECK ("status" IN ('draft', 'active', 'archived'));

-- R-06 [DECISION — lead 27 พ.ย. 2569, ย้อนได้]: 4 tier ตาม docs/02 §2 — คงรหัสเดิม start/std/ent (tenant/test ผูกอยู่) + เพิ่ม biz
-- ชื่อแสดงตาม docs/02 (Starter/Growth/Business/Enterprise) จนกว่า PO เคาะ D-40
UPDATE "plan" SET name_th = 'Starter', name_en = 'Starter', sort_order = 1 WHERE code = 'start';
UPDATE "plan" SET name_th = 'Growth', name_en = 'Growth', sort_order = 2, badge = 'นิยม' WHERE code = 'std';
INSERT INTO "plan" (code, name_th, name_en, sort_order) VALUES ('biz', 'Business', 'Business', 3);
UPDATE "plan" SET name_th = 'Enterprise', name_en = 'Enterprise', sort_order = 4, is_contact_sales = true WHERE code = 'ent';

-- ───────────────────────── feature catalog ─────────────────────────
CREATE TABLE "feature" (
    "key" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "name_th" TEXT NOT NULL,
    "name_en" TEXT,
    "type" VARCHAR(10) NOT NULL DEFAULT 'boolean',
    "unit" TEXT,
    "is_basic" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "feature_pkey" PRIMARY KEY ("key"),
    CONSTRAINT "feature_type_check" CHECK ("type" IN ('boolean', 'limit', 'metered'))
);

-- key เดิมของ ST1-T18 (ต้นแบบ plans.js — โค้ด guard ผูกอยู่) + `acc_export` (Export ให้บัญชี — docs/02 §2 แถว ✓ ทุก tier)
-- isBasic (R-07 + docs/02 §2 "ทุกอย่างที่ต้องมีเพื่อปิดเดือนอยู่ Starter" + K2): งานขนส่งหลัก, ePOD (driver), ลิงก์จ่ายงานรถร่วม (sub),
-- reason code/ข้อยกเว้น (exc), วางบิล (bill), settlement (settle), เงินเบิก (adv), export ให้บัญชี (acc_export), ผู้ใช้ไม่จำกัด (users)
INSERT INTO "feature" (key, category, name_th, name_en, type, unit, is_basic, sort_order) VALUES
  ('so',         'ปฏิบัติการ',       'ใบสั่งขนส่ง (SO) / ใบส่งของ (DO)', 'Sales / delivery orders', 'boolean', NULL, true, 10),
  ('plan',       'ปฏิบัติการ',       'กระดานวางแผน', 'Planning board', 'boolean', NULL, true, 20),
  ('driver',     'ปฏิบัติการ',       'แอปคนขับ + POD', 'Driver app + POD', 'boolean', NULL, true, 30),
  ('trips',      'ปฏิบัติการ',       'เที่ยวรถ / ใบคุมรถ', 'Trips / trip sheets', 'boolean', NULL, true, 40),
  ('sub',        'ปฏิบัติการ',       'จ่ายงานรถร่วม', 'Subcontractor dispatch', 'boolean', NULL, true, 50),
  ('track',      'ปฏิบัติการ',       'ติดตามรถ (GPS)', 'Vehicle tracking (GPS)', 'boolean', NULL, false, 60),
  ('exc',        'ปฏิบัติการ',       'ศูนย์ข้อยกเว้น', 'Exception center', 'boolean', NULL, true, 70),
  ('bill',       'บัญชี',            'วางบิล / ใบแจ้งหนี้ / รับชำระ', 'Billing / invoices / payments', 'boolean', NULL, true, 80),
  ('settle',     'บัญชี',            'Settlement รถร่วม', 'Subcontractor settlement', 'boolean', NULL, true, 90),
  ('adv',        'บัญชี',            'เงินเบิกคนขับ', 'Driver advances', 'boolean', NULL, true, 100),
  ('acc_export', 'บัญชี',            'Export ให้บัญชี (Excel / CSV)', 'Accountant export (Excel / CSV)', 'boolean', NULL, true, 105),
  ('conn',       'บัญชี',            'เชื่อมโปรแกรมบัญชี (connector)', 'Accounting connector', 'limit', 'ตัว', false, 110),
  ('multi',      'บัญชี',            'หลายนิติบุคคล', 'Multiple legal entities', 'boolean', NULL, false, 120),
  ('fleet',      'Fleet',            'ทะเบียนรถ เอกสารรถ ใบสั่งซ่อม', 'Fleet basics', 'boolean', NULL, false, 130),
  ('fleetx',     'Fleet',            'ยาง อะไหล่ ถังน้ำมัน', 'Full fleet (tyres, parts, fuel)', 'boolean', NULL, false, 140),
  ('report',     'รายงานและลูกค้า',  'รายงาน', 'Reports', 'boolean', NULL, false, 150),
  ('portal',     'รายงานและลูกค้า',  'Customer portal', 'Customer portal', 'boolean', NULL, false, 160),
  ('api',        'เชื่อมต่อ',        'Open API + MCP (req/นาที)', 'Open API + MCP (req/min)', 'limit', 'req/นาที', false, 170),
  ('webhook',    'เชื่อมต่อ',        'Webhook (endpoint)', 'Webhook endpoints', 'limit', 'endpoint', false, 180),
  ('cf',         'เชื่อมต่อ',        'ฟิลด์เพิ่มเติม (ต่อ entity)', 'Custom fields (per entity)', 'limit', 'ฟิลด์', false, 190),
  ('veh',        'โควตา',            'รถ active / เดือน', 'Active vehicles / month', 'metered', 'คัน', false, 200),
  ('users',      'โควตา',            'ผู้ใช้', 'Users', 'limit', 'คน', true, 210);

-- ───────────────────────── plan_version ─────────────────────────
CREATE TABLE "plan_version" (
    "id" UUID NOT NULL,
    "plan_code" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'draft',
    "price_per_vehicle_monthly" DECIMAL(14,2),
    "minimum_monthly" DECIMAL(14,2),
    "annual_discount_pct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "volume_tiers" JSONB NOT NULL DEFAULT '[]',
    "vehicle_min" INTEGER NOT NULL DEFAULT 1,
    "vehicle_max" INTEGER,
    "trial_days" INTEGER NOT NULL DEFAULT 30,
    "currency" CHAR(3) NOT NULL DEFAULT 'THB',
    "vat_mode" VARCHAR(10) NOT NULL DEFAULT 'exclusive',
    "provisional" BOOLEAN NOT NULL DEFAULT false,
    "effective_from" TIMESTAMPTZ(6) NOT NULL,
    "published_at" TIMESTAMPTZ(6),
    "published_by" UUID,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_version_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "plan_version_status_check" CHECK ("status" IN ('draft', 'published', 'retired')),
    CONSTRAINT "plan_version_version_check" CHECK ("version" >= 1),
    CONSTRAINT "plan_version_money_check" CHECK (
      ("price_per_vehicle_monthly" IS NULL OR "price_per_vehicle_monthly" >= 0)
      AND ("minimum_monthly" IS NULL OR "minimum_monthly" >= 0)),
    CONSTRAINT "plan_version_discount_check" CHECK ("annual_discount_pct" >= 0 AND "annual_discount_pct" <= 100),
    CONSTRAINT "plan_version_vehicles_check" CHECK ("vehicle_min" >= 1 AND ("vehicle_max" IS NULL OR "vehicle_max" >= "vehicle_min")),
    CONSTRAINT "plan_version_trial_check" CHECK ("trial_days" >= 0 AND "trial_days" <= 365),
    CONSTRAINT "plan_version_tiers_check" CHECK (jsonb_typeof("volume_tiers") = 'array'),
    CONSTRAINT "plan_version_currency_check" CHECK ("currency" = 'THB'),
    CONSTRAINT "plan_version_vat_mode_check" CHECK ("vat_mode" = 'exclusive'),
    CONSTRAINT "plan_version_published_check" CHECK ("status" = 'draft' OR "published_at" IS NOT NULL)
);
CREATE UNIQUE INDEX "plan_version_plan_code_version_key" ON "plan_version"("plan_code", "version");
-- draft ได้ทีละ 1 ต่อแพ็กเกจ
CREATE UNIQUE INDEX "plan_version_one_draft_key" ON "plan_version"("plan_code") WHERE "status" = 'draft';
ALTER TABLE "plan_version" ADD CONSTRAINT "plan_version_plan_code_fkey" FOREIGN KEY ("plan_code") REFERENCES "plan"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- R-06 seed v1 ตาม docs/02 §2 (ราคาตั้งต้น — ยังไม่ประกาศ: provisional) · Enterprise = ตกลงราคา (null)
-- uuid คงที่ — อ้างใน test/seed ได้
INSERT INTO "plan_version" (id, plan_code, version, status, price_per_vehicle_monthly, minimum_monthly, annual_discount_pct,
                            vehicle_min, vehicle_max, trial_days, provisional, effective_from) VALUES
  ('00000000-0000-4000-9000-000000000001', 'start', 1, 'draft', 350.00, 2500.00, 15.00, 1, 15, 30, true, '2026-11-27 00:00:00+07'),
  ('00000000-0000-4000-9000-000000000002', 'std', 1, 'draft', 280.00, 4500.00, 15.00, 16, 60, 30, true, '2026-11-27 00:00:00+07'),
  ('00000000-0000-4000-9000-000000000003', 'biz', 1, 'draft', 220.00, 13500.00, 15.00, 61, 200, 30, true, '2026-11-27 00:00:00+07'),
  ('00000000-0000-4000-9000-000000000004', 'ent', 1, 'draft', NULL, NULL, 0.00, 201, NULL, 30, true, '2026-11-27 00:00:00+07');

-- ───────────────────────── plan_entitlement → plan_version_id ─────────────────────────
ALTER TABLE "plan_entitlement" DROP CONSTRAINT "plan_entitlement_plan_code_fkey";
ALTER TABLE "plan_entitlement" ADD COLUMN "plan_version_id" UUID;
UPDATE "plan_entitlement" e SET plan_version_id = v.id FROM "plan_version" v WHERE v.plan_code = e.plan_code AND v.version = 1;
-- ฟีเจอร์ที่ไม่มีในแคตตาล็อก (ไม่ควรมี) ทิ้งไป — FK feature บังคับต่อจากนี้
DELETE FROM "plan_entitlement" WHERE plan_version_id IS NULL OR feature_key NOT IN (SELECT key FROM "feature");
-- Business = Growth + หลายนิติบุคคล + Open API 1,000 req/นาที (docs/02 §2 แถว "หลายนิติบุคคล", PLT-064)
-- [DECISION — lead 27 พ.ย. 2569, ย้อนได้] ช่องอื่นของ Business เท่า Growth จนกว่า PO เคาะ D-40
INSERT INTO "plan_entitlement" (plan_code, feature_key, mode, "limit", plan_version_id)
  SELECT 'biz', feature_key,
         CASE WHEN feature_key = 'multi' THEN 'included' ELSE mode END,
         CASE WHEN feature_key = 'api' THEN 1000 ELSE "limit" END,
         '00000000-0000-4000-9000-000000000003'
    FROM "plan_entitlement" WHERE plan_code = 'std';
-- R-07: ฟีเจอร์ปิดเดือน included ทุกแพ็กเกจ (เดิม Starter ไม่มี sub/settle/exc)
INSERT INTO "plan_entitlement" (plan_code, feature_key, mode, "limit", plan_version_id)
  SELECT v.plan_code, 'acc_export', 'included', NULL, v.id FROM "plan_version" v;
UPDATE "plan_entitlement" e SET mode = 'included'
  FROM "feature" f WHERE f.key = e.feature_key AND f.is_basic AND e.mode <> 'included';
-- โควตารถ = เพดานช่วงจำนวนรถของ tier (docs/02 §2: 15 / 60 / 200 / ไม่จำกัด)
UPDATE "plan_entitlement" e SET "limit" = v.vehicle_max FROM "plan_version" v WHERE v.id = e.plan_version_id AND e.feature_key = 'veh';

ALTER TABLE "plan_entitlement" DROP CONSTRAINT "plan_entitlement_pkey";
ALTER TABLE "plan_entitlement" DROP COLUMN "plan_code";
ALTER TABLE "plan_entitlement" ALTER COLUMN "plan_version_id" SET NOT NULL;
ALTER TABLE "plan_entitlement" ADD CONSTRAINT "plan_entitlement_pkey" PRIMARY KEY ("plan_version_id", "feature_key");
ALTER TABLE "plan_entitlement" ADD CONSTRAINT "plan_entitlement_plan_version_id_fkey" FOREIGN KEY ("plan_version_id") REFERENCES "plan_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "plan_entitlement" ADD CONSTRAINT "plan_entitlement_feature_key_fkey" FOREIGN KEY ("feature_key") REFERENCES "feature"("key") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "plan_entitlement" ADD CONSTRAINT "plan_entitlement_limit_check" CHECK ("limit" IS NULL OR "limit" >= 0);

-- publish v1 ทั้ง 4 แพ็กเกจ (หลังใส่สิทธิ์ครบ — trigger ด้านล่างล็อกเวอร์ชันที่ publish แล้ว)
UPDATE "plan_version" SET status = 'published', published_at = '2026-11-27 00:00:00+07' WHERE version = 1;

-- ───────────────────────── immutable + ล็อกฟีเจอร์พื้นฐาน (PLT-060/061) ─────────────────────────
-- เจ้าของตาราง (migration/ล้างฐาน test) ข้ามได้ · role แอป/แพลตฟอร์มต้องเคารพเสมอ
CREATE OR REPLACE FUNCTION tms_is_catalog_owner() RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS
$$ SELECT current_user = (SELECT pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c
                            JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                           WHERE n.nspname = 'public' AND c.relname = 'plan_version') $$;

CREATE OR REPLACE FUNCTION tms_plan_version_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS
$$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' AND NOT tms_is_catalog_owner() THEN
      RAISE EXCEPTION 'plan_version_immutable: version % of % is %', OLD.version, OLD.plan_code, OLD.status
        USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'draft' THEN
    IF NEW.status = 'retired' THEN
      RAISE EXCEPTION 'plan_version_immutable: draft cannot be retired' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  -- published/retired: เปลี่ยนได้เฉพาะ published → retired (ช่องอื่นต้องเท่าเดิม)
  IF OLD.status = 'published' AND NEW.status = 'retired'
     AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status') THEN
    RETURN NEW;
  END IF;
  IF tms_is_catalog_owner() AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'plan_version_immutable: version % of % is %', OLD.version, OLD.plan_code, OLD.status
    USING ERRCODE = 'P0001';
END
$$;
CREATE TRIGGER plan_version_guard BEFORE UPDATE OR DELETE ON "plan_version"
  FOR EACH ROW EXECUTE FUNCTION tms_plan_version_guard();

CREATE OR REPLACE FUNCTION tms_plan_entitlement_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS
$$
DECLARE st text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    SELECT status INTO st FROM plan_version WHERE id = OLD.plan_version_id;
    -- st IS NULL = แถวถูกลบตาม plan_version (cascade)
    IF st IS NOT NULL AND st <> 'draft' AND NOT tms_is_catalog_owner() THEN
      RAISE EXCEPTION 'plan_version_immutable: entitlements of a % version are read-only', st USING ERRCODE = 'P0001';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  SELECT status INTO st FROM plan_version WHERE id = NEW.plan_version_id;
  IF st IS DISTINCT FROM 'draft' AND NOT tms_is_catalog_owner() THEN
    RAISE EXCEPTION 'plan_version_immutable: entitlements of a % version are read-only', st USING ERRCODE = 'P0001';
  END IF;
  IF NEW.mode <> 'included' AND EXISTS (SELECT 1 FROM feature WHERE key = NEW.feature_key AND is_basic) THEN
    RAISE EXCEPTION 'basic_feature_locked: % must be included in every plan', NEW.feature_key USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER plan_entitlement_guard BEFORE INSERT OR UPDATE OR DELETE ON "plan_entitlement"
  FOR EACH ROW EXECUTE FUNCTION tms_plan_entitlement_guard();

-- ฟีเจอร์ที่เปลี่ยนเป็นพื้นฐานต้องไม่มีเวอร์ชันใดตั้งไว้ไม่ใช่ included
CREATE OR REPLACE FUNCTION tms_feature_basic_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS
$$
BEGIN
  IF NEW.is_basic AND EXISTS (SELECT 1 FROM plan_entitlement WHERE feature_key = NEW.key AND mode <> 'included') THEN
    RAISE EXCEPTION 'basic_feature_locked: % is not included in some plan versions', NEW.key USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER feature_basic_guard BEFORE INSERT OR UPDATE OF is_basic ON "feature"
  FOR EACH ROW EXECUTE FUNCTION tms_feature_basic_guard();

-- ───────────────────────── subscription ─────────────────────────
CREATE TABLE "subscription" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "plan_version_id" UUID NOT NULL,
    "billing_cycle" VARCHAR(10) NOT NULL DEFAULT 'monthly',
    "status" VARCHAR(10) NOT NULL DEFAULT 'trialing',
    "trial_ends_at" TIMESTAMPTZ(6),
    "current_period_start" TIMESTAMPTZ(6),
    "current_period_end" TIMESTAMPTZ(6),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "committed_vehicles" INTEGER,
    "next_plan_version_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "subscription_billing_cycle_check" CHECK ("billing_cycle" IN ('monthly', 'annual')),
    CONSTRAINT "subscription_status_check" CHECK ("status" IN ('trialing', 'active', 'past_due', 'cancelled')),
    CONSTRAINT "subscription_period_check" CHECK ("current_period_end" IS NULL OR "current_period_start" IS NULL OR "current_period_end" >= "current_period_start"),
    CONSTRAINT "subscription_committed_check" CHECK ("committed_vehicles" IS NULL OR "committed_vehicles" >= 1)
);
CREATE UNIQUE INDEX "subscription_tenant_id_key" ON "subscription"("tenant_id");
CREATE INDEX "subscription_plan_version_id_idx" ON "subscription"("plan_version_id");
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_plan_version_id_fkey" FOREIGN KEY ("plan_version_id") REFERENCES "plan_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_next_plan_version_id_fkey" FOREIGN KEY ("next_plan_version_id") REFERENCES "plan_version"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- subscription ต้องอยู่บนเวอร์ชันที่ publish แล้ว (draft ไม่มีผลกับลูกค้า)
CREATE OR REPLACE FUNCTION tms_subscription_version_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM plan_version WHERE id = NEW.plan_version_id AND status <> 'draft') THEN
    RAISE EXCEPTION 'subscription must reference a published plan version' USING ERRCODE = 'P0001';
  END IF;
  IF NEW.next_plan_version_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM plan_version WHERE id = NEW.next_plan_version_id AND status = 'published') THEN
    RAISE EXCEPTION 'next plan version must be published' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER subscription_version_guard BEFORE INSERT OR UPDATE OF plan_version_id, next_plan_version_id ON "subscription"
  FOR EACH ROW EXECUTE FUNCTION tms_subscription_version_guard();

-- เวอร์ชันที่มีผลตอนนี้ของแพ็กเกจ = published ล่าสุดที่ effective_from ≤ now()
CREATE OR REPLACE FUNCTION tms_current_plan_version(code text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$ SELECT id FROM plan_version
    WHERE plan_code = code AND status = 'published' AND effective_from <= now()
    ORDER BY version DESC LIMIT 1 $$;

-- tenant (live) ใหม่ → subscription บนเวอร์ชันปัจจุบัน · sandbox (mode test) ใช้ของบริษัทจริง (ST7-T09) ไม่มีแถวของตัวเอง
CREATE OR REPLACE FUNCTION tms_subscription_for_tenant() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE
  v uuid := tms_current_plan_version(NEW.plan_code);
  trial_d int;
  now_ts timestamptz := now();
BEGIN
  IF NEW.mode <> 'live' THEN RETURN NEW; END IF;
  IF v IS NULL THEN
    RAISE EXCEPTION 'plan % has no published version in effect', NEW.plan_code USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND EXISTS (SELECT 1 FROM subscription WHERE tenant_id = NEW.id) THEN
    -- เปลี่ยนแพ็กเกจ → เวอร์ชันปัจจุบันของแพ็กเกจใหม่ (ล้างการย้ายที่รอมีผล)
    UPDATE subscription SET plan_version_id = v, next_plan_version_id = NULL,
           version = version + 1, updated_at = now_ts
     WHERE tenant_id = NEW.id;
    RETURN NEW;
  END IF;
  SELECT trial_days INTO trial_d FROM plan_version WHERE id = v;
  INSERT INTO subscription (tenant_id, plan_version_id, status, trial_ends_at, current_period_start, current_period_end)
  VALUES (
    NEW.id, v,
    CASE NEW.status WHEN 'TRIAL' THEN 'trialing' WHEN 'CANCELLED' THEN 'cancelled' ELSE 'active' END,
    CASE WHEN NEW.status = 'TRIAL' THEN now_ts + make_interval(days => trial_d) END,
    now_ts,
    CASE WHEN NEW.status = 'TRIAL' THEN now_ts + make_interval(days => trial_d)
         -- รอบรายเดือนตามปฏิทินไทย: ถึงต้นเดือนถัดไป 00:00 Asia/Bangkok
         ELSE (date_trunc('month', now_ts AT TIME ZONE 'Asia/Bangkok') + interval '1 month') AT TIME ZONE 'Asia/Bangkok' END
  );
  RETURN NEW;
END
$$;
CREATE TRIGGER tenant_subscription_insert AFTER INSERT ON "tenant"
  FOR EACH ROW EXECUTE FUNCTION tms_subscription_for_tenant();
CREATE TRIGGER tenant_subscription_plan AFTER UPDATE OF plan_code ON "tenant"
  FOR EACH ROW WHEN (OLD.plan_code IS DISTINCT FROM NEW.plan_code) EXECUTE FUNCTION tms_subscription_for_tenant();

-- tenant ที่มีอยู่ (dev/seed — ยังไม่มีลูกค้าจริง D-76)
INSERT INTO subscription (tenant_id, plan_version_id, status, trial_ends_at, current_period_start, current_period_end)
SELECT t.id, tms_current_plan_version(t.plan_code),
       CASE t.status WHEN 'TRIAL' THEN 'trialing' WHEN 'CANCELLED' THEN 'cancelled' ELSE 'active' END,
       CASE WHEN t.status = 'TRIAL' THEN t.created_at + interval '30 days' END,
       t.created_at,
       CASE WHEN t.status = 'TRIAL' THEN t.created_at + interval '30 days'
            ELSE (date_trunc('month', now() AT TIME ZONE 'Asia/Bangkok') + interval '1 month') AT TIME ZONE 'Asia/Bangkok' END
  FROM tenant t WHERE t.mode = 'live';

-- ───────────────────────── platform_audit_log (ระดับแพลตฟอร์ม, append-only) ─────────────────────────
CREATE TABLE "platform_audit_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "platform_user_id" UUID,
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
CREATE INDEX "platform_audit_log_entity_type_entity_id_seq_idx" ON "platform_audit_log"("entity_type", "entity_id", "seq");
CREATE INDEX "platform_audit_log_at_idx" ON "platform_audit_log"("at");

-- ───────────────────────── สิทธิ์ ─────────────────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    -- แคตตาล็อก/เวอร์ชัน/subscription: แอปอ่านอย่างเดียว (แก้จาก Platform Console เท่านั้น)
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON feature, plan_version, subscription FROM tms_app';
    EXECUTE 'REVOKE ALL ON platform_audit_log FROM tms_app';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_platform') THEN
    -- แคตตาล็อกฟีเจอร์เพิ่มโดย dev ผ่าน migration · audit append-only
    EXECUTE 'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON feature FROM tms_platform';
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON platform_audit_log FROM tms_platform';
  END IF;
END $$;

SELECT tms_enable_tenant_rls('subscription');
