-- P1-ST1-T04: ค่าตั้งของแพลตฟอร์ม (spec/01 §9 PlatformSetting, PLT-099) — key/type/ค่าเริ่มต้นอยู่ใน
-- apps/api/src/platform/platform-settings.registry.ts · ไม่มีแถว = ค่าเริ่มต้น · ระดับแพลตฟอร์ม (ไม่มี tenant_id)

CREATE TABLE "platform_setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_setting_pkey" PRIMARY KEY ("key"),
    CONSTRAINT "platform_setting_key_check" CHECK ("key" ~ '^[a-z][A-Za-z]*(\.[a-z][A-Za-z]*)+$')
);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE ALL ON platform_setting FROM tms_app';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_platform') THEN
    -- ไม่มีการลบค่าตั้ง (กลับค่าเริ่มต้น = บันทึกค่าเริ่มต้นทับ) — ประวัติอยู่ใน platform_audit_log
    EXECUTE 'REVOKE DELETE, TRUNCATE ON platform_setting FROM tms_platform';
  END IF;
END $$;

-- trial ของ tenant ใหม่: ค่าตั้ง `trial.days` (ถ้าตั้งจาก Console) ทับ trial_days ของเวอร์ชันแพ็กเกจ
-- [DECISION — lead 27 พ.ย. 2569, ย้อนได้] — มีผลเฉพาะ tenant ที่สร้างหลังแก้ (subscription เดิมคงวันหมด trial เดิม — PLT-099)
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
    UPDATE subscription SET plan_version_id = v, next_plan_version_id = NULL,
           version = version + 1, updated_at = now_ts
     WHERE tenant_id = NEW.id;
    RETURN NEW;
  END IF;
  SELECT COALESCE(
           (SELECT (s.value #>> '{}')::int FROM platform_setting s
             WHERE s.key = 'trial.days' AND jsonb_typeof(s.value) = 'number'),
           pv.trial_days)
    INTO trial_d FROM plan_version pv WHERE pv.id = v;
  INSERT INTO subscription (tenant_id, plan_version_id, status, trial_ends_at, current_period_start, current_period_end)
  VALUES (
    NEW.id, v,
    CASE NEW.status WHEN 'TRIAL' THEN 'trialing' WHEN 'CANCELLED' THEN 'cancelled' ELSE 'active' END,
    CASE WHEN NEW.status = 'TRIAL' THEN now_ts + make_interval(days => trial_d) END,
    now_ts,
    CASE WHEN NEW.status = 'TRIAL' THEN now_ts + make_interval(days => trial_d)
         ELSE (date_trunc('month', now_ts AT TIME ZONE 'Asia/Bangkok') + interval '1 month') AT TIME ZONE 'Asia/Bangkok' END
  );
  RETURN NEW;
END
$$;
