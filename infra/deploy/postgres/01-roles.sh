#!/bin/sh
# ST0-T03 — role ของ production/staging (เทียบ infra/postgres/init/01-roles.sql ของ dev แต่รหัสผ่านมาจาก env ไม่ hard-code)
# รันครั้งเดียวตอนสร้าง PGDATA ใหม่ (docker-entrypoint-initdb.d) ด้วย owner = $POSTGRES_USER (เจ้าของตาราง, ใช้รัน migration)
#   tms_app       — แอป: ไม่มี BYPASSRLS (T-05) → RLS บังคับทุก query ของ tenant
#   tms_platform  — งาน platform / job ข้าม tenant: BYPASSRLS (bootstrap-tenants, Console, rate limit)
#   tms_backup    — REPLICATION เท่านั้น สำหรับ pg_basebackup (ST9-T18) ไม่มีสิทธิ์อ่านตาราง
set -eu
: "${POSTGRES_APP_PASSWORD:?}" "${POSTGRES_PLATFORM_PASSWORD:?}" "${POSTGRES_BACKUP_PASSWORD:?}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v db="$POSTGRES_DB" -v owner="$POSTGRES_USER" \
  -v app_pw="$POSTGRES_APP_PASSWORD" -v platform_pw="$POSTGRES_PLATFORM_PASSWORD" -v backup_pw="$POSTGRES_BACKUP_PASSWORD" <<'SQL'
CREATE ROLE tms_app LOGIN PASSWORD :'app_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT CONNECT ON DATABASE :"db" TO tms_app;
GRANT USAGE ON SCHEMA public TO tms_app;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tms_app;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO tms_app;
CREATE ROLE tms_platform LOGIN PASSWORD :'platform_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
GRANT CONNECT ON DATABASE :"db" TO tms_platform;
GRANT USAGE ON SCHEMA public TO tms_platform;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tms_platform;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO tms_platform;
CREATE ROLE tms_backup LOGIN REPLICATION PASSWORD :'backup_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE;
-- ห้าม PUBLIC สร้าง object ใน public (PG15+ เป็นค่าเริ่มอยู่แล้ว — ใส่ซ้ำให้ชัด)
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL
# pg_basebackup จาก container backup (เครือข่ายภายใน compose) — ต้องมีบรรทัด replication แยก ("all" ไม่ครอบ replication)
echo "host replication tms_backup all scram-sha-256" >> "$PGDATA/pg_hba.conf"
