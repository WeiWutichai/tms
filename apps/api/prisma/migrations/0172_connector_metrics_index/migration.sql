-- ST9-T04 Dashboard เชื่อมต่อ / หน้า Health ของ Console: นับคิว ล้มเหลว lag ซิงก์ล่าสุด ต่อ connector
-- integration_outbox ไม่มี index ตาม target_id (connector) — partial index เฉพาะ sink `erp` (webhook ไม่เข้า)
-- ย้อนกลับ: DROP INDEX "integration_outbox_erp_target_idx"; (ไม่มีข้อมูลเปลี่ยน)
CREATE INDEX "integration_outbox_erp_target_idx"
  ON "integration_outbox" ("target_id", "status", "done_at") WHERE "sink" = 'erp';
