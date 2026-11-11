-- ST2-T02 (review): คำค้นของสถานที่สร้างจากฐานข้อมูลเอง (ไม่ให้แอปเขียน → ไม่คลาดกัน) + FK ลูกค้า

ALTER TABLE "customer_site" ADD COLUMN "address_search" TEXT NOT NULL DEFAULT '';

-- alias_search = aliases ตัวเล็ก ครอบ/คั่นด้วย \n (contains `\nค่า\n` = ตรงตัว, contains `ค่า` = บางส่วน)
-- address_search = ที่อยู่บรรทัดแรก + ช่องแยก ตัวเล็ก (ค้นไม่สนตัวพิมพ์)
CREATE OR REPLACE FUNCTION tms_customer_site_search() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.alias_search := CASE WHEN cardinality(NEW.aliases) > 0
    THEN E'\n' || lower(array_to_string(NEW.aliases, E'\n')) || E'\n' ELSE '' END;
  NEW.address_search := lower(concat_ws(' ',
    NEW.address->>'line1', NEW.address->>'line2', NEW.address->>'subdistrict',
    NEW.address->>'district', NEW.address->>'province', NEW.address->>'postcode'));
  RETURN NEW;
END $$;

CREATE TRIGGER customer_site_search
  BEFORE INSERT OR UPDATE ON "customer_site"
  FOR EACH ROW EXECUTE FUNCTION tms_customer_site_search();

-- เติมค่าแถวเดิม (trigger ทำงานตอน UPDATE)
UPDATE "customer_site" SET "aliases" = "aliases";

-- ลูกค้าที่อ้างถึงต้องมีจริง (ไม่มีลบจริงอยู่แล้ว — RESTRICT กันพลาด)
ALTER TABLE "customer_site" ADD CONSTRAINT "customer_site_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

SELECT tms_enable_tenant_rls('customer_site');
