-- ST3-T23 (review L8): FK รถ/คนขับที่รถร่วมรับงาน — index สำหรับตรวจ RESTRICT/ค้นประวัติการรับงานของรถ/คนขับ
CREATE INDEX IF NOT EXISTS "subcon_offer_tenant_id_accepted_vehicle_id_idx" ON "subcon_offer"("tenant_id", "accepted_vehicle_id");
CREATE INDEX IF NOT EXISTS "subcon_offer_tenant_id_accepted_driver_id_idx" ON "subcon_offer"("tenant_id", "accepted_driver_id");
