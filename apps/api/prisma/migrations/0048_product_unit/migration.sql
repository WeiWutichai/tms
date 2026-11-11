-- ST2-T10 สินค้า / หน่วย (docs/04 B "สินค้า / หน่วย": รหัส ชื่อ หน่วย น้ำหนัก/ปริมาตร อุณหภูมิ สินค้าอันตราย externalId)
-- รายละเอียดฟิลด์ตาม spec/02 §3 (Unit + Product + altUnits) — docs/01 ไม่มีตารางสินค้า (sales_order_line เก็บข้อความ/ค่า snapshot)
-- อุณหภูมิใช้หน่วย/ความละเอียดเดียวกับ vehicle_type.temp_min_c/temp_max_c (numeric(4,1) °C) → ST2-T16 เทียบตรงได้ (MD-072)

-- CreateTable
CREATE TABLE "unit" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name_th" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "to_kg" DECIMAL(14,6),
    "to_cbm" DECIMAL(14,6),
    "system_key" TEXT,
    "status" "active_status" NOT NULL DEFAULT 'ACTIVE',
    "deleted_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name_th" TEXT NOT NULL,
    "customer_id" UUID,
    "base_unit_id" UUID NOT NULL,
    "weight_per_unit_kg" DECIMAL(12,3),
    "volume_per_unit_cbm" DECIMAL(12,4),
    "fragile" BOOLEAN NOT NULL DEFAULT false,
    "hazardous" BOOLEAN NOT NULL DEFAULT false,
    "un_number" TEXT,
    "hazard_class" TEXT,
    "temp_controlled" BOOLEAN NOT NULL DEFAULT false,
    "temp_min_c" DECIMAL(4,1),
    "temp_max_c" DECIMAL(4,1),
    "stackable" BOOLEAN NOT NULL DEFAULT true,
    "barcode" TEXT,
    "external_id" TEXT,
    "deleted_external_id" TEXT,
    "status" "active_status" NOT NULL DEFAULT 'ACTIVE',
    "deleted_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_alt_unit" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "unit_id" UUID NOT NULL,
    "factor_to_base" DECIMAL(14,6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_alt_unit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "unit_tenant_id_updated_at_id_idx" ON "unit"("tenant_id", "updated_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "unit_tenant_id_code_key" ON "unit"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "unit_tenant_id_system_key_key" ON "unit"("tenant_id", "system_key");

-- CreateIndex
CREATE INDEX "product_tenant_id_customer_id_idx" ON "product"("tenant_id", "customer_id");

-- CreateIndex
CREATE INDEX "product_tenant_id_base_unit_id_idx" ON "product"("tenant_id", "base_unit_id");

-- CreateIndex
CREATE INDEX "product_tenant_id_updated_at_id_idx" ON "product"("tenant_id", "updated_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "product_tenant_id_code_key" ON "product"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "product_tenant_id_external_id_key" ON "product"("tenant_id", "external_id");

-- CreateIndex
CREATE INDEX "product_alt_unit_tenant_id_unit_id_idx" ON "product_alt_unit"("tenant_id", "unit_id");

-- CreateIndex
CREATE UNIQUE INDEX "product_alt_unit_product_id_unit_id_key" ON "product_alt_unit"("product_id", "unit_id");

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product" ADD CONSTRAINT "product_base_unit_id_fkey" FOREIGN KEY ("base_unit_id") REFERENCES "unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_alt_unit" ADD CONSTRAINT "product_alt_unit_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_alt_unit" ADD CONSTRAINT "product_alt_unit_unit_id_fkey" FOREIGN KEY ("unit_id") REFERENCES "unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- รหัสไม่สนตัวพิมพ์ (MD-002) — API เก็บเป็นตัวใหญ่
CREATE UNIQUE INDEX "unit_tenant_code_upper_uq" ON "unit"("tenant_id", upper("code"));
CREATE UNIQUE INDEX "product_tenant_code_upper_uq" ON "product"("tenant_id", upper("code"));
-- ชื่อหน่วยห้ามซ้ำ (ไม่สนตัวพิมพ์; ที่ลบแล้วไม่นับ)
CREATE UNIQUE INDEX "unit_tenant_name_lower_uq" ON "unit"("tenant_id", lower("name_th")) WHERE "deleted_at" IS NULL;

-- กติกาที่ฐานข้อมูลบังคับ (ซ้ำกับ service — กันข้อมูลผิดจากทางอื่น)
ALTER TABLE "unit" ADD CONSTRAINT "unit_kind_check" CHECK ("kind" IN ('COUNT', 'WEIGHT', 'VOLUME'));
ALTER TABLE "unit" ADD CONSTRAINT "unit_factor_check" CHECK (
  ("kind" = 'COUNT' AND "to_kg" IS NULL AND "to_cbm" IS NULL)
  OR ("kind" = 'WEIGHT' AND "to_kg" > 0 AND "to_cbm" IS NULL)
  OR ("kind" = 'VOLUME' AND "to_cbm" > 0 AND "to_kg" IS NULL)
);
ALTER TABLE "product" ADD CONSTRAINT "product_weight_check" CHECK ("weight_per_unit_kg" IS NULL OR "weight_per_unit_kg" > 0);
ALTER TABLE "product" ADD CONSTRAINT "product_volume_check" CHECK ("volume_per_unit_cbm" IS NULL OR "volume_per_unit_cbm" >= 0);
ALTER TABLE "product" ADD CONSTRAINT "product_hazard_check" CHECK (
  ("hazardous" AND "un_number" ~ '^[0-9]{4}$' AND "hazard_class" ~ '^[1-9](\.[1-6])?$')
  OR (NOT "hazardous" AND "un_number" IS NULL AND "hazard_class" IS NULL)
);
ALTER TABLE "product" ADD CONSTRAINT "product_temp_check" CHECK (
  ("temp_controlled" AND "temp_min_c" IS NOT NULL AND "temp_max_c" IS NOT NULL
    AND "temp_min_c" >= -40 AND "temp_max_c" <= 30 AND "temp_min_c" < "temp_max_c")
  OR (NOT "temp_controlled" AND "temp_min_c" IS NULL AND "temp_max_c" IS NULL)
);
ALTER TABLE "product_alt_unit" ADD CONSTRAINT "product_alt_unit_factor_check" CHECK ("factor_to_base" > 0);

SELECT tms_enable_tenant_rls('unit');
SELECT tms_enable_tenant_rls('product');
SELECT tms_enable_tenant_rls('product_alt_unit');

-- ไม่มีการลบจริง (D7 / MD-004) ของข้อมูลหลัก: "ลบ" = ตั้ง deleted_at
-- product_alt_unit เป็นรายการลูกที่แทนทั้งชุดเมื่อแก้สินค้า (ประวัติอยู่ใน audit ของ product) — ลบแถวได้
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE DELETE ON "unit" FROM tms_app';
    EXECUTE 'REVOKE DELETE ON "product" FROM tms_app';
  END IF;
END $$;
