-- ST3-T08: ล็อกการแก้ใบสั่งขนส่ง (docs/04 C "Edit lock"; spec/03 ORD-031)
-- 1 แถวต่อใบ — ขอ/ต่ออายุ = INSERT … ON CONFLICT DO UPDATE แบบมีเงื่อนไข (ผู้ถือเดิม หรือแถวหมดอายุแล้ว) คำสั่งเดียว
-- หมดอายุตามเวลา (expires_at = กิจกรรมล่าสุด + 10 นาที) ไม่มี job ล้าง · ปลด = ลบแถว (ข้อมูลชั่วคราว ไม่ใช่เอกสาร)

-- CreateTable
CREATE TABLE "order_edit_lock" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "acquired_at" TIMESTAMPTZ(6) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "order_edit_lock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_edit_lock_tenant_id_user_id_idx" ON "order_edit_lock"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "order_edit_lock_sales_order_id_key" ON "order_edit_lock"("sales_order_id");

-- AddForeignKey
ALTER TABLE "order_edit_lock" ADD CONSTRAINT "order_edit_lock_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_edit_lock" ADD CONSTRAINT "order_edit_lock_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "order_edit_lock" ADD CONSTRAINT "order_edit_lock_times" CHECK (
  "acquired_at" <= "last_seen_at" AND "last_seen_at" < "expires_at");

SELECT tms_enable_tenant_rls('order_edit_lock');
