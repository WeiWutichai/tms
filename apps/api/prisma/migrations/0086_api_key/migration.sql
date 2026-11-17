-- ST7-T01 API key ของ tenant (docs/04 G1 Auth; docs/01 §5.1; spec/07 §6)
-- secret แสดงครั้งเดียว — เก็บเฉพาะ HMAC-SHA256(pepper) · ไม่มี hard delete (เพิกถอน = revoke_at)

CREATE TABLE "api_key" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "mode" VARCHAR(8) NOT NULL,
    "prefix" VARCHAR(16) NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "scopes" TEXT[],
    "ip_allowlist" TEXT[],
    "expires_at" TIMESTAMPTZ(6),
    "last_used_at" TIMESTAMPTZ(6),
    "last_used_ip" TEXT,
    "revoke_at" TIMESTAMPTZ(6),
    "revoke_reason" TEXT,
    "revoked_by" TEXT,
    "rotated_to_id" UUID,
    "rotated_from_id" UUID,
    "created_by" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "api_key_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "api_key_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "api_key_mode_check" CHECK ("mode" IN ('live', 'test')),
    CONSTRAINT "api_key_prefix_check" CHECK ("prefix" ~ '^tk_(live|test)_[0-9a-f]{4}$'),
    CONSTRAINT "api_key_scopes_check" CHECK (cardinality("scopes") >= 1),
    CONSTRAINT "api_key_ip_allowlist_check" CHECK (cardinality("ip_allowlist") <= 20),
    CONSTRAINT "api_key_name_check" CHECK (length(btrim("name")) >= 1),
    -- เพิกถอน/หมุน ต้องมีเหตุผล (CLAUDE.md: ทุกการยกเลิกต้องมีเหตุผล + audit)
    CONSTRAINT "api_key_revoke_reason_check" CHECK ("revoke_at" IS NULL OR "revoke_reason" IS NOT NULL)
);

CREATE UNIQUE INDEX "api_key_secret_hash_key" ON "api_key"("secret_hash");
CREATE INDEX "api_key_tenant_id_created_at_id_idx" ON "api_key"("tenant_id", "created_at", "id");
-- ชื่อไม่ซ้ำต่อ tenant เฉพาะ key ที่ยังไม่ถูกเพิกถอน/หมุน (spec/07 §6 name unique; key ที่หมุนแล้วกับ key ใหม่ใช้ชื่อเดียวกันได้)
CREATE UNIQUE INDEX "api_key_tenant_id_name_active_key" ON "api_key"("tenant_id", lower("name")) WHERE "revoke_at" IS NULL;

SELECT tms_enable_tenant_rls('api_key');
