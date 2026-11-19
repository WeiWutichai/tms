-- ST5-T05 กันวางบิลซ้ำ (docs/04 F3 "Flag กันวางบิลซ้ำ"; docs/01 §3.3 / §3.4 invoice_line.delivery_order_id unique partial; spec/05 BIL-022)
-- (1) delivery_order.billing_status UNBILLED / IN_DRAFT / INVOICED / CREDITED — แกนแยกจาก do_status (UNBILLED/BILLED ของ docs/01 §4.3 คงอยู่)
-- (2) invoice + invoice_line เฉพาะคอลัมน์ขั้นต่ำของ docs/01 §3.4 (ร่าง/ออกเลข/PDF/ชำระ เพิ่มใน ST5-T07/T08/T09/T22)
--     สถานะใบไม่มี SENT/ACCEPTED/MISMATCH (สถานะซิงก์แยก — plan/00a §4.4)
-- (3) DO หนึ่งใบอยู่ได้ในบรรทัดที่ active เพียงบรรทัดเดียวต่อ tenant: unique partial (tenant_id, delivery_order_id) WHERE active
--     active = false เมื่อถอดออกจากร่าง หรือใบเป็น CANCELLED/VOIDED (trigger) · ไม่กลับเป็น true
-- [DECISION spec/12 §3 — ST5-T05]

-- CreateEnum
CREATE TYPE "billing_status" AS ENUM ('UNBILLED', 'IN_DRAFT', 'INVOICED', 'CREDITED');
CREATE TYPE "invoice_status" AS ENUM ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'ADJUSTED', 'VOIDED', 'CANCELLED');

-- AlterTable (ยังไม่มีใบแจ้งหนี้ในระบบ → ทุก DO = UNBILLED)
ALTER TABLE "delivery_order" ADD COLUMN "billing_status" "billing_status" NOT NULL DEFAULT 'UNBILLED';

-- CreateTable
CREATE TABLE "invoice" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "invoice_no" TEXT,
    "customer_id" UUID NOT NULL,
    "issuing_company_id" UUID NOT NULL,
    "issuing_branch_id" UUID NOT NULL,
    "status" "invoice_status" NOT NULL DEFAULT 'DRAFT',
    "subtotal_vatable" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "subtotal_exempt" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "vat_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "wht_expected_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "created_by" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_pkey" PRIMARY KEY ("id"),
    -- ร่างไม่มีเลข (docs/04 F3 "draft ไม่มีเลข") — เลขออกตอน finalize เท่านั้น (ST5-T09)
    CONSTRAINT "invoice_draft_no_number" CHECK ("status" <> 'DRAFT' OR "invoice_no" IS NULL)
);

CREATE TABLE "invoice_line" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "delivery_order_id" UUID,
    "do_surcharge_id" UUID,
    "service_item_id" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unit_label" TEXT NOT NULL,
    "unit_price" DECIMAL(14,2) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "vat_type" "vat_type" NOT NULL,
    "vat_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "wht_rate" DECIMAL(5,2) NOT NULL,
    "account_code" TEXT,
    "is_user_added" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_line_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "invoice_line_line_no_check" CHECK ("line_no" >= 1),
    CONSTRAINT "invoice_line_wht_rate_check" CHECK ("wht_rate" >= 0 AND "wht_rate" <= 100),
    -- docs/01 §3.4 "vat_amount 0 เมื่อ exempt"
    CONSTRAINT "invoice_line_vat_amount_check" CHECK ("vat_type" = 'VAT_7' OR "vat_amount" = 0)
);

