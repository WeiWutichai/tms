-- D-81 · D68-39 (PO 23 พ.ย. 2569): ชนิด event `LOADED` (ขึ้นของเสร็จ — จุดรับ) ตาม docs/01 §3.9
-- ลิงก์รถร่วมปิดจุดรับด้วย LOADED (เดิม COMPLETE outcome DELIVERED) · ไม่มี outcome (CHECK stop_event_outcome)
-- ค่าใหม่ของ enum ใช้ใน transaction เดียวกันไม่ได้ → CHECK เทียบแบบข้อความ (::text)
ALTER TYPE "stop_event_type" ADD VALUE IF NOT EXISTS 'LOADED' BEFORE 'COMPLETE';

ALTER TABLE "stop_event" DROP CONSTRAINT "stop_event_outcome";
ALTER TABLE "stop_event" ADD CONSTRAINT "stop_event_outcome" CHECK (
  ("type"::text = 'COMPLETE' AND "outcome" IS NOT NULL AND "outcome" IN ('DELIVERED', 'PARTIAL', 'FAILED', 'UNDELIVERED_RETAIN'))
  OR ("type"::text = 'FAIL' AND ("outcome" IS NULL OR "outcome" IN ('FAILED', 'UNDELIVERED_RETAIN')))
  OR ("type"::text IN ('ARRIVE', 'DEPART', 'LOADED') AND "outcome" IS NULL));
