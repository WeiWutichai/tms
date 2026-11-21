-- ST9-T09 ค้นหา global (⌘K) — docs/04 I "ค้นหา global (⌘K)", spec/11 NFR-707 (p95 ≤ 300 ms)
-- ค้นแบบ "มีคำนี้อยู่" (ILIKE '%q%') ในเลขเอกสาร / เลข PO / ทะเบียน / ชื่อ-รหัสลูกค้า → index trigram (GIN) ช่วยเมื่อคำค้น ≥ 3 ตัวอักษร
-- pg_trgm เป็น extension มาตรฐานของ PostgreSQL (trusted ตั้งแต่ PG13 — เจ้าของฐานสร้างได้) · ไม่มีตารางใหม่ (RLS เดิมครอบอยู่แล้ว)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- CreateIndex
CREATE INDEX "sales_order_so_no_trgm_idx" ON "sales_order" USING GIN ("so_no" gin_trgm_ops);
CREATE INDEX "sales_order_customer_ref_trgm_idx" ON "sales_order" USING GIN ("customer_ref" gin_trgm_ops);
CREATE INDEX "delivery_order_do_no_trgm_idx" ON "delivery_order" USING GIN ("do_no" gin_trgm_ops);
CREATE INDEX "delivery_order_customer_ref_trgm_idx" ON "delivery_order" USING GIN ("customer_ref" gin_trgm_ops);
CREATE INDEX "trip_trip_no_trgm_idx" ON "trip" USING GIN ("trip_no" gin_trgm_ops);
CREATE INDEX "invoice_invoice_no_trgm_idx" ON "invoice" USING GIN ("invoice_no" gin_trgm_ops);
CREATE INDEX "invoice_customer_po_no_trgm_idx" ON "invoice" USING GIN ("customer_po_no" gin_trgm_ops);
CREATE INDEX "billing_note_billing_note_no_trgm_idx" ON "billing_note" USING GIN ("billing_note_no" gin_trgm_ops);
CREATE INDEX "customer_legal_name_trgm_idx" ON "customer" USING GIN ("legal_name" gin_trgm_ops);
CREATE INDEX "customer_code_trgm_idx" ON "customer" USING GIN ("code" gin_trgm_ops);
CREATE INDEX "vehicle_plate_norm_trgm_idx" ON "vehicle" USING GIN ("plate_norm" gin_trgm_ops);
