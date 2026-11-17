-- ST4-T07 ePOD ผ่านเว็บ (docs/04 E2 "ePOD ผ่านเว็บ", docs/01 §3.3 `pod_status`, §4.3, §5.3 payload POD; spec/04 §13 DRV-164)
-- หลักฐานส่งต่อ DO เป็นฉบับ: แก้ = แถวใหม่ (version + 1) + เหตุผล · ไม่มี UPDATE/DELETE · ไฟล์อ้าง stored_document (เขียนครั้งเดียว)
CREATE TABLE "delivery_order_pod" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "delivery_order_id" UUID NOT NULL,
    "trip_stop_id" UUID,
    "version" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "receiver_name" TEXT,
    "receiver_relation" TEXT,
    "signature_document_id" UUID,
    "photo_document_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "file_document_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "weighed_kg" DECIMAL(14,3),
    "customer_ref" TEXT,
    "note" TEXT,
    "checks" JSONB NOT NULL DEFAULT '{}',
    "choices" JSONB NOT NULL DEFAULT '{}',
    "barcodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pin_enc" TEXT,
    "pin_length" INTEGER,
    "rating" INTEGER,
    "pod_status" TEXT NOT NULL,
    "missing" JSONB NOT NULL DEFAULT '[]',
    "reason" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_order_pod_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "delivery_order_pod_tenant_id_delivery_order_id_version_key" ON "delivery_order_pod"("tenant_id", "delivery_order_id", "version");
CREATE INDEX "delivery_order_pod_tenant_id_trip_stop_id_idx" ON "delivery_order_pod"("tenant_id", "trip_stop_id");

ALTER TABLE "delivery_order_pod" ADD CONSTRAINT "delivery_order_pod_delivery_order_id_fkey"
  FOREIGN KEY ("delivery_order_id") REFERENCES "delivery_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "delivery_order_pod" ADD CONSTRAINT "delivery_order_pod_trip_stop_id_fkey"
  FOREIGN KEY ("trip_stop_id") REFERENCES "trip_stop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "delivery_order_pod" ADD CONSTRAINT "delivery_order_pod_signature_document_id_fkey"
  FOREIGN KEY ("signature_document_id") REFERENCES "stored_document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ค่าที่ฐานบังคับ
ALTER TABLE "delivery_order_pod" ADD CONSTRAINT "delivery_order_pod_version_pos" CHECK ("version" >= 1);
ALTER TABLE "delivery_order_pod" ADD CONSTRAINT "delivery_order_pod_outcome" CHECK ("outcome" IN ('SUCCESS', 'FAILURE'));
ALTER TABLE "delivery_order_pod" ADD CONSTRAINT "delivery_order_pod_source" CHECK ("source" IN ('WEB', 'LINK', 'APP', 'API'));
ALTER TABLE "delivery_order_pod" ADD CONSTRAINT "delivery_order_pod_relation" CHECK ("receiver_relation" IS NULL OR "receiver_relation" IN ('SELF', 'SECURITY', 'STAFF', 'OTHER'));
ALTER TABLE "delivery_order_pod" ADD CONSTRAINT "delivery_order_pod_status" CHECK ("pod_status" IN ('PARTIAL', 'COMPLETE'));
ALTER TABLE "delivery_order_pod" ADD CONSTRAINT "delivery_order_pod_weighed_nonneg" CHECK ("weighed_kg" IS NULL OR "weighed_kg" >= 0);
ALTER TABLE "delivery_order_pod" ADD CONSTRAINT "delivery_order_pod_rating_pos" CHECK ("rating" IS NULL OR "rating" >= 1);
ALTER TABLE "delivery_order_pod" ADD CONSTRAINT "delivery_order_pod_reason" CHECK ("version" = 1 OR "reason" IS NOT NULL);

-- delivery_order.pod_status (docs/01 §3.3 enum NONE / PARTIAL / COMPLETE)
ALTER TABLE "delivery_order" ADD CONSTRAINT "delivery_order_pod_status" CHECK ("pod_status" IN ('NONE', 'PARTIAL', 'COMPLETE'));

-- append-only ทุก role (เหมือน stop_event — 0082)
CREATE OR REPLACE FUNCTION tms_delivery_order_pod_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'delivery_order_pod is append-only (amend = new version)' USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER delivery_order_pod_append_only BEFORE UPDATE OR DELETE ON "delivery_order_pod"
  FOR EACH ROW EXECUTE FUNCTION tms_delivery_order_pod_append_only();
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON "delivery_order_pod" FROM tms_app';
  END IF;
END $$;

SELECT tms_enable_tenant_rls('delivery_order_pod');
