-- ST5-T06 Lifecycle และ revert rules ของ DO (docs/04 F4) [DECISION spec/12 §3]
-- ขั้น DELIVERED → RELEASED → IN_DRAFT → INVOICED → PAID/CREDITED ยังคำนวณ (`billingStage` — ST5-T05) ไม่เก็บ
-- F4 "ทุก transition มี timestamp แยก (releasedAt, invoicedAt, paidAt)": released_at มีแล้ว (0120) · เพิ่ม invoiced_at / paid_at
-- เก็บเป็นคอลัมน์ (ไม่อ่านจาก doc_status_history) เพราะรายการ/คิว/รายงาน aging ต้องกรอง-เรียงตามเวลานี้ได้ตรง ๆ
-- invoiced_at: ตั้งเมื่อ billing_status IN_DRAFT → INVOICED (ใบออกเลข ST5-T09) · ล้างพร้อม paid_at เมื่อดึงเข้าร่างใหม่หลังลดหนี้เต็มใบ
-- paid_at: รับชำระครบ (ST5-T22 เขียน) · ตารางเดิมมี RLS แล้ว (ไม่มีตารางใหม่)

ALTER TABLE "delivery_order" ADD COLUMN "invoiced_at" TIMESTAMPTZ(6);
ALTER TABLE "delivery_order" ADD COLUMN "paid_at" TIMESTAMPTZ(6);
-- ชำระแล้วต้องออกใบแล้ว
ALTER TABLE "delivery_order" ADD CONSTRAINT "delivery_order_paid_check"
  CHECK ("paid_at" IS NULL OR "invoiced_at" IS NOT NULL);
