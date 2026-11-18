-- ST7-T09 Sandbox (docs/04 G1 "Sandbox", docs/01 §5.1, spec/07 INT-061)
-- tenant mode `test` ใน cluster เดียว = **แถว tenant แยก** ที่ผูกกับ tenant จริง (live) 1:1
-- ข้อมูลของ sandbox แยกด้วย RLS ตาม tenant_id เหมือนบริษัทอื่นทุกประการ — key `tk_test_` อยู่ในแถวของ sandbox
-- จึงมองไม่เห็นข้อมูล live ได้แม้โค้ดส่วนอื่นผิด (ไม่มีการแปลง tenant ตอนยืนยันตัวตน)
ALTER TABLE "tenant" ADD COLUMN "mode" VARCHAR(8) NOT NULL DEFAULT 'live';
ALTER TABLE "tenant" ADD COLUMN "live_tenant_id" UUID;
ALTER TABLE "tenant" ADD CONSTRAINT "tenant_mode_check" CHECK ("mode" IN ('live', 'test'));
-- test ⇔ มี tenant จริงที่ผูก · sandbox ซ้อน sandbox ไม่ได้ (ตรวจใน trigger ด้านล่าง)
ALTER TABLE "tenant" ADD CONSTRAINT "tenant_sandbox_link_check"
  CHECK (("mode" = 'test') = ("live_tenant_id" IS NOT NULL));
ALTER TABLE "tenant" ADD CONSTRAINT "tenant_live_tenant_id_fkey"
  FOREIGN KEY ("live_tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- 1 sandbox ต่อ 1 บริษัท
CREATE UNIQUE INDEX "tenant_live_tenant_id_key" ON "tenant"("live_tenant_id");

CREATE OR REPLACE FUNCTION tms_tenant_sandbox_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.live_tenant_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM tenant WHERE id = NEW.live_tenant_id AND mode <> 'live'
  ) THEN
    RAISE EXCEPTION 'sandbox tenant must link to a live tenant' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.mode IS DISTINCT FROM OLD.mode OR NEW.live_tenant_id IS DISTINCT FROM OLD.live_tenant_id) THEN
    RAISE EXCEPTION 'tenant mode is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenant_sandbox_guard BEFORE INSERT OR UPDATE ON tenant
  FOR EACH ROW EXECUTE FUNCTION tms_tenant_sandbox_guard();

-- สิทธิ์: แอป (tms_app) แก้ได้เฉพาะคอลัมน์ที่ให้ไว้แล้ว (0011) — mode/live_tenant_id ไม่อยู่ในรายการ จึงแก้ไม่ได้อยู่แล้ว
