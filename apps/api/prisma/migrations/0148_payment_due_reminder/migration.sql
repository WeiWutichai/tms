-- ST5-T22 เตือนครบกำหนดชำระ (spec/05 BIL-121: ก่อนครบกำหนด 3 วัน · วันครบกำหนด · เกิน 7 / 30 วัน — ในระบบถึงผู้ดูแลลูกค้า)
-- ใช้สมุดเตือนของ ST2-T18 (expiry_reminder) ร่วม: entity_type 'INVOICE', entity_id = invoice.id, expires_on = วันครบกำหนด,
-- level = ระดับเตือน → unique เดิมกันเตือนซ้ำต่อใบ × ระดับ × วันครบกำหนด × ผู้รับ (job รันซ้ำ/สอง worker = แถวเดียว)
-- ไม่มีตารางใหม่ (RLS ของ expiry_reminder มีอยู่แล้ว — migration 0055)
-- ย้อนกลับ: คืน CHECK เดิมไม่ได้เมื่อมีแถว entity_type 'INVOICE' แล้ว (ADD CONSTRAINT จะล้ม) — ต้องย้ายแถว INVOICE ไปที่อื่นก่อน
-- (ห้ามลบประวัติการเตือน) จึงถือว่า migration นี้ไปทางเดียวหลังมีการเตือนจริง

ALTER TABLE "expiry_reminder" DROP CONSTRAINT "expiry_reminder_entity_type_chk";
ALTER TABLE "expiry_reminder" ADD CONSTRAINT "expiry_reminder_entity_type_chk"
  CHECK ("entity_type" IN ('VEHICLE_DOCUMENT', 'DRIVER_LICENCE', 'RATE_CARD', 'INVOICE'));

ALTER TABLE "expiry_reminder" DROP CONSTRAINT "expiry_reminder_level_chk";
ALTER TABLE "expiry_reminder" ADD CONSTRAINT "expiry_reminder_level_chk"
  CHECK ("level" IN ('D60', 'D30', 'D7', 'EXPIRED', 'DUE_IN_3', 'DUE_TODAY', 'OVERDUE_7', 'OVERDUE_30'));
