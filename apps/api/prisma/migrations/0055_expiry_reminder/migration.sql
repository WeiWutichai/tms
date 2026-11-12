-- ST2-T18 เตือนต่ออายุ 60/30/7 วัน — สมุดการเตือน (กันเตือนซ้ำ)
-- 1 แถว = เตือนระดับหนึ่งของสิ่งหนึ่ง ณ วันหมดหนึ่ง · unique → job รันซ้ำวันเดียวกัน/สอง worker พร้อมกัน ได้แถวเดียว
-- ต่ออายุ/เปลี่ยนวันหมด = expires_on ใหม่ = รอบเตือนใหม่ (ไม่ต้องล้างแถวเดิม — เก็บเป็นประวัติ)
-- คอลัมน์ vehicle_document.reminder_sent (schema v0) ไม่ใช้ — สมุดนี้ใช้ร่วมกับใบขับขี่และ rate card (บันทึกใน PROGRESS)

-- CreateTable
CREATE TABLE "expiry_reminder" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "level" TEXT NOT NULL,
    "expires_on" DATE NOT NULL,
    "sent_on" DATE NOT NULL,
    "recipients" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expiry_reminder_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "expiry_reminder_entity_type_chk"
      CHECK ("entity_type" IN ('VEHICLE_DOCUMENT', 'DRIVER_LICENCE', 'RATE_CARD')),
    CONSTRAINT "expiry_reminder_level_chk" CHECK ("level" IN ('D60', 'D30', 'D7', 'EXPIRED')),
    CONSTRAINT "expiry_reminder_recipients_chk" CHECK ("recipients" >= 0)
);

-- CreateIndex
CREATE INDEX "expiry_reminder_tenant_id_sent_on_idx" ON "expiry_reminder"("tenant_id", "sent_on");

-- CreateIndex
CREATE UNIQUE INDEX "expiry_reminder_tenant_id_entity_type_entity_id_expires_on__key" ON "expiry_reminder"("tenant_id", "entity_type", "entity_id", "expires_on", "level");

SELECT tms_enable_tenant_rls('expiry_reminder');
