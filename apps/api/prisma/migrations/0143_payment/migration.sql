-- ST5-T13 บันทึกรับชำระ + เช็ค — บัญชีเบา (D-54 · D-56 ไม่ออกใบเสร็จ · D-57 รับเงิน/เช็คบันทึกใน TMS)
-- docs/04 F5 "บันทึกรับชำระ … Payment แยกตาราง", F4 "PAID / PARTIALLY_PAID ย้อนไม่ได้; แก้รับชำระด้วย reversal entry"
-- docs/01 §3.4 payment / payment_allocation ("รวมต่อ invoice ไม่เกิน total_amount") · spec/05 §4 (BIL-050/051, chequeStatus)
-- (1) payment + payment_allocation (tenant_id + RLS) · แก้/ลบไม่ได้ (trigger) — กลับรายการด้วยสถานะ REVERSED + เหตุผล
-- (2) invoice.paid_amount = Σ ยอดตัดของ payment ที่ยังไม่กลับรายการ (เขียนใต้ล็อกใบ) · CHECK 0 ≤ paid ≤ total (ด่านสุดท้ายกันตัดเกิน)
-- (3) doc_type PAY — เลขภายในของการรับชำระ (spec/05 §4 docNo series PAY — ไม่ใช่ใบเสร็จ)
-- [DECISION spec/12 §3 — ST5-T13]

ALTER TYPE "doc_type" ADD VALUE IF NOT EXISTS 'PAY';

CREATE TYPE "payment_method" AS ENUM ('TRANSFER', 'CHEQUE', 'CASH', 'OFFSET');
CREATE TYPE "payment_status" AS ENUM ('RECORDED', 'REVERSED');
CREATE TYPE "cheque_status" AS ENUM ('PENDING', 'CLEARED', 'BOUNCED');
CREATE TYPE "payment_source" AS ENUM ('MANUAL', 'CONNECTOR');

ALTER TABLE "invoice" ADD COLUMN "paid_amount" DECIMAL(14,2) NOT NULL DEFAULT 0;
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_paid_amount_check"
  CHECK ("paid_amount" >= 0 AND "paid_amount" <= "total_amount");

CREATE TABLE "payment" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "payment_no" TEXT NOT NULL,
    "customer_id" UUID NOT NULL,
    "received_date" DATE NOT NULL,
    "method" "payment_method" NOT NULL,
    "reference" TEXT,
    "cheque_no" TEXT,
    "cheque_bank" TEXT,
    "cheque_date" DATE,
    "cheque_status" "cheque_status",
    "amount_received" DECIMAL(14,2) NOT NULL,
    "wht_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "wht_certificate_no" TEXT,
    "fee_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "difference_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "difference_reason" TEXT,
    "note" TEXT,
    "source" "payment_source" NOT NULL DEFAULT 'MANUAL',
    "status" "payment_status" NOT NULL DEFAULT 'RECORDED',
    "reversed_at" TIMESTAMPTZ(6),
    "reversed_by" TEXT,
    "reverse_reason" TEXT,
    "created_by" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payment_amounts_check" CHECK (
      "amount_received" >= 0 AND "wht_amount" >= 0 AND "fee_amount" >= 0 AND "difference_amount" >= 0
      AND "amount_received" + "wht_amount" + "fee_amount" + "difference_amount" > 0),
    -- เช็ค: เลขเช็ค ธนาคาร วันที่เช็ค สถานะเช็ค ครบ (D-57) · วิธีอื่นไม่มีข้อมูลเช็ค
    CONSTRAINT "payment_cheque_check" CHECK (
      ("method" = 'CHEQUE' AND "cheque_no" IS NOT NULL AND "cheque_bank" IS NOT NULL
        AND "cheque_date" IS NOT NULL AND "cheque_status" IS NOT NULL)
      OR ("method" <> 'CHEQUE' AND "cheque_no" IS NULL AND "cheque_bank" IS NULL
        AND "cheque_date" IS NULL AND "cheque_status" IS NULL)),
    CONSTRAINT "payment_difference_reason_check" CHECK ("difference_amount" = 0 OR "difference_reason" IS NOT NULL),
    CONSTRAINT "payment_reversed_check" CHECK (
      ("status" = 'REVERSED') = ("reversed_at" IS NOT NULL AND "reverse_reason" IS NOT NULL)),
    CONSTRAINT "payment_bounced_reversed_check" CHECK ("cheque_status" IS DISTINCT FROM 'BOUNCED' OR "status" = 'REVERSED')
);

CREATE TABLE "payment_allocation" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "payment_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "wht_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_allocation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payment_allocation_amount_check" CHECK ("amount" > 0 AND "wht_amount" >= 0 AND "wht_amount" <= "amount")
);

