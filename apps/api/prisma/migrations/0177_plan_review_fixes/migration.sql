-- P1-ST1-T01/T04 แก้ตาม review (lead 27 พ.ย. 2569)
-- S2: ย้ายการสร้าง/ย้าย subscription ออกจาก trigger ไปโค้ดแอป (modules/entitlements/subscription.ts) — ฐานข้อมูลเหลือแค่ guard
-- S1: plan_version.row_version สำหรับ ETag/If-Match (docs/01 §5.1)
-- S3: guard immutable ครอบ INSERT + ตรวจฟีเจอร์พื้นฐานครบตอน publish
-- S4: ตาม docs/02 §2 (D-68) — Starter มีรายงานพื้นฐาน · ส่งรายงานตามเวลาแยกเป็น report_adv · Growth/Business มี Customer portal ·
--     โควตา veh กลับเป็นค่าเดิม (ช่วงรถของ tier = ช่วงราคา ไม่ใช่โควตา — [OPEN — PO])

-- ───────────── S2 ─────────────
DROP TRIGGER IF EXISTS tenant_subscription_insert ON "tenant";
DROP TRIGGER IF EXISTS tenant_subscription_plan ON "tenant";
DROP FUNCTION IF EXISTS tms_subscription_for_tenant();
DROP FUNCTION IF EXISTS tms_current_plan_version(text);

-- tenant ที่ยังไม่มีแถว (ไม่ควรมี — 0175 backfill แล้ว) · trial ตาม trial_days ของเวอร์ชันที่มีผล (N2)
INSERT INTO subscription (tenant_id, plan_version_id, status, trial_ends_at, current_period_start, current_period_end)
SELECT t.id, v.id,
       CASE t.status WHEN 'TRIAL' THEN 'trialing' WHEN 'CANCELLED' THEN 'cancelled' ELSE 'active' END,
       CASE WHEN t.status = 'TRIAL' THEN t.created_at + make_interval(days => v.trial_days) END,
       t.created_at,
       CASE WHEN t.status = 'TRIAL' THEN t.created_at + make_interval(days => v.trial_days)
            ELSE (date_trunc('month', now() AT TIME ZONE 'Asia/Bangkok') + interval '1 month') AT TIME ZONE 'Asia/Bangkok' END
  FROM tenant t
  CROSS JOIN LATERAL (
    SELECT id, trial_days FROM plan_version
     WHERE plan_code = t.plan_code AND status = 'published' AND effective_from <= now()
     ORDER BY version DESC LIMIT 1) v
 WHERE t.mode = 'live' AND NOT EXISTS (SELECT 1 FROM subscription s WHERE s.tenant_id = t.id);

-- guard: tenant live ทุกรายต้องมี subscription เมื่อจบ transaction (ตรวจตอน commit — สร้าง tenant แล้วสร้างแถวในโค้ดแอป transaction เดียวกัน)
-- mode ของ tenant แก้ไม่ได้ (0107) → ไม่มีกรณี test → live
CREATE OR REPLACE FUNCTION tms_tenant_subscription_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS
$$
DECLARE tid uuid;
BEGIN
  IF TG_TABLE_NAME = 'tenant' THEN tid := NEW.id; ELSE tid := OLD.tenant_id; END IF;
  IF EXISTS (SELECT 1 FROM tenant WHERE id = tid AND mode = 'live')
     AND NOT EXISTS (SELECT 1 FROM subscription WHERE tenant_id = tid) THEN
    RAISE EXCEPTION 'tenant_subscription_required: live tenant % has no subscription', tid USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER tenant_subscription_required AFTER INSERT ON "tenant"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tms_tenant_subscription_guard();
CREATE CONSTRAINT TRIGGER subscription_still_required AFTER DELETE OR UPDATE OF tenant_id ON "subscription"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tms_tenant_subscription_guard();

-- ───────────── S1 ─────────────
ALTER TABLE "plan_version" ADD COLUMN "row_version" INTEGER NOT NULL DEFAULT 1;

