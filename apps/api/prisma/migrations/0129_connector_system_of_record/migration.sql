-- ST7-T17 system-of-record rules ต่อ connector (docs/04 G3; docs/01 §1 ข้อ 4, §8.1; plan/05 D-27)
-- ค่าเริ่มต้นตาม docs/04 G3 (ERP = เจ้าของลูกค้า(หลัก)/VAT) + คำตอบสำรอง plan/08 KRS-2 แบบ A — ยืนยันกับลูกค้าก่อน go-live
-- ตาราง connector มี tenant_id + RLS อยู่แล้ว (ไม่มีตารางใหม่)

-- CreateEnum
CREATE TYPE "sor_owner" AS ENUM ('TMS', 'ERP');

-- AlterTable
ALTER TABLE "connector" ADD COLUMN     "customer_owner" "sor_owner" NOT NULL DEFAULT 'ERP',
ADD COLUMN     "editable_until_paid" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "field_sync" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "tax_document_owner" "sor_owner" NOT NULL DEFAULT 'ERP';
