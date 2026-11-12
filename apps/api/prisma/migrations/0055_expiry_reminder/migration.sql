-- ST2-T18 เตือนต่ออายุ 60/30/7 วัน — สมุดการเตือน (กันเตือนซ้ำ)
-- 1 แถว = ผู้รับ 1 คนได้รับเตือนระดับหนึ่งของสิ่งหนึ่ง ณ วันหมดหนึ่งแล้ว
-- unique → job รันซ้ำวันเดียวกัน/สอง worker พร้อมกัน ได้แถวเดียว · แยกต่อผู้รับ → สรุปรายวันของแต่ละคนจองและส่ง
-- ใน transaction ของตัวเอง (คนหนึ่งล้มไม่ rollback ของคนอื่น)
-- ต่ออายุ/เปลี่ยนวันหมด = expires_on ใหม่ = รอบเตือนใหม่ (ไม่ต้องล้างแถวเดิม — เก็บเป็นประวัติ)
-- คอลัมน์ vehicle_document.reminder_sent (schema v0) ไม่ใช้ — สมุดนี้ใช้ร่วมกับใบขับขี่และ rate card (บันทึกใน PROGRESS)
-- ไม่มี FK ไปยัง entity (อ้างได้ 3 ตาราง) — เหมือน notification.related_entity_id

-- CreateTable
CREATE TABLE "expiry_reminder" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "level" TEXT NOT NULL,
    "expires_on" DATE NOT NULL,
    "recipient_id" UUID NOT NULL,
    "sent_on" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "expiry_reminder_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "expiry_reminder_entity_type_chk"
      CHECK ("entity_type" IN ('VEHICLE_DOCUMENT', 'DRIVER_LICENCE', 'RATE_CARD')),
    CONSTRAINT "expiry_reminder_level_chk" CHECK ("level" IN ('D60', 'D30', 'D7', 'EXPIRED'))
);

-- CreateIndex
CREATE INDEX "expiry_reminder_tenant_id_sent_on_idx" ON "expiry_reminder"("tenant_id", "sent_on");

-- CreateIndex
CREATE UNIQUE INDEX "expiry_reminder_tenant_id_entity_type_entity_id_expires_on__key" ON "expiry_reminder"("tenant_id", "entity_type", "entity_id", "expires_on", "level", "recipient_id");

SELECT tms_enable_tenant_rls('expiry_reminder');
