-- ST3-T02: เทมเพลตงานประจำของใบสั่งขนส่ง (docs/04 C "กรอกมือ … template งานประจำ"; ตั้งเวลาอัตโนมัติ = P1)
-- payload = body ของ POST /v1/orders (public id) ตรวจด้วยกฎชุดเดียวกับใบสั่ง (normalizeOrderInput)

-- CreateTable
CREATE TABLE "order_template" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_by" UUID,
    "updated_by" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),
    "deleted_reason" TEXT,

    CONSTRAINT "order_template_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_template_tenant_id_updated_at_id_idx" ON "order_template"("tenant_id", "updated_at", "id");

-- ชื่อไม่ซ้ำในบริษัท (ไม่สนตัวพิมพ์) เฉพาะที่ยังไม่ลบ — ลบแล้วตั้งชื่อเดิมใหม่ได้
CREATE UNIQUE INDEX "order_template_tenant_name_lower_uq" ON "order_template"("tenant_id", lower("name")) WHERE "deleted_at" IS NULL;

ALTER TABLE "order_template" ADD CONSTRAINT "order_template_values" CHECK (
  length(btrim("name")) BETWEEN 1 AND 100
  AND jsonb_typeof("payload") = 'object'
  AND "version" >= 1
  AND (("deleted_at" IS NULL) = ("deleted_reason" IS NULL)));

SELECT tms_enable_tenant_rls('order_template');

-- ลบ = soft delete (deleted_at + เหตุผล + audit) — ไม่มีการลบแถวจริง
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE DELETE ON "order_template" FROM tms_app';
  END IF;
END $$;
