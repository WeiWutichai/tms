-- ST2-T01 (review): ลบลูกค้าแล้วปล่อย externalId (ย้ายไป deleted_external_id) ให้ระบบต้นทางส่งรายการใหม่ได้
ALTER TABLE "customer" ADD COLUMN "deleted_external_id" TEXT;

-- รหัสเก็บเป็นตัวใหญ่ (API แปลงให้) — unique ไม่สนตัวพิมพ์ตาม MD-002 กันกรณีเขียนตรงเข้า DB
UPDATE "customer" SET "code" = upper("code") WHERE "code" <> upper("code");
CREATE UNIQUE INDEX "customer_tenant_code_upper_uq" ON "customer"("tenant_id", upper("code"));

SELECT tms_enable_tenant_rls('customer');
