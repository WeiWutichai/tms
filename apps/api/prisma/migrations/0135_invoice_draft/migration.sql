-- ST5-T07 ร่างใบแจ้งหนี้ (D-54 บัญชีเบา: ใบแจ้งหนี้ — ไม่ใช่ใบกำกับภาษี; docs/04 F3 "Draft (แก้ได้)", F2 ใบแจ้งหนี้, spec/05 §3)
-- (1) หัวใบ: งวด เครดิต เลข PO หมายเหตุ รูปบรรทัด (SINGLE/GROUP/MERGE) ยอดส่วนลด/อัตราศูนย์/ยอดสุทธิคาดรับ (ประมาณการ) ยกเลิกร่าง
-- (2) บรรทัด: 1 บรรทัด = 1 บรรทัดรายได้ (revenue_line_id) — DO หนึ่งใบมีได้หลายบรรทัด (ค่าขนส่ง + บริการประกอบ + ค่าใช้จ่ายหน้างาน)
--     กันวางบิลซ้ำต่อ DO (ST5-T05) ย้ายไปที่ "บรรทัดหลักของ DO" (`do_anchor`) — DO หนึ่งใบยังอยู่ได้ใบเดียว + กันซ้ำต่อบรรทัดรายได้
--     ส่วนลดบรรทัด (amount = หลังหักส่วนลด) · กลุ่มที่ผู้ใช้รวมเอง (print_group) · ข้อมูลการถอดออก (removed_*)
-- (3) ใบที่ไม่ใช่ร่าง: เนื้อหาบรรทัดแก้ไม่ได้ (เดิมกันแค่การอ้างอิง/active)
-- [DECISION spec/12 §3 — ST5-T07]

-- AlterTable
ALTER TABLE "invoice" ADD COLUMN     "cancel_reason" TEXT,
ADD COLUMN     "cancelled_at" TIMESTAMPTZ(6),
ADD COLUMN     "cancelled_by" TEXT,
ADD COLUMN     "credit_term_days" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "customer_po_no" TEXT,
ADD COLUMN     "discount_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "line_mode" TEXT NOT NULL DEFAULT 'SINGLE',
ADD COLUMN     "net_expected_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "period_from" DATE,
ADD COLUMN     "period_to" DATE,
ADD COLUMN     "subtotal_zero_rated" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "updated_by" TEXT;

ALTER TABLE "invoice" ADD CONSTRAINT "invoice_line_mode_check" CHECK ("line_mode" IN ('SINGLE', 'GROUP', 'MERGE'));
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_credit_term_days_check" CHECK ("credit_term_days" >= 0 AND "credit_term_days" <= 365);
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_period_check" CHECK ("period_from" IS NULL OR "period_to" IS NULL OR "period_from" <= "period_to");
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_discount_amount_check" CHECK ("discount_amount" >= 0);
-- ยกเลิกร่าง: ข้อมูลการยกเลิกครบชุดเมื่อ CANCELLED (ใบ CANCELLED ก่อน ST5-T07 ไม่มี — ไม่มีข้อมูลจริง)
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_cancel_fields_check" CHECK (
  ("cancelled_at" IS NULL AND "cancel_reason" IS NULL) OR ("cancelled_at" IS NOT NULL AND "cancel_reason" IS NOT NULL));

-- AlterTable
ALTER TABLE "invoice_line" ADD COLUMN     "discount" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "do_anchor" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "print_group" INTEGER,
ADD COLUMN     "remove_reason" TEXT,
ADD COLUMN     "removed_at" TIMESTAMPTZ(6),
ADD COLUMN     "removed_by" TEXT,
ADD COLUMN     "revenue_line_id" UUID;

ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_discount_check" CHECK ("discount" >= 0);
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_print_group_check" CHECK ("print_group" IS NULL OR "print_group" >= 1);
-- บรรทัดหลักของ DO ต้องผูก DO
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_do_anchor_check" CHECK (NOT "do_anchor" OR "delivery_order_id" IS NOT NULL OR "is_user_added");

-- CreateIndex
CREATE INDEX "invoice_line_tenant_id_revenue_line_id_idx" ON "invoice_line"("tenant_id", "revenue_line_id");

