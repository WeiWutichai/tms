-- ST6-T05 รถร่วมตรวจใบสำคัญจ่ายผ่านลิงก์ — docs/04 F6 "รถร่วมตรวจผ่านลิงก์", docs/01 §4.5 (DRAFT → SENT_TO_CARRIER → APPROVED), spec/05 §11
-- (1) สถานะ SENT_TO_CARRIER + ผู้ส่ง/เวลาส่ง/รอบตรวจ · ทางเปลี่ยนสถานะ: DRAFT → SENT_TO_CARRIER / APPROVED / CANCELLED ·
--     SENT_TO_CARRIER → DRAFT (เรียกกลับมาแก้) / APPROVED · บรรทัดของใบที่ส่งแล้วแข็ง (กติกาเดิม 0124: ไม่ใช่ร่าง = แก้ไม่ได้)
-- (2) settlement_line_review: คำตอบของรถร่วมต่อบรรทัด (ยอมรับ/โต้แย้ง + เหตุผล/รูป) — เพิ่มอย่างเดียว ·
--     ตอบได้เฉพาะใบ SENT_TO_CARRIER ในรอบปัจจุบัน · ผู้ตอบ = actor สังเคราะห์ `link:<id>` ของลิงก์ที่ตอบ
-- (3) separation of duties: ผู้ส่งให้รถร่วมตรวจทุกรอบ / ผู้เรียกกลับ / ผู้ออกลิงก์ใหม่ (`preparers` + `sent_by`) นับเป็นผู้เตรียมใบ ·
--     ผู้อนุมัติต้องเป็นคน — actor สังเคราะห์ (`link:` `connector:` ฯลฯ ที่มี `:` หลังแปลง key / `system`) อนุมัติไม่ได้
--     · อนุมัติไม่ได้ถ้าบรรทัดที่ยังใช้มีคำตอบล่าสุด (รอบตรวจล่าสุด) เป็น DISPUTED — ทั้งจาก SENT_TO_CARRIER และร่างที่เรียกกลับ (review M1/L4)
--     · ระหว่าง SENT_TO_CARRIER หัวใบแก้ไม่ได้ (ยกเว้นสถานะ/อนุมัติ/ผู้เตรียม/version)

-- AlterTable
ALTER TABLE "carrier_settlement" ADD COLUMN "sent_at" TIMESTAMPTZ(6),
ADD COLUMN "sent_by" TEXT,
ADD COLUMN "review_round" INTEGER NOT NULL DEFAULT 0,
-- ผู้เตรียมใบจากขั้นรถร่วมตรวจ (ผู้ส่งทุกรอบ + ผู้เรียกกลับ + ผู้ออกลิงก์ใหม่) — เพิ่มอย่างเดียว (review L3)
ADD COLUMN "preparers" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "carrier_settlement" DROP CONSTRAINT "carrier_settlement_status_check";
ALTER TABLE "carrier_settlement" ADD CONSTRAINT "carrier_settlement_status_check"
  CHECK ("status" IN ('DRAFT', 'SENT_TO_CARRIER', 'APPROVED', 'CANCELLED'));
-- ใบที่ส่งตรวจต้องมีผู้ส่ง + เวลา + รอบ ≥ 1
ALTER TABLE "carrier_settlement" ADD CONSTRAINT "carrier_settlement_sent_check" CHECK (
  "status" <> 'SENT_TO_CARRIER' OR ("sent_at" IS NOT NULL AND "sent_by" IS NOT NULL AND "review_round" >= 1));

-- หัวใบ: เพิ่มทาง DRAFT → SENT_TO_CARRIER และ SENT_TO_CARRIER → DRAFT / APPROVED · รอบตรวจเพิ่มได้อย่างเดียว
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
     AND NOT (OLD.status = 'SENT_TO_CARRIER' AND NEW.status IN ('DRAFT', 'APPROVED')) THEN
    RAISE EXCEPTION 'carrier_settlement_transition: carrier_settlement %: % → % is not allowed', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation', CONSTRAINT = 'carrier_settlement_transition';
  END IF;
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.carrier_id IS DISTINCT FROM OLD.carrier_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR (OLD.settlement_no IS NOT NULL AND NEW.settlement_no IS DISTINCT FROM OLD.settlement_no) THEN
    RAISE EXCEPTION 'carrier_settlement_immutable: carrier_settlement %: tenant / carrier / creator / document number cannot change', OLD.id
      USING ERRCODE = 'check_violation', CONSTRAINT = 'carrier_settlement_immutable';
  END IF;
  -- ระหว่างรอรถร่วมตรวจ: หัวใบ (ยอด งวด หมายเหตุ เลขใบแจ้งหนี้ ฯลฯ) แข็ง — เปลี่ยนได้เฉพาะสถานะ/อนุมัติ/ผู้เตรียม (review L4)
  IF OLD.status = 'SENT_TO_CARRIER'
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

