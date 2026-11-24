-- D-71 (PO 24 พ.ย. 2569 — ข้อ #82): อายุ "ร่างใบแจ้งหนี้ค้างเกิน N วัน" นับจากวันแรกที่ DO เข้าร่างใดก็ได้
-- (ย้ายไปร่างอื่น / ถอดแล้วใส่ใหม่ ไม่เริ่มนับใหม่) — เขียนตอน billing event `draft` เมื่อยังว่าง ไม่เขียนทับ
-- [DECISION lead 24 พ.ย.] ล้างเมื่อออกเอกสาร (billing event `invoice`) — ยกเลิก/ลดหนี้แล้วเข้าร่างใหม่ = เริ่มนับใหม่
-- delivery_order มี tenant_id + RLS อยู่แล้ว (เพิ่มคอลัมน์เท่านั้น)
-- ย้อนกลับ: ALTER TABLE "delivery_order" DROP COLUMN "first_drafted_at";
ALTER TABLE "delivery_order" ADD COLUMN "first_drafted_at" TIMESTAMPTZ(6);

-- ค่าจากข้อมูลเดิม (เฉพาะ DO ที่อยู่ในร่างตอนนี้): เวลาสร้างบรรทัดหลัก (do_anchor) แรกสุดของ DO ในใบที่ไม่เคยออกเลข
-- (บรรทัดไม่ถูกลบ — ถอดออก = active false · ใบที่ออกเลขแล้ว = รอบวางบิลก่อน ไม่นับ)
-- อ่าน/เขียนข้ามทุก tenant (migration เป็นเจ้าของตาราง) — แบบเดียวกับ 0116/0117/0159
SET row_security = off;
UPDATE "delivery_order" d
   SET "first_drafted_at" = f.first_at
  FROM (SELECT l."delivery_order_id" AS id, min(l."created_at") AS first_at
          FROM "invoice_line" l
          JOIN "invoice" i ON i."id" = l."invoice_id" AND i."invoice_no" IS NULL
         WHERE l."do_anchor" AND l."delivery_order_id" IS NOT NULL
         GROUP BY l."delivery_order_id") f
 WHERE d."id" = f.id AND d."first_drafted_at" IS NULL
   AND d."billing_status" = 'IN_DRAFT';
RESET row_security;

-- #89 (PO 24 พ.ย. 2569 "ให้กำหนดได้ว่าต้องการให้ล่าช้าเท่าไหร่"): หน่วงเวลาอ่านเอกสารกลับมาเทียบรอบ AFTER_PUSH ต่อ connector (นาที)
-- 0 = ทันที (docs/01 §6.5 — worker ตรวจทุก 1 นาที) · สูงสุด 1440 (1 วัน) · connector มี tenant_id + RLS อยู่แล้ว
-- ย้อนกลับ: ALTER TABLE "connector" DROP COLUMN "after_push_reconcile_delay_min";
ALTER TABLE "connector" ADD COLUMN "after_push_reconcile_delay_min" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "connector" ADD CONSTRAINT "connector_after_push_reconcile_delay_min_check"
  CHECK ("after_push_reconcile_delay_min" BETWEEN 0 AND 1440);
