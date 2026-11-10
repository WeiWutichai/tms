-- ST1-T06: magic link (เข้าถึงโดยไม่ login)

-- CreateTable
CREATE TABLE "magic_link" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "actions" TEXT[],
    "scopes" TEXT[],
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_reason" TEXT,
    "created_by" TEXT,
    "last_used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "magic_link_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "magic_link_tenant_id_entity_type_entity_id_idx" ON "magic_link"("tenant_id", "entity_type", "entity_id");


ALTER TABLE "magic_link" ADD CONSTRAINT "magic_link_actions_check" CHECK (cardinality("actions") > 0);
-- ห้ามลบ (เก็บเป็นหลักฐานว่าใครได้ลิงก์อะไร) — เพิกถอนด้วย revoked_at
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE DELETE ON magic_link FROM tms_app';
  END IF;
END $$;
SELECT tms_enable_tenant_rls('magic_link');
