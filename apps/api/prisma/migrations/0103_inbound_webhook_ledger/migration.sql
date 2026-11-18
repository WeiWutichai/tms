-- ST7-T22 Inbound webhook ledger (docs/04 G3 "Inbound webhook ledger" I10)
-- URL รับ webhook ขาเข้ามี tenant token (ต่อ connector — เก็บเฉพาะ HMAC-SHA256(pepper) หมุนได้) → ตรวจลายเซ็นผ่าน adapter ก่อน
-- → ledger `processed_webhook_event` unique (tenant, connector, event_key) กัน replay
--   (ต่อ connector ไม่ใช่ต่อ provider: 2 connector ของ adapter เดียวกัน = 2 ระบบต้นทาง รหัส event ชนกันได้) (ส่งซ้ำ = ไม่ประมวลผลซ้ำ)

-- CreateEnum
CREATE TYPE "InboundEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED');

-- AlterTable
ALTER TABLE "connector" ADD COLUMN     "inbound_token_hash" VARCHAR(64),
ADD COLUMN     "inbound_token_prefix" VARCHAR(16),
ADD COLUMN     "inbound_token_rotated_at" TIMESTAMPTZ(6);

-- CreateIndex (token ไม่ซ้ำทั้งระบบ — ใช้หา tenant + connector จาก URL โดยไม่ต้อง login)
CREATE UNIQUE INDEX "connector_inbound_token_hash_key" ON "connector"("inbound_token_hash");

-- CreateTable
CREATE TABLE "processed_webhook_event" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "connector_id" UUID NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "event_key" VARCHAR(200) NOT NULL,
    "event_type" VARCHAR(100) NOT NULL,
    "status" "InboundEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "payload_enc" TEXT,
    "payload_sha256" CHAR(64) NOT NULL,
    "payload_bytes" INTEGER NOT NULL,
    "occurred_at" TIMESTAMPTZ(6),
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "duplicate_count" INTEGER NOT NULL DEFAULT 0,
    "last_duplicate_at" TIMESTAMPTZ(6),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "processed_at" TIMESTAMPTZ(6),
    "last_error" JSONB,
    "result" JSONB,
    "request_id" TEXT,
    "ip" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_webhook_event_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "processed_webhook_event_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "processed_webhook_event_connector_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connector"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "processed_webhook_event_event_key_check" CHECK (length("event_key") > 0),
    CONSTRAINT "processed_webhook_event_processed_check" CHECK (("status" = 'RECEIVED') = ("processed_at" IS NULL))
);

-- CreateIndex
CREATE UNIQUE INDEX "processed_webhook_event_tenant_id_connector_id_event_key_key" ON "processed_webhook_event"("tenant_id", "connector_id", "event_key");
CREATE INDEX "processed_webhook_event_tenant_id_connector_id_received_at_idx" ON "processed_webhook_event"("tenant_id", "connector_id", "received_at");
-- retention payload 30 วัน (role platform ล้างตามเวลารับ — ST7-T22)
CREATE INDEX "processed_webhook_event_received_at_idx" ON "processed_webhook_event"("received_at");

-- แอปลบไม่ได้ · แก้ได้เฉพาะคอลัมน์สถานะ/ตัวนับ (ตัวตนของ event + payload แก้ไม่ได้)
-- ล้าง payload หลัง 30 วันโดย role platform (InboundWebhookService.purge) · แถวไม่ลบอัตโนมัติ (archive หลัง 24 เดือน = OPEN)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON processed_webhook_event FROM tms_app';
    EXECUTE 'GRANT UPDATE (status, attempts, processed_at, last_error, result, duplicate_count, last_duplicate_at, updated_at) ON processed_webhook_event TO tms_app';
  END IF;
END $$;

SELECT tms_enable_tenant_rls('processed_webhook_event');