-- AddForeignKey
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_revenue_line_id_fkey" FOREIGN KEY ("revenue_line_id") REFERENCES "revenue_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- กันวางบิลซ้ำต่อ DO (ST5-T05) — นับเฉพาะบรรทัดหลักของ DO (DO หนึ่งใบมีหลายบรรทัดในใบเดียวได้)
DROP INDEX "invoice_line_active_delivery_order_key";
CREATE UNIQUE INDEX "invoice_line_active_delivery_order_key" ON "invoice_line"("tenant_id", "delivery_order_id")
  WHERE "delivery_order_id" IS NOT NULL AND "active" AND "do_anchor";
-- กันวางบิลซ้ำต่อบรรทัดรายได้ (spec/05 BIL-022 `(sourceType, sourceLineId)`) และต่อค่าใช้จ่ายหน้างาน (spec/12 §3 แถว ST5-T05 → T07 ข้อ 1)
CREATE UNIQUE INDEX "invoice_line_active_revenue_line_key" ON "invoice_line"("tenant_id", "revenue_line_id")
  WHERE "revenue_line_id" IS NOT NULL AND "active";
CREATE UNIQUE INDEX "invoice_line_active_do_surcharge_key" ON "invoice_line"("tenant_id", "do_surcharge_id")
  WHERE "do_surcharge_id" IS NOT NULL AND "active";

-- บรรทัด (แทนฉบับ 0123): เดิม + (ก) revenue_line_id / do_surcharge_id / do_anchor แก้ไม่ได้
--   (ข) เนื้อหาบรรทัด (รายการ จำนวน ราคา ยอด ส่วนลด ภาษี กลุ่ม ลำดับ) แก้ได้เฉพาะเมื่อใบเป็น DRAFT — ใบที่ออกแล้วแก้ด้วยใบลดหนี้
--   (ค) บรรทัดที่ถอดออกแล้ว (active = false) แก้อะไรไม่ได้อีก (ยกเว้นบันทึกข้อมูลการถอดออกพร้อมกัน)
CREATE OR REPLACE FUNCTION tms_invoice_line_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS
$$
DECLARE
  st invoice_status;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT i.status INTO st FROM invoice i WHERE i.id = NEW.invoice_id;
    IF st IS DISTINCT FROM 'DRAFT' OR NOT NEW.active THEN
      RAISE EXCEPTION 'invoice_line: invoice % is not a draft (%) — lines can only be added to drafts', NEW.invoice_id, st
        USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_line_draft_only';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
     OR NEW.delivery_order_id IS DISTINCT FROM OLD.delivery_order_id
     OR NEW.revenue_line_id IS DISTINCT FROM OLD.revenue_line_id
     OR NEW.do_surcharge_id IS DISTINCT FROM OLD.do_surcharge_id
     OR NEW.do_anchor IS DISTINCT FROM OLD.do_anchor THEN
    RAISE EXCEPTION 'invoice_line %: tenant_id / invoice_id / delivery_order_id / revenue_line_id / do_surcharge_id / do_anchor cannot change', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_line_immutable_ref';
  END IF;
  IF NOT OLD.active AND NEW.active THEN
    RAISE EXCEPTION 'invoice_line % was released from billing — cannot reactivate', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_line_active_one_way';
  END IF;
  SELECT i.status INTO st FROM invoice i WHERE i.id = OLD.invoice_id;
  IF OLD.active AND NOT NEW.active THEN
    IF st NOT IN ('DRAFT', 'CANCELLED', 'VOIDED') THEN
      RAISE EXCEPTION 'invoice_line %: invoice % is % — lines of an issued invoice cannot be released', OLD.id, OLD.invoice_id, st
        USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_line_release_state';
    END IF;
  END IF;
  IF (NEW.line_no, NEW.service_item_id, NEW.description, NEW.quantity, NEW.unit_label, NEW.unit_price, NEW.amount,
      NEW.vat_type, NEW.vat_amount, NEW.wht_rate, NEW.account_code, NEW.discount, NEW.print_group, NEW.is_user_added)
     IS DISTINCT FROM
     (OLD.line_no, OLD.service_item_id, OLD.description, OLD.quantity, OLD.unit_label, OLD.unit_price, OLD.amount,
      OLD.vat_type, OLD.vat_amount, OLD.wht_rate, OLD.account_code, OLD.discount, OLD.print_group, OLD.is_user_added) THEN
    IF st IS DISTINCT FROM 'DRAFT' OR NOT OLD.active THEN
      RAISE EXCEPTION 'invoice_line %: content can only change on an active line of a draft (invoice %)', OLD.id, st
        USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_line_draft_content';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