-- CreateIndex
CREATE INDEX "invoice_tenant_id_customer_id_status_idx" ON "invoice"("tenant_id", "customer_id", "status");
CREATE INDEX "invoice_tenant_id_status_idx" ON "invoice"("tenant_id", "status");
CREATE UNIQUE INDEX "invoice_tenant_id_issuing_branch_id_invoice_no_key" ON "invoice"("tenant_id", "issuing_branch_id", "invoice_no");
CREATE INDEX "invoice_line_tenant_id_delivery_order_id_idx" ON "invoice_line"("tenant_id", "delivery_order_id");
CREATE INDEX "invoice_line_tenant_id_do_surcharge_id_idx" ON "invoice_line"("tenant_id", "do_surcharge_id");
CREATE INDEX "invoice_line_tenant_id_service_item_id_idx" ON "invoice_line"("tenant_id", "service_item_id");
CREATE UNIQUE INDEX "invoice_line_tenant_id_invoice_id_line_no_key" ON "invoice_line"("tenant_id", "invoice_id", "line_no");
-- **กันวางบิลซ้ำ** (docs/01 §3.4 "unique partial where invoice.status ≠ CANCELLED"; docs/04 F3 unique (tenantId, orderId) ใน line ที่ active)
CREATE UNIQUE INDEX "invoice_line_active_delivery_order_key" ON "invoice_line"("tenant_id", "delivery_order_id")
  WHERE "delivery_order_id" IS NOT NULL AND "active";

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_issuing_company_id_fkey" FOREIGN KEY ("issuing_company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_issuing_branch_id_fkey" FOREIGN KEY ("issuing_branch_id") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_delivery_order_id_fkey" FOREIGN KEY ("delivery_order_id") REFERENCES "delivery_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_do_surcharge_id_fkey" FOREIGN KEY ("do_surcharge_id") REFERENCES "do_surcharge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoice_line" ADD CONSTRAINT "invoice_line_service_item_id_fkey" FOREIGN KEY ("service_item_id") REFERENCES "service_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- บรรทัด: (1) เพิ่มได้เฉพาะใบที่ยังเป็น DRAFT และเพิ่มเป็น active เท่านั้น
--        (2) tenant_id / invoice_id / delivery_order_id แก้ไม่ได้ (ย้ายบรรทัดข้ามใบ/เปลี่ยน DO = ข้ามตัวกัน)
--        (3) active ทางเดียว true → false และปิดได้เฉพาะเมื่อใบเป็น DRAFT (ถอดออกจากร่าง) หรือ CANCELLED/VOIDED (trigger สถานะใบ)
--            — ใบที่ออกแล้วถอด DO ไม่ได้ (แก้ด้วยใบลดหนี้)
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
     OR NEW.delivery_order_id IS DISTINCT FROM OLD.delivery_order_id THEN
    RAISE EXCEPTION 'invoice_line %: tenant_id / invoice_id / delivery_order_id cannot change', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_line_immutable_ref';
  END IF;
  IF NOT OLD.active AND NEW.active THEN
    RAISE EXCEPTION 'invoice_line % was released from billing — cannot reactivate', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_line_active_one_way';
  END IF;
  IF OLD.active AND NOT NEW.active THEN
    SELECT i.status INTO st FROM invoice i WHERE i.id = OLD.invoice_id;
    IF st NOT IN ('DRAFT', 'CANCELLED', 'VOIDED') THEN
      RAISE EXCEPTION 'invoice_line %: invoice % is % — lines of an issued invoice cannot be released', OLD.id, OLD.invoice_id, st
        USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_line_release_state';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER invoice_line_guard BEFORE INSERT OR UPDATE ON "invoice_line"
  FOR EACH ROW EXECUTE FUNCTION tms_invoice_line_guard();

-- ใบ CANCELLED / VOIDED = สถานะสิ้นสุด (ทุก role) — state machine เต็มของใบ = ST5-T07/T09 (domain)
CREATE OR REPLACE FUNCTION tms_invoice_terminal_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS
$$
BEGIN
  IF OLD.status IN ('CANCELLED', 'VOIDED') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'invoice % is % (terminal) — status cannot change', OLD.id, OLD.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_status_terminal';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER invoice_terminal_guard BEFORE UPDATE OF "status" ON "invoice"
  FOR EACH ROW EXECUTE FUNCTION tms_invoice_terminal_guard();

-- ใบเป็น CANCELLED (ยกเลิกร่าง) / VOIDED (ลดหนี้เต็มใบ) → บรรทัดหยุดนับ (DO วางบิลใหม่ได้ — docs/01 §4.3/§4.4)
CREATE OR REPLACE FUNCTION tms_invoice_release_lines() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS
$$
BEGIN
  IF NEW.status IN ('CANCELLED', 'VOIDED') AND OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE invoice_line SET active = false WHERE invoice_id = NEW.id AND active;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER invoice_release_lines AFTER UPDATE OF "status" ON "invoice"
  FOR EACH ROW EXECUTE FUNCTION tms_invoice_release_lines();

-- เอกสารภาษี: ไม่มี hard delete (ยกเลิก = CANCELLED · ถอดบรรทัด = active false)
REVOKE DELETE ON "invoice", "invoice_line" FROM tms_app;

SELECT tms_enable_tenant_rls('invoice');
SELECT tms_enable_tenant_rls('invoice_line');
