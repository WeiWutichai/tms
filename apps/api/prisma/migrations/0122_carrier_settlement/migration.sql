-- ST6-T03 ติ๊กเที่ยว → ใบสำคัญจ่าย (settlement draft) — docs/04 F6, docs/01 §3.6 carrier_settlement / settlement_line, §4.5, spec/05 §11
-- (1) ใบสำคัญจ่ายรถร่วม 1 ใบ = รถร่วม 1 ราย หลายเที่ยว · ร่าง (DRAFT) ไม่มีเลขเอกสาร (เลข STL ออกตอนอนุมัติ — ST6-T07)
-- (2) บรรทัด FREIGHT / SURCHARGE อ้าง trip_cost 1:1 · บรรทัดหัก DEDUCTION กรอกมือ ยอดติดลบ + เอกสารอ้างอิง (BIL-134)
-- (3) กันจ่ายซ้ำระดับ DB (K11 / X11): trip_cost หนึ่งบรรทัดอยู่ในบรรทัดที่ยังใช้ (voided_at ว่าง) ได้บรรทัดเดียว — partial unique index
--     นำออก/ยกเลิกใบ = voided_at + เหตุผล (ไม่มีการลบ) → trip_cost กลับคิว
-- (4) ยอด: gross = Σ บรรทัดที่ไม่ใช่หัก · deduction_amount = Σ |บรรทัดหัก| (ค่าบวก) · net_payable = gross − deduction
--     ไม่คำนวณ VAT/WHT ในงานนี้ (ST6-T08) — บรรทัดเก็บ vat_type / wht_rate ที่คัดลอกจาก trip_cost เท่านั้น

-- CreateTable
CREATE TABLE "carrier_settlement" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "settlement_no" TEXT,
    "carrier_id" UUID NOT NULL,
    "carrier_snapshot" JSONB NOT NULL,
    "paying_company_id" UUID,
    "period_from" DATE NOT NULL,
    "period_to" DATE NOT NULL,
    "carrier_invoice_no" TEXT,
    "carrier_invoice_date" DATE,
    "carrier_receipt_no" TEXT,
    "note" TEXT,
    "gross_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "deduction_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "net_payable" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "cancelled_at" TIMESTAMPTZ(6),
    "cancelled_by" TEXT,
    "cancel_reason" TEXT,
    "created_by" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "carrier_settlement_pkey" PRIMARY KEY ("id"),
    -- สถานะเต็มตาม docs/01 §4.5 เพิ่มในงานถัดไป (ST6-T05…T09)
    CONSTRAINT "carrier_settlement_status_check" CHECK ("status" IN ('DRAFT', 'CANCELLED')),
    CONSTRAINT "carrier_settlement_period_check" CHECK ("period_from" <= "period_to"),
    CONSTRAINT "carrier_settlement_amount_check" CHECK (
      "deduction_amount" >= 0 AND "net_payable" = "gross_amount" - "deduction_amount"),
    CONSTRAINT "carrier_settlement_cancel_check" CHECK (
      "status" <> 'CANCELLED'
      OR ("cancelled_at" IS NOT NULL AND "cancelled_by" IS NOT NULL AND length(btrim("cancel_reason")) >= 10))
);

CREATE TABLE "settlement_line" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "settlement_id" UUID NOT NULL,
    "line_no" INTEGER NOT NULL,
    "line_type" TEXT NOT NULL,
    "trip_cost_id" UUID,
    "trip_id" UUID,
    "deduction_type" TEXT,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reference" TEXT,
    "vat_type" TEXT,
    "wht_rate" DECIMAL(5,2),
    "voided_at" TIMESTAMPTZ(6),
    "voided_by" TEXT,
    "void_reason" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_line_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "settlement_line_type_check" CHECK ("line_type" IN ('FREIGHT', 'SURCHARGE', 'DEDUCTION')),
    -- บรรทัดเที่ยวอ้าง trip_cost + trip · บรรทัดหัก: ไม่อ้าง trip_cost, ยอดติดลบ, มีชนิดและเอกสารอ้างอิง
    CONSTRAINT "settlement_line_ref_check" CHECK (
      ("line_type" <> 'DEDUCTION' AND "trip_cost_id" IS NOT NULL AND "trip_id" IS NOT NULL AND "deduction_type" IS NULL)
      OR ("line_type" = 'DEDUCTION' AND "trip_cost_id" IS NULL AND "amount" < 0
          AND "deduction_type" IN ('CASH_ADVANCE', 'FUEL_PROVIDED', 'FINE', 'DAMAGE')
          AND length(btrim(coalesce("reference", ''))) > 0)),
    CONSTRAINT "settlement_line_wht_rate_check" CHECK ("wht_rate" IS NULL OR ("wht_rate" >= 0 AND "wht_rate" <= 100)),
    CONSTRAINT "settlement_line_void_check" CHECK (
      "voided_at" IS NULL OR ("voided_by" IS NOT NULL AND length(btrim("void_reason")) >= 10))
);

-- CreateIndex
CREATE UNIQUE INDEX "carrier_settlement_tenant_id_settlement_no_key" ON "carrier_settlement"("tenant_id", "settlement_no") WHERE "settlement_no" IS NOT NULL;
CREATE INDEX "carrier_settlement_tenant_id_updated_at_id_idx" ON "carrier_settlement"("tenant_id", "updated_at", "id");
CREATE INDEX "carrier_settlement_tenant_id_carrier_id_status_idx" ON "carrier_settlement"("tenant_id", "carrier_id", "status");
CREATE UNIQUE INDEX "settlement_line_settlement_id_line_no_key" ON "settlement_line"("settlement_id", "line_no");
CREATE INDEX "settlement_line_tenant_id_trip_id_idx" ON "settlement_line"("tenant_id", "trip_id");
-- กันจ่ายซ้ำ (K11): trip_cost เดียวอยู่ในบรรทัดที่ยังใช้ได้บรรทัดเดียว (ทุกใบ — ใบที่ยกเลิกแล้วบรรทัดถูก void หมด)
CREATE UNIQUE INDEX "settlement_line_active_trip_cost_key" ON "settlement_line"("trip_cost_id")
  WHERE "trip_cost_id" IS NOT NULL AND "voided_at" IS NULL;

-- AddForeignKey
ALTER TABLE "carrier_settlement" ADD CONSTRAINT "carrier_settlement_carrier_id_fkey" FOREIGN KEY ("carrier_id") REFERENCES "carrier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "carrier_settlement" ADD CONSTRAINT "carrier_settlement_paying_company_id_fkey" FOREIGN KEY ("paying_company_id") REFERENCES "company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "settlement_line" ADD CONSTRAINT "settlement_line_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "carrier_settlement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "settlement_line" ADD CONSTRAINT "settlement_line_trip_cost_id_fkey" FOREIGN KEY ("trip_cost_id") REFERENCES "trip_cost"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "settlement_line" ADD CONSTRAINT "settlement_line_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

SELECT tms_enable_tenant_rls('carrier_settlement');
SELECT tms_enable_tenant_rls('settlement_line');

-- ไม่มีการลบ (นำออก/ยกเลิก = void + เหตุผล)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE DELETE ON "carrier_settlement", "settlement_line" FROM tms_app';
  END IF;
END $$;
