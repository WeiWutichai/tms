-- ST1-T07: คำเชิญผู้ใช้


-- CreateTable
CREATE TABLE "user_invitation" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "invited_by" UUID,
    "accepted_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_invitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_invitation_token_hash_key" ON "user_invitation"("token_hash");

-- CreateIndex
CREATE INDEX "user_invitation_tenant_id_user_id_idx" ON "user_invitation"("tenant_id", "user_id");

-- AddForeignKey
ALTER TABLE "user_invitation" ADD CONSTRAINT "user_invitation_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


SELECT tms_enable_tenant_rls('user_invitation');
-- ไม่มี hard delete ของคำเชิญ (ประวัติการเชิญ)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE DELETE ON user_invitation FROM tms_app';
  END IF;
END $$;
