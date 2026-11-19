-- ST6-T07 แก้ตาม review/QA — separation of duties ระดับ DB (ทุก role รวม owner)
-- (1) ผู้อนุมัติต้องไม่ใช่ผู้เตรียมใบ: ผู้สร้างหัวใบ + ผู้เพิ่มบรรทัด + ผู้นำบรรทัดออก · actor `apikey:<uuid>` = ผู้ออก key (`api_key.created_by`)
--     ผู้เตรียม/ผู้อนุมัติที่ระบุตัวไม่ได้ (ว่าง / key หาไม่พบ / key ไม่มีผู้ออก) = ปฏิเสธ (fail closed)
-- (2) CHECK: ใบที่มีผู้อนุมัติต้องมีผู้สร้าง (created_by ว่าง = อนุมัติไม่ได้)
-- (3) สร้างใบได้เฉพาะสถานะ DRAFT

ALTER TABLE "carrier_settlement" DROP CONSTRAINT "carrier_settlement_sod_check";
ALTER TABLE "carrier_settlement" ADD CONSTRAINT "carrier_settlement_sod_check" CHECK (
  "approved_by" IS NULL OR ("created_by" IS NOT NULL AND "approved_by" <> "created_by"));

-- actor → ผู้ใช้ (คน) เบื้องหลัง: `apikey:<uuid>` → api_key.created_by · อื่น ๆ = ตัวเอง · ระบุไม่ได้ = NULL
CREATE OR REPLACE FUNCTION tms_resolve_actor(a text) RETURNS text
  LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS
$$
DECLARE
  k text;
  owner text;
BEGIN
  IF a IS NULL THEN RETURN NULL; END IF;
  IF a NOT LIKE 'apikey:%' THEN RETURN a; END IF;
  k := substr(a, 8);
  IF k !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RETURN NULL; END IF;
  SELECT created_by INTO owner FROM api_key WHERE id = k::uuid;
  RETURN owner;
END
$$;

CREATE OR REPLACE FUNCTION tms_carrier_settlement_sod_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS
$$
DECLARE
  approver text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'carrier_settlement_insert_draft: carrier_settlement must be created as DRAFT (got %)', NEW.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'carrier_settlement_insert_draft';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'APPROVED' AND OLD.status IS DISTINCT FROM 'APPROVED' THEN
    approver := tms_resolve_actor(NEW.approved_by);
    IF approver IS NULL OR EXISTS (
         SELECT 1 FROM (
           SELECT NEW.created_by AS a
           UNION ALL SELECT l.created_by FROM settlement_line l WHERE l.settlement_id = NEW.id
           UNION ALL SELECT l.voided_by FROM settlement_line l WHERE l.settlement_id = NEW.id AND l.voided_at IS NOT NULL
         ) p
         WHERE tms_resolve_actor(p.a) IS NULL OR tms_resolve_actor(p.a) = approver) THEN
      RAISE EXCEPTION 'carrier_settlement_sod: carrier_settlement %: approver % prepared this settlement or a preparer is unknown', NEW.id, NEW.approved_by
        USING ERRCODE = 'check_violation', CONSTRAINT = 'carrier_settlement_sod';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER carrier_settlement_sod_guard BEFORE INSERT OR UPDATE ON "carrier_settlement"
  FOR EACH ROW EXECUTE FUNCTION tms_carrier_settlement_sod_guard();
