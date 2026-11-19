-- ST5-T01 บรรทัดรายได้ (docs/04 F3 "Revenue line ตั้งแต่สร้าง order"; plan/05 D-25 / plan/00a RA-7 ฝั่งรายได้แยกจากต้นทุน)
-- ที่มาต่อบรรทัด (source_type/source_id): SO_CHARGE = sales_order_charge (rate card / ราคาที่กำหนดเอง) ·
-- DO_SURCHARGE = do_surcharge ที่ CONFIRMED · MANUAL = คนเพิ่มเอง (is_user_added — คงไว้เมื่อ rebuild)
-- ล็อกเมื่อเอกสารแม่ออกเลข (locked_at — ST5-T09): trigger ห้ามแก้เนื้อหา/ลบแถวที่ล็อก · ไม่คำนวณภาษีที่นี่ (ST5-T02)

-- CreateTable
CREATE TABLE "revenue_line" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "sales_order_id" UUID NOT NULL,
    "delivery_order_id" UUID,
    "line_no" INTEGER NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" UUID,
    "is_user_added" BOOLEAN NOT NULL DEFAULT false,
    "kind" "order_charge_kind" NOT NULL,
    "service_item_id" UUID NOT NULL,
    "service_item_version" INTEGER,
    "service_item_snapshot" JSONB,
    "description" TEXT NOT NULL,
    "qty" DECIMAL(18,4) NOT NULL,
    "unit_price" DECIMAL(14,2) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "vat_type" "vat_type" NOT NULL,
    "wht_rate" DECIMAL(5,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "voided_at" TIMESTAMPTZ(6),
    "voided_by" TEXT,
    "void_reason" TEXT,
    "locked_at" TIMESTAMPTZ(6),
    "locked_document_id" UUID,
    "created_by" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revenue_line_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "revenue_line_source_type_check" CHECK ("source_type" IN ('SO_CHARGE', 'DO_SURCHARGE', 'MANUAL')),
    -- MANUAL = คนเพิ่ม (ไม่มี source_id) · บรรทัดระบบต้องมี source_id · DO_SURCHARGE ต้องผูก DO
    CONSTRAINT "revenue_line_source_ref" CHECK (
      ("source_type" = 'MANUAL' AND "source_id" IS NULL AND "is_user_added")
      OR ("source_type" = 'SO_CHARGE' AND "source_id" IS NOT NULL AND NOT "is_user_added")
      OR ("source_type" = 'DO_SURCHARGE' AND "source_id" IS NOT NULL AND NOT "is_user_added" AND "delivery_order_id" IS NOT NULL)),
    CONSTRAINT "revenue_line_amount_check" CHECK ("qty" > 0 AND "unit_price" >= 0 AND "amount" >= 0),
    CONSTRAINT "revenue_line_wht_rate_check" CHECK ("wht_rate" >= 0 AND "wht_rate" <= 100),
    CONSTRAINT "revenue_line_status_check" CHECK ("status" IN ('ACTIVE', 'VOIDED')),
    -- ยกเลิกได้เฉพาะบรรทัดที่คนเพิ่ม + ผู้ยกเลิก เวลา เหตุผล ≥ 10 ตัวอักษร
    CONSTRAINT "revenue_line_void_check" CHECK (
      "status" = 'ACTIVE'
      OR ("is_user_added" AND "voided_at" IS NOT NULL AND "voided_by" IS NOT NULL AND length(btrim("void_reason")) >= 10)),
    CONSTRAINT "revenue_line_lock_check" CHECK ("locked_document_id" IS NULL OR "locked_at" IS NOT NULL)
);

