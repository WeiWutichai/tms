-- ST2-T12 (review): ธง "แสดงบน tracking" ใช้ได้เฉพาะเหตุผลหน้างาน (ส่งไม่สำเร็จ/ตีกลับ/ไม่เซ็นเอกสาร/ล่าช้า) — กฎเดียวกับ API
-- (TRACKING_CATEGORIES ใน reason-code.dto.ts) · แถวเดิมที่ขัดกฎถูกล้างธงก่อนใส่ CHECK
-- + "อื่น ๆ" ของระบบอยู่ท้ายหมวดเสมอ (sort_order 9999)

UPDATE "reason_code"
   SET "show_on_tracking" = false, "version" = "version" + 1, "updated_at" = now()
 WHERE "show_on_tracking"
   AND "category"::text NOT IN ('DELIVERY_FAILED', 'REJECTED_BY_RECEIVER', 'POD_MISSING', 'DELAY');

UPDATE "reason_code"
   SET "sort_order" = 9999, "version" = "version" + 1, "updated_at" = now()
 WHERE "is_system" AND "code" = 'OTHER' AND "sort_order" <> 9999;

ALTER TABLE "reason_code" ADD CONSTRAINT "reason_code_show_on_tracking" CHECK (
  NOT "show_on_tracking"
  OR "category"::text IN ('DELIVERY_FAILED', 'REJECTED_BY_RECEIVER', 'POD_MISSING', 'DELAY'));