-- separation of duties: + ผู้ส่งให้รถร่วมตรวจ (sent_by) เป็นผู้เตรียม · ผู้อนุมัติที่เป็น actor สังเคราะห์ = ปฏิเสธ
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
    -- dispute บล็อกอนุมัติ (docs/01 §4.5): คำตอบล่าสุดของรอบตรวจล่าสุดของบรรทัดที่ยังใช้ = DISPUTED → ปฏิเสธ
    IF NEW.review_round > 0 AND EXISTS (
         SELECT 1 FROM settlement_line l
          WHERE l.settlement_id = NEW.id AND l.voided_at IS NULL
            AND (SELECT r.response FROM settlement_line_review r
                  WHERE r.line_id = l.id AND r.round = NEW.review_round
                  ORDER BY r.created_at DESC, r.id DESC LIMIT 1) = 'DISPUTED') THEN
      RAISE EXCEPTION 'carrier_settlement_disputed: carrier_settlement % has lines disputed by the carrier', NEW.id
        USING ERRCODE = 'check_violation', CONSTRAINT = 'carrier_settlement_disputed';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- CreateTable
CREATE TABLE "settlement_line_review" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "settlement_id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "round" INTEGER NOT NULL,
    "response" TEXT NOT NULL,
    "reason" TEXT,
    "photo_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
    "link_id" UUID NOT NULL,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settlement_line_review_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "settlement_line_review_response_check" CHECK ("response" IN ('ACCEPTED', 'DISPUTED')),
    CONSTRAINT "settlement_line_review_round_check" CHECK ("round" >= 1),
    -- โต้แย้งต้องมีเหตุผลหรือรูปอย่างน้อยหนึ่งอย่าง · ยอมรับไม่มีรูป
    CONSTRAINT "settlement_line_review_dispute_check" CHECK (
      ("response" = 'DISPUTED' AND (coalesce(length(btrim("reason")), 0) > 0 OR cardinality("photo_ids") > 0))
      OR ("response" = 'ACCEPTED' AND cardinality("photo_ids") = 0)),
    CONSTRAINT "settlement_line_review_reason_check" CHECK ("reason" IS NULL OR length("reason") <= 500),
    CONSTRAINT "settlement_line_review_photos_check" CHECK (cardinality("photo_ids") <= 6),
    -- ผู้ตอบ = ลิงก์ที่ตอบเท่านั้น (actor สังเคราะห์ — ไม่ใช่ผู้ใช้)
    CONSTRAINT "settlement_line_review_actor_check" CHECK ("created_by" = 'link:' || "link_id"::text)
);

-- CreateIndex
CREATE INDEX "settlement_line_review_tenant_id_settlement_id_round_line_i_idx" ON "settlement_line_review"("tenant_id", "settlement_id", "round", "line_id", "created_at");

-- AddForeignKey
ALTER TABLE "settlement_line_review" ADD CONSTRAINT "settlement_line_review_settlement_id_fkey" FOREIGN KEY ("settlement_id") REFERENCES "carrier_settlement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "settlement_line_review" ADD CONSTRAINT "settlement_line_review_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "settlement_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- เพิ่มอย่างเดียว · ตอบได้เฉพาะบรรทัดที่ยังใช้ของใบ SENT_TO_CARRIER ในรอบปัจจุบัน
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
  IF st IS DISTINCT FROM 'SENT_TO_CARRIER' OR NEW.round IS DISTINCT FROM rnd OR NOT ok THEN
    RAISE EXCEPTION 'settlement_line_review_state: settlement % is % (round %) — the carrier can only review active lines of a settlement sent for review in the current round', NEW.settlement_id, st, rnd
      USING ERRCODE = 'check_violation', CONSTRAINT = 'settlement_line_review_state';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER settlement_line_review_guard BEFORE INSERT OR UPDATE OR DELETE ON "settlement_line_review"
  FOR EACH ROW EXECUTE FUNCTION tms_settlement_line_review_guard();

