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

-- ---------- กติการะดับ DB (ทุก role รวม owner — แบบเดียวกับ ST5-T05 invoice guard) ----------

-- บรรทัด: (1) เพิ่มได้เฉพาะใบ DRAFT และเพิ่มเป็นบรรทัดที่ยังใช้ (voided_at ว่าง) เท่านั้น
--        (2) tenant_id / settlement_id / line_no / line_type / trip_cost_id / trip_id / deduction_type / amount แก้ไม่ได้
--        (3) voided_at ทางเดียว NULL → มีค่า (นำออก/ยกเลิก) และทำได้เฉพาะเมื่อใบเป็น DRAFT · ข้อมูลการนำออกแก้ภายหลังไม่ได้
CREATE OR REPLACE FUNCTION tms_settlement_line_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS
$$
DECLARE
  st text;
BEGIN
  SELECT s.status INTO st FROM carrier_settlement s WHERE s.id = NEW.settlement_id;
  IF TG_OP = 'INSERT' THEN
    IF st IS DISTINCT FROM 'DRAFT' OR NEW.voided_at IS NOT NULL THEN
      RAISE EXCEPTION 'settlement_line_draft_only: settlement_line: settlement % is not a draft (%) — lines can only be added to drafts', NEW.settlement_id, st
        USING ERRCODE = 'check_violation', CONSTRAINT = 'settlement_line_draft_only';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.settlement_id IS DISTINCT FROM OLD.settlement_id
     OR NEW.line_no IS DISTINCT FROM OLD.line_no OR NEW.line_type IS DISTINCT FROM OLD.line_type
     OR NEW.trip_cost_id IS DISTINCT FROM OLD.trip_cost_id OR NEW.trip_id IS DISTINCT FROM OLD.trip_id
     OR NEW.deduction_type IS DISTINCT FROM OLD.deduction_type OR NEW.amount IS DISTINCT FROM OLD.amount THEN
    RAISE EXCEPTION 'settlement_line_immutable: settlement_line %: settlement / trip cost / kind / amount cannot change', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'settlement_line_immutable';
  END IF;
  IF OLD.voided_at IS NOT NULL AND (NEW.voided_at IS DISTINCT FROM OLD.voided_at
     OR NEW.voided_by IS DISTINCT FROM OLD.voided_by OR NEW.void_reason IS DISTINCT FROM OLD.void_reason) THEN
    RAISE EXCEPTION 'settlement_line_void_one_way: settlement_line % was removed — cannot reactivate or change the removal', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'settlement_line_void_one_way';
  END IF;
  IF OLD.voided_at IS NULL AND NEW.voided_at IS NOT NULL AND st IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'settlement_line_void_state: settlement_line %: settlement % is % — lines can only be removed from drafts', OLD.id, OLD.settlement_id, st
      USING ERRCODE = 'check_violation', CONSTRAINT = 'settlement_line_void_state';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER settlement_line_guard BEFORE INSERT OR UPDATE ON "settlement_line"
  FOR EACH ROW EXECUTE FUNCTION tms_settlement_line_guard();

-- ใบ CANCELLED = สถานะสิ้นสุด: แก้อะไรไม่ได้อีก (สถานะ/หัวใบ/ยอด)
CREATE OR REPLACE FUNCTION tms_carrier_settlement_terminal_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS
$$
BEGIN
  IF OLD.status = 'CANCELLED' THEN
    RAISE EXCEPTION 'carrier_settlement_terminal: carrier_settlement % is CANCELLED (terminal) — cannot change', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'carrier_settlement_terminal';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER carrier_settlement_terminal_guard BEFORE UPDATE ON "carrier_settlement"
  FOR EACH ROW EXECUTE FUNCTION tms_carrier_settlement_terminal_guard();

-- ยอดหัวใบ = ยอดจากบรรทัดที่ยังใช้ (ตรวจตอน commit — DEFERRABLE INITIALLY DEFERRED: service เพิ่มบรรทัดแล้วคิดยอดใหม่ใน transaction เดียวกัน)
-- ยกเว้นใบ CANCELLED: ยอดคงไว้ ณ เวลายกเลิก (เป็นประวัติ) ขณะที่ทุกบรรทัดถูกนำออกแล้ว
CREATE OR REPLACE FUNCTION tms_carrier_settlement_check_totals(sid uuid) RETURNS void
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS
$$
DECLARE
  h record;
  g numeric;
  d numeric;
BEGIN
  SELECT status, gross_amount, deduction_amount INTO h FROM carrier_settlement WHERE id = sid;
  IF NOT FOUND OR h.status = 'CANCELLED' THEN RETURN; END IF;
  SELECT coalesce(sum(amount) FILTER (WHERE line_type <> 'DEDUCTION'), 0),
         coalesce(-sum(amount) FILTER (WHERE line_type = 'DEDUCTION'), 0)
    INTO g, d FROM settlement_line WHERE settlement_id = sid AND voided_at IS NULL;
  IF g <> h.gross_amount OR d <> h.deduction_amount THEN
    RAISE EXCEPTION 'carrier_settlement_totals: carrier_settlement %: totals (gross %, deduction %) do not match active lines (gross %, deduction %)',
      sid, h.gross_amount, h.deduction_amount, g, d
      USING ERRCODE = 'check_violation', CONSTRAINT = 'carrier_settlement_totals';
  END IF;
