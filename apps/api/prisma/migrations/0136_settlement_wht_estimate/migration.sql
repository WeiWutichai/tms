-- ST6-T08 หัก ณ ที่จ่ายประมาณการบนใบสำคัญจ่ายรถร่วม (D-54/D-58 บัญชีเบา — PO 20 พ.ย. 2569; docs/04 F6 "คำนวณ WHT")
-- ร่าง/ส่งตรวจ/โต้แย้ง: คำนวณสดจากบรรทัด (computeDocumentTax ของ @tms/domain) — ไม่เก็บ
-- อนุมัติ: ตรึงยอด WHT + ขั้นต่ำที่ใช้ + ค่าตั้งต้นอัตราของรถร่วม ในคำสั่ง UPDATE เดียวกับการอนุมัติ (ใบ APPROVED แก้ไม่ได้อยู่แล้ว — trigger 0124)
--   → บรรทัด (แข็งตั้งแต่ส่งตรวจ/อนุมัติ) + wht_rate_default + wht_minimum_amount = ทำซ้ำทุกตัวเลขได้ (ยอดรวม/แยกอัตรา/รายบรรทัด)
-- wht_rate_default: ค่าตั้งต้นอัตราของรถร่วม ณ วันสร้างใบ (ใช้กับบรรทัดที่ไม่มีธง) — ใบที่สร้างก่อน migration นี้ = null จนอนุมัติ
-- ใบที่อนุมัติก่อน migration นี้ = null ทั้งหมด (API คำนวณจากบรรทัด + ค่าตั้งปัจจุบัน)

-- AlterTable
ALTER TABLE "carrier_settlement" ADD COLUMN "wht_amount" DECIMAL(14,2),
ADD COLUMN "wht_minimum_amount" DECIMAL(14,2),
ADD COLUMN "wht_rate_default" DECIMAL(5,2);

ALTER TABLE "carrier_settlement" ADD CONSTRAINT "carrier_settlement_wht_check" CHECK (
  ("wht_amount" IS NULL) = ("wht_minimum_amount" IS NULL)
  AND ("wht_amount" IS NULL OR ("wht_amount" >= 0 AND "wht_minimum_amount" >= 0))
  -- ตรึงได้เฉพาะใบที่พ้นขั้นร่างแล้ว (APPROVED และสถานะหลังจากนั้น เช่น PAID ของ ST6-T09)
  AND ("wht_amount" IS NULL OR "status" NOT IN ('DRAFT', 'SENT_TO_CARRIER', 'DISPUTED', 'CANCELLED'))
  -- ตรึงแล้วต้องมีค่าตั้งต้นอัตราด้วย (ทำซ้ำได้)
  AND ("wht_amount" IS NULL OR "wht_rate_default" IS NOT NULL)
  AND ("wht_rate_default" IS NULL OR ("wht_rate_default" >= 0 AND "wht_rate_default" <= 100)));

-- หัวใบแข็งระหว่างรอรถร่วมตรวจ (0130) — ช่อง WHT ที่ตรึง (wht_amount / wht_minimum_amount / wht_rate_default) เปลี่ยนได้
-- เฉพาะในคำสั่งที่อนุมัติ (NEW.status = APPROVED) เท่านั้น · ใบ APPROVED แล้วแก้อะไรไม่ได้ (รวมช่องเหล่านี้ — ST6-T09 ต้องคงไว้)
CREATE OR REPLACE FUNCTION tms_carrier_settlement_terminal_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS
$$
DECLARE
  frozen_excl text[] := ARRAY['status', 'version', 'updated_at', 'approved_at', 'approved_by', 'settlement_no', 'preparers'];
BEGIN
  IF NEW.status = 'APPROVED' THEN
    frozen_excl := frozen_excl || ARRAY['wht_amount', 'wht_minimum_amount', 'wht_rate_default'];
  END IF;
  IF OLD.status IN ('CANCELLED', 'APPROVED') THEN
    RAISE EXCEPTION 'carrier_settlement_terminal: carrier_settlement % is % (terminal) — cannot change', OLD.id, OLD.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'carrier_settlement_terminal';
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
