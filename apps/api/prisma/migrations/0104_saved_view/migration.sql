-- ST9-T11: มุมมองที่บันทึกไว้ (saved view) ของตาราง/รายงาน ต่อผู้ใช้ (docs/04 I UI pattern มาตรฐาน, H บันทึก filter)
-- ชุดตัวกรอง/แท็บ (state) + คอลัมน์ที่ซ่อน ต่อ (ผู้ใช้, หน้า) · เห็นเฉพาะเจ้าของ (แชร์ในทีม = P1)
-- ค่าส่วนตัว ไม่ใช่เอกสาร → ไม่มี audit (เหมือน user_preference) · ลบ = soft (deleted_at)

-- CreateTable
CREATE TABLE "saved_view" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "page" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "state" JSONB NOT NULL,
    "hidden_columns" JSONB,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "saved_view_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "saved_view_tenant_id_user_id_page_idx" ON "saved_view"("tenant_id", "user_id", "page");

-- ชื่อไม่ซ้ำ (ไม่สนตัวพิมพ์) ต่อผู้ใช้ต่อหน้า · ค่าเริ่มต้นได้ 1 มุมมองต่อผู้ใช้ต่อหน้า (เฉพาะที่ยังไม่ลบ)
CREATE UNIQUE INDEX "saved_view_user_page_name_key" ON "saved_view"("user_id", "page", lower("name")) WHERE "deleted_at" IS NULL;
CREATE UNIQUE INDEX "saved_view_user_page_default_key" ON "saved_view"("user_id", "page") WHERE "is_default" AND "deleted_at" IS NULL;

-- AddForeignKey
ALTER TABLE "saved_view" ADD CONSTRAINT "saved_view_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "saved_view" ADD CONSTRAINT "saved_view_shape" CHECK (
  "page" ~ '^[a-z][a-z0-9_.-]{0,39}$'
  AND char_length("name") BETWEEN 1 AND 60
  AND jsonb_typeof("state") = 'object'
  AND ("hidden_columns" IS NULL OR jsonb_typeof("hidden_columns") = 'array'));

SELECT tms_enable_tenant_rls('saved_view');
