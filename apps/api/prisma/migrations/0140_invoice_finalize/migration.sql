-- ST5-T09 ออกเอกสาร (finalize) ใบแจ้งหนี้ — D-54 บัญชีเบา: ใบแจ้งหนี้ **ไม่ใช่ใบกำกับภาษี** (ไม่มี tax_invoice_no ในเฟส 0)
-- docs/04 F3 "Finalize (immutable)", F1 เลขเอกสารเรียงลำดับ + สาขาผู้ออก/ผู้ซื้อ, docs/01 §4.4 (ISSUED: ไม่มี PUT/PATCH), spec/05 §2/§16 (BIL-196)
-- (1) ข้อมูล ณ วันออก: เวลา/ผู้ออก วันที่ออก ครบกำหนด snapshot ลูกค้า/ผู้ออก ค่าพิมพ์ (ปี พ.ศ./ค.ศ., ขั้นต่ำ WHT) + PDF ต้นฉบับที่เก็บ
-- (2) ใบที่ออกแล้วต้องมีข้อมูลข้อ (1) ครบ (CHECK NOT VALID — ไม่ตรวจแถวเก่าที่อาจมีจาก test/สคริปต์ก่อน T09)
-- (3) trigger: ใบที่ไม่ใช่ร่าง แก้เนื้อหาหัวใบไม่ได้ (ทุก role) · เลขออกได้เฉพาะตอน DRAFT → ISSUED · PDF ต้นฉบับผูกได้ครั้งเดียว
--     ร่างไปได้แค่ ISSUED / CANCELLED
-- [DECISION spec/12 §3 — ST5-T09]

ALTER TABLE "invoice" ADD COLUMN "issued_at" TIMESTAMPTZ(6),
ADD COLUMN "issued_by" TEXT,
ADD COLUMN "issue_date" DATE,
ADD COLUMN "due_date" DATE,
ADD COLUMN "customer_snapshot" JSONB,
ADD COLUMN "issuer_snapshot" JSONB,
ADD COLUMN "print_options" JSONB,
ADD COLUMN "pdf_document_id" UUID;

ALTER TABLE "invoice" ADD CONSTRAINT "invoice_pdf_document_id_fkey" FOREIGN KEY ("pdf_document_id") REFERENCES "stored_document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "invoice" ADD CONSTRAINT "invoice_due_after_issue_check" CHECK ("due_date" IS NULL OR "issue_date" IS NULL OR "due_date" >= "issue_date");
-- ร่างไม่มีข้อมูลการออก
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_draft_not_issued_check" CHECK ("status" <> 'DRAFT' OR ("issued_at" IS NULL AND "issue_date" IS NULL AND "pdf_document_id" IS NULL)) NOT VALID;
-- ใบที่ออกเลขแล้ว (ไม่ใช่ร่าง/ร่างที่ยกเลิก) ต้องมีข้อมูล ณ วันออกครบ
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_issued_fields_check" CHECK (
  "status" IN ('DRAFT', 'CANCELLED') OR (
    "invoice_no" IS NOT NULL AND "issued_at" IS NOT NULL AND "issue_date" IS NOT NULL AND "due_date" IS NOT NULL
    AND "customer_snapshot" IS NOT NULL AND "issuer_snapshot" IS NOT NULL AND "print_options" IS NOT NULL)) NOT VALID;

CREATE INDEX "invoice_tenant_id_issue_date_idx" ON "invoice"("tenant_id", "issue_date");

CREATE OR REPLACE FUNCTION tms_invoice_issued_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS
$$
BEGIN
  -- ร่างไปได้แค่ ISSUED (ออกเอกสาร) / CANCELLED (ยกเลิกร่าง)
  IF OLD.status = 'DRAFT' AND NEW.status NOT IN ('DRAFT', 'ISSUED', 'CANCELLED') THEN
    RAISE EXCEPTION 'invoice %: DRAFT → % is not allowed (finalize first)', OLD.id, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_draft_transition';
  END IF;
  -- เลขเอกสารออกได้ครั้งเดียว ตอน DRAFT → ISSUED
  IF NEW.invoice_no IS DISTINCT FROM OLD.invoice_no
     AND NOT (OLD.status = 'DRAFT' AND NEW.status = 'ISSUED' AND OLD.invoice_no IS NULL) THEN
    RAISE EXCEPTION 'invoice %: invoice_no is assigned only when a draft is finalized', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_number_once';
  END IF;
  IF OLD.status <> 'DRAFT' THEN
    IF (NEW.tenant_id, NEW.customer_id, NEW.issuing_company_id, NEW.issuing_branch_id,
        NEW.subtotal_vatable, NEW.subtotal_exempt, NEW.subtotal_zero_rated, NEW.vat_amount, NEW.total_amount,
        NEW.wht_expected_amount, NEW.discount_amount, NEW.net_expected_amount,
        NEW.period_from, NEW.period_to, NEW.credit_term_days, NEW.customer_po_no, NEW.note, NEW.line_mode,
        NEW.created_by, NEW.created_at, NEW.issued_at, NEW.issued_by, NEW.issue_date, NEW.due_date,
        NEW.customer_snapshot, NEW.issuer_snapshot, NEW.print_options)
       IS DISTINCT FROM
       (OLD.tenant_id, OLD.customer_id, OLD.issuing_company_id, OLD.issuing_branch_id,
        OLD.subtotal_vatable, OLD.subtotal_exempt, OLD.subtotal_zero_rated, OLD.vat_amount, OLD.total_amount,
        OLD.wht_expected_amount, OLD.discount_amount, OLD.net_expected_amount,
        OLD.period_from, OLD.period_to, OLD.credit_term_days, OLD.customer_po_no, OLD.note, OLD.line_mode,
        OLD.created_by, OLD.created_at, OLD.issued_at, OLD.issued_by, OLD.issue_date, OLD.due_date,
        OLD.customer_snapshot, OLD.issuer_snapshot, OLD.print_options) THEN
      RAISE EXCEPTION 'invoice % is % — content cannot change (cancel and reissue)', OLD.id, OLD.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_issued_immutable';
    END IF;
    -- PDF ต้นฉบับ ณ วันออก ผูกได้ครั้งเดียว (render หลัง commit — ST5-T09) แล้วเปลี่ยนไม่ได้
    IF OLD.pdf_document_id IS NOT NULL AND NEW.pdf_document_id IS DISTINCT FROM OLD.pdf_document_id THEN
      RAISE EXCEPTION 'invoice %: issued PDF is immutable', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_pdf_once';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER invoice_issued_guard BEFORE UPDATE ON "invoice"
  FOR EACH ROW EXECUTE FUNCTION tms_invoice_issued_guard();
