-- ST9-T15 (D-54; docs/04 J "เอกสารภาษี ≥ 5 ปี": ห้าม hard-delete · เก็บ PDF ที่ render ณ วันออก ไม่ render ใหม่)
-- เอกสารที่ออกเลขแล้วของ TMS = ใบแจ้งหนี้ ใบวางบิล ใบสำคัญจ่ายรถร่วม (+ รับชำระ, ตัวนับเลข, ไฟล์ PDF ที่เก็บ)
-- เลข migration เว้นจาก 0153 (+7) กันชนกับ branch อื่นที่กำลังทำ
--
-- ก่อนหน้านี้: ตารางกลุ่มนี้กัน DELETE ด้วย REVOKE จาก tms_app อย่างเดียว (0007/0122/0123/0142) — role platform (worker/job)
-- และเจ้าของตารางยังลบได้ · stored_document ไม่มีตัวกันเลย (ลบแถว / เปลี่ยน sha256, file_key ของ PDF ที่ออกแล้วได้)
-- migration นี้เพิ่ม trigger (มีผลกับทุก role รวมเจ้าของตาราง) + REVOKE จาก tms_platform/tms_app เป็นชั้นที่สอง
-- ร่างไม่มี hard delete อยู่แล้ว (ยกเลิกร่าง = CANCELLED · ถอดบรรทัด = active false / voided_at) จึงกันทั้งตาราง ไม่แยกสถานะ
-- ไม่ครอบคลุม: TRUNCATE / DROP / ALTER TABLE … DISABLE TRIGGER / session_replication_role โดยเจ้าของหรือ superuser
-- (test ล้างฐานด้วย TRUNCATE — helper ปฏิเสธฐานที่ไม่ใช่ *_test/_e2e/_qa) → ปิดด้วยการแยก role migrate ออกจาก role เจ้าของบน staging/production
-- (docs/security/st9-t15-retention.md)

-- 1) ไม่มี hard delete (ทุก role)
CREATE OR REPLACE FUNCTION tms_financial_no_delete() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS
$$
BEGIN
  RAISE EXCEPTION '%: rows cannot be deleted (financial documents are kept — cancel / reverse instead)', TG_TABLE_NAME
    USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_no_delete';
END
$$;

CREATE TRIGGER invoice_no_delete BEFORE DELETE ON "invoice"
  FOR EACH ROW EXECUTE FUNCTION tms_financial_no_delete();
CREATE TRIGGER invoice_line_no_delete BEFORE DELETE ON "invoice_line"
  FOR EACH ROW EXECUTE FUNCTION tms_financial_no_delete();
CREATE TRIGGER billing_note_no_delete BEFORE DELETE ON "billing_note"
  FOR EACH ROW EXECUTE FUNCTION tms_financial_no_delete();
CREATE TRIGGER billing_note_invoice_no_delete BEFORE DELETE ON "billing_note_invoice"
  FOR EACH ROW EXECUTE FUNCTION tms_financial_no_delete();
CREATE TRIGGER carrier_settlement_no_delete BEFORE DELETE ON "carrier_settlement"
  FOR EACH ROW EXECUTE FUNCTION tms_financial_no_delete();
CREATE TRIGGER settlement_line_no_delete BEFORE DELETE ON "settlement_line"
  FOR EACH ROW EXECUTE FUNCTION tms_financial_no_delete();
CREATE TRIGGER document_sequence_no_delete BEFORE DELETE ON "document_sequence"
  FOR EACH ROW EXECUTE FUNCTION tms_financial_no_delete();
-- payment / payment_allocation: trigger เดิม (0143 `payment_guard`, `payment_allocation_guard`) กัน DELETE ทุก role อยู่แล้ว
-- audit_log: trigger เดิม (0007/0108) · settlement_line_review / settlement_line_dispute: trigger เดิม (0127/0130)

