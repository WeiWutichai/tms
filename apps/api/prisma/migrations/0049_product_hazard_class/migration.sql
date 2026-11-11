-- review ST2-T10 #7: class สินค้าอันตรายรับเฉพาะ class/division ของระบบ UN
-- 1.1–1.6, 2.1–2.3, 3, 4.1–4.3, 5.1–5.2, 6.1–6.2, 7, 8, 9 (ตรงกับ HAZARD_CLASSES ใน product.dto.ts)

-- pre-check: ข้อมูลเดิมที่ไม่ผ่านกฎใหม่ → หยุดพร้อมข้อความ (ไม่แก้ข้อมูลเงียบ ๆ)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM "product"
     WHERE "hazard_class" IS NOT NULL
       AND "hazard_class" !~ '^(1\.[1-6]|2\.[1-3]|3|4\.[1-3]|5\.[12]|6\.[12]|7|8|9)$'
  ) THEN
    RAISE EXCEPTION 'product.hazard_class has values outside the UN class list — fix them before migrating';
  END IF;
END $$;

ALTER TABLE "product" DROP CONSTRAINT "product_hazard_check";
ALTER TABLE "product" ADD CONSTRAINT "product_hazard_check" CHECK (
  ("hazardous" AND "un_number" ~ '^[0-9]{4}$'
    AND "hazard_class" ~ '^(1\.[1-6]|2\.[1-3]|3|4\.[1-3]|5\.[12]|6\.[12]|7|8|9)$')
  OR (NOT "hazardous" AND "un_number" IS NULL AND "hazard_class" IS NULL)
);
