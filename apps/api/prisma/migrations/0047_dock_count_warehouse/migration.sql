-- ST2-T09 review: ช่องโหลด (dock_count) มีเฉพาะสถานที่ชนิดคลัง (WAREHOUSE)
-- แถวเดิมที่ไม่ใช่คลังแต่มีค่า → ล้างเป็น NULL ก่อนเพิ่ม CHECK (ค่าที่ไม่มีความหมายสำหรับจุดรับ/ส่ง)
SET row_security = off;
UPDATE "customer_site" SET "dock_count" = NULL WHERE "kind" <> 'WAREHOUSE' AND "dock_count" IS NOT NULL;
ALTER TABLE "customer_site" ADD CONSTRAINT "customer_site_dock_count_warehouse" CHECK ("dock_count" IS NULL OR "kind" = 'WAREHOUSE');
RESET row_security;
