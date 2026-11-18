-- ST9-T19 Monitoring + alert: heartbeat, สถานะเงื่อนไข (hysteresis), alert ถึงทีม Innovera, self-probe availability, คำขอ HTTP ต่อนาที
-- ตารางระดับแพลตฟอร์ม (ไม่มี tenant_id — ไม่มีข้อมูลลูกค้า) · role แอปเข้าไม่ได้ · ใช้ผ่าน role platform เท่านั้น

-- CreateTable
CREATE TABLE "worker_heartbeat" (
    "instance_id" VARCHAR(120) NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "last_beat_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "worker_heartbeat_pkey" PRIMARY KEY ("instance_id")
);

-- CreateTable
CREATE TABLE "monitor_check" (
    "key" VARCHAR(200) NOT NULL,
    "rule" VARCHAR(60) NOT NULL,
    "subject" VARCHAR(120),
    "state" VARCHAR(10) NOT NULL DEFAULT 'OK',
    "breach_count" INTEGER NOT NULL DEFAULT 0,
    "ok_count" INTEGER NOT NULL DEFAULT 0,
    "last_value" DOUBLE PRECISION,
    "threshold" DOUBLE PRECISION,
    "last_eval_at" TIMESTAMPTZ(6) NOT NULL,
    "pending_since" TIMESTAMPTZ(6),
    "alert_id" UUID,

    CONSTRAINT "monitor_check_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "monitor_alert" (
    "id" UUID NOT NULL,
    "key" VARCHAR(200) NOT NULL,
    "rule" VARCHAR(60) NOT NULL,
    "subject" VARCHAR(120),
    "severity" VARCHAR(10) NOT NULL,
    "status" VARCHAR(10) NOT NULL DEFAULT 'OPEN',
    "threshold" DOUBLE PRECISION NOT NULL,
    "open_value" DOUBLE PRECISION NOT NULL,
    "last_value" DOUBLE PRECISION NOT NULL,
    "opened_at" TIMESTAMPTZ(6) NOT NULL,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL,
    "resolved_at" TIMESTAMPTZ(6),
    "notified_at" TIMESTAMPTZ(6),
    "resolve_notified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "monitor_alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "availability_probe" (
    "minute" TIMESTAMPTZ(6) NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "status" INTEGER,
    "latency_ms" INTEGER,
    "error" VARCHAR(200),
    "source" VARCHAR(20) NOT NULL,

    CONSTRAINT "availability_probe_pkey" PRIMARY KEY ("minute")
);

-- CreateTable
CREATE TABLE "http_request_minute" (
    "minute" TIMESTAMPTZ(6) NOT NULL,
    "instance_id" VARCHAR(120) NOT NULL,
    "total" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "http_request_minute_pkey" PRIMARY KEY ("minute","instance_id")
);

-- CreateIndex
CREATE INDEX "worker_heartbeat_kind_last_beat_at_idx" ON "worker_heartbeat"("kind", "last_beat_at");

-- CreateIndex
CREATE INDEX "monitor_check_rule_idx" ON "monitor_check"("rule");

-- CreateIndex
CREATE INDEX "monitor_alert_status_opened_at_idx" ON "monitor_alert"("status", "opened_at");

-- CreateIndex
CREATE INDEX "monitor_alert_opened_at_idx" ON "monitor_alert"("opened_at");


-- กัน alert ซ้ำ: OPEN ได้แถวเดียวต่อ key (evaluator หลายตัวพร้อมกัน → INSERT ชนกัน → ตัวหลังไม่สร้างซ้ำ)
CREATE UNIQUE INDEX "monitor_alert_open_key_uq" ON "monitor_alert"("key") WHERE "status" = 'OPEN';
ALTER TABLE "monitor_check" ADD CONSTRAINT "monitor_check_state_chk" CHECK ("state" IN ('OK', 'PENDING', 'FIRING'));
ALTER TABLE "monitor_alert" ADD CONSTRAINT "monitor_alert_status_chk" CHECK ("status" IN ('OPEN', 'RESOLVED'));
ALTER TABLE "monitor_alert" ADD CONSTRAINT "monitor_alert_severity_chk" CHECK ("severity" IN ('critical', 'warning'));
ALTER TABLE "monitor_alert" ADD CONSTRAINT "monitor_alert_resolved_chk" CHECK (("status" = 'RESOLVED') = ("resolved_at" IS NOT NULL));
ALTER TABLE "availability_probe" ADD CONSTRAINT "availability_probe_minute_chk" CHECK ("minute" = date_trunc('minute', "minute"));

-- สิทธิ์: role แอป (tms_app) ไม่แตะตาราง monitoring เลย · role platform (API ส่วน Console / worker) อ่าน-เขียนได้
-- alert ไม่มี hard delete (ประวัติ) — platform ลบได้เฉพาะ heartbeat / probe / นับคำขอ (ล้างตามอายุ)
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_app') THEN
    EXECUTE 'REVOKE ALL ON worker_heartbeat, monitor_check, monitor_alert, availability_probe, http_request_minute FROM tms_app';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tms_platform') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON worker_heartbeat, monitor_check, availability_probe, http_request_minute TO tms_platform';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON monitor_alert TO tms_platform';
    EXECUTE 'REVOKE DELETE ON monitor_alert FROM tms_platform';
  END IF;
END $$;
