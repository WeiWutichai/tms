-- ST3-T11 trip + trip_stop — docs/01 §3.3 (trip/trip_stop), §4.2 (state machine เที่ยว + plan/00a DISPATCHED → CANCELLED),
-- docs/04 D1 (snapshot รถ/คนขับ/คนขับสำรอง/หาง/รถร่วม ต่อเที่ยว), plan/00a (planned_start/end, trailer)
-- ALTER ตาราง schema v0 (0004): FK ทุกตัว RESTRICT · CHECK · ไม่มีการลบเที่ยว/จุดจริง (ยกเลิก = CANCELLED, จุดเลิกใช้ = removed_at)
-- (0062 = ST2-T21, 0063 = ST3-T02 ที่ทำคู่ขนาน) · ก่อน T11 ไม่มีโค้ดแอปใดเขียน trip — แถวที่ขัด CHECK ทำให้ ADD CONSTRAINT ล้มพร้อมชื่อ constraint

-- DropIndex (แทนด้วย partial unique เฉพาะจุดที่ยังใช้ — ท้ายไฟล์)
DROP INDEX "trip_stop_tenant_id_trip_id_sequence_key";

-- AlterTable
ALTER TABLE "delivery_order" ADD COLUMN     "pickup_trip_stop_id" UUID;

-- AlterTable
ALTER TABLE "trip" ADD COLUMN     "assigned_at" TIMESTAMPTZ(6),
ADD COLUMN     "cancel_reason" TEXT,
ADD COLUMN     "cancel_reason_code_id" UUID,
ADD COLUMN     "cancelled_at" TIMESTAMPTZ(6),
ADD COLUMN     "offered_at" TIMESTAMPTZ(6),
ADD COLUMN     "offered_by" TEXT,
ADD COLUMN     "planned_end_at" TIMESTAMPTZ(6),
ADD COLUMN     "planned_start_at" TIMESTAMPTZ(6),
ADD COLUMN     "relief_driver_id" UUID,
ADD COLUMN     "relief_driver_name_snapshot" TEXT,
ADD COLUMN     "relief_driver_phone_snapshot" TEXT,
ADD COLUMN     "trailer_id" UUID,
ADD COLUMN     "trailer_plate_snapshot" TEXT;

-- AlterTable
ALTER TABLE "trip_stop" ADD COLUMN     "removed_at" TIMESTAMPTZ(6),
ADD COLUMN     "window_end" TIMESTAMPTZ(6),
ADD COLUMN     "window_start" TIMESTAMPTZ(6);

-- CreateIndex
CREATE INDEX "trip_tenant_id_vehicle_id_trip_date_idx" ON "trip"("tenant_id", "vehicle_id", "trip_date");

-- CreateIndex
CREATE INDEX "trip_tenant_id_driver_id_trip_date_idx" ON "trip"("tenant_id", "driver_id", "trip_date");

-- CreateIndex
CREATE INDEX "trip_stop_tenant_id_trip_id_idx" ON "trip_stop"("tenant_id", "trip_id");

-- CreateIndex
CREATE INDEX "trip_stop_tenant_id_site_id_idx" ON "trip_stop"("tenant_id", "site_id");

