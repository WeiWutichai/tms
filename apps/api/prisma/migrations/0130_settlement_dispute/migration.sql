-- ST6-T06 Dispute ใบสำคัญจ่ายรถร่วม — docs/04 F6 "Dispute" (item status OPEN / DISPUTED / APPROVED; dispute บล็อก approve ทั้งใบจนเคลียร์),
-- docs/01 §4.5 (SENT_TO_CARRIER → DISPUTED : รถร่วม/บัญชีติด dispute รายการ · DISPUTED → DRAFT : แก้รายการ · approve เมื่อ disputed_count = 0),
-- spec/05 BIL-136 (DISPUTED บล็อกจน RESOLVED — แก้ยอดหรือยืนยันยอดเดิมพร้อมเหตุผล)
-- (1) สถานะหัวใบ DISPUTED: SENT_TO_CARRIER ↔ DISPUTED (ตามจำนวนรายการที่โต้แย้งค้าง — DB ตรวจให้ตรง) · DISPUTED → DRAFT (เรียกกลับมาแก้) ·
--     DISPUTED → APPROVED / CANCELLED ไม่ได้ · ระหว่าง DISPUTED หัวใบ/บรรทัดแข็งเหมือน SENT_TO_CARRIER
-- (2) settlement_line_dispute: การตัดสินฝั่งบริษัทต่อบรรทัด — DISPUTED (บัญชีติด dispute เอง) / RESOLVED (ยืนยันยอดเดิมพร้อมเหตุผล) — เพิ่มอย่างเดียว
-- (3) settlement_line_review.claimed_amount: ยอดที่รถร่วมเรียก (เฉพาะโต้แย้ง ไม่บังคับ)
-- (4) นิยาม "รายการโต้แย้งค้าง" ที่เดียว (tms_settlement_line_disputed) ใช้ทั้งบล็อกอนุมัติ, ตรวจสถานะ DISPUTED และกันเคลียร์บรรทัดที่ไม่ได้โต้แย้ง
-- ข้อมูลเดิม: ใบ SENT_TO_CARRIER ที่มีรายการโต้แย้ง (ก่อน T06) ยังอนุมัติไม่ได้ (บล็อกด้วยนิยามเดียวกัน) และเปลี่ยนเป็น DISPUTED
-- ทันทีที่มีคำตอบ/การตัดสินครั้งถัดไป — ไม่แก้ข้อมูลย้อนหลังใน migration นี้

-- ---------- (1) สถานะ ----------
ALTER TABLE "carrier_settlement" DROP CONSTRAINT "carrier_settlement_status_check";
ALTER TABLE "carrier_settlement" ADD CONSTRAINT "carrier_settlement_status_check"
  CHECK ("status" IN ('DRAFT', 'SENT_TO_CARRIER', 'DISPUTED', 'APPROVED', 'CANCELLED'));
ALTER TABLE "carrier_settlement" DROP CONSTRAINT "carrier_settlement_sent_check";
ALTER TABLE "carrier_settlement" ADD CONSTRAINT "carrier_settlement_sent_check" CHECK (
  "status" NOT IN ('SENT_TO_CARRIER', 'DISPUTED') OR ("sent_at" IS NOT NULL AND "sent_by" IS NOT NULL AND "review_round" >= 1));

-- ---------- (3) ยอดที่รถร่วมเรียก ----------
ALTER TABLE "settlement_line_review" ADD COLUMN "claimed_amount" DECIMAL(14,2);
ALTER TABLE "settlement_line_review" ADD CONSTRAINT "settlement_line_review_claimed_check"
  CHECK ("claimed_amount" IS NULL OR ("response" = 'DISPUTED' AND "claimed_amount" >= 0));