-- CreateIndex
CREATE INDEX "revenue_line_tenant_id_delivery_order_id_idx" ON "revenue_line"("tenant_id", "delivery_order_id");
CREATE INDEX "revenue_line_tenant_id_service_item_id_idx" ON "revenue_line"("tenant_id", "service_item_id");
CREATE UNIQUE INDEX "revenue_line_tenant_id_sales_order_id_line_no_key" ON "revenue_line"("tenant_id", "sales_order_id", "line_no");
-- แหล่งเดียว = บรรทัดรายได้เดียว (กันนับรายได้ซ้ำ)
CREATE UNIQUE INDEX "revenue_line_source_key" ON "revenue_line"("tenant_id", "source_type", "source_id") WHERE "source_id" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "revenue_line" ADD CONSTRAINT "revenue_line_sales_order_id_fkey" FOREIGN KEY ("sales_order_id") REFERENCES "sales_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "revenue_line" ADD CONSTRAINT "revenue_line_delivery_order_id_fkey" FOREIGN KEY ("delivery_order_id") REFERENCES "delivery_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "revenue_line" ADD CONSTRAINT "revenue_line_service_item_id_fkey" FOREIGN KEY ("service_item_id") REFERENCES "service_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ล็อกหลังออกเลข (immutability hook ของ ST5-T09) — ทุก role รวม owner:
-- (1) แถวที่ล็อกแล้ว แก้ได้เฉพาะคอลัมน์ล็อก (locked_at / locked_document_id — ทางปลดของการยกเลิกใบ ST5-T10) + updated_at/version
-- (2) ลบแถวที่ล็อกไม่ได้ · ลบบรรทัดที่คนเพิ่มไม่ได้ (ใช้ VOIDED) — ลบได้เฉพาะบรรทัดระบบที่ยังไม่ล็อก (rebuild)
CREATE OR REPLACE FUNCTION tms_revenue_line_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS
$$
DECLARE
  skip text[] := ARRAY['locked_at', 'locked_document_id', 'updated_at', 'version'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.locked_at IS NOT NULL THEN
      RAISE EXCEPTION 'revenue_line % is locked (issued document) — cannot delete', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'revenue_line_locked';
    END IF;
    IF OLD.is_user_added THEN
      RAISE EXCEPTION 'revenue_line % was added by a user — void it instead of deleting', OLD.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'revenue_line_user_added';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.locked_at IS NOT NULL
     AND (to_jsonb(NEW) - skip) IS DISTINCT FROM (to_jsonb(OLD) - skip) THEN
    RAISE EXCEPTION 'revenue_line % is locked (issued document) — content cannot change', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'revenue_line_locked';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER revenue_line_guard BEFORE UPDATE OR DELETE ON "revenue_line"
  FOR EACH ROW EXECUTE FUNCTION tms_revenue_line_guard();

-- ข้อมูลเดิม: สร้างบรรทัดรายได้จากราคาของใบสั่งที่มีอยู่ + ค่าใช้จ่ายหน้างานที่ยืนยันแล้ว (ยังไม่มีใบแจ้งหนี้ — ไม่มีแถวที่ล็อก)
SET row_security = off;
INSERT INTO "revenue_line" (
  "id", "tenant_id", "sales_order_id", "delivery_order_id", "line_no", "source_type", "source_id", "is_user_added",
  "kind", "service_item_id", "service_item_version", "service_item_snapshot", "description",
  "qty", "unit_price", "amount", "vat_type", "wht_rate", "created_at", "updated_at")
SELECT gen_random_uuid(), c."tenant_id", c."sales_order_id", NULL,
       row_number() OVER (PARTITION BY c."sales_order_id" ORDER BY c."line_no")::int,
       'SO_CHARGE', c."id", false, c."kind", c."service_item_id", c."service_item_version", c."service_item_snapshot",
       c."description", c."qty", c."unit_price", c."amount", c."vat_type", c."wht_rate", now(), now()
  FROM "sales_order_charge" c;
INSERT INTO "revenue_line" (
  "id", "tenant_id", "sales_order_id", "delivery_order_id", "line_no", "source_type", "source_id", "is_user_added",
  "kind", "service_item_id", "service_item_version", "service_item_snapshot", "description",
  "qty", "unit_price", "amount", "vat_type", "wht_rate", "created_at", "updated_at")
SELECT gen_random_uuid(), s."tenant_id", d."sales_order_id", s."delivery_order_id",
       (SELECT count(*) FROM "sales_order_charge" c WHERE c."sales_order_id" = d."sales_order_id")::int
         + row_number() OVER (PARTITION BY d."sales_order_id" ORDER BY s."created_at", s."id")::int,
       'DO_SURCHARGE', s."id", false, 'ACCESSORIAL', s."service_item_id", s."service_item_version", s."service_item_snapshot",
       s."description", s."qty", s."unit_price", s."amount", s."vat_type", s."wht_rate", now(), now()
  FROM "do_surcharge" s JOIN "delivery_order" d ON d."id" = s."delivery_order_id"
 WHERE s."status" = 'CONFIRMED' AND s."qty" > 0;
RESET row_security;

SELECT tms_enable_tenant_rls('revenue_line');
