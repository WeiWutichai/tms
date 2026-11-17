-- ST4-T01 stop_event (docs/01 §3.9, docs/04 E1 "Stop event") — ขยายร่างของ 0004 (ไม่แก้ migration เก่า)
-- event หน้างานต่อจุดแวะ: append-only, แหล่งความจริงของเวลาถึง/ออก/ปิดงาน · ไม่มีโค้ดแอปใดเขียนตารางนี้ก่อน T01

-- แถวที่ไม่มีจุดแวะจริง = เศษจาก test ของ schema v0 (ก่อน T01 ไม่มีโค้ดแอป/seed/API ใดเขียนตารางนี้ และยังไม่มี trigger)
-- ล้างก่อนใส่ FK — ฐานที่มีข้อมูลจริงจะไม่มีแถวแบบนี้
DELETE FROM "stop_event" e WHERE NOT EXISTS (SELECT 1 FROM "trip_stop" s WHERE s."id" = e."trip_stop_id");

-- trip_id denormalize (docs/01 §3.9 "trip_id denormalize เพื่อ query") — เติมจาก trip_stop แล้วบังคับ NOT NULL
ALTER TABLE "stop_event" ADD COLUMN "trip_id" UUID;
UPDATE "stop_event" e SET "trip_id" = s."trip_id" FROM "trip_stop" s WHERE s."id" = e."trip_stop_id";
ALTER TABLE "stop_event" ALTER COLUMN "trip_id" SET NOT NULL;

-- ความแม่นของพิกัดเป็นเมตร (docs: numeric) — ทศนิยม 1 ตำแหน่ง · lat/lng numeric(9,6) ≈ 0.11 ม. (คงจาก 0004)
ALTER TABLE "stop_event" ALTER COLUMN "accuracy_m" TYPE DECIMAL(8,1) USING "accuracy_m"::DECIMAL(8,1);

-- ช่องทำบัญชีของ projection (T02 ธงขัดแย้ง, T03 apply ลง trip_stop/DO, T07 ไฟล์ POD ตามมาทีหลัง) — แก้ได้เฉพาะสามช่องนี้
ALTER TABLE "stop_event" ADD COLUMN "attachments_pending" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "stop_event" ADD COLUMN "sequence_conflict" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "stop_event" ADD COLUMN "applied_at" TIMESTAMPTZ(6);

-- FK: จุดแวะต้องอยู่ในเที่ยวเดียวกับ trip_id (unique (id, trip_id) ของ trip_stop จาก 0064) · ไม่มีการลบ → RESTRICT
ALTER TABLE "stop_event" ADD CONSTRAINT "stop_event_trip_id_fkey"
  FOREIGN KEY ("trip_id") REFERENCES "trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stop_event" ADD CONSTRAINT "stop_event_trip_stop_same_trip_fkey"
  FOREIGN KEY ("trip_stop_id", "trip_id") REFERENCES "trip_stop"("id", "trip_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "stop_event" ADD CONSTRAINT "stop_event_reason_code_id_fkey"
  FOREIGN KEY ("reason_code_id") REFERENCES "reason_code"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ค่าที่ฐานบังคับ (docs/01 §3.9 + docs/04 E1)
ALTER TABLE "stop_event" ADD CONSTRAINT "stop_event_source" CHECK ("source" IN ('APP', 'LINK', 'WEB', 'API', 'GPS'));
-- outcome: COMPLETE ต้องมี (4 ค่า) · FAIL มีได้เฉพาะ FAILED / UNDELIVERED_RETAIN · ARRIVE/DEPART ไม่มี
ALTER TABLE "stop_event" ADD CONSTRAINT "stop_event_outcome" CHECK (
  ("type" = 'COMPLETE' AND "outcome" IS NOT NULL AND "outcome" IN ('DELIVERED', 'PARTIAL', 'FAILED', 'UNDELIVERED_RETAIN'))
  OR ("type" = 'FAIL' AND ("outcome" IS NULL OR "outcome" IN ('FAILED', 'UNDELIVERED_RETAIN')))
  OR ("type" IN ('ARRIVE', 'DEPART') AND "outcome" IS NULL));
-- พิกัดมาคู่กันและอยู่ในช่วง · ความแม่นไม่ติดลบ
ALTER TABLE "stop_event" ADD CONSTRAINT "stop_event_gps" CHECK (
  ("lat" IS NULL) = ("lng" IS NULL)
  AND ("lat" IS NULL OR ("lat" BETWEEN -90 AND 90 AND "lng" BETWEEN -180 AND 180))
  AND ("accuracy_m" IS NULL OR "accuracy_m" >= 0));
ALTER TABLE "stop_event" ADD CONSTRAINT "stop_event_attachments_pending_nonneg" CHECK ("attachments_pending" >= 0);

-- หน้าติดตามรถ / timeline ของเที่ยว (docs/01 §3.9 index)
CREATE INDEX "stop_event_tenant_id_received_at_idx" ON "stop_event"("tenant_id", "received_at");
CREATE INDEX "stop_event_tenant_id_trip_id_occurred_at_idx" ON "stop_event"("tenant_id", "trip_id", "occurred_at");
CREATE INDEX "stop_event_tenant_id_reason_code_id_idx" ON "stop_event"("tenant_id", "reason_code_id");

-- append-only ทุก role (เหมือน audit_log — 0007): ห้าม DELETE · UPDATE ได้เฉพาะช่องทำบัญชีของ projection
-- (tms_app ยังถูก REVOKE UPDATE/DELETE จาก 0004 — T02/T03 GRANT UPDATE เฉพาะคอลัมน์เมื่อเริ่มใช้)
CREATE OR REPLACE FUNCTION tms_stop_event_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'stop_event is append-only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (to_jsonb(NEW) - 'attachments_pending' - 'sequence_conflict' - 'applied_at')
     IS DISTINCT FROM (to_jsonb(OLD) - 'attachments_pending' - 'sequence_conflict' - 'applied_at') THEN
    RAISE EXCEPTION 'stop_event is append-only (only attachments_pending, sequence_conflict, applied_at may change)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stop_event_append_only BEFORE UPDATE OR DELETE ON "stop_event"
  FOR EACH ROW EXECUTE FUNCTION tms_stop_event_append_only();

SELECT tms_enable_tenant_rls('stop_event');
