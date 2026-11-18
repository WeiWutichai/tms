-- ST9-T08 ศูนย์แจ้งเตือน: สมุดสรุปรายวัน 08:00 (docs/04 I "สรุปรายวัน 08:00")
-- 1 แถว = ผู้ใช้ 1 คนได้สรุปของวันหนึ่งแล้ว → unique กันส่งซ้ำ แม้ job รันซ้ำ / หลาย worker / ลองใหม่หลังบางคนล้ม
-- items = จำนวนแจ้งเตือนที่สรุป (0 = ไม่มีอะไร ไม่ได้ส่งอีเมล) · ไม่มี FK ไป app_user (เหมือน notification.recipient_id)
-- การตั้งค่ารับต่อผู้ใช้เก็บใน user_preference key `notifications` (ไม่ต้องมีตารางใหม่)

-- CreateTable
CREATE TABLE "notification_digest" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "digest_day" DATE NOT NULL,
    "items" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_digest_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "notification_digest_items_chk" CHECK ("items" >= 0)
);

-- CreateIndex
CREATE INDEX "notification_digest_tenant_id_digest_day_idx" ON "notification_digest"("tenant_id", "digest_day");

-- CreateIndex
CREATE UNIQUE INDEX "notification_digest_tenant_id_user_id_digest_day_key" ON "notification_digest"("tenant_id", "user_id", "digest_day");

SELECT tms_enable_tenant_rls('notification_digest');
-- role แอป: อ่าน/สร้างเท่านั้น (สมุดกันส่งซ้ำ — ไม่แก้ ไม่ลบ)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE ALL ON notification_digest FROM tms_app';
    EXECUTE 'GRANT SELECT, INSERT ON notification_digest TO tms_app';
  END IF;
END $$;
