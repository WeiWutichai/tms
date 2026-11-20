-- ST6-T07 อนุมัติใบสำคัญจ่ายรถร่วม (separation of duties) — docs/04 F6 "Approve", A3, docs/01 §4.5 (DRAFT → APPROVED), spec/05 §11
-- (1) สถานะ APPROVED + ผู้อนุมัติ/เวลา · เลข STL ออกตอนอนุมัติเท่านั้น (ร่างไม่มีเลข) และแก้ไม่ได้
-- (2) ผู้อนุมัติ ≠ ผู้สร้าง (CHECK — ทุก role รวม owner) · ยอดสุทธิติดลบอนุมัติไม่ได้ (BIL-133)
-- (3) ใบ APPROVED = แก้อะไรไม่ได้ (ST6-T09 เปิดทาง APPROVED → PAID ใน migration ของตัวเอง) · บรรทัดของใบที่ไม่ใช่ร่างแก้ไม่ได้ทุกช่อง

-- AlterTable
ALTER TABLE "carrier_settlement" ADD COLUMN "approved_at" TIMESTAMPTZ(6),
ADD COLUMN "approved_by" TEXT;

ALTER TABLE "carrier_settlement" DROP CONSTRAINT "carrier_settlement_status_check";
ALTER TABLE "carrier_settlement" ADD CONSTRAINT "carrier_settlement_status_check"
  CHECK ("status" IN ('DRAFT', 'APPROVED', 'CANCELLED'));
-- ร่าง (และร่างที่ยกเลิก) ไม่มีเลข/ผู้อนุมัติ · APPROVED ต้องมีเลข + ผู้อนุมัติ + เวลา + ยอดสุทธิไม่ติดลบ
ALTER TABLE "carrier_settlement" ADD CONSTRAINT "carrier_settlement_draft_unnumbered_check" CHECK (
  "status" = 'APPROVED'
  OR ("settlement_no" IS NULL AND "approved_at" IS NULL AND "approved_by" IS NULL));
ALTER TABLE "carrier_settlement" ADD CONSTRAINT "carrier_settlement_approved_check" CHECK (
  "status" <> 'APPROVED'
  OR ("settlement_no" IS NOT NULL AND "approved_at" IS NOT NULL AND "approved_by" IS NOT NULL AND "net_payable" >= 0));
-- separation of duties (A3): ผู้สร้างอนุมัติใบตัวเองไม่ได้
ALTER TABLE "carrier_settlement" ADD CONSTRAINT "carrier_settlement_sod_check" CHECK (
  "approved_by" IS NULL OR "created_by" IS NULL OR "approved_by" <> "created_by");

-- หัวใบ: CANCELLED / APPROVED = สิ้นสุด (แก้อะไรไม่ได้) · เปลี่ยนสถานะได้เฉพาะ DRAFT → APPROVED / CANCELLED
--       tenant / รถร่วม / ผู้สร้าง แก้ไม่ได้ (ผู้สร้างใช้ตรวจ separation of duties) · เลขเอกสารออกแล้วแก้ไม่ได้
CREATE OR REPLACE FUNCTION tms_carrier_settlement_terminal_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS
$$
BEGIN
  IF OLD.status IN ('CANCELLED', 'APPROVED') THEN
    RAISE EXCEPTION 'carrier_settlement_terminal: carrier_settlement % is % (terminal) — cannot change', OLD.id, OLD.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'carrier_settlement_terminal';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'DRAFT' AND NEW.status IN ('APPROVED', 'CANCELLED')) THEN
    RAISE EXCEPTION 'carrier_settlement_transition: carrier_settlement %: % → % is not allowed', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'carrier_settlement_transition';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.carrier_id IS DISTINCT FROM OLD.carrier_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR (OLD.settlement_no IS NOT NULL AND NEW.settlement_no IS DISTINCT FROM OLD.settlement_no) THEN
    RAISE EXCEPTION 'carrier_settlement_immutable: carrier_settlement %: tenant / carrier / creator / document number cannot change', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'carrier_settlement_immutable';
  END IF;
  RETURN NEW;
END
$$;

-- บรรทัด: เพิ่มกติกา (4) ใบที่ไม่ใช่ร่าง → บรรทัดแก้ไม่ได้ทุกช่อง (ยกเว้น updated_at)
CREATE OR REPLACE FUNCTION tms_settlement_line_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS
$$
DECLARE
  st text;
BEGIN
  SELECT s.status INTO st FROM carrier_settlement s WHERE s.id = NEW.settlement_id;
  IF TG_OP = 'INSERT' THEN
    IF st IS DISTINCT FROM 'DRAFT' OR NEW.voided_at IS NOT NULL THEN
      RAISE EXCEPTION 'settlement_line_draft_only: settlement_line: settlement % is not a draft (%) — lines can only be added to drafts', NEW.settlement_id, st
        USING ERRCODE = 'check_violation', CONSTRAINT = 'settlement_line_draft_only';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.settlement_id IS DISTINCT FROM OLD.settlement_id
     OR NEW.line_no IS DISTINCT FROM OLD.line_no OR NEW.line_type IS DISTINCT FROM OLD.line_type
     OR NEW.trip_cost_id IS DISTINCT FROM OLD.trip_cost_id OR NEW.trip_id IS DISTINCT FROM OLD.trip_id
     OR NEW.deduction_type IS DISTINCT FROM OLD.deduction_type OR NEW.amount IS DISTINCT FROM OLD.amount THEN
    RAISE EXCEPTION 'settlement_line_immutable: settlement_line %: settlement / trip cost / kind / amount cannot change', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'settlement_line_immutable';
  END IF;
  IF OLD.voided_at IS NOT NULL AND (NEW.voided_at IS DISTINCT FROM OLD.voided_at
     OR NEW.voided_by IS DISTINCT FROM OLD.voided_by OR NEW.void_reason IS DISTINCT FROM OLD.void_reason) THEN
    RAISE EXCEPTION 'settlement_line_void_one_way: settlement_line % was removed — cannot reactivate or change the removal', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'settlement_line_void_one_way';
  END IF;
  IF OLD.voided_at IS NULL AND NEW.voided_at IS NOT NULL AND st IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'settlement_line_void_state: settlement_line %: settlement % is % — lines can only be removed from drafts', OLD.id, OLD.settlement_id, st
      USING ERRCODE = 'check_violation', CONSTRAINT = 'settlement_line_void_state';
  END IF;
  IF st IS DISTINCT FROM 'DRAFT' AND (to_jsonb(NEW) - 'updated_at') IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at') THEN
    RAISE EXCEPTION 'settlement_line_frozen: settlement_line %: settlement % is % — lines are frozen', OLD.id, OLD.settlement_id, st
      USING ERRCODE = 'check_violation', CONSTRAINT = 'settlement_line_frozen';
  END IF;
  RETURN NEW;
END
$$;