-- ---------- (2) การตัดสินฝั่งบริษัท ----------
CREATE TABLE "settlement_line_dispute" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "settlement_id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "round" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "settlement_line_dispute_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "settlement_line_dispute_action_check" CHECK ("action" IN ('DISPUTED', 'RESOLVED')),
    CONSTRAINT "settlement_line_dispute_round_check" CHECK ("round" >= 1),
    -- ทุกการติด dispute / เคลียร์ ต้องมีเหตุผล (CLAUDE.md "override ต้องมีเหตุผล")
    CONSTRAINT "settlement_line_dispute_reason_check" CHECK (length(btrim("reason")) >= 10 AND length("reason") <= 500),
    -- ผู้บันทึก = คนของบริษัท (ไม่ใช่ลิงก์ของรถร่วม / ว่าง)
    CONSTRAINT "settlement_line_dispute_actor_check" CHECK (btrim("created_by") <> '' AND "created_by" NOT LIKE 'link:%')
);
CREATE INDEX "settlement_line_dispute_tenant_id_settlement_id_round_line__idx" ON "settlement_line_dispute"("tenant_id", "settlement_id", "round", "line_id", "created_at");
ALTER TABLE "settlement_line_dispute" ADD CONSTRAINT "settlement_line_dispute_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "carrier_settlement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "settlement_line_dispute" ADD CONSTRAINT "settlement_line_dispute_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "settlement_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------- (4) นิยามรายการโต้แย้งค้าง ----------
-- บรรทัดโต้แย้งค้างในรอบ p_round เมื่อ (ก) คำตอบล่าสุดของรถร่วมเป็น DISPUTED และไม่มีการเคลียร์ (RESOLVED) หลังจากนั้น หรือ
-- (ข) บริษัทติด dispute (DISPUTED) หลังการเคลียร์ล่าสุด · ลำดับ = (created_at, id)
CREATE OR REPLACE FUNCTION tms_settlement_line_disputed(p_line uuid, p_round integer) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, public AS
$$
  WITH res AS (
    SELECT d.created_at, d.id FROM settlement_line_dispute d
     WHERE d.line_id = p_line AND d.round = p_round AND d.action = 'RESOLVED'
     ORDER BY d.created_at DESC, d.id DESC LIMIT 1),
  car AS (
    SELECT r.response, r.created_at, r.id FROM settlement_line_review r
     WHERE r.line_id = p_line AND r.round = p_round
     ORDER BY r.created_at DESC, r.id DESC LIMIT 1)
  SELECT EXISTS (
           SELECT 1 FROM car WHERE car.response = 'DISPUTED'
              AND NOT EXISTS (SELECT 1 FROM res WHERE (res.created_at, res.id) > (car.created_at, car.id)))
      OR EXISTS (
           SELECT 1 FROM settlement_line_dispute d
            WHERE d.line_id = p_line AND d.round = p_round AND d.action = 'DISPUTED'
              AND NOT EXISTS (SELECT 1 FROM res WHERE (res.created_at, res.id) > (d.created_at, d.id)))
$$;

-- จำนวนบรรทัดที่ยังใช้ซึ่งโต้แย้งค้างในรอบ (docs/01 §4.5 `disputed_count`)
CREATE OR REPLACE FUNCTION tms_settlement_disputed_count(p_settlement uuid, p_round integer) RETURNS integer
  LANGUAGE sql STABLE SET search_path = pg_catalog, public AS
$$
  SELECT CASE WHEN p_round IS NULL OR p_round < 1 THEN 0 ELSE (
    SELECT count(*)::integer FROM settlement_line l
     WHERE l.settlement_id = p_settlement AND l.voided_at IS NULL
       AND tms_settlement_line_disputed(l.id, p_round)) END
$$;

-- เพิ่มอย่างเดียว · ติด dispute ได้เฉพาะใบที่ส่งตรวจอยู่ (SENT_TO_CARRIER / DISPUTED) · เคลียร์ได้เฉพาะบรรทัดที่โต้แย้งค้าง
-- ของใบ DISPUTED หรือร่างที่เรียกกลับ · บรรทัดต้องยังใช้ + รอบ = รอบตรวจปัจจุบัน
CREATE OR REPLACE FUNCTION tms_settlement_line_dispute_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS
$$
DECLARE
  st text;
  rnd int;
  ok boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'settlement_line_dispute_append_only: settlement_line_dispute is append-only'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'settlement_line_dispute_append_only';
  END IF;
  SELECT s.status, s.review_round INTO st, rnd FROM carrier_settlement s WHERE s.id = NEW.settlement_id;
  SELECT EXISTS (SELECT 1 FROM settlement_line l
                  WHERE l.id = NEW.line_id AND l.settlement_id = NEW.settlement_id AND l.voided_at IS NULL) INTO ok;
  IF NOT ok OR NEW.round IS DISTINCT FROM rnd
     OR (NEW.action = 'DISPUTED' AND st NOT IN ('SENT_TO_CARRIER', 'DISPUTED'))
     OR (NEW.action = 'RESOLVED' AND (st NOT IN ('DISPUTED', 'DRAFT') OR NOT tms_settlement_line_disputed(NEW.line_id, NEW.round))) THEN
    RAISE EXCEPTION 'settlement_line_dispute_state: settlement % is % (round %) — cannot % line %', NEW.settlement_id, st, rnd, NEW.action, NEW.line_id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'settlement_line_dispute_state';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER settlement_line_dispute_guard BEFORE INSERT OR UPDATE OR DELETE ON "settlement_line_dispute"
  FOR EACH ROW EXECUTE FUNCTION tms_settlement_line_dispute_guard();

