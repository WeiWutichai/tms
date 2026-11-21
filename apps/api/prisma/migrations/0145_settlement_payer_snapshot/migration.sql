-- ST6-T04 (review L1): ผู้จ่ายบนใบสำคัญจ่าย (นิติบุคคล "จ้างในนาม" + สาขา + เลขผู้เสียภาษี + ที่อยู่) ตรึงตอนอนุมัติ
-- PDF ใช้ค่านี้ (ไม่อ่านชื่อบริษัทปัจจุบัน) · ใบที่อนุมัติก่อน 0145 = null → PDF ใช้ค่าปัจจุบัน
ALTER TABLE "carrier_settlement" ADD COLUMN "payer_snapshot" JSONB;

-- ตั้งได้เฉพาะใบที่พ้นร่าง (ตั้งในคำสั่งอนุมัติ) · หลังจากนั้นแข็ง (trigger: APPROVED → PAID เปลี่ยนได้เฉพาะช่องการจ่าย)
ALTER TABLE "carrier_settlement" ADD CONSTRAINT "carrier_settlement_payer_snapshot_check" CHECK (
  "payer_snapshot" IS NULL OR "status" IN ('APPROVED', 'PAID'));

-- เดิม (0139) + ยกเว้น payer_snapshot ในคำสั่งอนุมัติจาก SENT_TO_CARRIER (หัวใบแข็งระหว่างรอตรวจ)
CREATE OR REPLACE FUNCTION tms_carrier_settlement_terminal_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS
$$
DECLARE
  frozen_excl text[] := ARRAY['status', 'version', 'updated_at', 'approved_at', 'approved_by', 'settlement_no', 'preparers'];
  pay_excl text[] := ARRAY['status', 'version', 'updated_at', 'paid_date', 'paid_at', 'paid_by',
                           'payment_method', 'payment_reference', 'payment_bank'];
BEGIN
  IF NEW.status = 'APPROVED' THEN
    frozen_excl := frozen_excl || ARRAY['wht_amount', 'wht_minimum_amount', 'wht_rate_default', 'payer_snapshot'];
  END IF;
  IF OLD.status IN ('CANCELLED', 'PAID') THEN
    RAISE EXCEPTION 'carrier_settlement_terminal: carrier_settlement % is % (terminal) — cannot change', OLD.id, OLD.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'carrier_settlement_terminal';
  END IF;
  IF OLD.status = 'APPROVED' THEN
    IF NEW.status IS DISTINCT FROM 'PAID' THEN
      RAISE EXCEPTION 'carrier_settlement_terminal: carrier_settlement % is APPROVED — it can only be marked as paid', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'carrier_settlement_terminal';
    END IF;
    -- ใบที่อนุมัติก่อน 0136 (ยังไม่ตรึงหัก ณ ที่จ่าย) → ตรึงพร้อมการบันทึกจ่ายได้ครั้งเดียว · ตรึงแล้ว = คงเดิม
    IF OLD.wht_amount IS NULL THEN
      pay_excl := pay_excl || ARRAY['wht_amount', 'wht_minimum_amount', 'wht_rate_default'];
    END IF;
    IF (pg_catalog.to_jsonb(NEW) - pay_excl) IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - pay_excl) THEN
      RAISE EXCEPTION 'carrier_settlement_paid_frozen: carrier_settlement %: recording the payment can only set the payment fields', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'carrier_settlement_paid_frozen';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'DRAFT' AND NEW.status IN ('APPROVED', 'CANCELLED', 'SENT_TO_CARRIER'))
     AND NOT (OLD.status = 'SENT_TO_CARRIER' AND NEW.status IN ('DRAFT', 'APPROVED', 'DISPUTED'))
     AND NOT (OLD.status = 'DISPUTED' AND NEW.status IN ('DRAFT', 'SENT_TO_CARRIER')) THEN
    RAISE EXCEPTION 'carrier_settlement_transition: carrier_settlement %: % → % is not allowed', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'carrier_settlement_transition';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.carrier_id IS DISTINCT FROM OLD.carrier_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR (OLD.settlement_no IS NOT NULL AND NEW.settlement_no IS DISTINCT FROM OLD.settlement_no) THEN
    RAISE EXCEPTION 'carrier_settlement_immutable: carrier_settlement %: tenant / carrier / creator / document number cannot change', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'carrier_settlement_immutable';
  END IF;
  -- ระหว่างรอรถร่วมตรวจ/มีรายการโต้แย้ง: หัวใบ (ยอด งวด หมายเหตุ เลขใบแจ้งหนี้ ฯลฯ) แข็ง — เปลี่ยนได้เฉพาะสถานะ/อนุมัติ/ผู้เตรียม
  IF OLD.status IN ('SENT_TO_CARRIER', 'DISPUTED')
     AND (pg_catalog.to_jsonb(NEW) - frozen_excl)
         IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - frozen_excl) THEN
    RAISE EXCEPTION 'carrier_settlement_sent_frozen: carrier_settlement % is awaiting the carrier review — recall it before editing', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'carrier_settlement_sent_frozen';
  END IF;
  IF NOT (NEW.preparers @> OLD.preparers) THEN
    RAISE EXCEPTION 'carrier_settlement_preparers: carrier_settlement %: preparers can only be appended', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'carrier_settlement_preparers';
  END IF;
  IF NEW.review_round < OLD.review_round
     OR (NEW.review_round <> OLD.review_round AND NOT (OLD.status = 'DRAFT' AND NEW.status = 'SENT_TO_CARRIER')) THEN
    RAISE EXCEPTION 'carrier_settlement_review_round: carrier_settlement %: review round only increases when sent to the carrier', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'carrier_settlement_review_round';
  END IF;
  RETURN NEW;
END
$$;
