-- ST2-T14 "ราคา 5 ครั้งล่าสุดที่จ้างรถร่วมรายนี้" (GET /v1/carriers/{id}/recent-prices)
-- query เริ่มจากเที่ยวของรถร่วม (tenant + carrier_id + trip_date ≤ วันนี้ เรียงใหม่สุด) แล้ว join trip_cost ด้วย (tenant_id, trip_id) ที่มีดัชนีอยู่แล้ว
-- ไม่มีตารางใหม่ (ไม่ต้อง tms_enable_tenant_rls) · ไม่แตะข้อมูล

-- CreateIndex
CREATE INDEX "trip_tenant_id_carrier_id_trip_date_idx" ON "trip"("tenant_id", "carrier_id", "trip_date");

-- ประเภทรถ ณ วันจ่ายงาน (QA ST2-T14): ตัวกรอง "ประเภทรถ" ของราคา 5 ครั้งต้องใช้ประเภทของเที่ยว ไม่ใช่ประเภทปัจจุบันของรถ
-- (รถเปลี่ยนประเภทภายหลัง/เที่ยวที่ไม่มี vehicle_id) — ST3 จ่ายงานต้องเขียนคู่กับ vehicle_type_snapshot (ชื่อ)
-- ไม่มี FK ตามแบบคอลัมน์อ้างอิงอื่นของ trip ใน schema v0 (vehicle_id/driver_id/carrier_id)
ALTER TABLE "trip" ADD COLUMN "vehicle_type_id" UUID;
