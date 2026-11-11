-- ST2-T09 เส้นทาง (OD pair) + คลัง/ต้นทาง
-- docs/04 B "เส้นทาง (route / OD pair)": ต้นทาง ปลายทาง ระยะทาง เวลามาตรฐาน ค่าผ่านทาง — key ของ rate card และจับคู่ order
-- docs/04 B "คลัง / ต้นทาง": ชื่อ ที่อยู่ พิกัด ช่องโหลด เวลาทำการ → ใช้ customer_site ชนิด WAREHOUSE (spec/02 §2 type depot/warehouse)
--   เพิ่มเฉพาะ dock_count (spec/02 §2 dockCount) — ชื่อ/ที่อยู่/พิกัด/เวลาเปิด-ปิด มีอยู่แล้ว (ST2-T02)

-- คลัง: จำนวนช่องโหลด
ALTER TABLE "customer_site" ADD COLUMN "dock_count" INTEGER;
ALTER TABLE "customer_site" ADD CONSTRAINT "customer_site_dock_count_range" CHECK ("dock_count" IS NULL OR "dock_count" BETWEEN 0 AND 999);

-- เส้นทาง
CREATE TABLE "route" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "origin_site_id" UUID NOT NULL,
    "dest_site_id" UUID NOT NULL,
    "distance_km" DECIMAL(8,1) NOT NULL,
    "standard_minutes" INTEGER,
    "toll_amount" DECIMAL(14,2),
    "notes" TEXT,
    "external_id" TEXT,
    "deleted_external_id" TEXT,
    "status" "active_status" NOT NULL DEFAULT 'ACTIVE',
    "deleted_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "route_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "route_tenant_id_origin_site_id_idx" ON "route"("tenant_id", "origin_site_id");
CREATE INDEX "route_tenant_id_dest_site_id_idx" ON "route"("tenant_id", "dest_site_id");
CREATE INDEX "route_tenant_id_updated_at_id_idx" ON "route"("tenant_id", "updated_at", "id");
CREATE UNIQUE INDEX "route_tenant_id_code_key" ON "route"("tenant_id", "code");
CREATE UNIQUE INDEX "route_tenant_id_external_id_key" ON "route"("tenant_id", "external_id");
-- รหัสไม่สนตัวพิมพ์ (MD-002) — API เก็บเป็นตัวใหญ่
CREATE UNIQUE INDEX "route_tenant_code_upper_uq" ON "route"("tenant_id", upper("code"));
-- เกณฑ์ตรวจรับ ST2-T09: คู่ต้นทาง–ปลายทางเดิมสร้างซ้ำไม่ได้ (ทิศทางมีผล; รายการที่ลบแล้วไม่นับ — ที่ปิดใช้ยังนับ ให้เปิดใช้แทนสร้างใหม่)
CREATE UNIQUE INDEX "route_tenant_od_uq" ON "route"("tenant_id", "origin_site_id", "dest_site_id") WHERE "deleted_at" IS NULL;

ALTER TABLE "route" ADD CONSTRAINT "route_origin_site_id_fkey" FOREIGN KEY ("origin_site_id") REFERENCES "customer_site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "route" ADD CONSTRAINT "route_dest_site_id_fkey" FOREIGN KEY ("dest_site_id") REFERENCES "customer_site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- กติกาที่ฐานข้อมูลบังคับ (ซ้ำกับ service — กันข้อมูลผิดจากทางอื่น)
ALTER TABLE "route" ADD CONSTRAINT "route_od_differ" CHECK ("origin_site_id" <> "dest_site_id");
ALTER TABLE "route" ADD CONSTRAINT "route_distance_range" CHECK ("distance_km" > 0);
ALTER TABLE "route" ADD CONSTRAINT "route_minutes_range" CHECK ("standard_minutes" IS NULL OR "standard_minutes" BETWEEN 1 AND 10080);
ALTER TABLE "route" ADD CONSTRAINT "route_toll_range" CHECK ("toll_amount" IS NULL OR "toll_amount" >= 0);

SELECT tms_enable_tenant_rls('route');

-- ไม่มีการลบจริง (D7 / MD-004): "ลบ" = ตั้ง deleted_at
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE DELETE ON "route" FROM tms_app';
  END IF;
END $$;
