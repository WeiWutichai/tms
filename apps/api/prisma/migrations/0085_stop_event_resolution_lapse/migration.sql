-- ST4-T02 แก้ตาม review: การตัดสินหมดผลเมื่อชุดธงของ event เปลี่ยน (หลักเดียวกับการยืนยันคำเตือน ST3-T14)
-- → 1 event มีการตัดสินได้หลายแถว (ตัดสินใหม่เมื่อธงเปลี่ยน) · stop_event.resolution_id = การตัดสินที่มีผลตอนนี้ (projection)

DROP INDEX "stop_event_resolution_tenant_id_stop_event_id_key";
CREATE INDEX "stop_event_resolution_tenant_id_stop_event_id_created_at_idx"
  ON "stop_event_resolution"("tenant_id", "stop_event_id", "created_at");

ALTER TABLE "stop_event" ADD COLUMN "resolution_id" UUID;
ALTER TABLE "stop_event" ADD CONSTRAINT "stop_event_resolution_id_fkey"
  FOREIGN KEY ("resolution_id") REFERENCES "stop_event_resolution"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
CREATE INDEX "stop_event_resolution_id_idx" ON "stop_event"("resolution_id");

-- append-only: ช่อง projection ที่แก้ได้ += resolution_id
CREATE OR REPLACE FUNCTION tms_stop_event_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'stop_event is append-only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (to_jsonb(NEW) - 'attachments_pending' - 'sequence_conflict' - 'applied_at' - 'resolution_id')
     IS DISTINCT FROM (to_jsonb(OLD) - 'attachments_pending' - 'sequence_conflict' - 'applied_at' - 'resolution_id') THEN
    RAISE EXCEPTION 'stop_event is append-only (only attachments_pending, sequence_conflict, applied_at, resolution_id may change)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'GRANT UPDATE (resolution_id) ON stop_event TO tms_app';
  END IF;
END $$;

-- การตัดสินที่มีอยู่ (ก่อน 0085 = 1 แถวต่อ event) ถือว่ามีผล ถ้าธงยังตรง — ระบบคำนวณใหม่ทุกครั้งที่มี event/การตัดสินของจุด
UPDATE "stop_event" e SET "resolution_id" = r."id"
  FROM "stop_event_resolution" r
 WHERE r."stop_event_id" = e."id";
