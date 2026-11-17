-- ST7-T03 integration_outbox + subscription (docs/01 §3.7, §6.2; docs/04 G3 Outbox)
-- กฎ transaction (docs/01 §6.2): การเปลี่ยนสถานะเอกสาร + domain_event + integration_outbox อยู่ใน transaction เดียวกันเสมอ
-- → บังคับที่ฐานข้อมูล: trigger AFTER INSERT บน domain_event เขียนคำสั่งให้ทุก subscription ที่ตรง (ทุกทางเขียน event ผ่านจุดนี้)

CREATE TYPE "OutboxKind" AS ENUM ('ADAPTER', 'WEBHOOK');
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'IN_FLIGHT', 'DONE', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'SKIPPED');

CREATE TABLE "integration_subscription" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "OutboxKind" NOT NULL,
    "sink" VARCHAR(40) NOT NULL,
    "target_id" VARCHAR(100),
    "event_types" TEXT[],
    "operation" VARCHAR(60),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_subscription_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "integration_subscription_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "integration_subscription_sink_check" CHECK ("sink" ~ '^[a-z][a-z0-9_-]{0,39}$'),
    CONSTRAINT "integration_subscription_event_types_check" CHECK (cardinality("event_types") >= 1)
);
CREATE INDEX "integration_subscription_tenant_id_active_idx" ON "integration_subscription"("tenant_id", "active");

CREATE TABLE "integration_outbox" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "kind" "OutboxKind" NOT NULL,
    "sink" VARCHAR(40) NOT NULL,
    "target_id" VARCHAR(100),
    "subscription_id" UUID,
    "operation" VARCHAR(60) NOT NULL,
    "entity_type" TEXT NOT NULL,
    "local_id" UUID NOT NULL,
    "event_id" UUID,
    "event_type" TEXT,
    "serialize_key" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "payload" JSONB,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "max_attempt" INTEGER NOT NULL DEFAULT 7,
    "next_run_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "lease_id" UUID,
    "lease_until" TIMESTAMPTZ(6),
    "claimed_at" TIMESTAMPTZ(6),
    "done_at" TIMESTAMPTZ(6),
    "error_class" VARCHAR(20),
    "last_error" JSONB,
    "result" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integration_outbox_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "integration_outbox_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "integration_outbox_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "domain_event"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "integration_outbox_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "integration_subscription"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "integration_outbox_attempt_check" CHECK ("attempt" >= 0 AND "max_attempt" >= 1),
    CONSTRAINT "integration_outbox_lease_check" CHECK ("status" <> 'IN_FLIGHT' OR ("lease_id" IS NOT NULL AND "lease_until" IS NOT NULL))
);
CREATE UNIQUE INDEX "integration_outbox_tenant_id_idempotency_key_key" ON "integration_outbox"("tenant_id", "idempotency_key");
CREATE INDEX "integration_outbox_status_next_run_at_idx" ON "integration_outbox"("status", "next_run_at");
CREATE INDEX "integration_outbox_tenant_id_serialize_key_seq_idx" ON "integration_outbox"("tenant_id", "serialize_key", "seq");
CREATE INDEX "integration_outbox_tenant_id_claimed_at_idx" ON "integration_outbox"("tenant_id", "claimed_at");
CREATE INDEX "integration_outbox_event_id_idx" ON "integration_outbox"("event_id");
-- คิวที่ยังไม่จบ (หัวคิวต่อ serialize_key) — partial index ให้ claim ไม่ต้องสแกนแถวที่จบแล้ว
CREATE INDEX "integration_outbox_open_idx" ON "integration_outbox"("tenant_id", "serialize_key", "seq")
  WHERE "status" IN ('PENDING', 'IN_FLIGHT', 'FAILED_RETRYABLE');

-- ลูกค้าของ event (คีย์ serialize ต่อ (ปลายทาง, ลูกค้า) — docs/01 §6.2 กัน credit note แซง invoice ต้นฉบับ)
-- snapshot ใช้ทั้ง `cus_<hex32>` (มุมมอง API) และ uuid ดิบ → ทำให้เป็น hex32 เดียวกัน
CREATE OR REPLACE FUNCTION tms_outbox_customer_key(entity_type text, local_id uuid, snapshot jsonb) RETURNS text
  LANGUAGE sql IMMUTABLE AS
$$
  SELECT CASE
    WHEN entity_type = 'customer' THEN replace(local_id::text, '-', '')
    ELSE nullif(lower(replace(regexp_replace(coalesce(
           snapshot ->> 'customerId', snapshot #>> '{customer,id}', ''), '^cus_', ''), '-', '')), '')
  END
$$;

-- trigger: event ใหม่ → คำสั่งต่อ subscription ที่ active และชนิด event ตรง (ชื่อเต็ม / `prefix.*` / `*`)
-- รันใน transaction เดียวกับ INSERT domain_event (rollback = ไม่มีทั้ง event และคำสั่ง) ใต้ RLS ของผู้เขียน event
-- ON CONFLICT: subscription ซ้ำที่ชี้ปลายทางเดียวกันได้คำสั่งเดียว (idempotency_key = sink:target:operation:event)
CREATE OR REPLACE FUNCTION tms_domain_event_to_outbox() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  cust text := tms_outbox_customer_key(NEW.entity_type, NEW.local_id, NEW.snapshot);
BEGIN
  INSERT INTO integration_outbox (tenant_id, kind, sink, target_id, subscription_id, operation, entity_type,
                                  local_id, event_id, event_type, serialize_key, idempotency_key, updated_at)
  SELECT NEW.tenant_id, s.kind, s.sink, s.target_id, s.id, coalesce(s.operation, NEW.type), NEW.entity_type,
         NEW.local_id, NEW.id, NEW.type,
         s.sink || ':' || coalesce(s.target_id, '-') || ':' ||
           CASE WHEN cust IS NOT NULL THEN 'cus:' || cust ELSE NEW.entity_type || ':' || NEW.local_id::text END,
         s.sink || ':' || coalesce(s.target_id, '-') || ':' || coalesce(s.operation, NEW.type) || ':' || NEW.id::text,
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

CREATE TRIGGER domain_event_to_outbox AFTER INSERT ON domain_event
  FOR EACH ROW EXECUTE FUNCTION tms_domain_event_to_outbox();

SELECT tms_enable_tenant_rls('integration_subscription');
SELECT tms_enable_tenant_rls('integration_outbox');
