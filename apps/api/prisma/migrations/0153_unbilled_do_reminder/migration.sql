-- ST9-T06 แจ้งเตือน "DO ยังไม่วางบิลเกิน N วัน" ถึงผู้วางบิล (docs/04 H "ส่งให้ Invoicer อัตโนมัติ", I "DO ยังไม่วางบิล")
-- ใช้สมุดเตือนของ ST2-T18 (expiry_reminder) ร่วม: entity_type 'DELIVERY_ORDER', entity_id = delivery_order.id,
-- expires_on = วันที่ส่งถึง (เวลาไทย), level 'UNBILLED' → unique เดิมกันแจ้งซ้ำต่อ DO × วันที่ส่งถึง × ผู้รับ
-- (job รันซ้ำ/สอง worker = แถวเดียว · ย้อนผลส่งถึงแล้วส่งใหม่ = วันที่ส่งถึงใหม่ แจ้งได้อีกครั้ง)
-- ไม่มีตารางใหม่ (RLS ของ expiry_reminder มีอยู่แล้ว — migration 0055)
-- ย้อนกลับ: คืน CHECK ของ 0148 ไม่ได้เมื่อมีแถว 'DELIVERY_ORDER' / 'UNBILLED' แล้ว — ต้องย้ายแถวไปที่อื่นก่อน (ห้ามลบประวัติการเตือน)

ALTER TABLE "expiry_reminder" DROP CONSTRAINT "expiry_reminder_entity_type_chk";
ALTER TABLE "expiry_reminder" ADD CONSTRAINT "expiry_reminder_entity_type_chk"
  CHECK ("entity_type" IN ('VEHICLE_DOCUMENT', 'DRIVER_LICENCE', 'RATE_CARD', 'INVOICE', 'DELIVERY_ORDER'));

ALTER TABLE "expiry_reminder" DROP CONSTRAINT "expiry_reminder_level_chk";
ALTER TABLE "expiry_reminder" ADD CONSTRAINT "expiry_reminder_level_chk"
  CHECK ("level" IN ('D60', 'D30', 'D7', 'EXPIRED', 'DUE_IN_3', 'DUE_TODAY', 'OVERDUE_7', 'OVERDUE_30', 'UNBILLED'));