SELECT tms_enable_tenant_rls('settlement_line_review');

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE UPDATE, DELETE ON "settlement_line_review" FROM tms_app';
  END IF;
END $$;

-- (4) audit ของใบสำคัญจ่ายรถร่วม (entity_type `carrier_settlement` — ST6-T03/T05/T07) เป็นเหตุการณ์ของเอกสารการเงิน
--     → retention job ไม่ลบ (ตกหล่นจากรายการ 0108 เพราะ ST6-T03 ใช้ชื่อ `carrier_settlement` ไม่ใช่ `settlement`)
CREATE OR REPLACE FUNCTION tms_audit_retention_purge(p_tenant uuid, p_limit integer) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS
$$
DECLARE
  protected text[] := ARRAY[
    'audit_log', 'retention',
    'tenant', 'tenant_setting', 'company', 'legal_entity', 'branch', 'document_sequence', 'document_series',
    'customer', 'customer_site', 'carrier', 'service_item',
    'rate_card', 'rate_card_accessorial', 'rate_card_line',
    'sales_order', 'sales_order_line', 'sales_order_charge', 'sales_order_stop', 'order_charge',
    'delivery_order', 'delivery_order_line', 'delivery_order_pod', 'do_surcharge', 'field_charge',
    'trip', 'trip_stop', 'trip_cost', 'subcon_offer', 'stop_event',
    'vehicle', 'vehicle_cost', 'depreciation',
    'sales_document', 'invoice', 'tax_invoice', 'receipt', 'credit_note', 'debit_note', 'billing_note',
    'payment', 'wht_certificate', 'settlement', 'settlement_line', 'carrier_settlement', 'advance', 'cod', 'expense',
    'platform_invoice', 'platform_payment', 'etax_submission',
    'stored_document'
  ];
  v_years integer;
  v_raw jsonb;
  v_cutoff timestamptz;
  v_n integer;
  v_prev_tenant text := pg_catalog.current_setting('app.tenant_id', true);
BEGIN
  IF p_tenant IS NULL OR p_limit IS NULL OR p_limit < 1 OR p_limit > 10000 THEN
    RAISE EXCEPTION 'tms_audit_retention_purge: invalid arguments' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- FORCE RLS: เจ้าของตารางก็ต้องตั้ง tenant (กรณีเจ้าของไม่ใช่ superuser ใน production)
  PERFORM pg_catalog.set_config('app.tenant_id', p_tenant::text, true);
  SELECT value INTO v_raw FROM public.tenant_setting WHERE tenant_id = p_tenant AND key = 'retention.auditLogYears';
  IF v_raw IS NOT NULL AND pg_catalog.jsonb_typeof(v_raw) = 'number' THEN
    v_years := pg_catalog.floor((v_raw #>> '{}')::numeric)::integer;
  END IF;
  v_years := greatest(5, coalesce(v_years, 5));
  v_cutoff := pg_catalog.now() - pg_catalog.make_interval(years => v_years);
  PERFORM pg_catalog.set_config('tms.audit_retention_purge', 'on', true);
  WITH d AS (
    DELETE FROM public.audit_log
     WHERE id IN (SELECT id FROM public.audit_log
                   WHERE tenant_id = p_tenant AND at < v_cutoff
                     AND pg_catalog.lower(entity_type) <> ALL (protected)
                   ORDER BY at LIMIT p_limit)
    RETURNING 1
  )
  SELECT count(*)::integer INTO v_n FROM d;
  PERFORM pg_catalog.set_config('tms.audit_retention_purge', 'off', true);
  IF v_n > 0 THEN
    INSERT INTO public.audit_log (id, tenant_id, actor_id, action, entity_type, entity_id, after, reason)
    VALUES (pg_catalog.gen_random_uuid(), p_tenant, 'system:retention', 'retention.purged', 'retention', 'audit_log',
            pg_catalog.jsonb_build_object('count', v_n, 'olderThan', v_cutoff, 'years', v_years),
            'ลบตามระยะเก็บ audit log (ST9-T14)');
  END IF;
  PERFORM pg_catalog.set_config('app.tenant_id', coalesce(v_prev_tenant, ''), true);
  RETURN v_n;
END
$$;
