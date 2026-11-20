-- ST5-T10 แก้ตาม review (L2/L3) — ตัวกันระดับฐานข้อมูลของใบที่ยกเลิก [DECISION spec/12 §3 แถว ST5-T10]
-- (L2) ใบที่ CANCELLED แล้ว: เหตุผล/เวลา/ผู้ยกเลิก แก้ไม่ได้ (บันทึก ณ วันยกเลิก — audit trail)
-- (L3) invoice_line.released_with_invoice ตั้งได้ทางเดียว: ในคำสั่งเดียวกับที่ปิดบรรทัด (active true → false) ตอนใบเป็น CANCELLED/VOIDED
--      (trigger `invoice_release_lines`) · ไม่กลับเป็น false · บรรทัดที่ยังนับ (active) ต้องเป็น false

CREATE OR REPLACE FUNCTION tms_invoice_cancel_immutable() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS
$$
BEGIN
  IF OLD.status = 'CANCELLED'
     AND (NEW.cancelled_at, NEW.cancelled_by, NEW.cancel_reason)
         IS DISTINCT FROM (OLD.cancelled_at, OLD.cancelled_by, OLD.cancel_reason) THEN
    RAISE EXCEPTION 'invoice % is CANCELLED — cancel reason/time/actor cannot change', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_cancel_immutable';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER invoice_cancel_immutable BEFORE UPDATE ON "invoice"
  FOR EACH ROW EXECUTE FUNCTION tms_invoice_cancel_immutable();

ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_released_inactive_check"
  CHECK (NOT ("active" AND "released_with_invoice"));

CREATE OR REPLACE FUNCTION tms_invoice_line_released_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS
$$
DECLARE
  st invoice_status;
BEGIN
  IF NEW.released_with_invoice IS NOT DISTINCT FROM OLD.released_with_invoice THEN
    RETURN NEW;
  END IF;
  SELECT i.status INTO st FROM invoice i WHERE i.id = OLD.invoice_id;
  IF NOT (NEW.released_with_invoice AND NOT OLD.released_with_invoice AND OLD.active AND NOT NEW.active
          AND st IN ('CANCELLED', 'VOIDED')) THEN
    RAISE EXCEPTION 'invoice_line %: released_with_invoice is set only when the invoice is cancelled/voided', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_line_released_once';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER invoice_line_released_guard BEFORE UPDATE OF "released_with_invoice" ON "invoice_line"
  FOR EACH ROW EXECUTE FUNCTION tms_invoice_line_released_guard();
