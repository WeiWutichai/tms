-- ST2-T05 รถร่วม / ผู้รับเหมา (carrier): เลขผู้เสียภาษี (นิติบุคคล) / เลขบัตรประชาชนเข้ารหัส (บุคคลธรรมดา), ที่อยู่,
-- บัญชีธนาคาร (เลขบัญชีเข้ารหัส + 4 หลักท้าย), parent carrier, "จ้างในนาม", เพดานเที่ยว/วัน, ลำดับ, soft delete
-- docs/04 B Carrier + A3 (principal แยก ไม่นับ seat), docs/01 §3.2, spec/10 Carrier, spec/11 NFR-153/304

-- ตรวจก่อน (แถวเดิมจาก schema v0 ถ้ามี): ข้อมูลที่จะทำให้ index/CHECK ด้านล่างล้ม → หยุดพร้อมข้อความชัด
DO $$
DECLARE r record;
BEGIN
  SELECT tenant_id, upper(code) AS c, count(*) AS n INTO r FROM "carrier"
    GROUP BY tenant_id, upper(code) HAVING count(*) > 1 LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0040: carrier มีรหัสซ้ำเมื่อไม่สนตัวพิมพ์ (tenant %, รหัส %, % แถว) — แก้รหัสให้ไม่ซ้ำก่อน migrate', r.tenant_id, r.c, r.n; END IF;
  SELECT tenant_id, code, wht_rate_default, payment_term_days INTO r FROM "carrier"
    WHERE wht_rate_default NOT IN (1.00, 3.00) OR payment_term_days < 0 OR payment_term_days > 365 LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0040: carrier ค่าไม่อยู่ในช่วง (tenant %, รหัส %, WHT %, เครดิต % วัน) — WHT ต้องเป็น 1.00/3.00 เครดิต 0–365', r.tenant_id, r.code, r.wht_rate_default, r.payment_term_days; END IF;
  SELECT tenant_id, code INTO r FROM "carrier"
    WHERE bank_account_enc IS NOT NULL OR (tax_id_enc IS NOT NULL AND entity_type = 'JURISTIC') LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0040: carrier มีข้อมูลเข้ารหัสจาก schema v0 (tenant %, รหัส %) — ต้องย้ายข้อมูลด้วยมือ (ไม่มีหน้าจอสร้างมาก่อน จึงไม่ควรมี)', r.tenant_id, r.code; END IF;
  -- tax_id_last4 ต้องเป็นตัวเลข 4 หลักคู่กับเลขที่เข้ารหัส (ALTER เป็น CHAR(4) + CHECK carrier_tax_last4 ด้านล่าง)
  SELECT tenant_id, code, tax_id_last4 INTO r FROM "carrier"
    WHERE tax_id_last4 IS NOT NULL AND (tax_id_enc IS NULL OR tax_id_last4 !~ '^[0-9]{4}$') LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0040: carrier tax_id_last4 ผิด (tenant %, รหัส %, ค่า "%") — ต้องเป็นตัวเลข 4 หลักและมี tax_id_enc คู่กัน', r.tenant_id, r.code, r.tax_id_last4; END IF;
  SELECT tenant_id, code INTO r FROM "carrier"
    WHERE tax_id_enc IS NOT NULL AND tax_id_last4 IS NULL LIMIT 1;
  IF FOUND THEN RAISE EXCEPTION '0040: carrier มี tax_id_enc แต่ไม่มี tax_id_last4 (tenant %, รหัส %) — เติม 4 หลักท้ายก่อน migrate', r.tenant_id, r.code; END IF;
  -- นิติบุคคลจาก v0 ที่ไม่มีเลขผู้เสียภาษี: ผ่านได้ (CHECK อนุญาตว่างทั้งชุด) — API ให้แก้ช่องอื่นได้โดยไม่บังคับใส่เลข
END $$;

ALTER TABLE "carrier" ADD COLUMN     "address" JSONB,
ADD COLUMN     "bank_account_last4" CHAR(4),
ADD COLUMN     "bank_account_name" TEXT,
ADD COLUMN     "bank_code" TEXT,
ADD COLUMN     "billing_company_id" UUID,
ADD COLUMN     "deleted_at" TIMESTAMPTZ(6),
ADD COLUMN     "deleted_external_id" TEXT,
ADD COLUMN     "max_trips_per_day" INTEGER,
ADD COLUMN     "parent_carrier_id" UUID,
ADD COLUMN     "priority" INTEGER,
ADD COLUMN     "tax_id" CHAR(13),
ALTER COLUMN "tax_id_last4" SET DATA TYPE CHAR(4);

