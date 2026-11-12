-- ST2-T14 "ราคา 5 ครั้งล่าสุดที่จ้างรถร่วมรายนี้" (GET /v1/carriers/{id}/recent-prices)
-- query เริ่มจากเที่ยวของรถร่วม (tenant + carrier_id + trip_date ≤ วันนี้ เรียงใหม่สุด) แล้ว join trip_cost ด้วย (tenant_id, trip_id) ที่มีดัชนีอยู่แล้ว
-- ไม่มีตารางใหม่ (ไม่ต้อง tms_enable_tenant_rls) · ไม่แตะข้อมูล

-- CreateIndex
CREATE INDEX "trip_tenant_id_carrier_id_trip_date_idx" ON "trip"("tenant_id", "carrier_id", "trip_date");
