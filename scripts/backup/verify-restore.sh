#!/bin/sh
# ST9-T18 ตรวจฐานหลังกู้ (runbook §4.4 ขั้น 4): ออกจาก recovery แล้ว · migration ครบไม่มีค้าง · จำนวนแถวตารางหลัก ·
#   เอกสารที่ออกเลขล่าสุดต่อชุด (เทียบกับต้นทาง / บันทึกเหตุการณ์ เพื่อกันเลขซ้ำ — runbook §4.8)
# ใช้: psql ต่อฐานที่กู้ (PGHOST/PGUSER/PGDATABASE/PGPASSWORD) → verify-restore.sh
set -eu
psql -X -v ON_ERROR_STOP=1 -P pager=off <<'SQL'
\echo '== สถานะ =='
SELECT now() AS checked_at, pg_is_in_recovery() AS in_recovery, timeline_id FROM pg_control_checkpoint();
\echo '== migration =='
SELECT count(*) AS applied,
       count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL) AS broken,
       max(migration_name) AS latest
  FROM _prisma_migrations;
\echo '== จำนวนแถว (ตารางที่มี tenant_id ทั้งหมด, นับจริง) =='
DO $$
DECLARE r record; n bigint; total bigint := 0; tables int := 0;
BEGIN
  FOR r IN SELECT c.table_name FROM information_schema.columns c
            JOIN information_schema.tables t USING (table_schema, table_name)
           WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE'
           ORDER BY 1 LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', r.table_name) INTO n;
    total := total + n; tables := tables + 1;
  END LOOP;
  RAISE NOTICE 'tenant tables=%, total rows=%', tables, total;
END $$;
SELECT 'tenant' AS t, count(*) FROM tenant
UNION ALL SELECT 'app_user', count(*) FROM app_user
UNION ALL SELECT 'sales_order', count(*) FROM sales_order
UNION ALL SELECT 'delivery_order', count(*) FROM delivery_order
UNION ALL SELECT 'invoice', count(*) FROM invoice
UNION ALL SELECT 'billing_note', count(*) FROM billing_note
UNION ALL SELECT 'audit_log', count(*) FROM audit_log;
\echo '== เลขเอกสารถัดไปต่อชุด (เทียบกับต้นทาง: ต้องไม่ต่ำกว่าเลขที่ออกไปแล้วจริง — runbook §4.8) =='
SELECT tenant_id, doc_type, period_key, next_value FROM document_sequence ORDER BY 1, 2, 3;
SQL
