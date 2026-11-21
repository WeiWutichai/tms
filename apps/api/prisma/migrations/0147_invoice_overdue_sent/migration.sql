-- ST5-T18 สถานะใบแจ้งหนี้จากการรับชำระ + เกินกำหนด + ธง "ส่งลูกค้าแล้ว" (docs/04 F5 "สถานะ invoice", F3 "ยกเลิกใบ";
-- docs/01 §4.4; plan/11 #5; plan/00a §2.4.5 "เกินกำหนด = ค่าคำนวณ ไม่เป็นสถานะ") [DECISION spec/12 §3 แถว ST5-T18]
-- (1) invoice.overdue_at: ธงเกินกำหนดที่เก็บ (ไม่เพิ่มค่าใน enum invoice_status) — ตั้ง/ล้างโดย applyInvoicePayments (รับชำระ/กลับรายการ/job รายวัน)
--     มีค่าได้เฉพาะใบค้างรับ (ISSUED / PARTIALLY_PAID) · trigger ล้างให้เมื่อสถานะออกจากค้างรับ (ชำระครบ/ยกเลิก/ปรับยอด)
-- (2) invoice.sent_to_customer_*: ส่งลูกค้าแล้ว (เวลา/ผู้ทำ/ช่องทาง MANUAL · BILLING_NOTE · EMAIL) — เฉพาะใบที่มีเลข
-- (3) ยกเลิก (void) ใบที่ส่งลูกค้าแล้วไม่ได้ (docs/04 F3 "เฉพาะยังไม่ส่งลูกค้า/ยังไม่รับชำระ") — เพิ่มใน trigger invoice_cancel_guard

ALTER TABLE "invoice" ADD COLUMN "overdue_at" TIMESTAMPTZ(6),
ADD COLUMN "sent_to_customer_at" TIMESTAMPTZ(6),
ADD COLUMN "sent_to_customer_by" TEXT,
ADD COLUMN "sent_to_customer_channel" TEXT;

CREATE INDEX "invoice_tenant_id_overdue_at_idx" ON "invoice"("tenant_id", "overdue_at");
CREATE INDEX "invoice_tenant_id_due_date_idx" ON "invoice"("tenant_id", "due_date");

ALTER TABLE "invoice" ADD CONSTRAINT "invoice_overdue_status_check"
  CHECK ("overdue_at" IS NULL OR "status" IN ('ISSUED', 'PARTIALLY_PAID'));
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_sent_to_customer_check" CHECK (
  ("sent_to_customer_at" IS NULL AND "sent_to_customer_by" IS NULL AND "sent_to_customer_channel" IS NULL)
  OR ("sent_to_customer_at" IS NOT NULL AND "sent_to_customer_by" IS NOT NULL
      AND "sent_to_customer_channel" IN ('MANUAL', 'BILLING_NOTE', 'EMAIL') AND "invoice_no" IS NOT NULL));

-- (1) สถานะออกจากค้างรับ → ล้างธงเกินกำหนดในคำสั่งเดียวกัน (CHECK ตรวจหลัง BEFORE trigger)
CREATE OR REPLACE FUNCTION tms_invoice_overdue_clear() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS
$$
BEGIN
  IF NEW.status NOT IN ('ISSUED', 'PARTIALLY_PAID') THEN
    NEW.overdue_at := NULL;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER invoice_overdue_clear BEFORE UPDATE OF "status" ON "invoice"
  FOR EACH ROW EXECUTE FUNCTION tms_invoice_overdue_clear();

-- (3) ยกเลิกใบที่ออกแล้ว: เฉพาะ ISSUED ที่ยังไม่รับชำระ (0144) และยังไม่ส่งลูกค้า (ST5-T18)
CREATE OR REPLACE FUNCTION tms_invoice_cancel_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS
$$
BEGIN
  IF NEW.status = 'CANCELLED' AND OLD.status IS DISTINCT FROM NEW.status AND OLD.status <> 'DRAFT' THEN
    IF OLD.status <> 'ISSUED' OR OLD.paid_amount <> 0 OR NEW.paid_amount <> 0 THEN
      RAISE EXCEPTION 'invoice % is % (paid %) — only an issued invoice without payments can be cancelled', OLD.id, OLD.status, OLD.paid_amount
        USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_cancel_paid';
    END IF;
    IF OLD.sent_to_customer_at IS NOT NULL OR NEW.sent_to_customer_at IS NOT NULL THEN
      RAISE EXCEPTION 'invoice % was sent to the customer — it cannot be cancelled', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_cancel_sent';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