SELECT tms_enable_tenant_rls('settlement_line_dispute');

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON "settlement_line_dispute" FROM tms_app';
  END IF;
END $$;

-- คำตอบของรถร่วม: + ใบ DISPUTED ตอบได้ (เปลี่ยนใจ/ตอบบรรทัดอื่น) · บรรทัดที่บริษัทเคลียร์แล้วในรอบนี้ตอบไม่ได้อีก
CREATE OR REPLACE FUNCTION tms_settlement_line_review_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS
$$
DECLARE
  st text;
  rnd int;
  ok boolean;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'settlement_line_review_append_only: settlement_line_review is append-only'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'settlement_line_review_append_only';
  END IF;
  SELECT s.status, s.review_round INTO st, rnd FROM carrier_settlement s WHERE s.id = NEW.settlement_id;
  SELECT EXISTS (SELECT 1 FROM settlement_line l
                  WHERE l.id = NEW.line_id AND l.settlement_id = NEW.settlement_id AND l.voided_at IS NULL) INTO ok;
  IF st IS NULL OR st NOT IN ('SENT_TO_CARRIER', 'DISPUTED') OR NEW.round IS DISTINCT FROM rnd OR NOT ok THEN
    RAISE EXCEPTION 'settlement_line_review_state: settlement % is % (round %) — the carrier can only review active lines of a settlement sent for review in the current round', NEW.settlement_id, st, rnd
      USING ERRCODE = 'check_violation', CONSTRAINT = 'settlement_line_review_state';
  END IF;
  IF EXISTS (SELECT 1 FROM settlement_line_dispute d
              WHERE d.line_id = NEW.line_id AND d.round = NEW.round AND d.action = 'RESOLVED') THEN
    RAISE EXCEPTION 'settlement_line_review_resolved: settlement_line % was resolved by the company in round % — the carrier cannot answer it again', NEW.line_id, NEW.round
      USING ERRCODE = 'check_violation', CONSTRAINT = 'settlement_line_review_resolved';
  END IF;
  RETURN NEW;
END
$$;

-- หัวใบ: ทางเปลี่ยนสถานะ + DISPUTED (แข็งเหมือน SENT_TO_CARRIER) — คงกติกาเดิมของ 0124/0127 ทั้งหมด
CREATE OR REPLACE FUNCTION tms_carrier_settlement_terminal_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS
$$
BEGIN
  IF OLD.status IN ('CANCELLED', 'APPROVED') THEN
    RAISE EXCEPTION 'carrier_settlement_terminal: carrier_settlement % is % (terminal) — cannot change', OLD.id, OLD.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'carrier_settlement_terminal';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'DRAFT' AND NEW.status IN ('APPROVED', 'CANCELLED', 'SENT_TO_CARRIER'))
     AND NOT (OLD.status = 'SENT_TO_CARRIER' AND NEW.status IN ('DRAFT', 'APPROVED', 'DISPUTED'))
     AND NOT (OLD.status = 'DISPUTED' AND NEW.status IN ('DRAFT', 'SENT_TO_CARRIER')) THEN
    RAISE EXCEPTION 'carrier_settlement_transition: carrier_settlement %: % → % is not allowed', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'carrier_settlement_transition';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.carrier_id IS DISTINCT FROM OLD.carrier_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR (OLD.settlement_no IS NOT NULL AND NEW.settlement_no IS DISTINCT FROM OLD.settlement_no) THEN
    RAISE EXCEPTION 'carrier_settlement_immutable: carrier_settlement %: tenant / carrier / creator / document number cannot change', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'carrier_settlement_immutable';
  END IF;
  -- ระหว่างรอรถร่วมตรวจ/มีรายการโต้แย้ง: หัวใบ (ยอด งวด หมายเหตุ เลขใบแจ้งหนี้ ฯลฯ) แข็ง — เปลี่ยนได้เฉพาะสถานะ/อนุมัติ/ผู้เตรียม
  IF OLD.status IN ('SENT_TO_CARRIER', 'DISPUTED')
     AND (pg_catalog.to_jsonb(NEW) - ARRAY['status', 'version', 'updated_at', 'approved_at', 'approved_by', 'settlement_no', 'preparers'])
         IS DISTINCT FROM (pg_catalog.to_jsonb(OLD) - ARRAY['status', 'version', 'updated_at', 'approved_at', 'approved_by', 'settlement_no', 'preparers']) THEN
    RAISE EXCEPTION 'carrier_settlement_sent_frozen: carrier_settlement % is awaiting the carrier review — recall it before editing', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'carrier_settlement_sent_frozen';
  END IF;
  IF NOT (NEW.preparers @> OLD.preparers) THEN
    RAISE EXCEPTION 'carrier_settlement_preparers: carrier_settlement %: preparers can only be appended', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'carrier_settlement_preparers';
  END IF;
  IF NEW.review_round < OLD.review_round
     OR (NEW.review_round <> OLD.review_round AND NOT (OLD.status = 'DRAFT' AND NEW.status = 'SENT_TO_CARRIER')) THEN
    RAISE EXCEPTION 'carrier_settlement_review_round: carrier_settlement %: review round only increases when sent to the carrier', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'carrier_settlement_review_round';
  END IF;
  RETURN NEW;