UPDATE "carrier" SET "code" = upper("code") WHERE "code" <> upper("code");

CREATE INDEX "carrier_tenant_id_parent_carrier_id_idx" ON "carrier"("tenant_id", "parent_carrier_id");
-- รหัสไม่สนตัวพิมพ์ (MD-002)
CREATE UNIQUE INDEX "carrier_tenant_code_upper_uq" ON "carrier"("tenant_id", upper("code"));
-- นิติบุคคล: (เลขผู้เสียภาษี, สาขา) ห้ามซ้ำ (เหมือน MD-020 ของลูกค้า) — ไม่นับที่ลบ
CREATE UNIQUE INDEX "carrier_tenant_tax_branch_uq" ON "carrier"("tenant_id", "tax_id", "branch_code")
  WHERE "deleted_at" IS NULL AND "tax_id" IS NOT NULL;

ALTER TABLE "carrier" ADD CONSTRAINT "carrier_parent_carrier_id_fkey" FOREIGN KEY ("parent_carrier_id") REFERENCES "carrier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "carrier" ADD CONSTRAINT "carrier_parent_not_self" CHECK ("parent_carrier_id" IS NULL OR "parent_carrier_id" <> "id");

-- เลขผู้เสียภาษี: นิติบุคคลเก็บเลขตรง (เปิดเผยได้) · บุคคลธรรมดาเก็บเฉพาะแบบเข้ารหัส (เลขบัตรประชาชน — PDPA)
ALTER TABLE "carrier" ADD CONSTRAINT "carrier_tax_storage" CHECK (
  ("entity_type" = 'INDIVIDUAL' AND "tax_id" IS NULL)
  OR ("entity_type" = 'JURISTIC' AND "tax_id_enc" IS NULL));
ALTER TABLE "carrier" ADD CONSTRAINT "carrier_tax_id_digits" CHECK ("tax_id" IS NULL OR "tax_id" ~ '^[0-9]{13}$');
ALTER TABLE "carrier" ADD CONSTRAINT "carrier_tax_last4" CHECK (
  ("tax_id" IS NULL AND "tax_id_enc" IS NULL AND "tax_id_last4" IS NULL)
  OR (("tax_id" IS NOT NULL OR "tax_id_enc" IS NOT NULL) AND "tax_id_last4" ~ '^[0-9]{4}$'));
ALTER TABLE "carrier" ADD CONSTRAINT "carrier_branch_code" CHECK ("branch_code" IS NULL OR "branch_code" ~ '^[0-9]{5}$');
-- บัญชีธนาคาร: ธนาคาร + เลข (เข้ารหัส) + 4 หลักท้าย + ชื่อบัญชี ครบทั้งชุดหรือว่างทั้งชุด
ALTER TABLE "carrier" ADD CONSTRAINT "carrier_bank_complete" CHECK (
  ("bank_code" IS NULL AND "bank_account_enc" IS NULL AND "bank_account_last4" IS NULL AND "bank_account_name" IS NULL)
  OR ("bank_code" IS NOT NULL AND "bank_account_enc" IS NOT NULL AND "bank_account_last4" ~ '^[0-9]{4}$' AND "bank_account_name" IS NOT NULL));
-- อัตราหัก ณ ที่จ่ายตั้งต้น: 1% ค่าขนส่ง / 3% ค่าบริการ (docs/04 F, ต้นแบบมี 2 ตัวเลือก)
ALTER TABLE "carrier" ADD CONSTRAINT "carrier_wht_rate" CHECK ("wht_rate_default" IN (1.00, 3.00));
ALTER TABLE "carrier" ADD CONSTRAINT "carrier_payment_term" CHECK ("payment_term_days" BETWEEN 0 AND 365);
ALTER TABLE "carrier" ADD CONSTRAINT "carrier_max_trips" CHECK ("max_trips_per_day" IS NULL OR "max_trips_per_day" BETWEEN 1 AND 999);
ALTER TABLE "carrier" ADD CONSTRAINT "carrier_priority" CHECK ("priority" IS NULL OR "priority" BETWEEN 1 AND 999);

-- ตาราง carrier เปิด RLS แล้วตั้งแต่ 0004 (schema v0) — เรียกซ้ำได้ (idempotent)
SELECT tms_enable_tenant_rls('carrier');

-- ไม่มีการลบจริง (D7 / MD-004): "ลบ" = ตั้ง deleted_at
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE DELETE ON "carrier" FROM tms_app';
  END IF;
END $$;