-- ───────────── S3 ─────────────
CREATE OR REPLACE FUNCTION tms_plan_version_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS
$$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- เวอร์ชันใหม่ต้องเริ่มเป็น draft (publish = UPDATE ที่ผ่านด่านด้านล่าง) · migration (เจ้าของตาราง) ข้ามได้
    IF NEW.status <> 'draft' AND NOT tms_is_catalog_owner() THEN
      RAISE EXCEPTION 'plan_version_immutable: new versions must start as draft' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
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
    -- PLT-061: publish ได้เมื่อฟีเจอร์พื้นฐานทุกตัวมีเซลล์ included (กันร่างที่สร้างก่อนเพิ่มฟีเจอร์พื้นฐาน/เขียนตรง)
    IF NEW.status = 'published' AND EXISTS (
         SELECT 1 FROM feature f
          WHERE f.is_basic AND NOT EXISTS (
            SELECT 1 FROM plan_entitlement e
             WHERE e.plan_version_id = NEW.id AND e.feature_key = f.key AND e.mode = 'included')) THEN
      RAISE EXCEPTION 'basic_feature_locked: every basic feature must be included before publishing' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'published' AND NEW.status = 'retired'
     AND (to_jsonb(NEW) - 'status') = (to_jsonb(OLD) - 'status') THEN
    RETURN NEW;
  END IF;
  IF tms_is_catalog_owner() THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'plan_version_immutable: version % of % is %', OLD.version, OLD.plan_code, OLD.status
    USING ERRCODE = 'P0001';
END
$$;
DROP TRIGGER IF EXISTS plan_version_guard ON "plan_version";
CREATE TRIGGER plan_version_guard BEFORE INSERT OR UPDATE OR DELETE ON "plan_version"
  FOR EACH ROW EXECUTE FUNCTION tms_plan_version_guard();

-- ───────────── S4 (docs/02 §2) ─────────────
-- แก้เซลล์ของ v1 ที่ seed ใน 0175 (ยังไม่มีลูกค้าจริง — D-76; ทำในฐานะเจ้าของตาราง)
INSERT INTO "feature" (key, category, name_th, name_en, type, unit, is_basic, sort_order) VALUES
  ('report_adv', 'รายงานและลูกค้า', 'ส่งรายงานตามเวลา (อีเมล / LINE)', 'Scheduled reports (email / LINE)', 'boolean', NULL, false, 155);
UPDATE "feature" SET name_th = 'รายงาน (กำไรต่อเที่ยว / ลูกค้า / รถ)', name_en = 'Reports (profit by trip / customer / vehicle)' WHERE key = 'report';
-- รายงานกำไรต่อเที่ยว/ลูกค้า/รถ: Starter "พื้นฐาน" → included ทุกแพ็กเกจ · ส่งรายงานตามเวลา: Growth ขึ้นไป
UPDATE "plan_entitlement" SET mode = 'included' WHERE feature_key = 'report' AND plan_version_id IN (SELECT id FROM plan_version WHERE version = 1 AND plan_code IN ('start', 'std', 'biz', 'ent'));
INSERT INTO "plan_entitlement" (plan_version_id, feature_key, mode, "limit")
  SELECT id, 'report_adv', CASE WHEN plan_code = 'start' THEN 'not_available' ELSE 'included' END, NULL
    FROM plan_version WHERE version = 1 AND plan_code IN ('start', 'std', 'biz', 'ent');
-- Customer portal: Growth/Business ✓ (เดิม addon)
UPDATE "plan_entitlement" SET mode = 'included' WHERE feature_key = 'portal' AND plan_version_id IN (SELECT id FROM plan_version WHERE version = 1 AND plan_code IN ('std', 'biz'));
-- โควตารถ: ค่าเดิมก่อน P1-ST1-T01 (Starter 20 · Growth 80 · Enterprise ไม่จำกัด) · Business = Growth
-- ช่วงรถของ tier (vehicle_min/max) = ช่วงราคา ไม่ใช่โควตา — จะใช้เป็นโควตาหรือไม่ [OPEN — PO] (plan/13 R-06, spec/12 §3)
UPDATE "plan_entitlement" e SET "limit" = CASE v.plan_code WHEN 'start' THEN 20 WHEN 'std' THEN 80 WHEN 'biz' THEN 80 ELSE NULL END
  FROM plan_version v WHERE v.id = e.plan_version_id AND e.feature_key = 'veh' AND v.version = 1 AND v.plan_code IN ('start', 'std', 'biz', 'ent');
