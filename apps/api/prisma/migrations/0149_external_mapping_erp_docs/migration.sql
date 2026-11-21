-- ST8-T16 ต่อยอด external_mapping ของ ST8-T05 (0141) แบบเพิ่มอย่างเดียว — เอกสารที่ส่งเข้า ERP (ใบแจ้งหนี้/ใบสำคัญจ่าย)
-- และการรับชำระที่สร้างจาก webhook: เลข TMS (หาเอกสารจาก webhook), สถานะเอกสารฝั่ง ERP (แยกจาก status ของการซิงก์), รายละเอียด
ALTER TYPE "ExternalEntityType" ADD VALUE IF NOT EXISTS 'PAYMENT';

ALTER TABLE "external_mapping" ADD COLUMN "local_number" TEXT,
  ADD COLUMN "external_status" TEXT,
  ADD COLUMN "detail" JSONB;

ALTER TABLE "external_mapping" ADD CONSTRAINT "external_mapping_local_number_check"
  CHECK ("local_number" IS NULL OR (btrim("local_number") <> '' AND length("local_number") <= 60));
ALTER TABLE "external_mapping" ADD CONSTRAINT "external_mapping_external_status_check"
  CHECK ("external_status" IS NULL OR "external_status" IN ('DRAFT', 'POSTED', 'VOIDED', 'PAID'));

CREATE INDEX "external_mapping_connector_id_entity_type_local_number_idx" ON "external_mapping"("connector_id", "entity_type", "local_number");

-- ไม่มี hard delete (ตามหัว 0141 / docs/01 §3.7 — ยกเลิก = external_id null / status RETIRED) · บังคับที่สิทธิ์ของ role แอป
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE DELETE ON external_mapping FROM tms_app';
  END IF;
END $$;
