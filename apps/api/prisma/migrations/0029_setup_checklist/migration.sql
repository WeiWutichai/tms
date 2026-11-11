-- ST1-T21: setup checklist




-- CreateTable
CREATE TABLE "setup_checklist_state" (
    "tenant_id" UUID NOT NULL,
    "connector_skipped_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "hidden_for" UUID[] DEFAULT ARRAY[]::UUID[],
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "setup_checklist_state_pkey" PRIMARY KEY ("tenant_id")
);


SELECT tms_enable_tenant_rls('setup_checklist_state');
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE DELETE ON setup_checklist_state FROM tms_app';
  END IF;
END $$;
