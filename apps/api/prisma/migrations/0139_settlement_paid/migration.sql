-- ST6-T09 บันทึกจ่ายใบสำคัญจ่ายรถร่วม — docs/04 F6 "จ่าย" (วันโอน/เลขอ้างอิง/ธนาคาร), docs/01 §3.6 (`paid_at`, `payment_reference`, `paid_by`) + §4.5 APPROVED → PAID,
-- D-58 (บัญชีเบา — 50 ทวิ ออกที่ระบบบัญชี; AP ร่างส่งผ่าน ST8-T16 จาก event `settlement.paid`)
-- (1) สถานะ PAID + ข้อมูลการจ่าย (วันที่จ่าย / เวลาที่บันทึก / ผู้บันทึก / วิธี / เลขอ้างอิง / ธนาคาร) — มีครบเมื่อ PAID เท่านั้น
-- (2) APPROVED → PAID ทางเดียว · ใบ PAID = สถานะสิ้นสุด (แก้อะไรไม่ได้ — แก้ผิดพลาดเป็นงานแยก ไม่มีในเฟส 0)
-- (3) คำสั่งที่บันทึกจ่ายเปลี่ยนได้เฉพาะช่องการจ่าย + สถานะ — ยอด/เลข STL/ผู้อนุมัติ และหัก ณ ที่จ่ายที่ตรึงตอนอนุมัติ
--     (`wht_amount` / `wht_minimum_amount` / `wht_rate_default` — 0136) คงเดิม · ยกเว้นใบที่อนุมัติก่อน 0136 (ยังไม่ตรึง) → ตรึงในคำสั่งที่บันทึกจ่าย
-- (4) ใบ PAID ต้องมีหัก ณ ที่จ่ายที่ตรึงแล้ว (ยอดที่จ่ายจริง = net_payable − wht_amount ทำซ้ำได้)

-- AlterTable
ALTER TABLE "carrier_settlement" ADD COLUMN "paid_date" DATE,
ADD COLUMN "paid_at" TIMESTAMPTZ(6),
ADD COLUMN "paid_by" TEXT,
ADD COLUMN "payment_method" TEXT,
ADD COLUMN "payment_reference" TEXT,
ADD COLUMN "payment_bank" TEXT;

-- ---------- (1) สถานะ + ข้อมูลการจ่าย ----------
ALTER TABLE "carrier_settlement" DROP CONSTRAINT "carrier_settlement_status_check";
ALTER TABLE "carrier_settlement" ADD CONSTRAINT "carrier_settlement_status_check"
  CHECK ("status" IN ('DRAFT', 'SENT_TO_CARRIER', 'DISPUTED', 'APPROVED', 'PAID', 'CANCELLED'));
-- ใบที่ยังไม่อนุมัติไม่มีเลข/ผู้อนุมัติ · APPROVED และ PAID ต้องมีเลข + ผู้อนุมัติ + เวลา + ยอดสุทธิไม่ติดลบ (0124 + PAID)
ALTER TABLE "carrier_settlement" DROP CONSTRAINT "carrier_settlement_draft_unnumbered_check";
ALTER TABLE "carrier_settlement" ADD CONSTRAINT "carrier_settlement_draft_unnumbered_check" CHECK (
  "status" IN ('APPROVED', 'PAID')
  OR ("settlement_no" IS NULL AND "approved_at" IS NULL AND "approved_by" IS NULL));
ALTER TABLE "carrier_settlement" DROP CONSTRAINT "carrier_settlement_approved_check";
ALTER TABLE "carrier_settlement" ADD CONSTRAINT "carrier_settlement_approved_check" CHECK (
  "status" NOT IN ('APPROVED', 'PAID')
  OR ("settlement_no" IS NOT NULL AND "approved_at" IS NOT NULL AND "approved_by" IS NOT NULL AND "net_payable" >= 0));
-- ข้อมูลการจ่าย: มีครบเมื่อ PAID เท่านั้น · โอน/เช็ค ต้องมีเลขอ้างอิง · PAID ต้องตรึงหัก ณ ที่จ่ายแล้ว
ALTER TABLE "carrier_settlement" ADD CONSTRAINT "carrier_settlement_paid_check" CHECK (
  ("status" = 'PAID') = ("paid_at" IS NOT NULL)
  AND ("paid_at" IS NOT NULL) = ("paid_date" IS NOT NULL)
  AND ("paid_at" IS NOT NULL) = ("paid_by" IS NOT NULL)
  AND ("paid_at" IS NOT NULL) = ("payment_method" IS NOT NULL)
  AND ("payment_method" IS NULL OR "payment_method" IN ('TRANSFER', 'CHEQUE', 'CASH'))
  AND ("payment_method" IS NULL OR "payment_method" = 'CASH' OR coalesce(btrim("payment_reference"), '') <> '')
  AND ("paid_at" IS NOT NULL OR ("payment_reference" IS NULL AND "payment_bank" IS NULL))
  AND ("status" <> 'PAID' OR "wht_amount" IS NOT NULL));

-- ---------- (2)(3) หัวใบ ----------
-- เดิม (0136) + APPROVED → PAID: เปลี่ยนได้เฉพาะสถานะ + ช่องการจ่าย (+ ช่อง WHT เฉพาะใบที่ยังไม่ตรึง) · PAID = สิ้นสุด
CREATE OR REPLACE FUNCTION tms_carrier_settlement_terminal_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS
$$
DECLARE
  frozen_excl text[] := ARRAY['status', 'version', 'updated_at', 'approved_at', 'approved_by', 'settlement_no', 'preparers'];
  pay_excl text[] := ARRAY['status', 'version', 'updated_at', 'paid_date', 'paid_at', 'paid_by',
                           'payment_method', 'payment_reference', 'payment_bank'];
BEGIN
  IF NEW.status = 'APPROVED' THEN
    frozen_excl := frozen_excl || ARRAY['wht_amount', 'wht_minimum_amount', 'wht_rate_default'];
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
