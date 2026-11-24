-- D-71 (PO 24 พ.ย. 2569 — ข้อ #82): อายุ "ร่างใบแจ้งหนี้ค้างเกิน N วัน" นับจากวันแรกที่ DO เข้าร่างใดก็ได้
-- (ย้ายไปร่างอื่น / ถอดแล้วใส่ใหม่ ไม่เริ่มนับใหม่) — เขียนครั้งเดียวตอน billing event `draft` ครั้งแรก ไม่เขียนทับ
-- delivery_order มี tenant_id + RLS อยู่แล้ว (เพิ่มคอลัมน์เท่านั้น)
-- ย้อนกลับ: ALTER TABLE "delivery_order" DROP COLUMN "first_drafted_at";
ALTER TABLE "delivery_order" ADD COLUMN "first_drafted_at" TIMESTAMPTZ(6);

-- ค่าจากข้อมูลเดิม: เวลาสร้างบรรทัดหลัก (do_anchor) แรกสุดของ DO ในใบแจ้งหนี้ใดก็ได้ (บรรทัดไม่ถูกลบ — ถอดออก = active false)
UPDATE "delivery_order" d
   SET "first_drafted_at" = f.first_at
  FROM (SELECT "delivery_order_id" AS id, min("created_at") AS first_at
          FROM "invoice_line"
         WHERE "do_anchor" AND "delivery_order_id" IS NOT NULL
         GROUP BY "delivery_order_id") f
 WHERE d."id" = f.id AND d."first_drafted_at" IS NULL;

-- #89 (PO 24 พ.ย. 2569 "ให้กำหนดได้ว่าต้องการให้ล่าช้าเท่าไหร่"): หน่วงเวลาอ่านเอกสารกลับมาเทียบรอบ AFTER_PUSH ต่อ connector (นาที)
-- 0 = ทันที (docs/01 §6.5 — worker ตรวจทุก 1 นาที) · สูงสุด 1440 (1 วัน) · connector มี tenant_id + RLS อยู่แล้ว
-- ย้อนกลับ: ALTER TABLE "connector" DROP COLUMN "after_push_reconcile_delay_min";
ALTER TABLE "connector" ADD COLUMN "after_push_reconcile_delay_min" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "connector" ADD CONSTRAINT "connector_after_push_reconcile_delay_min_check"
  CHECK ("after_push_reconcile_delay_min" BETWEEN 0 AND 1440);
