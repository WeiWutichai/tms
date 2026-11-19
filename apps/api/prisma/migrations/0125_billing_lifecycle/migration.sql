-- ST5-T06 Lifecycle และ revert rules ของ DO (docs/04 F4) [DECISION spec/12 §3]
-- ขั้น DELIVERED → RELEASED → IN_DRAFT → INVOICED → PAID/CREDITED ยังคำนวณ (`billingStage` — ST5-T05) ไม่เก็บ
-- F4 "ทุก transition มี timestamp แยก (releasedAt, invoicedAt, paidAt)": released_at มีแล้ว (0120) · เพิ่ม invoiced_at / paid_at
-- เก็บเป็นคอลัมน์ให้ API/รายการแสดงเวลาต่อขั้นได้ตรง ๆ — aging/ครบกำหนด (ST5-T22, ST9-T06) ใช้วันที่ออก/วันครบกำหนดของ**ใบแจ้งหนี้** ไม่ใช่ invoiced_at
-- invoiced_at: ตั้งเมื่อ billing_status IN_DRAFT → INVOICED (ใบออกเลข ST5-T09) · ล้างพร้อม paid_at เมื่อดึงเข้าร่างใหม่หลังลดหนี้เต็มใบ
-- paid_at: รับชำระครบ (ST5-T22 เขียน — และต้องล้างเมื่อกลับรายการรับชำระ) · ตารางเดิมมี RLS แล้ว (ไม่มีตารางใหม่)

ALTER TABLE "delivery_order" ADD COLUMN "invoiced_at" TIMESTAMPTZ(6);
ALTER TABLE "delivery_order" ADD COLUMN "paid_at" TIMESTAMPTZ(6);
-- ชำระแล้วต้องออกใบแล้ว
ALTER TABLE "delivery_order" ADD CONSTRAINT "delivery_order_paid_check"
  CHECK ("paid_at" IS NULL OR "invoiced_at" IS NOT NULL);

-- ST5-T06 (review): event จากเครื่อง/ลิงก์ของจุดที่ DO ส่งบัญชีแล้ว/อยู่ในใบแจ้งหนี้ → รับเก็บแบบมาช้า (ไม่นับ + ธง LATE)
ALTER TABLE "stop_event" DROP CONSTRAINT "stop_event_late_reason";
ALTER TABLE "stop_event" ADD CONSTRAINT "stop_event_late_reason"
  CHECK ("late_reason" IS NULL OR "late_reason" IN ('STOP_REMOVED', 'TRIP_CANCELLED', 'TRIP_COMPLETED', 'BILLING_LOCKED'));
