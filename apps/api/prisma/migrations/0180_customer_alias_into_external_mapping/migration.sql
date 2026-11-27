-- P1-ST5-T12 (plan/05a D68-29 — "รวม/เชื่อม customer_alias กับ external_mapping ก่อนเปิด connector ตัวที่สอง")
-- ผลจับคู่ลูกค้าที่คนสอน (ST3-T06 — เดิมตาราง customer_alias) ย้ายเข้า external_mapping เป็นแถว "alias":
--   connector_id = NULL (ผูกกับ **ช่องทาง** ไม่ใช่ connector) · entity_type = CUSTOMER · local_id = ลูกค้า ·
--   match_kind = EXTERNAL_ID / NAME · channel = ช่องทาง (`ERP:{adapter}` / `API` / `EXCEL` / `PORTAL` / `MANUAL`; NAME = '') ·
--   source_code = คีย์ที่ใช้ค้น (รหัสตรงตัว / matchKey ของชื่อ — เดิม value_key) · match_value = ข้อความตามต้นทาง (เดิม value)
-- แถว mapping ของ connector เดิมไม่เปลี่ยน (match_kind NULL + connector_id NOT NULL — CHECK ด้านล่าง)
-- ย้ายข้อมูลทุกแถว (ไม่มี tenant production — PO 22 พ.ย. 2569 — แต่ฐาน dev/UAT ที่มี alias ต้องค้นได้เหมือนเดิม) แล้วลบตารางเดิม

-- AlterTable
ALTER TABLE "external_mapping" ADD COLUMN     "channel" TEXT,
ADD COLUMN     "match_kind" TEXT,
ADD COLUMN     "match_value" TEXT,
ALTER COLUMN "connector_id" DROP NOT NULL;

-- แถว alias ⇔ ไม่มี connector · alias เป็นของลูกค้าเท่านั้น และมีช่องทาง/คีย์/ข้อความครบ · ไม่มีรหัสฝั่ง ERP
ALTER TABLE "external_mapping" ADD CONSTRAINT "external_mapping_match_kind_check"
  CHECK ("match_kind" IS NULL OR "match_kind" IN ('EXTERNAL_ID', 'NAME'));
ALTER TABLE "external_mapping" ADD CONSTRAINT "external_mapping_alias_shape_check"
  CHECK (("match_kind" IS NULL) = ("connector_id" IS NOT NULL)
     AND ("match_kind" IS NULL OR ("entity_type" = 'CUSTOMER'
          AND "channel" IS NOT NULL AND ("match_kind" = 'NAME') = ("channel" = '')
          AND "source_code" IS NOT NULL AND "match_value" IS NOT NULL
          AND length("match_value") BETWEEN 1 AND 500
          AND "external_id" IS NULL)));
ALTER TABLE "external_mapping" ADD CONSTRAINT "external_mapping_alias_cols_check"
  CHECK ("match_kind" IS NOT NULL OR ("channel" IS NULL AND "match_value" IS NULL));
-- source_code: รหัสของ connector ≤ 100 (เดิม) · คีย์ของ alias ≤ 500 (เท่ากับ customer_alias.value_key เดิม — ชื่อยาวได้)
ALTER TABLE "external_mapping" DROP CONSTRAINT "external_mapping_source_code_check";
ALTER TABLE "external_mapping" ADD CONSTRAINT "external_mapping_source_code_check"
  CHECK ("source_code" IS NULL OR (btrim("source_code") <> ''
         AND length("source_code") <= CASE WHEN "match_kind" IS NULL THEN 100 ELSE 500 END));

-- 1 คีย์ต่อ (ชนิด, ช่องทาง) ต่อ tenant — แทน unique (tenant_id, kind, source, value_key) ของ customer_alias
CREATE UNIQUE INDEX "external_mapping_alias_key" ON "external_mapping"("tenant_id", "match_kind", "channel", "source_code")
  WHERE "match_kind" IS NOT NULL;

-- ย้ายข้อมูล (id เดิม · ผู้สร้าง/เวลาเดิม) — alias = ผลที่คนตัดสินแล้ว → SYNCED
INSERT INTO "external_mapping" ("id", "tenant_id", "connector_id", "entity_type", "local_id", "source_code",
                                "match_kind", "channel", "match_value", "status", "created_by", "updated_by",
                                "created_at", "updated_at")
SELECT a."id", a."tenant_id", NULL, 'CUSTOMER', a."customer_id", a."value_key",
       a."kind", a."source", a."value", 'SYNCED', a."created_by", a."created_by",
       a."created_at", a."updated_at"
  FROM "customer_alias" a;

-- DropTable
DROP TABLE "customer_alias";
