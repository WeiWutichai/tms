-- ST7-T14 ดึง order ผ่าน connector (ErpAdapter.pullOrders): cursor ต่อ **connector id** (ส่งต่อจาก ST7-T13)
-- tenant ที่มี 2 นิติบุคคลใช้ adapter เดียวกัน (2 แถว connector) ต้องมี cursor แยกกัน — เดิม unique (tenant, connector_key)
-- แถวเดิม (connector_id null) = ต้นทางทดสอบตามรหัส (`mock` — dev/test) คงความหมายเดิม: unique (tenant, connector_key) เฉพาะแถวนั้น

-- AlterTable
ALTER TABLE "connector_cursor" ADD COLUMN "connector_id" UUID;

-- DropIndex
DROP INDEX "connector_cursor_tenant_id_connector_key_key";

-- CreateIndex
CREATE INDEX "connector_cursor_tenant_id_connector_key_idx" ON "connector_cursor"("tenant_id", "connector_key");
CREATE INDEX "connector_cursor_connector_id_idx" ON "connector_cursor"("connector_id");

-- 1 แถวต่อ connector · 1 แถวต่อ (tenant, รหัส) ของต้นทางทดสอบ (ไม่มี connector)
CREATE UNIQUE INDEX "connector_cursor_connector_key" ON "connector_cursor"("tenant_id", "connector_id")
  WHERE "connector_id" IS NOT NULL;
CREATE UNIQUE INDEX "connector_cursor_keyed_key" ON "connector_cursor"("tenant_id", "connector_key")
  WHERE "connector_id" IS NULL;

-- AddForeignKey
ALTER TABLE "connector_cursor" ADD CONSTRAINT "connector_cursor_connector_id_fkey"
  FOREIGN KEY ("connector_id") REFERENCES "connector"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

SELECT tms_enable_tenant_rls('connector_cursor');
