-- ST4-T01 (review): FK ของ stop_event ไม่ตามการเปลี่ยน id ของต้นทาง (ON UPDATE RESTRICT) — แถว append-only ต้องไม่ถูกแก้โดยอ้อม
ALTER TABLE "stop_event" DROP CONSTRAINT "stop_event_trip_id_fkey";
ALTER TABLE "stop_event" ADD CONSTRAINT "stop_event_trip_id_fkey"
  FOREIGN KEY ("trip_id") REFERENCES "trip"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "stop_event" DROP CONSTRAINT "stop_event_trip_stop_same_trip_fkey";
ALTER TABLE "stop_event" ADD CONSTRAINT "stop_event_trip_stop_same_trip_fkey"
  FOREIGN KEY ("trip_stop_id", "trip_id") REFERENCES "trip_stop"("id", "trip_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "stop_event" DROP CONSTRAINT "stop_event_reason_code_id_fkey";
ALTER TABLE "stop_event" ADD CONSTRAINT "stop_event_reason_code_id_fkey"
  FOREIGN KEY ("reason_code_id") REFERENCES "reason_code"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

SELECT tms_enable_tenant_rls('stop_event');
