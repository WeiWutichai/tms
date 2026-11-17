-- ST7-T04 webhook dispatcher (docs/04 G1 Webhook; docs/01 §3.7 webhook_endpoint/webhook_delivery, §5.3; spec/07 §10)
-- endpoint รับ event ผ่าน integration_subscription (sink `webhook`, target_id = id ของ endpoint) — ไม่มีคิวแยก (ST7-T03 outbox)
-- secret เก็บเข้ารหัสถอดได้ (ต้องใช้เซ็น HMAC — plan/00a §2.2.5) · ไม่มี hard delete

CREATE TYPE "WebhookEndpointStatus" AS ENUM ('ACTIVE', 'DISABLED', 'AUTO_DISABLED');
CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('DELIVERED', 'FAILED', 'EXHAUSTED');

CREATE TABLE "webhook_endpoint" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "description" VARCHAR(200),
    "events" TEXT[],
    "extra_headers_enc" TEXT,
    "extra_header_names" TEXT[],
    "secret_enc" TEXT NOT NULL,
    "secret_prev_enc" TEXT,
    "secret_prev_expires_at" TIMESTAMPTZ(6),
    "secret_rotated_at" TIMESTAMPTZ(6),
    "status" "WebhookEndpointStatus" NOT NULL DEFAULT 'ACTIVE',
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "disabled_at" TIMESTAMPTZ(6),
    "disabled_reason" TEXT,
    "disabled_by" TEXT,
    "verified_at" TIMESTAMPTZ(6),
    "last_delivery_at" TIMESTAMPTZ(6),
    "last_success_at" TIMESTAMPTZ(6),
    "last_failure_at" TIMESTAMPTZ(6),
    "subscription_id" UUID,
    "created_by" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "webhook_endpoint_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "webhook_endpoint_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "webhook_endpoint_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "integration_subscription"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "webhook_endpoint_events_check" CHECK (cardinality("events") >= 1),
    CONSTRAINT "webhook_endpoint_url_check" CHECK ("url" ~ '^https?://'),
    CONSTRAINT "webhook_endpoint_failures_check" CHECK ("consecutive_failures" >= 0)
);
CREATE INDEX "webhook_endpoint_tenant_id_created_at_id_idx" ON "webhook_endpoint"("tenant_id", "created_at", "id");
-- URL ซ้ำในบริษัทเดียวกันไม่ได้ (ต้นแบบ cfHook "มี endpoint นี้แล้ว") — นับเฉพาะที่ยังไม่ลบ
CREATE UNIQUE INDEX "webhook_endpoint_tenant_id_url_key" ON "webhook_endpoint"("tenant_id", "url") WHERE "deleted_at" IS NULL;

CREATE TABLE "webhook_delivery" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "endpoint_id" UUID NOT NULL,
    "outbox_id" UUID,
    "event_id" UUID,
    "envelope_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "test" BOOLEAN NOT NULL DEFAULT false,
    "status" "WebhookDeliveryStatus" NOT NULL,
    "request_url" TEXT NOT NULL,
    "request_headers" JSONB NOT NULL,
    "request_body" TEXT NOT NULL,
    "response_status" INTEGER,
    "response_body" TEXT,
    "duration_ms" INTEGER NOT NULL,
    "error_code" VARCHAR(40),
    "error_class" VARCHAR(20),
    "error_message" TEXT,
    "sent_at" TIMESTAMPTZ(6) NOT NULL,
    "next_retry_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_delivery_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "webhook_delivery_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "webhook_delivery_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoint"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "webhook_delivery_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "domain_event"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "webhook_delivery_outbox_id_fkey" FOREIGN KEY ("outbox_id") REFERENCES "integration_outbox"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "webhook_delivery_attempt_check" CHECK ("attempt" >= 1),
    CONSTRAINT "webhook_delivery_response_body_check" CHECK ("response_body" IS NULL OR length("response_body") <= 4096)
);
CREATE INDEX "webhook_delivery_tenant_id_endpoint_id_sent_at_idx" ON "webhook_delivery"("tenant_id", "endpoint_id", "sent_at");
CREATE INDEX "webhook_delivery_tenant_id_event_id_idx" ON "webhook_delivery"("tenant_id", "event_id");
CREATE INDEX "webhook_delivery_tenant_id_sent_at_idx" ON "webhook_delivery"("tenant_id", "sent_at");

-- trigger ของ T03: คำสั่ง WEBHOOK ไม่เรียงต่อลูกค้า — serialize_key ต่อ event (ส่งขนานกันได้, INT-104 ไม่รับประกันลำดับ)
-- ปลายทางที่ล่ม (retry ~3 วัน) จึงไม่ทำให้ event อื่นของลูกค้าเดียวกันค้างหลังหัวคิว และนับ "ล้มเหลวติดกัน 50 event" ได้จริง
-- max_attempt ของ WEBHOOK = 9 (ครั้งแรก + retry 8 ครั้ง — docs/04 G1)
CREATE OR REPLACE FUNCTION tms_domain_event_to_outbox() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  cust text := tms_outbox_customer_key(NEW.entity_type, NEW.local_id, NEW.snapshot);
BEGIN
  INSERT INTO integration_outbox (tenant_id, kind, sink, target_id, subscription_id, operation, entity_type,
                                  local_id, event_id, event_type, serialize_key, idempotency_key, max_attempt, updated_at)
  SELECT NEW.tenant_id, s.kind, s.sink, s.target_id, s.id, coalesce(s.operation, NEW.type), NEW.entity_type,
         NEW.local_id, NEW.id, NEW.type,
         s.sink || ':' || coalesce(s.target_id, '-') || ':' ||
           CASE WHEN s.kind = 'WEBHOOK' THEN 'evt:' || NEW.id::text
                WHEN cust IS NOT NULL THEN 'cus:' || cust
                ELSE NEW.entity_type || ':' || NEW.local_id::text END,
         s.sink || ':' || coalesce(s.target_id, '-') || ':' || coalesce(s.operation, NEW.type) || ':' || NEW.id::text,
         CASE WHEN s.kind = 'WEBHOOK' THEN 9 ELSE 7 END,
         now()
    FROM integration_subscription s
   WHERE s.tenant_id = NEW.tenant_id
     AND s.active
     AND (NEW.type = ANY (s.event_types)
          OR '*' = ANY (s.event_types)
          OR (split_part(NEW.type, '.', 1) || '.*') = ANY (s.event_types))
  ON CONFLICT (tenant_id, idempotency_key) DO NOTHING;
  RETURN NULL;
END
$$;

-- ไม่มี hard delete (ลบ endpoint = deleted_at) · ประวัติการส่งแก้/ลบจากแอปไม่ได้ (ล้างตาม retention 30 วันโดย role platform — ST7-T05)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE DELETE ON webhook_endpoint FROM tms_app';
    EXECUTE 'REVOKE UPDATE, DELETE ON webhook_delivery FROM tms_app';
  END IF;
END $$;

SELECT tms_enable_tenant_rls('webhook_endpoint');
SELECT tms_enable_tenant_rls('webhook_delivery');
