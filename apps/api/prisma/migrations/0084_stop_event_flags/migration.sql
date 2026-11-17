-- ST4-T02 server idempotent + ลำดับ + ธงขัดแย้ง (docs/04 E1 "Idempotent server", docs/01 §3.9, spec/04 DRV-072/075)

-- ธงที่กำหนดตอนรับ (ไม่เปลี่ยนภายหลัง — trigger append-only ของ 0082 ไม่ยอมให้แก้สองช่องนี้)
-- clock_skew: occurred_at เพี้ยนจาก received_at (อนาคต > 5 นาที / ย้อนหลัง > 24 ชม.) — ธงอย่างเดียว ไม่แก้เวลา
-- late_reason: event มาหลังจุดถูกถอด / เที่ยวยกเลิก / เที่ยวจบ — รับเก็บเป็นประวัติ ไม่นับจนกว่า dispatcher ยอมรับ
ALTER TABLE "stop_event" ADD COLUMN "clock_skew" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "stop_event" ADD COLUMN "late_reason" TEXT;
ALTER TABLE "stop_event" ADD CONSTRAINT "stop_event_late_reason"
  CHECK ("late_reason" IS NULL OR "late_reason" IN ('STOP_REMOVED', 'TRIP_CANCELLED', 'TRIP_COMPLETED'));

-- หน้า ศูนย์ข้อยกเว้น: event ที่มีธง เรียงตามเวลารับ
CREATE INDEX "stop_event_flagged_idx" ON "stop_event"("tenant_id", "received_at" DESC)
  WHERE "sequence_conflict" OR "clock_skew" OR "late_reason" IS NOT NULL;

-- role แอปคำนวณ sequence_conflict ใหม่ทุกครั้งที่ลำดับของจุดเปลี่ยน (คอลัมน์เดียว — applied_at/attachments_pending = T03/T07)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'GRANT UPDATE (sequence_conflict) ON stop_event TO tms_app';
  END IF;
END $$;

-- การตัดสินของ dispatcher ต่อ event ที่มีธง — แถวใหม่ + เหตุผล (ไม่ใช่พลิกธง) · 1 event ตัดสินได้ครั้งเดียว · append-only
CREATE TABLE "stop_event_resolution" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "stop_event_id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "flags" TEXT[] NOT NULL,
    "resolved_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "stop_event_resolution_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "stop_event_resolution_decision" CHECK ("decision" IN ('ACCEPT', 'IGNORE')),
    CONSTRAINT "stop_event_resolution_reason_len" CHECK (char_length(btrim("reason")) >= 10)
);
CREATE UNIQUE INDEX "stop_event_resolution_tenant_id_stop_event_id_key" ON "stop_event_resolution"("tenant_id", "stop_event_id");
CREATE INDEX "stop_event_resolution_tenant_id_created_at_idx" ON "stop_event_resolution"("tenant_id", "created_at");
CREATE INDEX "stop_event_resolution_tenant_id_trip_id_idx" ON "stop_event_resolution"("tenant_id", "trip_id");
ALTER TABLE "stop_event_resolution" ADD CONSTRAINT "stop_event_resolution_stop_event_id_fkey"
  FOREIGN KEY ("stop_event_id") REFERENCES "stop_event"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "stop_event_resolution" ADD CONSTRAINT "stop_event_resolution_trip_id_fkey"
  FOREIGN KEY ("trip_id") REFERENCES "trip"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE OR REPLACE FUNCTION tms_stop_event_resolution_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'stop_event_resolution is append-only' USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER stop_event_resolution_append_only BEFORE UPDATE OR DELETE ON "stop_event_resolution"
  FOR EACH ROW EXECUTE FUNCTION tms_stop_event_resolution_append_only();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON stop_event_resolution FROM tms_app';
  END IF;
END $$;

SELECT tms_enable_tenant_rls('stop_event_resolution');
