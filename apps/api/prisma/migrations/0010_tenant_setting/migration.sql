-- ST1-T17: registry ค่าตั้งองค์กรแบบมี type

-- CreateTable
CREATE TABLE "tenant_setting" (
    "tenant_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_setting_pkey" PRIMARY KEY ("tenant_id","key")
);


SELECT tms_enable_tenant_rls('tenant_setting');