END
$$;

-- separation of duties (0126/0127 เดิมทั้งหมด) + dispute บล็อกอนุมัติด้วยนิยามใหม่ (รวมการติด dispute ของบริษัท/การเคลียร์) +
-- สถานะ DISPUTED ต้องตรงกับจำนวนรายการโต้แย้งค้าง (เข้า DISPUTED ต้องมี > 0 · DISPUTED → SENT_TO_CARRIER ต้องเป็น 0)
CREATE OR REPLACE FUNCTION tms_carrier_settlement_sod_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, public AS
$$
DECLARE
  approver text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status IS DISTINCT FROM 'DRAFT' THEN
      RAISE EXCEPTION 'carrier_settlement_insert_draft: carrier_settlement must be created as DRAFT (got %)', NEW.status
        USING ERRCODE = 'check_violation', CONSTRAINT = 'carrier_settlement_insert_draft';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'APPROVED' AND OLD.status IS DISTINCT FROM 'APPROVED' THEN
    approver := tms_resolve_actor(NEW.approved_by);
    IF approver IS NULL OR approver LIKE '%:%' OR approver = 'system' OR EXISTS (
         SELECT 1 FROM (
           SELECT NEW.created_by AS a
           UNION ALL SELECT NEW.updated_by WHERE NEW.updated_by IS NOT NULL
           UNION ALL SELECT NEW.sent_by WHERE NEW.sent_by IS NOT NULL
           UNION ALL SELECT p FROM unnest(NEW.preparers) AS p
           UNION ALL SELECT l.created_by FROM settlement_line l WHERE l.settlement_id = NEW.id
           UNION ALL SELECT l.voided_by FROM settlement_line l WHERE l.settlement_id = NEW.id AND l.voided_at IS NOT NULL
         ) p
         WHERE tms_resolve_actor(p.a) IS NULL OR tms_resolve_actor(p.a) = approver) THEN
      RAISE EXCEPTION 'carrier_settlement_sod: carrier_settlement %: approver % prepared this settlement, is not a person, or a preparer is unknown', NEW.id, NEW.approved_by
        USING ERRCODE = 'check_violation', CONSTRAINT = 'carrier_settlement_sod';
    END IF;
    -- dispute บล็อกอนุมัติ (docs/01 §4.5 disputed_count = 0) — ทั้งใบที่รอตรวจและร่างที่เรียกกลับ
    IF tms_settlement_disputed_count(NEW.id, NEW.review_round) > 0 THEN
      RAISE EXCEPTION 'carrier_settlement_disputed: carrier_settlement % has disputed lines that are not resolved', NEW.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'carrier_settlement_disputed';
    END IF;
  END IF;
  IF NEW.status = 'DISPUTED' AND OLD.status IS DISTINCT FROM 'DISPUTED'
     AND tms_settlement_disputed_count(NEW.id, NEW.review_round) = 0 THEN
    RAISE EXCEPTION 'carrier_settlement_dispute_state: carrier_settlement % has no open disputes — cannot be DISPUTED', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'carrier_settlement_dispute_state';
  END IF;
  IF OLD.status = 'DISPUTED' AND NEW.status = 'SENT_TO_CARRIER'
     AND tms_settlement_disputed_count(NEW.id, NEW.review_round) > 0 THEN
    RAISE EXCEPTION 'carrier_settlement_dispute_state: carrier_settlement % still has open disputes', NEW.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'carrier_settlement_dispute_state';
  END IF;
  RETURN NEW;
END
$$;