CREATE INDEX "payment_tenant_id_customer_id_idx" ON "payment"("tenant_id", "customer_id");
CREATE INDEX "payment_tenant_id_received_date_idx" ON "payment"("tenant_id", "received_date");
CREATE INDEX "payment_tenant_id_updated_at_id_idx" ON "payment"("tenant_id", "updated_at", "id");
CREATE UNIQUE INDEX "payment_tenant_id_payment_no_key" ON "payment"("tenant_id", "payment_no");
CREATE INDEX "payment_allocation_tenant_id_invoice_id_idx" ON "payment_allocation"("tenant_id", "invoice_id");
CREATE UNIQUE INDEX "payment_allocation_payment_id_invoice_id_key" ON "payment_allocation"("payment_id", "invoice_id");

ALTER TABLE "payment" ADD CONSTRAINT "payment_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_allocation" ADD CONSTRAINT "payment_allocation_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "payment_allocation" ADD CONSTRAINT "payment_allocation_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- (1) การรับชำระแก้เนื้อหาไม่ได้ — เปลี่ยนได้แค่: กลับรายการ (RECORDED → REVERSED ครั้งเดียว) · เช็ค PENDING → CLEARED · เช็คคืน (→ BOUNCED พร้อมกลับรายการ)
CREATE OR REPLACE FUNCTION tms_payment_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS
$$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment %: cannot be deleted (reverse it instead)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payment_no_delete';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.payment_no, NEW.customer_id, NEW.received_date, NEW.method, NEW.reference,
      NEW.cheque_no, NEW.cheque_bank, NEW.cheque_date, NEW.amount_received, NEW.wht_amount, NEW.wht_certificate_no,
      NEW.fee_amount, NEW.difference_amount, NEW.difference_reason, NEW.note, NEW.source, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.payment_no, OLD.customer_id, OLD.received_date, OLD.method, OLD.reference,
      OLD.cheque_no, OLD.cheque_bank, OLD.cheque_date, OLD.amount_received, OLD.wht_amount, OLD.wht_certificate_no,
      OLD.fee_amount, OLD.difference_amount, OLD.difference_reason, OLD.note, OLD.source, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'payment %: content cannot change (reverse and record again)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payment_immutable';
  END IF;
  IF OLD.status = 'REVERSED' AND (NEW.status, NEW.reversed_at, NEW.reversed_by, NEW.reverse_reason, NEW.cheque_status)
       IS DISTINCT FROM (OLD.status, OLD.reversed_at, OLD.reversed_by, OLD.reverse_reason, OLD.cheque_status) THEN
    RAISE EXCEPTION 'payment %: already reversed', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payment_reversed_final';
  END IF;
  IF NEW.cheque_status IS DISTINCT FROM OLD.cheque_status
     AND NOT ((OLD.cheque_status = 'PENDING' AND NEW.cheque_status = 'CLEARED' AND NEW.status = 'RECORDED')
           OR (OLD.cheque_status IN ('PENDING', 'CLEARED') AND NEW.cheque_status = 'BOUNCED' AND NEW.status = 'REVERSED')) THEN
    RAISE EXCEPTION 'payment %: cheque % → % is not allowed', OLD.id, OLD.cheque_status, NEW.cheque_status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payment_cheque_transition';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER payment_guard BEFORE UPDATE OR DELETE ON "payment"
  FOR EACH ROW EXECUTE FUNCTION tms_payment_guard();

-- (1) การตัดชำระ: เพิ่มได้ตอนบันทึกเท่านั้น (payment RECORDED · ลูกค้าเดียวกัน · tenant เดียวกัน · ใบที่ออกแล้วและยังรับชำระได้) · แก้/ลบไม่ได้
CREATE OR REPLACE FUNCTION tms_payment_allocation_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS
$$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'payment_allocation %: cannot change or delete (reverse the payment)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payment_allocation_immutable';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM payment p JOIN invoice i ON i.id = NEW.invoice_id
     WHERE p.id = NEW.payment_id AND p.status = 'RECORDED'
       AND p.tenant_id = NEW.tenant_id AND i.tenant_id = NEW.tenant_id
       AND i.customer_id = p.customer_id AND i.status IN ('ISSUED', 'PARTIALLY_PAID')) THEN
    RAISE EXCEPTION 'payment_allocation: payment % / invoice % not allocatable', NEW.payment_id, NEW.invoice_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'payment_allocation_target';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER payment_allocation_guard BEFORE INSERT OR UPDATE OR DELETE ON "payment_allocation"
  FOR EACH ROW EXECUTE FUNCTION tms_payment_allocation_guard();

SELECT tms_enable_tenant_rls('payment');
SELECT tms_enable_tenant_rls('payment_allocation');
