-- ST3-T23 ลิงก์ข้อเสนองาน (docs/04 D3 "ส่งลิงก์ LINE/SMS ไม่ต้อง login", M10; docs/01 §4.2 OFFERED → ASSIGNED / PLANNING;
-- spec/03 §8 SubconOffer ฟิลด์ตอบรับ, spec/04 §5 EXE-E) — คำตอบของรถร่วมเก็บที่การจ้าง (ประวัติคงอยู่ ไม่ลบ)
-- ทุกคอลัมน์ว่างได้ (ข้อเสนอเดิมของ ST3-T22 ไม่มีค่า) · ลิงก์ = magic_link purpose trip_offer entity subcon_offer

ALTER TABLE "subcon_offer"
  ADD COLUMN "expires_at" TIMESTAMPTZ(6),
  ADD COLUMN "viewed_at" TIMESTAMPTZ(6),
  ADD COLUMN "responded_at" TIMESTAMPTZ(6),
  ADD COLUMN "responded_via" TEXT,
  ADD COLUMN "reject_reason_code" TEXT,
  ADD COLUMN "reject_note" TEXT,
  ADD COLUMN "accepted_plate" TEXT,
  ADD COLUMN "accepted_vehicle_id" UUID,
  ADD COLUMN "accepted_driver_name" TEXT,
  ADD COLUMN "accepted_driver_phone" TEXT,
  ADD COLUMN "accepted_driver_id" UUID;

-- ข้อเสนอเดิม: หมดเวลาตอบ = เวลาเสนอ + 48 ชม. (docs/01 §4.2)
UPDATE "subcon_offer" SET "expires_at" = "offered_at" + interval '48 hours' WHERE "expires_at" IS NULL;

ALTER TABLE "subcon_offer" ADD CONSTRAINT "subcon_offer_accepted_vehicle_id_fkey"
  FOREIGN KEY ("accepted_vehicle_id") REFERENCES "vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subcon_offer" ADD CONSTRAINT "subcon_offer_accepted_driver_id_fkey"
  FOREIGN KEY ("accepted_driver_id") REFERENCES "driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- คำตอบ: ช่องทาง LINK (รถร่วมผ่านลิงก์) / USER (ผู้จัดรถบันทึกแทน) · ปฏิเสธผ่านลิงก์ต้องมีรหัสเหตุผล (PLN-151)
-- เหตุผลปฏิเสธมีได้เฉพาะข้อเสนอที่ปฏิเสธ · ทะเบียน/คนขับที่รับมีได้เฉพาะที่รับแล้ว (หรือถอนหลังรับ — ยกเลิกเที่ยว)
ALTER TABLE "subcon_offer" ADD CONSTRAINT "subcon_offer_response" CHECK (
  ("responded_via" IS NULL OR "responded_via" IN ('LINK', 'USER'))
  AND ("responded_via" IS NULL) = ("responded_at" IS NULL)
  AND ("reject_reason_code" IS NULL OR "status" = 'REJECTED')
  AND ("status" <> 'REJECTED' OR "responded_via" IS DISTINCT FROM 'LINK' OR "reject_reason_code" IS NOT NULL)
  AND ("reject_note" IS NULL OR char_length("reject_note") <= 500)
  AND ("accepted_plate" IS NULL OR "status" IN ('ACCEPTED', 'WITHDRAWN'))
  AND ("accepted_driver_name" IS NULL OR "accepted_plate" IS NOT NULL)) NOT VALID;
ALTER TABLE "subcon_offer" VALIDATE CONSTRAINT "subcon_offer_response";

-- ลิงก์ของข้อเสนอ (หาลิงก์ที่ใช้ได้ของการจ้าง)
CREATE INDEX IF NOT EXISTS "magic_link_tenant_id_purpose_entity_id_idx" ON "magic_link"("tenant_id", "purpose", "entity_id");

SELECT tms_enable_tenant_rls('subcon_offer');
