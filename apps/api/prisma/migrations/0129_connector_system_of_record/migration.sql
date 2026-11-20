-- ST7-T17 system-of-record rules ต่อ connector (docs/04 G3; docs/01 §1 ข้อ 4, §8.1; plan/05 D-27)
-- เจ้าของลูกค้า/เอกสารภาษี: ไม่มีค่าเริ่มต้น — null = "ยังไม่เลือก" (docs/01 §8.1 "ต้องเลือก"; ค่าเริ่มต้นเป็นคำถามค้างของ PO/นักบัญชี)
-- "แก้ได้จนรับชำระ" เป็นกฎ (docs/04 G3) ไม่ใช่ค่าตั้ง — บังคับใน SystemOfRecordPolicy ไม่มีคอลัมน์
-- ตาราง connector มี tenant_id + RLS อยู่แล้ว (ไม่มีตารางใหม่)

-- CreateEnum
CREATE TYPE "sor_owner" AS ENUM ('TMS', 'ERP');

-- AlterTable
ALTER TABLE "connector" ADD COLUMN     "customer_owner" "sor_owner",
ADD COLUMN     "field_sync" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "tax_document_owner" "sor_owner";

ALTER TABLE "connector" ADD CONSTRAINT "connector_field_sync_object" CHECK (jsonb_typeof("field_sync") = 'object');
