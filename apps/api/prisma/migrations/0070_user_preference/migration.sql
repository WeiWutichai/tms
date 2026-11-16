-- ST3-T13: ค่าที่ผู้ใช้เลือกไว้ต่อหน้าจอ (docs/04 D2 "View" — มุมมองกระดาน + field บนการ์ด จำต่อผู้ใช้ ฝั่ง server)
-- 1 แถวต่อ (ผู้ใช้, key) · value = JSON ที่ API ตรวจรูปแบบตาม key · แทนค่าได้ (ไม่ใช่เอกสาร ไม่มี audit)

-- CreateTable
CREATE TABLE "user_preference" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_preference_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_preference_tenant_id_idx" ON "user_preference"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_preference_user_id_key_key" ON "user_preference"("user_id", "key");

-- AddForeignKey
ALTER TABLE "user_preference" ADD CONSTRAINT "user_preference_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_preference" ADD CONSTRAINT "user_preference_key_format" CHECK (
  "key" ~ '^[a-z][a-z0-9_.-]{0,63}$' AND jsonb_typeof("value") = 'object');

SELECT tms_enable_tenant_rls('user_preference');
