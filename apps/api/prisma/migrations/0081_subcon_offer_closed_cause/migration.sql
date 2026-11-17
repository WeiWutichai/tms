-- ST3-T25 (QA M1): เหตุที่ปิดการจ้าง — CARRIER_CHANGED = ผู้จัดรถเปลี่ยนผู้รับเหมา (ยกเลิกการจ้างเดิมแล้วจ้างใหม่)
-- ใช้ตัดสิน "ไม่นับเป็นถูกสุด/ไม่เลือกเป็นค่าเริ่มต้น" (hire-options priorOutcome CHANGED) — ไม่อาศัยข้อความเหตุผล

ALTER TABLE "subcon_offer" ADD COLUMN "closed_cause" TEXT;

ALTER TABLE "subcon_offer" ADD CONSTRAINT "subcon_offer_closed_cause"
  CHECK ("closed_cause" IS NULL OR ("closed_cause" IN ('CARRIER_CHANGED') AND "status" = 'WITHDRAWN'));

SELECT tms_enable_tenant_rls('subcon_offer');
