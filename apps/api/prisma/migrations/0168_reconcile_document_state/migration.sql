-- ST8-T11 Reconcile engine: ผลกระทบยอดเนื้อหาเอกสารกับระบบภายนอก (docs/01 §4.4 SENT → ACCEPTED / MISMATCH) ต่อ external_mapping
-- แยกจาก status (ผลการส่ง/ซิงก์) · null = ยังไม่เคยเทียบ · ตาราง external_mapping มี RLS อยู่แล้ว (ไม่มีตารางใหม่)
CREATE TYPE "reconcile_document_state" AS ENUM ('ACCEPTED', 'MISMATCH');

ALTER TABLE "external_mapping"
  ADD COLUMN "reconcile_state" "reconcile_document_state",
  ADD COLUMN "reconciled_at" TIMESTAMPTZ(6);
