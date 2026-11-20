-- ST5-T11 ใบวางบิล (`billing_note`) — docs/01 §3.4, docs/04 F2 "ใบวางบิล", spec/05 §3 (BIL-039), D-54 บัญชีเบา (TMS ออกเลขใบวางบิลเอง — D-55)
-- สรุปใบแจ้งหนี้ค้างของลูกค้าหนึ่งราย + ยอดรวม + วันนัดรับเช็ค/โอน + ผู้รับวางบิล · **ไม่กระทบ VAT/WHT** (ไม่ใช่เอกสารภาษี)
-- (1) billing_note: DRAFT → ISSUED (ออกเลขชุด BN + snapshot + PDF) → COLLECTED · DRAFT/ISSUED → CANCELLED (เลขคงอยู่)
-- (2) billing_note_invoice: ใบแจ้งหนี้ในใบวางบิล + ยอด ณ วันใส่/ออก — **unique partial (tenant_id, invoice_id) WHERE active**
--     = ใบแจ้งหนี้หนึ่งใบอยู่ในใบวางบิลที่ active (DRAFT/ISSUED) ได้ใบเดียว (BIL-039) — ใช้ตารางผูกแทน `invoice.billing_note_id`
--     ของ docs/01 (เก็บประวัติใบวางบิลที่ยกเลิก/เก็บเงินแล้วได้ ไม่แตะตาราง invoice) [DECISION spec/12 §3 — ST5-T11]
-- (3) trigger: เลขออกได้ครั้งเดียวตอน DRAFT → ISSUED · หลัง ISSUED เนื้อหาแก้ไม่ได้ · สถานะเดินตามตาราง · ปิดใบ → ผูกหยุดนับ
-- CreateEnum
CREATE TYPE "billing_note_status" AS ENUM ('DRAFT', 'ISSUED', 'COLLECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "billing_note" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "billing_note_no" TEXT,
    "customer_id" UUID NOT NULL,
    "issuing_company_id" UUID NOT NULL,
    "issuing_branch_id" UUID NOT NULL,
    "status" "billing_note_status" NOT NULL DEFAULT 'DRAFT',
    "billing_date" DATE,
    "collection_date" DATE,
    "total_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_wht_expected" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "net_expected" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "note" TEXT,
    "acknowledged_by_name" TEXT,
    "acknowledged_on" DATE,
    "acknowledged_at" TIMESTAMPTZ(6),
    "acknowledged_by" TEXT,
    "collected_at" TIMESTAMPTZ(6),
    "collected_by" TEXT,
    "collect_note" TEXT,
    "cancelled_at" TIMESTAMPTZ(6),
    "cancelled_by" TEXT,
    "cancel_reason" TEXT,
    "created_by" TEXT,
    "updated_by" TEXT,
    "issued_at" TIMESTAMPTZ(6),
    "issued_by" TEXT,
    "customer_snapshot" JSONB,
    "issuer_snapshot" JSONB,
    "print_options" JSONB,
    "pdf_document_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_note_invoice" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "billing_note_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "invoice_no" TEXT NOT NULL,
    "issue_date" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "total_amount" DECIMAL(14,2) NOT NULL,
    "wht_expected_amount" DECIMAL(14,2) NOT NULL,
    "outstanding_amount" DECIMAL(14,2) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "removed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_note_invoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "billing_note_tenant_id_customer_id_status_idx" ON "billing_note"("tenant_id", "customer_id", "status");

-- CreateIndex
CREATE INDEX "billing_note_tenant_id_status_idx" ON "billing_note"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "billing_note_tenant_id_billing_note_no_key" ON "billing_note"("tenant_id", "billing_note_no");

-- CreateIndex
CREATE INDEX "billing_note_invoice_tenant_id_billing_note_id_idx" ON "billing_note_invoice"("tenant_id", "billing_note_id");

-- CreateIndex
CREATE INDEX "billing_note_invoice_tenant_id_invoice_id_idx" ON "billing_note_invoice"("tenant_id", "invoice_id");

-- AddForeignKey
ALTER TABLE "billing_note" ADD CONSTRAINT "billing_note_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_note" ADD CONSTRAINT "billing_note_issuing_company_id_fkey" FOREIGN KEY ("issuing_company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_note" ADD CONSTRAINT "billing_note_issuing_branch_id_fkey" FOREIGN KEY ("issuing_branch_id") REFERENCES "branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_note" ADD CONSTRAINT "billing_note_pdf_document_id_fkey" FOREIGN KEY ("pdf_document_id") REFERENCES "stored_document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_note_invoice" ADD CONSTRAINT "billing_note_invoice_billing_note_id_fkey" FOREIGN KEY ("billing_note_id") REFERENCES "billing_note"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_note_invoice" ADD CONSTRAINT "billing_note_invoice_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "billing_note" ADD CONSTRAINT "billing_note_amounts_check"
  CHECK ("total_amount" >= 0 AND "total_wht_expected" >= 0 AND "net_expected" = "total_amount" - "total_wht_expected");
ALTER TABLE "billing_note" ADD CONSTRAINT "billing_note_collection_after_billing_check"
  CHECK ("collection_date" IS NULL OR "billing_date" IS NULL OR "collection_date" >= "billing_date");
-- ร่างไม่มีเลข/ข้อมูลการออก · ใบที่ออกแล้ว (ISSUED/COLLECTED หรือยกเลิกหลังออก) ต้องมีข้อมูล ณ วันออกครบ
ALTER TABLE "billing_note" ADD CONSTRAINT "billing_note_draft_not_issued_check"
  CHECK ("status" <> 'DRAFT' OR ("billing_note_no" IS NULL AND "issued_at" IS NULL AND "billing_date" IS NULL AND "pdf_document_id" IS NULL));
ALTER TABLE "billing_note" ADD CONSTRAINT "billing_note_issued_fields_check" CHECK (
  "status" NOT IN ('ISSUED', 'COLLECTED') OR (
    "billing_note_no" IS NOT NULL AND "issued_at" IS NOT NULL AND "billing_date" IS NOT NULL AND "collection_date" IS NOT NULL
    AND "customer_snapshot" IS NOT NULL AND "issuer_snapshot" IS NOT NULL AND "print_options" IS NOT NULL));
ALTER TABLE "billing_note" ADD CONSTRAINT "billing_note_collected_check"
  CHECK ("status" <> 'COLLECTED' OR "collected_at" IS NOT NULL);
ALTER TABLE "billing_note" ADD CONSTRAINT "billing_note_cancelled_check"
  CHECK ("status" <> 'CANCELLED' OR ("cancelled_at" IS NOT NULL AND char_length(coalesce("cancel_reason", '')) >= 10));
ALTER TABLE "billing_note_invoice" ADD CONSTRAINT "billing_note_invoice_amounts_check"
  CHECK ("total_amount" >= 0 AND "wht_expected_amount" >= 0 AND "outstanding_amount" >= 0);

-- BIL-039: ใบแจ้งหนี้หนึ่งใบอยู่ในใบวางบิลที่ active ได้ใบเดียว (สองคำขอพร้อมกัน = รายที่สองชน unique)
CREATE UNIQUE INDEX "billing_note_invoice_active_uq" ON "billing_note_invoice"("tenant_id", "invoice_id") WHERE "active";
CREATE UNIQUE INDEX "billing_note_invoice_line_uq" ON "billing_note_invoice"("billing_note_id", "line_no");

CREATE OR REPLACE FUNCTION tms_billing_note_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS
$$
BEGIN
  -- ตารางสถานะ: DRAFT → ISSUED/CANCELLED · ISSUED → COLLECTED/CANCELLED · COLLECTED/CANCELLED = สิ้นสุด
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'DRAFT' AND NEW.status IN ('ISSUED', 'CANCELLED'))
    OR (OLD.status = 'ISSUED' AND NEW.status IN ('COLLECTED', 'CANCELLED'))) THEN
    RAISE EXCEPTION 'billing_note %: % → % is not allowed', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'billing_note_transition';
  END IF;
  -- เลขออกได้ครั้งเดียว ตอน DRAFT → ISSUED
  IF NEW.billing_note_no IS DISTINCT FROM OLD.billing_note_no
     AND NOT (OLD.status = 'DRAFT' AND NEW.status = 'ISSUED' AND OLD.billing_note_no IS NULL) THEN
    RAISE EXCEPTION 'billing_note %: billing_note_no is assigned only when a draft is issued', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'billing_note_number_once';
  END IF;
  -- หลังออก: เนื้อหา (ลูกค้า ผู้ออก ยอด วันที่ snapshot) แก้ไม่ได้ — เปลี่ยนได้แค่สถานะ/ผู้รับวางบิล/การเก็บเงิน/การยกเลิก/PDF ครั้งแรก
  IF OLD.status <> 'DRAFT' THEN
    IF (NEW.tenant_id, NEW.customer_id, NEW.issuing_company_id, NEW.issuing_branch_id, NEW.billing_date,
        NEW.collection_date, NEW.total_amount, NEW.total_wht_expected, NEW.net_expected, NEW.note,
        NEW.created_by, NEW.created_at, NEW.issued_at, NEW.issued_by,
        NEW.customer_snapshot, NEW.issuer_snapshot, NEW.print_options)
       IS DISTINCT FROM
       (OLD.tenant_id, OLD.customer_id, OLD.issuing_company_id, OLD.issuing_branch_id, OLD.billing_date,
        OLD.collection_date, OLD.total_amount, OLD.total_wht_expected, OLD.net_expected, OLD.note,
        OLD.created_by, OLD.created_at, OLD.issued_at, OLD.issued_by,
        OLD.customer_snapshot, OLD.issuer_snapshot, OLD.print_options) THEN
      RAISE EXCEPTION 'billing_note % is % — content cannot change (cancel and create a new one)', OLD.id, OLD.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'billing_note_issued_immutable';
    END IF;
    IF OLD.pdf_document_id IS NOT NULL AND NEW.pdf_document_id IS DISTINCT FROM OLD.pdf_document_id THEN
      RAISE EXCEPTION 'billing_note %: issued PDF is immutable', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'billing_note_pdf_once';
    END IF;
  END IF;
  IF NEW.pdf_document_id IS NOT NULL AND NEW.pdf_document_id IS DISTINCT FROM OLD.pdf_document_id
     AND NOT EXISTS (SELECT 1 FROM stored_document d WHERE d.id = NEW.pdf_document_id
                       AND d.tenant_id = NEW.tenant_id AND d.entity_type = 'billing_note' AND d.entity_id = NEW.id) THEN
    RAISE EXCEPTION 'billing_note %: pdf_document_id must be a stored PDF of this billing note (same tenant)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'billing_note_pdf_document_owner';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER billing_note_guard BEFORE UPDATE ON "billing_note"
  FOR EACH ROW EXECUTE FUNCTION tms_billing_note_guard();

