-- ST3-T05 ทางเข้าจาก connector (pullOrders): ตำแหน่งที่ดึงล่าสุด + lease ต่อ tenant + connector
-- ตาราง `connector` (ตั้งค่า adapter ต่อ tenant — docs/01 §3.7) มาใน ST7-T13 — ตอนนั้นค่อยผูก FK

-- CreateTable
CREATE TABLE "connector_cursor" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connector_key" TEXT NOT NULL,
    "cursor" TEXT,
    "lease_id" UUID,
    "lease_until" TIMESTAMPTZ(6),
    "last_pull_at" TIMESTAMPTZ(6),
    "last_success_at" TIMESTAMPTZ(6),
    "last_result" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connector_cursor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "connector_cursor_tenant_id_connector_key_key" ON "connector_cursor"("tenant_id", "connector_key");

-- รหัส connector รูปเดียวกับ sales_order.source_connector (CONNECTOR_KEY_RE)
ALTER TABLE "connector_cursor" ADD CONSTRAINT "connector_cursor_key_format"
  CHECK ("connector_key" ~ '^[a-z0-9][a-z0-9_-]{0,31}$');

-- role แอปไม่ลบแถว (ตำแหน่งที่ดึงต้องอยู่เสมอ)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE DELETE ON "connector_cursor" FROM tms_app';
  END IF;
END $$;

SELECT tms_enable_tenant_rls('connector_cursor');