-- 2) ตัวนับเลขเอกสาร: เลขไม่ถอยหลัง (ถอย = ออกเลขซ้ำ) · ตัวนับไม่ย้ายไป tenant/ประเภท/สาขา/งวดอื่น
CREATE OR REPLACE FUNCTION tms_document_sequence_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS
$$
BEGIN
  IF NEW.next_value < OLD.next_value THEN
    RAISE EXCEPTION 'document_sequence %: next_value cannot go backwards (% → %)', OLD.id, OLD.next_value, NEW.next_value
      USING ERRCODE = 'check_violation', CONSTRAINT = 'document_sequence_monotonic';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.doc_type, NEW.branch_id, NEW.period_key)
     IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.doc_type, OLD.branch_id, OLD.period_key) THEN
    RAISE EXCEPTION 'document_sequence %: tenant / document type / branch / period cannot change', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'document_sequence_immutable_key';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER document_sequence_guard BEFORE UPDATE ON "document_sequence"
  FOR EACH ROW EXECUTE FUNCTION tms_document_sequence_guard();

-- 3) stored_document (ไฟล์ที่เก็บ — PDF ณ วันออกของใบแจ้งหนี้/ใบวางบิล/ใบสำคัญจ่าย อยู่ที่นี่)
--    * ไม่มี DELETE แถว (retention ST9-T14 ใช้ status PURGED — แถว + sha256 คงอยู่เป็นหลักฐาน)
--    * ไฟล์ที่เก็บแล้ว (ไม่ใช่ PENDING): tenant / file_key / sha256 / ขนาด / ชนิดไฟล์ / เวลาสร้าง แก้ไม่ได้ (ชี้ไปไฟล์อื่นไม่ได้)
--    * PDF ของเอกสารการเงิน (kind PDF + entity invoice / billing_note / carrier_settlement): แก้ไม่ได้ทั้งแถว
--      → เปลี่ยนเป็น PURGED ไม่ได้ (retention job ลบไฟล์กลุ่มนี้ไม่ได้ แม้โค้ด job ผิด) · ย้ายไปผูกเอกสารอื่นไม่ได้
CREATE OR REPLACE FUNCTION tms_stored_document_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS
$$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'stored_document %: rows cannot be deleted (retention marks them PURGED)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'stored_document_no_delete';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR (OLD.status <> 'PENDING'
         AND (NEW.file_key, NEW.sha256, NEW.size_bytes, NEW.mime_type, NEW.created_at)
             IS DISTINCT FROM (OLD.file_key, OLD.sha256, OLD.size_bytes, OLD.mime_type, OLD.created_at)) THEN
    RAISE EXCEPTION 'stored_document %: a stored file cannot be replaced (file key / hash / size / type are write-once)', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'stored_document_content_immutable';
  END IF;
  IF OLD.kind = 'PDF' AND OLD.status <> 'PENDING'
     AND OLD.entity_type IN ('invoice', 'billing_note', 'carrier_settlement')
     AND pg_catalog.to_jsonb(NEW) IS DISTINCT FROM pg_catalog.to_jsonb(OLD) THEN
    RAISE EXCEPTION 'stored_document %: the stored PDF of a financial document is immutable', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'stored_document_financial_immutable';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER stored_document_guard BEFORE UPDATE OR DELETE ON "stored_document"
  FOR EACH ROW EXECUTE FUNCTION tms_stored_document_guard();

-- 4) สิทธิ์ (ชั้นที่สอง): role platform ไม่มี DELETE บนตารางเอกสารการเงิน · role แอปไม่มี DELETE บน stored_document
--    (payment / payment_allocation คงสิทธิ์เดิม — trigger 0143 กันทุก role และ test เดิมตรวจข้อความของ trigger)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_platform') THEN
    EXECUTE 'REVOKE DELETE ON "invoice", "invoice_line", "billing_note", "billing_note_invoice", "carrier_settlement", "settlement_line", "document_sequence", "stored_document" FROM tms_platform';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE DELETE ON "stored_document" FROM tms_app';
  END IF;
END $$;