-- ใบวางบิลเป็น COLLECTED / CANCELLED → ผูกหยุดนับ (ใบแจ้งหนี้ที่ยังค้างวางบิลใหม่ได้)
CREATE OR REPLACE FUNCTION tms_billing_note_release() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS
$$
BEGIN
  IF NEW.status IN ('COLLECTED', 'CANCELLED') AND OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE billing_note_invoice SET active = false WHERE billing_note_id = NEW.id AND active;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER billing_note_release AFTER UPDATE OF "status" ON "billing_note"
  FOR EACH ROW EXECUTE FUNCTION tms_billing_note_release();

-- แถวผูก: เพิ่ม/ถอด/แก้ยอดได้เฉพาะใบวางบิล DRAFT · active ไม่กลับเป็น true · ใบแจ้งหนี้ต้องของ tenant/ลูกค้าเดียวกับใบวางบิล
CREATE OR REPLACE FUNCTION tms_billing_note_invoice_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS
$$
DECLARE
  bn record;
BEGIN
  SELECT status, customer_id, tenant_id INTO bn FROM billing_note WHERE id = NEW.billing_note_id;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.active AND NOT OLD.active THEN
      RAISE EXCEPTION 'billing_note_invoice %: cannot reactivate', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'billing_note_invoice_reactivate';
    END IF;
    IF (NEW.billing_note_id, NEW.invoice_id, NEW.line_no, NEW.invoice_no, NEW.issue_date, NEW.due_date,
        NEW.total_amount, NEW.wht_expected_amount, NEW.outstanding_amount, NEW.tenant_id)
       IS DISTINCT FROM
       (OLD.billing_note_id, OLD.invoice_id, OLD.line_no, OLD.invoice_no, OLD.issue_date, OLD.due_date,
        OLD.total_amount, OLD.wht_expected_amount, OLD.outstanding_amount, OLD.tenant_id)
       AND bn.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'billing_note_invoice %: billing note is % — lines cannot change', OLD.id, bn.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'billing_note_invoice_issued_immutable';
    END IF;
    -- ถอดออกจากใบที่ออกแล้ว: ได้เฉพาะเมื่อใบวางบิลปิด (trigger ปล่อยผูก) — ถอดรายใบหลังออกไม่ได้
    IF OLD.active AND NOT NEW.active AND bn.status = 'ISSUED' THEN
      RAISE EXCEPTION 'billing_note_invoice %: cannot remove an invoice from an issued billing note', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'billing_note_invoice_issued_immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF bn.status IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'billing_note %: invoices can be added only to a draft', NEW.billing_note_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'billing_note_invoice_draft_only';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM invoice i WHERE i.id = NEW.invoice_id AND i.tenant_id = NEW.tenant_id
                   AND i.tenant_id = bn.tenant_id AND i.customer_id = bn.customer_id) THEN
    RAISE EXCEPTION 'billing_note_invoice: invoice % must belong to the billing note customer (same tenant)', NEW.invoice_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'billing_note_invoice_customer';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER billing_note_invoice_guard BEFORE INSERT OR UPDATE ON "billing_note_invoice"
  FOR EACH ROW EXECUTE FUNCTION tms_billing_note_invoice_guard();

-- ไม่มี hard delete (ยกเลิก = CANCELLED · ถอดใบแจ้งหนี้ออกจากร่าง = active false)
REVOKE DELETE ON "billing_note", "billing_note_invoice" FROM tms_app;

SELECT tms_enable_tenant_rls('billing_note');
SELECT tms_enable_tenant_rls('billing_note_invoice');
