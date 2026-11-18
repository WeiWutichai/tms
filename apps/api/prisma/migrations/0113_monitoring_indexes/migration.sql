-- ST9-T19 (review M1/M2): index บางส่วนให้ตัวเก็บ metrics/evaluator (ทุก 1 นาที) ไม่ไล่ทั้งตารางประวัติ
-- ทุกตัวเป็น partial index เฉพาะแถวที่ query ใช้ — ประวัติที่จบแล้ว (DONE / SUCCEEDED / PROCESSED / SENT) ไม่เข้า index

-- webhook ขาเข้าที่ยังไม่ประมวลผล (inbound_stuck)
CREATE INDEX "processed_webhook_event_received_open_idx"
  ON "processed_webhook_event" ("received_at") WHERE "status" = 'RECEIVED';

-- outbox dead-letter ใน 24 ชม. ต่อ sink (tms_outbox_commands{state="failed_final_24h"})
CREATE INDEX "integration_outbox_failed_final_idx"
  ON "integration_outbox" ("updated_at", "sink") WHERE "status" = 'FAILED_FINAL';

-- job ล้มครั้งสุดท้ายในช่วงกฎ job_failed
CREATE INDEX "job_failed_finished_idx"
  ON "job" ("finished_at") WHERE "status" = 'FAILED';

-- อีเมลที่เลิกส่งใน 1 ชม.
CREATE INDEX "email_outbox_failed_updated_idx"
  ON "email_outbox" ("updated_at") WHERE "status" = 'FAILED';
