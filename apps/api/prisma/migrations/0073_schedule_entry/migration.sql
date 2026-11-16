-- ST3-T19: ตารางรถ/คนขับรายวัน (docs/04 D2 "คลิกขวาใส่วันลา/โน้ต"; spec/06 FLT-302 ลาตามช่วงวันที่)
-- วันลาคนขับ (LEAVE) / โน้ตรายวันของรถหรือคนขับ (NOTE) เป็นช่วงวันที่ไทย รวมสองปลาย · ไม่ลบ — ยกเลิกพร้อมเหตุผล + audit

-- CreateEnum
CREATE TYPE "schedule_entry_kind" AS ENUM ('LEAVE', 'NOTE');

-- CreateTable
CREATE TABLE "schedule_entry" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "schedule_entry_kind" NOT NULL,
    "driver_id" UUID,
    "vehicle_id" UUID,
    "starts_on" DATE NOT NULL,
    "ends_on" DATE NOT NULL,
    "note" TEXT NOT NULL,
    "cancelled_at" TIMESTAMPTZ(6),
    "cancel_reason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schedule_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "schedule_entry_tenant_id_starts_on_ends_on_idx" ON "schedule_entry"("tenant_id", "starts_on", "ends_on");

-- CreateIndex
CREATE INDEX "schedule_entry_tenant_id_driver_id_idx" ON "schedule_entry"("tenant_id", "driver_id");

-- CreateIndex
CREATE INDEX "schedule_entry_tenant_id_vehicle_id_idx" ON "schedule_entry"("tenant_id", "vehicle_id");

-- AddForeignKey
ALTER TABLE "schedule_entry" ADD CONSTRAINT "schedule_entry_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_entry" ADD CONSTRAINT "schedule_entry_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- คนขับหรือรถอย่างใดอย่างหนึ่ง · วันลาต้องเป็นของคนขับ · ช่วงไม่ถอยหลังและไม่เกิน 1 ปี · ยกเลิกต้องมีเหตุผล
ALTER TABLE "schedule_entry" ADD CONSTRAINT "schedule_entry_subject" CHECK (
  ("driver_id" IS NULL) <> ("vehicle_id" IS NULL) AND ("kind" <> 'LEAVE' OR "driver_id" IS NOT NULL));
ALTER TABLE "schedule_entry" ADD CONSTRAINT "schedule_entry_range" CHECK (
  "ends_on" >= "starts_on" AND "ends_on" - "starts_on" <= 366);
ALTER TABLE "schedule_entry" ADD CONSTRAINT "schedule_entry_cancel" CHECK (
  ("cancelled_at" IS NULL) = ("cancel_reason" IS NULL));

SELECT tms_enable_tenant_rls('schedule_entry');
