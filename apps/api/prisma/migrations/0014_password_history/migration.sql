-- ST1-T02: ประวัติรหัสผ่าน (ห้ามซ้ำ 5 ครั้งล่าสุด)

-- CreateTable
CREATE TABLE "password_history" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "password_history_tenant_id_user_id_created_at_idx" ON "password_history"("tenant_id", "user_id", "created_at");


DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE ALL ON password_history FROM tms_app';
  END IF;
END $$;
SELECT tms_enable_tenant_rls('password_history');
