-- ST3-T22 (review M2): ที่มาของบรรทัดต้นทุน (แนวคิด ST6-T01 sourceType/sourceId) — บรรทัดที่เกิดจากการจ้างรถร่วม
-- = ราคาที่ตกลงแล้ว (SUBCON_OFFER) ล็อกไว้ ไม่ให้งาน rebuild บรรทัดระบบของ ST6 แก้ทับ · ST6 เพิ่มค่าอื่นใน CHECK ได้
ALTER TABLE "trip_cost" ADD COLUMN "source_type" TEXT, ADD COLUMN "source_id" UUID;

UPDATE "trip_cost" SET "source_type" = 'SUBCON_OFFER', "source_id" = "subcon_offer_id"
 WHERE "subcon_offer_id" IS NOT NULL AND "source_type" IS NULL;

ALTER TABLE "trip_cost" ADD CONSTRAINT "trip_cost_source_ref" CHECK (
  ("source_type" IS NULL AND "source_id" IS NULL)
  OR ("source_type" = 'SUBCON_OFFER' AND "source_id" IS NOT NULL AND "source_id" = "subcon_offer_id"));