-- AddForeignKey
ALTER TABLE "trip" ADD CONSTRAINT "trip_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip" ADD CONSTRAINT "trip_vehicle_type_id_fkey" FOREIGN KEY ("vehicle_type_id") REFERENCES "vehicle_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip" ADD CONSTRAINT "trip_trailer_id_fkey" FOREIGN KEY ("trailer_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip" ADD CONSTRAINT "trip_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip" ADD CONSTRAINT "trip_relief_driver_id_fkey" FOREIGN KEY ("relief_driver_id") REFERENCES "driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip" ADD CONSTRAINT "trip_carrier_id_fkey" FOREIGN KEY ("carrier_id") REFERENCES "carrier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip" ADD CONSTRAINT "trip_cancel_reason_code_id_fkey" FOREIGN KEY ("cancel_reason_code_id") REFERENCES "reason_code"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_stop" ADD CONSTRAINT "trip_stop_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_stop" ADD CONSTRAINT "trip_stop_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "customer_site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_stop" ADD CONSTRAINT "trip_stop_fail_reason_code_id_fkey" FOREIGN KEY ("fail_reason_code_id") REFERENCES "reason_code"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_order" ADD CONSTRAINT "delivery_order_pickup_trip_stop_id_fkey" FOREIGN KEY ("pickup_trip_stop_id") REFERENCES "trip_stop"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex (ค้น DO ตามจุด — review ST3-T11)
CREATE INDEX "delivery_order_tenant_id_trip_stop_id_idx" ON "delivery_order"("tenant_id", "trip_stop_id");
CREATE INDEX "delivery_order_tenant_id_pickup_trip_stop_id_idx" ON "delivery_order"("tenant_id", "pickup_trip_stop_id");

-- จุดของ DO ต้องเป็นจุดของเที่ยวเดียวกับ DO (composite FK — Prisma ไม่ได้ model ไว้; MATCH SIMPLE: DO นอกเที่ยวไม่ตรวจ)
CREATE UNIQUE INDEX "trip_stop_id_trip_id_key" ON "trip_stop"("id", "trip_id");
ALTER TABLE "delivery_order" ADD CONSTRAINT "delivery_order_drop_stop_same_trip_fkey"
  FOREIGN KEY ("trip_stop_id", "trip_id") REFERENCES "trip_stop"("id", "trip_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "delivery_order" ADD CONSTRAINT "delivery_order_pickup_stop_same_trip_fkey"
  FOREIGN KEY ("pickup_trip_stop_id", "trip_id") REFERENCES "trip_stop"("id", "trip_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ลำดับจุดไม่ซ้ำเฉพาะจุดที่ยังใช้ (จุดที่ถอดแล้วเก็บไว้เป็นประวัติ)
CREATE UNIQUE INDEX "trip_stop_active_sequence_key" ON "trip_stop"("tenant_id", "trip_id", "sequence") WHERE "removed_at" IS NULL;

-- เลขเที่ยวออกตอนสร้างเสมอ (document_series TRIP — เอกสารปฏิบัติการ ข้ามเลขได้)
ALTER TABLE "trip" ADD CONSTRAINT "trip_number" CHECK ("trip_no" IS NOT NULL AND length(btrim("trip_no")) > 0);
-- ยกเลิก ⇔ มีเวลาและเหตุผล (≥ 10 ตัวอักษร — MD-222)
ALTER TABLE "trip" ADD CONSTRAINT "trip_cancel" CHECK (
  ("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL)
  AND ("status" <> 'CANCELLED' OR ("cancel_reason" IS NOT NULL AND char_length(btrim("cancel_reason")) >= 10)));
-- snapshot มาคู่กับ id เสมอ (docs/04 D1) · คนขับสำรองไม่ใช่คนขับหลัก · หางไม่ใช่รถหลัก
ALTER TABLE "trip" ADD CONSTRAINT "trip_snapshot" CHECK (
  ("vehicle_id" IS NULL OR ("vehicle_plate_snapshot" IS NOT NULL AND "vehicle_type_id" IS NOT NULL))
  AND ("driver_id" IS NULL OR "driver_name_snapshot" IS NOT NULL)
  AND ("relief_driver_id" IS NULL OR ("relief_driver_name_snapshot" IS NOT NULL AND "relief_driver_id" IS DISTINCT FROM "driver_id"))
  AND ("trailer_id" IS NULL OR ("trailer_plate_snapshot" IS NOT NULL AND "trailer_id" IS DISTINCT FROM "vehicle_id"))
  AND ("carrier_id" IS NULL OR "carrier_name_snapshot" IS NOT NULL));
-- จัดรถแล้ว (ASSIGNED ขึ้นไป) ต้องมีรถ · เสนอรถร่วมต้องมีรถร่วม (IS NOT DISTINCT FROM — NULL ไม่หลุด CHECK) · ช่วงวิ่งไม่ถอยหลัง
ALTER TABLE "trip" ADD CONSTRAINT "trip_state" CHECK (
  ("status" NOT IN ('ASSIGNED', 'DISPATCHED', 'IN_PROGRESS', 'COMPLETED', 'COSTED', 'SETTLED') OR "vehicle_id" IS NOT NULL)
  AND ("status" <> 'OFFERED' OR ("carrier_id" IS NOT NULL AND "assignment_status" IS NOT DISTINCT FROM 'OFFERED'::"assignment_status"))
  AND ("planned_end_at" IS NULL OR "planned_start_at" IS NULL OR "planned_end_at" >= "planned_start_at"));
ALTER TABLE "trip_stop" ADD CONSTRAINT "trip_stop_values" CHECK (
  "sequence" >= 1
  AND ("window_end" IS NULL OR "window_start" IS NULL OR "window_end" >= "window_start")
  AND ("planned_departure" IS NULL OR "planned_arrival" IS NULL OR "planned_departure" >= "planned_arrival"));
-- DO นอกเที่ยวไม่มีจุดของเที่ยว
ALTER TABLE "delivery_order" ADD CONSTRAINT "delivery_order_trip_stop" CHECK (
  "trip_id" IS NOT NULL OR ("trip_stop_id" IS NULL AND "pickup_trip_stop_id" IS NULL));

-- RLS เปิดแล้วใน 0004 (tms_enable_tenant_rls idempotent — เรียกซ้ำตามกติกา)
SELECT tms_enable_tenant_rls('trip');
SELECT tms_enable_tenant_rls('trip_stop');
-- ไม่มีการลบเที่ยว/จุดจริง
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE DELETE ON "trip", "trip_stop" FROM tms_app';
  END IF;
END $$;