END
$$;
CREATE OR REPLACE FUNCTION tms_carrier_settlement_totals_trg() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS
$$
BEGIN
  PERFORM tms_carrier_settlement_check_totals(NEW.id);
  RETURN NULL;
END
$$;
CREATE OR REPLACE FUNCTION tms_settlement_line_totals_trg() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS
$$
BEGIN
  PERFORM tms_carrier_settlement_check_totals(NEW.settlement_id);
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER carrier_settlement_totals AFTER INSERT OR UPDATE ON "carrier_settlement"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tms_carrier_settlement_totals_trg();
CREATE CONSTRAINT TRIGGER settlement_line_totals AFTER INSERT OR UPDATE ON "settlement_line"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tms_settlement_line_totals_trg();

-- ผูกสองทาง trip_cost.settlement_line_id ↔ บรรทัดที่ยังใช้ (ตรวจตอน commit — อ่านค่าปัจจุบันของแถว):
-- (ก) บรรทัดที่ยังใช้ที่อ้าง trip_cost → trip_cost.settlement_line_id = บรรทัดนั้น · บรรทัดที่นำออกแล้ว → trip_cost ไม่ชี้มาที่บรรทัดนั้น
-- (ข) trip_cost.settlement_line_id ไม่ว่าง → ต้องชี้บรรทัดที่ยังใช้ของ trip_cost เดียวกัน · ปลดลิงก์ได้เมื่อบรรทัดเดิมถูกนำออกแล้วเท่านั้น
CREATE OR REPLACE FUNCTION tms_settlement_line_link_trg() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS
$$
DECLARE
  l record;
  tc_link uuid;
BEGIN
  IF TG_TABLE_NAME = 'settlement_line' THEN
    SELECT id, trip_cost_id, voided_at INTO l FROM settlement_line WHERE id = NEW.id;
    IF l.trip_cost_id IS NULL THEN RETURN NULL; END IF;
    SELECT settlement_line_id INTO tc_link FROM trip_cost WHERE id = l.trip_cost_id;
    IF (l.voided_at IS NULL AND tc_link IS DISTINCT FROM l.id) OR (l.voided_at IS NOT NULL AND tc_link = l.id) THEN
      RAISE EXCEPTION 'settlement_line_trip_cost_link: settlement_line %: trip_cost % link (%) does not match the line state', l.id, l.trip_cost_id, tc_link
        USING ERRCODE = 'check_violation', CONSTRAINT = 'settlement_line_trip_cost_link';
    END IF;
  ELSE
    SELECT settlement_line_id INTO tc_link FROM trip_cost WHERE id = NEW.id;
    IF tc_link IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM settlement_line s WHERE s.id = tc_link AND s.trip_cost_id = NEW.id AND s.voided_at IS NULL) THEN
      RAISE EXCEPTION 'settlement_line_trip_cost_link: trip_cost %: settlement_line_id % is not an active settlement line of this cost', NEW.id, tc_link
        USING ERRCODE = 'check_violation', CONSTRAINT = 'settlement_line_trip_cost_link';
    END IF;
    -- ปลด/เปลี่ยนลิงก์ขณะบรรทัดเดิมยังใช้อยู่ไม่ได้ (ต้องนำบรรทัดออกก่อน)
    IF TG_OP = 'UPDATE' AND OLD.settlement_line_id IS NOT NULL AND OLD.settlement_line_id IS DISTINCT FROM tc_link
       AND EXISTS (SELECT 1 FROM settlement_line s
                    WHERE s.id = OLD.settlement_line_id AND s.trip_cost_id = NEW.id AND s.voided_at IS NULL) THEN
      RAISE EXCEPTION 'settlement_line_trip_cost_link: trip_cost %: released from active settlement_line %', NEW.id, OLD.settlement_line_id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'settlement_line_trip_cost_link';
    END IF;
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER settlement_line_trip_cost_link AFTER INSERT OR UPDATE ON "settlement_line"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tms_settlement_line_link_trg();
CREATE CONSTRAINT TRIGGER trip_cost_settlement_line_link AFTER INSERT OR UPDATE OF "settlement_line_id" ON "trip_cost"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION tms_settlement_line_link_trg();

SELECT tms_enable_tenant_rls('carrier_settlement');
SELECT tms_enable_tenant_rls('settlement_line');

-- ไม่มีการลบ (นำออก/ยกเลิก = void + เหตุผล)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE DELETE ON "carrier_settlement", "settlement_line" FROM tms_app';
  END IF;
END $$;
