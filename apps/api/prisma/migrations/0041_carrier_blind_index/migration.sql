-- ST2-T05 review: กันรถร่วมบุคคลธรรมดาซ้ำ — blind index (HMAC-SHA256 ด้วย BLIND_INDEX_KEY แยกจาก key เข้ารหัส)
-- ของเลขบัตรประชาชน (เลขเต็มยังเข้ารหัสที่ tax_id_enc) · แถวเดิมที่ไม่มีค่า = ตรวจซ้ำไม่ได้จนกว่าจะแก้เลข (ไม่มีข้อมูลจริงก่อน ST2-T05)
ALTER TABLE "carrier" ADD COLUMN     "tax_id_hash" TEXT;

-- เฉพาะบุคคลธรรมดา (นิติบุคคลใช้ unique (tax_id, branch_code) เดิม)
ALTER TABLE "carrier" ADD CONSTRAINT "carrier_tax_hash_individual" CHECK ("tax_id_hash" IS NULL OR ("entity_type" = 'INDIVIDUAL' AND "tax_id_enc" IS NOT NULL));
CREATE UNIQUE INDEX "carrier_tenant_tax_hash_uq" ON "carrier"("tenant_id", "tax_id_hash")
  WHERE "deleted_at" IS NULL AND "tax_id_hash" IS NOT NULL;

SELECT tms_enable_tenant_rls('carrier');
