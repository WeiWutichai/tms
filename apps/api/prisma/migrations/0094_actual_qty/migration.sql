-- ST4-T10 Actual quantity + reject reason ต่อรายการ (docs/04 E2, docs/01 §3.3 delivery_order_line, §5.3 POD `lines`)

-- ตั้งต่อลูกค้า: วางบิลตามยอดส่งจริง
ALTER TABLE "customer" ADD COLUMN "bill_by_actual_qty" BOOLEAN NOT NULL DEFAULT false;

-- ยอดส่งจริงต่อบรรทัด ณ ฉบับของหลักฐานส่ง (append-only เหมือนฉบับ)
ALTER TABLE "delivery_order_pod" ADD COLUMN "lines" JSONB NOT NULL DEFAULT '[]';

-- ค่าที่ฉายลงบรรทัด DO ต้องสอดคล้องกัน (ด่านสุดท้ายหลัง domain ตรวจ)
ALTER TABLE "delivery_order_line"
  ADD CONSTRAINT "delivery_order_line_qty_actual_range"
    CHECK ("qty_actual" IS NULL OR ("qty_actual" >= 0 AND "qty_actual" <= "qty_planned")),
  ADD CONSTRAINT "delivery_order_line_reject_qty_consistent"
    CHECK ("reject_qty" IS NULL OR ("qty_actual" IS NOT NULL AND "reject_qty" = "qty_planned" - "qty_actual")),
  ADD CONSTRAINT "delivery_order_line_reject_reason_required"
    CHECK ("reject_qty" IS NULL OR "reject_qty" = 0 OR "reject_reason_code_id" IS NOT NULL);
