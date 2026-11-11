-- ST2-T03: geocode อัตโนมัติ + คนยืนยัน — พิกัดที่ผู้ให้บริการเสนอเก็บแยกจาก lat/lng จนกว่าคนยืนยัน
-- geocode_status คงค่า OK/PENDING/FAILED ตาม docs/01 §3.2: PENDING + มี geocode_lat = "รอยืนยันพิกัด"

ALTER TABLE "customer_site" ADD COLUMN     "geocode_confidence" DECIMAL(3,2),
ADD COLUMN     "geocode_lat" DECIMAL(9,6),
ADD COLUMN     "geocode_lng" DECIMAL(9,6),
ADD COLUMN     "geocode_provider" TEXT,
ADD COLUMN     "geocoded_at" TIMESTAMPTZ(6);

-- พิกัดเสนอมาคู่กัน, ความมั่นใจ 0–1, มีพิกัดจริงแล้วไม่ค้างพิกัดเสนอ (ยืนยัน/ปักเอง = ล้างข้อเสนอ)
ALTER TABLE "customer_site"
  ADD CONSTRAINT "customer_site_geocode_pair_chk" CHECK (("geocode_lat" IS NULL) = ("geocode_lng" IS NULL)),
  ADD CONSTRAINT "customer_site_geocode_conf_chk" CHECK ("geocode_confidence" IS NULL OR ("geocode_confidence" >= 0 AND "geocode_confidence" <= 1)),
  ADD CONSTRAINT "customer_site_geocode_proposal_chk" CHECK ("geocode_lat" IS NULL OR ("lat" IS NULL AND "geocode_status" = 'PENDING'));

-- ตัวกรอง/สรุป "รอยืนยัน" และ "หาพิกัดไม่พบ" บนหน้ารายการ
CREATE INDEX "customer_site_tenant_geocode_idx" ON "customer_site"("tenant_id", "geocode_status");

SELECT tms_enable_tenant_rls('customer_site');
