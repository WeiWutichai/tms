-- D-71 (PO 22 พ.ย. 2569) แจ้ง "DO ยังไม่วางบิลเกิน N วัน" ทุกเช้าที่ยังมีใบค้าง — สมุดเตือนเปลี่ยนเป็น 1 แถว/ผู้รับ/วัน
-- ใช้ expiry_reminder ร่วม: entity_type 'TENANT', entity_id = tenant_id, level 'UNBILLED_DAILY', expires_on = sent_on = วันที่ส่ง
-- → unique เดิม (tenant, entity_type, entity_id, expires_on, level, recipient) กันส่งซ้ำวันเดียวกัน (job ลองใหม่ / สอง worker)
-- แถวแบบเดิม ('DELIVERY_ORDER' / 'UNBILLED' ต่อ DO — migration 0153) คงไว้ (ห้ามลบประวัติการเตือน) และยังนับเป็น "ส่งแล้ววันนั้น"
-- ไม่มีตารางใหม่ (RLS ของ expiry_reminder มีอยู่แล้ว — migration 0055)
-- ย้อนกลับ: คืน CHECK ของ 0153 ไม่ได้เมื่อมีแถว 'TENANT' / 'UNBILLED_DAILY' แล้ว — ต้องย้ายแถวไปที่อื่นก่อน

ALTER TABLE "expiry_reminder" DROP CONSTRAINT "expiry_reminder_entity_type_chk";
ALTER TABLE "expiry_reminder" ADD CONSTRAINT "expiry_reminder_entity_type_chk"
  CHECK ("entity_type" IN ('VEHICLE_DOCUMENT', 'DRIVER_LICENCE', 'RATE_CARD', 'INVOICE', 'DELIVERY_ORDER', 'TENANT'));

ALTER TABLE "expiry_reminder" DROP CONSTRAINT "expiry_reminder_level_chk";
ALTER TABLE "expiry_reminder" ADD CONSTRAINT "expiry_reminder_level_chk"
  CHECK ("level" IN ('D60', 'D30', 'D7', 'EXPIRED', 'DUE_IN_3', 'DUE_TODAY', 'OVERDUE_7', 'OVERDUE_30', 'UNBILLED', 'UNBILLED_DAILY'));
