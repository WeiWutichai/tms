-- ST3-T21 ช่องส่ง LINE Messaging API + SMS หลังแกนแจ้งเตือน (docs/04 G4 LINE OA / Messaging API; I การแจ้งเตือน — LINE สำหรับรถร่วม)
-- messaging_setting = ตั้งค่าต่อ tenant (channel access token เข้ารหัส FieldCipher ไม่คืนใน API)
-- message_delivery  = outbox + บันทึกการส่ง (API เขียนใน transaction ของงาน, worker ส่งด้วย retry + backoff)
--   ไม่เก็บเนื้อความ/ลิงก์ (token) — เก็บตัวแปร template + magic_link_id แล้ว worker render + สร้าง URL ตอนส่ง (review ST3-T21 M2)
-- message_recipient_counter = เพดานต่อผู้รับข้ามทุกบริษัท (blind index ของผู้รับ × ชั่วโมง — ไม่มี tenant_id, review M1)

-- CreateTable
CREATE TABLE "messaging_setting" (
    "tenant_id" UUID NOT NULL,
    "line_enabled" BOOLEAN NOT NULL DEFAULT false,
    "line_token_enc" TEXT,
    "line_token_last4" VARCHAR(4),
    "sms_enabled" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messaging_setting_pkey" PRIMARY KEY ("tenant_id")
);

-- CreateTable
CREATE TABLE "message_delivery" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'th',
    "recipient_enc" TEXT,
    "recipient_masked" TEXT NOT NULL,
    "recipient_hash" TEXT NOT NULL,
    "recipient_type" TEXT,
    "recipient_ref_id" UUID,
    "vars" JSONB,
    "magic_link_id" UUID,
    "entity_type" TEXT,
    "entity_id" UUID,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "run_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "locked_until" TIMESTAMPTZ(6),
    "provider" TEXT,
    "provider_message_id" TEXT,
    "error_code" TEXT,
    "error" TEXT,
    "created_by" TEXT,
    "sent_at" TIMESTAMPTZ(6),
    "failed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_recipient_counter" (
    "recipient_hash" TEXT NOT NULL,
    "hour" TIMESTAMPTZ(6) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "message_recipient_counter_pkey" PRIMARY KEY ("recipient_hash","hour")
);

-- CreateIndex
CREATE INDEX "message_delivery_status_run_at_idx" ON "message_delivery"("status", "run_at");

-- CreateIndex
CREATE INDEX "message_delivery_tenant_id_created_at_id_idx" ON "message_delivery"("tenant_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "message_delivery_tenant_id_entity_type_entity_id_created_at_idx" ON "message_delivery"("tenant_id", "entity_type", "entity_id", "created_at");

-- CreateIndex
CREATE INDEX "message_delivery_tenant_id_recipient_hash_created_at_idx" ON "message_delivery"("tenant_id", "recipient_hash", "created_at");

-- token ต้องมาพร้อม 4 ตัวท้าย (เปิด LINE จริงต้องมี token — ตรวจใน service เพราะ mock dev/test ไม่ใช้ token)
ALTER TABLE "messaging_setting" ADD CONSTRAINT "messaging_setting_line_token_check"
  CHECK (("line_token_enc" IS NULL) = ("line_token_last4" IS NULL));

ALTER TABLE "message_delivery" ADD CONSTRAINT "message_delivery_channel_check" CHECK ("channel" IN ('LINE', 'SMS'));
ALTER TABLE "message_delivery" ADD CONSTRAINT "message_delivery_status_check"
  CHECK ("status" IN ('QUEUED', 'SENDING', 'SENT', 'FAILED'));
-- จบแล้ว (SENT/FAILED) ห้ามเหลือตัวแปรข้อความ/ผู้รับตัวจริง (ข้อมูลส่วนบุคคล)
ALTER TABLE "message_delivery" ADD CONSTRAINT "message_delivery_final_scrub_check"
  CHECK ("status" IN ('QUEUED', 'SENDING') OR ("vars" IS NULL AND "recipient_enc" IS NULL));
ALTER TABLE "message_recipient_counter" ADD CONSTRAINT "message_recipient_counter_count_check" CHECK ("count" >= 0);
ALTER TABLE "message_delivery" ADD CONSTRAINT "message_delivery_attempts_check"
  CHECK ("attempts" >= 0 AND "max_attempts" BETWEEN 1 AND 10);

SELECT tms_enable_tenant_rls('messaging_setting');
SELECT tms_enable_tenant_rls('message_delivery');

-- role แอป: ตั้งค่า = อ่าน/เขียนได้ ไม่ลบ · บันทึกการส่ง = เพิ่มได้ อ่านได้เฉพาะคอลัมน์ที่ไม่ลับ ไม่แก้/ไม่ลบ (worker ใช้ role platform)
-- ตัวนับต่อผู้รับ (ข้ามบริษัท) = role แอปแตะตารางตรงไม่ได้ — เพิ่ม + อ่านค่าผ่านฟังก์ชัน SECURITY DEFINER เท่านั้น (QA ST3-T21)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE DELETE ON "messaging_setting" FROM tms_app';
    EXECUTE 'REVOKE ALL ON "message_recipient_counter" FROM tms_app';
    EXECUTE 'REVOKE SELECT, UPDATE, DELETE ON "message_delivery" FROM tms_app';
    EXECUTE 'GRANT SELECT ("id", "tenant_id", "channel", "template", "locale", "recipient_masked", "recipient_hash",
      "recipient_type", "recipient_ref_id", "magic_link_id", "entity_type", "entity_id", "status", "attempts",
      "max_attempts", "run_at", "provider", "provider_message_id", "error_code", "error", "created_by",
      "sent_at", "failed_at", "created_at", "updated_at") ON "message_delivery" TO tms_app';
  END IF;
END $$;

-- เพิ่มตัวนับของผู้รับในชั่วโมงนี้ 1 แล้วคืนค่าใหม่ (atomic) — ทางเดียวที่ role แอปใช้ตาราง message_recipient_counter
CREATE OR REPLACE FUNCTION tms_message_recipient_hit(p_hash text) RETURNS integer
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS
$$
  INSERT INTO message_recipient_counter (recipient_hash, hour, count)
  VALUES (p_hash, date_trunc('hour', now()), 1)
  ON CONFLICT (recipient_hash, hour) DO UPDATE SET count = message_recipient_counter.count + 1
  RETURNING count
$$;
REVOKE ALL ON FUNCTION tms_message_recipient_hit(text) FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION tms_message_recipient_hit(text) TO tms_app';
  END IF;
END $$;
