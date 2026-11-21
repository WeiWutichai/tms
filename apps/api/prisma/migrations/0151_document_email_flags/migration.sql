-- ST5-T21 review M1: ส่งอีเมลไม่สำเร็จ / sandbox → worker ล้างธง "ส่งลูกค้าแล้ว" (ช่องทาง EMAIL) ที่การส่งนั้นตั้ง
-- invoice_ids = ใบแจ้งหนี้ทั้งหมดในไฟล์แนบ · flagged_invoice_ids + flagged_at = ใบที่การส่งนี้ตั้งธง และเวลาที่ตั้ง
-- (ตาราง document_email มี RLS จาก 0150 แล้ว — เพิ่มคอลัมน์ไม่ต้องเปิดใหม่)

ALTER TABLE "document_email" ADD COLUMN "flagged_at" TIMESTAMPTZ(6),
ADD COLUMN "flagged_invoice_ids" UUID[] DEFAULT ARRAY[]::UUID[],
ADD COLUMN "invoice_ids" UUID[] DEFAULT ARRAY[]::UUID[];

CREATE INDEX "document_email_invoice_ids_idx" ON "document_email" USING GIN ("invoice_ids");
CREATE INDEX "document_email_tenant_id_created_at_idx" ON "document_email"("tenant_id", "created_at");
