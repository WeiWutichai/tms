-- D-81 · D68-45 (PO 23 พ.ย. 2569) externalId ของ invoices + payments (docs/04 G1 "External id")
-- ERP อ้างใบแจ้งหนี้/การรับชำระด้วยรหัสของตัวเอง: `PUT /invoices/external/{externalId}` · `PUT /payments/external/{externalId}`
-- unique (tenant_id, external_id) — NULL ซ้ำได้ (แถวที่ไม่มี externalId) แบบเดียวกับ master/orders
-- ตาราง invoice / payment มี tenant_id + RLS อยู่แล้ว (0135 / 0143) — ไม่มีตารางใหม่
-- ย้อนกลับ: DROP TRIGGER/FUNCTION ด้านล่าง + DROP INDEX + DROP COLUMN (ข้อมูล externalId หาย)

-- AlterTable
ALTER TABLE "invoice" ADD COLUMN     "external_id" TEXT;

-- AlterTable
ALTER TABLE "payment" ADD COLUMN     "external_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "invoice_tenant_id_external_id_key" ON "invoice"("tenant_id", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_tenant_id_external_id_key" ON "payment"("tenant_id", "external_id");

-- externalId ตั้งได้ตอนสร้างเท่านั้น — ใบแจ้งหนี้ที่ออกแล้ว/การรับชำระแก้เนื้อหาไม่ได้ (docs/04 F3/F4) จึงห้ามเปลี่ยนรหัสอ้างอิงภายหลังด้วย
-- (trigger แยกจาก `invoice_issued_guard` / `payment_guard` เดิม — ไม่แตะเงื่อนไขเดิม)
CREATE OR REPLACE FUNCTION tms_external_id_once() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS
$$
BEGIN
  IF NEW.external_id IS DISTINCT FROM OLD.external_id THEN
    RAISE EXCEPTION '% %: external_id is set only on create', TG_TABLE_NAME, OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_external_id_once';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER invoice_external_id_once BEFORE UPDATE OF "external_id" ON "invoice"
  FOR EACH ROW EXECUTE FUNCTION tms_external_id_once();
CREATE TRIGGER payment_external_id_once BEFORE UPDATE OF "external_id" ON "payment"
  FOR EACH ROW EXECUTE FUNCTION tms_external_id_once();
