-- ST9-T09 ค้นหา global (⌘K) — GET /v1/search อ่านต่อชนิดเรียง updated_at ล่าสุดก่อน (take จำกัด)
-- ตารางอื่นที่ค้นมี (tenant_id, updated_at, id) อยู่แล้ว · ไม่มีตารางใหม่ (RLS เดิมครอบอยู่แล้ว)
-- หมายเหตุ: index trigram (GIN) ใช้ไม่ได้ภายใต้ RLS เพราะ ILIKE ไม่ใช่ leakproof — ตัดออกแล้ว (review ST9-T09)

-- CreateIndex
CREATE INDEX "invoice_tenant_id_updated_at_id_idx" ON "invoice"("tenant_id", "updated_at", "id");

-- CreateIndex
CREATE INDEX "billing_note_tenant_id_updated_at_id_idx" ON "billing_note"("tenant_id", "updated_at", "id");
