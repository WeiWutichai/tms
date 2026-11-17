-- ST7-T05 Webhook ops (docs/04 G1 "เก็บ 30 วัน"; spec/07 INT-109)
-- (1) ล้างประวัติการส่งเกิน 30 วันข้าม tenant (worker role platform) — index ตามเวลาส่ง ให้ลบเป็นชุดไม่ต้อง scan ทั้งตาราง
CREATE INDEX "webhook_delivery_sent_at_idx" ON "webhook_delivery"("sent_at");

-- (2) INT-109: เวลาที่เริ่มพักคำสั่ง (tenant ถูกระงับ → AUTH → PENDING) — นับ 30 วันจากเวลานี้ ไม่ใช่เวลาสร้างคำสั่ง
--     dispatcher ตั้งค่าครั้งแรกที่พักและล้างเมื่อพ้นสถานะพัก · ไม่มีตารางใหม่ (RLS ของ integration_outbox คงเดิม)
ALTER TABLE "integration_outbox" ADD COLUMN "parked_at" TIMESTAMPTZ(6);
CREATE INDEX "integration_outbox_parked_at_idx" ON "integration_outbox"("parked_at");
