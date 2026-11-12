-- ST2-T12 เหตุผลมาตรฐาน (reason_code): หมวด "ล่าช้า" (DELAY), แถวค่าเริ่มต้นของระบบ (system_key), ลำดับ, externalId,
-- soft delete, version — docs/01 §3.2, docs/04 B Reason master, spec/02 §9, plan/11 ข้อ 4 (รหัสใบค้าง 12 รหัสของ docs/04 C)
-- ชุดเริ่มต้นภาษาไทยไม่อยู่ใน migration — เขียนโดย bootstrap ขั้น `reason-codes` (db:migrate เรียกต่อท้ายให้ทุก tenant)
-- ธง show_on_tracking ตรวจหมวดที่ API (ใช้ค่า enum ใหม่ DELAY ใน CHECK ภายใน transaction เดียวกับ ADD VALUE ไม่ได้)

-- ตรวจก่อน (แถวเดิมจาก schema v0 ถ้ามี): ข้อมูลที่จะทำให้ index/CHECK ด้านล่างล้ม → หยุดพร้อมข้อความชัด ให้แก้ข้อมูลก่อน
DO $$
DECLARE r record;
BEGIN
  SELECT tenant_id, category, upper(code) AS c, count(*) AS n INTO r FROM "reason_code"
    GROUP BY tenant_id, category, upper(code) HAVING count(*) > 1 LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0051: reason_code มีรหัสซ้ำในหมวดเมื่อไม่สนตัวพิมพ์ (tenant %, หมวด %, รหัส %, % แถว) — แก้รหัสก่อน migrate', r.tenant_id, r.category, r.c, r.n; END IF;
  SELECT tenant_id, category, lower(label_th) AS c, count(*) AS n INTO r FROM "reason_code"
    GROUP BY tenant_id, category, lower(label_th) HAVING count(*) > 1 LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0051: reason_code มีข้อความซ้ำในหมวด (tenant %, หมวด %, "%", % แถว) — แก้ข้อความก่อน migrate', r.tenant_id, r.category, r.c, r.n; END IF;
  SELECT tenant_id, category, code INTO r FROM "reason_code" WHERE auto_reschedule AND category <> 'DELIVERY_FAILED' LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0051: reason_code นัดส่งใหม่อัตโนมัติได้เฉพาะหมวด DELIVERY_FAILED (tenant %, หมวด %, รหัส %) — แก้ก่อน migrate', r.tenant_id, r.category, r.code; END IF;
END $$;

-- AlterEnum
ALTER TYPE "reason_category" ADD VALUE IF NOT EXISTS 'DELAY';

-- AlterTable
ALTER TABLE "reason_code" ADD COLUMN     "deleted_at" TIMESTAMPTZ(6),
ADD COLUMN     "deleted_external_id" TEXT,
ADD COLUMN     "external_id" TEXT,
ADD COLUMN     "sort_order" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "system_key" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;
UPDATE "reason_code" SET "code" = upper("code") WHERE "code" <> upper("code");

-- CreateIndex
CREATE INDEX "reason_code_tenant_id_updated_at_id_idx" ON "reason_code"("tenant_id", "updated_at", "id");
CREATE UNIQUE INDEX "reason_code_tenant_id_external_id_key" ON "reason_code"("tenant_id", "external_id");
CREATE UNIQUE INDEX "reason_code_tenant_id_system_key_key" ON "reason_code"("tenant_id", "system_key");
-- ข้อความห้ามซ้ำในหมวดเดียวกัน (ไม่สนตัวพิมพ์, ไม่นับที่ลบ)
CREATE UNIQUE INDEX "reason_code_tenant_category_label_uq" ON "reason_code"("tenant_id", "category", lower("label_th")) WHERE "deleted_at" IS NULL;

-- นัดส่งใหม่อัตโนมัติใช้กับ "ส่งไม่สำเร็จ" เท่านั้น (docs/01 §3.2 auto_reschedule "สำหรับ DELIVERY_FAILED")
ALTER TABLE "reason_code" ADD CONSTRAINT "reason_code_auto_reschedule" CHECK (NOT "auto_reschedule" OR "category" = 'DELIVERY_FAILED');
-- รหัสเก็บตัวใหญ่ (unique ต่อหมวดไม่สนตัวพิมพ์)
ALTER TABLE "reason_code" ADD CONSTRAINT "reason_code_code_upper" CHECK ("code" = upper("code"));

-- ตาราง reason_code เปิด RLS แล้วตั้งแต่ 0004 (schema v0) — เรียกซ้ำได้ (idempotent)
SELECT tms_enable_tenant_rls('reason_code');

-- ไม่มีการลบจริง (D7 / MD-004): "ลบ" = ตั้ง deleted_at
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE DELETE ON "reason_code" FROM tms_app';
  END IF;
END $$;
