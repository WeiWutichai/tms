-- ST5-T10 ยกเลิกใบแจ้งหนี้ที่ออกแล้ว (D-54 บัญชีเบา — ใบแจ้งหนี้ ไม่ใช่ใบกำกับภาษี; docs/04 F3 "ยกเลิกใบ", F1 เลขไม่ใช้ซ้ำ;
-- spec/05 §3.6 ISSUED → CANCELLED + §7 BIL-100/106/107) [DECISION spec/12 §3 แถว ST5-T10]
-- (1) invoice.replaces_invoice_id: ใบที่ออกแทนอ้างใบที่ยกเลิก (ตั้งได้ตอนเป็นร่างเท่านั้น · ต้องเป็นใบ CANCELLED ที่มีเลข ลูกค้าเดียวกัน)
-- (2) invoice_line.released_with_invoice: บรรทัดหยุดนับเพราะใบถูกยกเลิก/ลดหนี้เต็มใบ (≠ ถอดออกจากร่าง) — ใบที่ยกเลิกยังแสดง/พิมพ์รายการเดิม
-- (3) trigger: ใบที่ออกแล้ว → CANCELLED ได้เฉพาะ ISSUED ที่ยังไม่รับชำระ (paid_amount = 0) และต้องมีเหตุผล/เวลา/ผู้ยกเลิก
--     (ใบในใบวางบิล ISSUED/COLLECTED — trigger `invoice_billing_note_guard` ของ 0142 กันอยู่แล้ว)
-- เลขที่ใบที่ยกเลิกคงอยู่ (trigger `invoice_number_once` ของ 0140 — เลขเปลี่ยนไม่ได้) และไม่ถูกออกซ้ำ (ตัวนับ document_sequence เดินหน้าอย่างเดียว)

ALTER TABLE "invoice" ADD COLUMN "replaces_invoice_id" UUID;
ALTER TABLE "invoice_line" ADD COLUMN "released_with_invoice" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "invoice_tenant_id_replaces_invoice_id_idx" ON "invoice"("tenant_id", "replaces_invoice_id");
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_replaces_invoice_id_fkey" FOREIGN KEY ("replaces_invoice_id") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_replaces_self_check" CHECK ("replaces_invoice_id" IS DISTINCT FROM "id");
-- ใบที่ยกเลิกต้องมีเหตุผล + เวลา + ผู้ยกเลิก (NOT VALID — ไม่ตรวจแถวเก่าจาก test/สคริปต์ก่อน T07)
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_cancelled_fields_check" CHECK (
  "status" <> 'CANCELLED' OR ("cancelled_at" IS NOT NULL AND "cancelled_by" IS NOT NULL AND "cancel_reason" IS NOT NULL)) NOT VALID;

-- (2) ใบ CANCELLED / VOIDED → บรรทัด active หยุดนับ (DO วางบิลใหม่ได้) + ทำเครื่องหมายว่าเป็นบรรทัดของเอกสาร ณ วันยกเลิก
CREATE OR REPLACE FUNCTION tms_invoice_release_lines() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS
$$
BEGIN
  IF NEW.status IN ('CANCELLED', 'VOIDED') AND OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE invoice_line SET active = false, released_with_invoice = true WHERE invoice_id = NEW.id AND active;
  END IF;
  RETURN NEW;
END
$$;

-- (3) ยกเลิกใบที่ออกแล้ว: เฉพาะ ISSUED ที่ยังไม่รับชำระ (docs/04 F3 "ยังไม่รับชำระ" · spec/05 §3.6 "ไม่มี payment ที่ active")
CREATE OR REPLACE FUNCTION tms_invoice_cancel_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS
$$
BEGIN
  IF NEW.status = 'CANCELLED' AND OLD.status IS DISTINCT FROM NEW.status AND OLD.status <> 'DRAFT' THEN
    IF OLD.status <> 'ISSUED' OR OLD.paid_amount <> 0 OR NEW.paid_amount <> 0 THEN
      RAISE EXCEPTION 'invoice % is % (paid %) — only an issued invoice without payments can be cancelled', OLD.id, OLD.status, OLD.paid_amount
        USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_cancel_paid';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER invoice_cancel_guard BEFORE UPDATE OF "status" ON "invoice"
  FOR EACH ROW EXECUTE FUNCTION tms_invoice_cancel_guard();

-- (1) ใบที่ออกแทน: ตั้ง/เปลี่ยนได้ตอนสร้างหรือตอนเป็นร่าง · ใบเดิมต้อง CANCELLED มีเลข ของ tenant/ลูกค้าเดียวกัน
CREATE OR REPLACE FUNCTION tms_invoice_replaces_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS
$$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.replaces_invoice_id IS NOT DISTINCT FROM OLD.replaces_invoice_id THEN
      RETURN NEW;
    END IF;
    IF OLD.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'invoice % is % — replaces_invoice_id cannot change', OLD.id, OLD.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_replaces_immutable';
    END IF;
  END IF;
  IF NEW.replaces_invoice_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM invoice o WHERE o.id = NEW.replaces_invoice_id AND o.tenant_id = NEW.tenant_id
          AND o.customer_id = NEW.customer_id AND o.status = 'CANCELLED' AND o.invoice_no IS NOT NULL) THEN
    RAISE EXCEPTION 'invoice %: replaces_invoice_id must be a cancelled issued invoice of the same customer', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'invoice_replaces_target';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER invoice_replaces_guard BEFORE INSERT OR UPDATE OF "replaces_invoice_id" ON "invoice"
  FOR EACH ROW EXECUTE FUNCTION tms_invoice_replaces_guard();
