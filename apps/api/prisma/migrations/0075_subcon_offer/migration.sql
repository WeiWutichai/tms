-- ST3-T22 จ้างรถร่วม (docs/04 D3 "เลือก carrier + ราคาซื้อ" + "บันทึกเหตุผลการเลือก `selectionReason`"; spec/03 §8 SubconOffer ชุดย่อย)
-- subcon_offer = การจ้างรถร่วมต่อเที่ยว (ประวัติคงอยู่ — ไม่ลบ) · trip_cost เพิ่มธงภาษีของบรรทัด + อ้างการจ้าง + กลับรายการ

-- CreateEnum
CREATE TYPE "subcon_offer_status" AS ENUM ('OFFERED', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'WITHDRAWN');

-- AlterTable
ALTER TABLE "trip_cost" ADD COLUMN     "created_by" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "reversal_of_id" UUID,
ADD COLUMN     "service_item_id" UUID,
ADD COLUMN     "subcon_offer_id" UUID,
ADD COLUMN     "vat_type" TEXT,
ADD COLUMN     "wht_rate" DECIMAL(5,2);

-- CreateTable
CREATE TABLE "subcon_offer" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "trip_id" UUID NOT NULL,
    "carrier_id" UUID NOT NULL,
    "carrier_name_snapshot" TEXT NOT NULL,
    "status" "subcon_offer_status" NOT NULL DEFAULT 'OFFERED',
    "buy_amount" DECIMAL(14,2) NOT NULL,
    "price_source" TEXT NOT NULL,
    "rate_quote" JSONB NOT NULL,
    "comparison" JSONB NOT NULL,
    "selection_kind" TEXT NOT NULL,
    "selection_reason" TEXT NOT NULL,
    "vehicle_type_id" UUID,
    "sell_amount" DECIMAL(14,2),
    "offered_by" TEXT,
    "offered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(6),
    "closed_reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subcon_offer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "subcon_offer_tenant_id_trip_id_idx" ON "subcon_offer"("tenant_id", "trip_id");

-- CreateIndex
CREATE INDEX "subcon_offer_tenant_id_carrier_id_offered_at_idx" ON "subcon_offer"("tenant_id", "carrier_id", "offered_at");

-- CreateIndex
CREATE UNIQUE INDEX "trip_cost_reversal_of_id_key" ON "trip_cost"("reversal_of_id");

-- AddForeignKey
ALTER TABLE "trip_cost" ADD CONSTRAINT "trip_cost_subcon_offer_id_fkey" FOREIGN KEY ("subcon_offer_id") REFERENCES "subcon_offer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trip_cost" ADD CONSTRAINT "trip_cost_reversal_of_id_fkey" FOREIGN KEY ("reversal_of_id") REFERENCES "trip_cost"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subcon_offer" ADD CONSTRAINT "subcon_offer_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subcon_offer" ADD CONSTRAINT "subcon_offer_carrier_id_fkey" FOREIGN KEY ("carrier_id") REFERENCES "carrier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ข้อเสนอที่ใช้งานได้ครั้งละ 1 ต่อเที่ยว (รอตอบ/รับแล้ว) — จ้างใหม่ต้องปิดข้อเสนอเดิมก่อน
CREATE UNIQUE INDEX "subcon_offer_active_per_trip" ON "subcon_offer"("trip_id") WHERE "status" IN ('OFFERED', 'ACCEPTED');

-- ราคาซื้อ > 0 · ที่มาราคา/ชนิดการเลือกตามรายการ · ทุกการจ้างมีเหตุผลการเลือกไม่ว่าง (docs/04 D3 PL5) · ปิดแล้วต้องมีเวลา
ALTER TABLE "subcon_offer" ADD CONSTRAINT "subcon_offer_values" CHECK (
  "buy_amount" > 0
  AND "price_source" IN ('RATE_CARD', 'MANUAL')
  AND "selection_kind" IN ('CHEAPEST', 'OVERRIDE')
  AND char_length(btrim("selection_reason")) > 0
  AND (("status" IN ('OFFERED', 'ACCEPTED')) = ("closed_at" IS NULL)));

-- บรรทัดต้นทุน: ธงภาษีตามชุดของรายการบริการ (ServiceItemVatType / อัตรา 0, 1, 3%) · กลับรายการ = ยอดติดลบเท่านั้น
ALTER TABLE "trip_cost" ADD CONSTRAINT "trip_cost_tax_flags" CHECK (
  ("vat_type" IS NULL OR "vat_type" IN ('EXEMPT_TRANSPORT', 'VAT_7', 'ZERO_RATED'))
  AND ("wht_rate" IS NULL OR "wht_rate" IN (0, 1, 3))
  AND ("reversal_of_id" IS NULL OR "amount" < 0)) NOT VALID;
ALTER TABLE "trip_cost" VALIDATE CONSTRAINT "trip_cost_tax_flags";

SELECT tms_enable_tenant_rls('subcon_offer');

-- ประวัติการจ้างไม่ลบ (ปิดด้วยสถานะ + เหตุผล) · บรรทัดต้นทุนไม่ลบ (แก้ด้วยบรรทัดกลับรายการ)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE DELETE ON "subcon_offer" FROM tms_app';
    EXECUTE 'REVOKE DELETE ON "trip_cost" FROM tms_app';
  END IF;
END $$;
