-- ST5-T01b บรรทัดรายได้ต่อ DO ตามปริมาณส่งจริง (PO ตัดสิน 19 พ.ย. 2569 — docs/01 §3.3 `revenue_amount` = snapshot × ปริมาณจริงของ DO)
-- (1) ธง provisional: ยอดยังไม่ยืนยัน (ใบสั่งยังไม่มี DO / DO ยังไม่บันทึกยอดส่งจริง) — คิดใหม่เมื่อบันทึกยอดส่งจริง
-- (2) แหล่งเดียว = บรรทัดที่ยังใช้บรรทัดเดียว **ต่อ DO**: SO_CHARGE หนึ่งบรรทัดแบ่งลงได้หลาย DO (แหล่ง = บรรทัดราคา + DO)
-- (3) ข้อมูลเดิม: บรรทัด SO_CHARGE ระดับใบสั่ง (ยังไม่มี DO) ที่ยังใช้ = provisional
--     การย้ายบรรทัดระดับใบสั่งลง DO (VOIDED + สร้างต่อ DO) ต้องใช้ pricing engine → ทำในขั้น bootstrap `revenue-lines-per-do`
--     (`pnpm --filter @tms/api db:migrate` รันต่อจาก migrate ทุกครั้ง — idempotent) · บรรทัดที่ล็อกไม่แตะ

ALTER TABLE "revenue_line" ADD COLUMN "provisional" BOOLEAN NOT NULL DEFAULT false;

DROP INDEX "revenue_line_source_key";
CREATE UNIQUE INDEX "revenue_line_source_key" ON "revenue_line"(
  "tenant_id", "source_type", "source_id", COALESCE("delivery_order_id", '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE "source_id" IS NOT NULL AND "status" = 'ACTIVE';

SET row_security = off;
UPDATE "revenue_line" SET "provisional" = true
 WHERE "source_type" = 'SO_CHARGE' AND "delivery_order_id" IS NULL AND "status" = 'ACTIVE' AND "locked_at" IS NULL;
RESET row_security;
