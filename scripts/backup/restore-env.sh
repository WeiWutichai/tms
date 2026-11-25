#!/usr/bin/env bash
# ST9-T18 กู้ทั้ง environment (ฐาน + ไฟล์) ลง compose project ใหม่ที่ยังว่าง — ขั้น (2) ของการซ้อม/กู้จริง (runbook §4.4)
#
#   scripts/backup/restore-env.sh <profile> (--from <dir บน host> | --from-volume <docker volume>) [--base <UTC ts>] [--target-time '<timestamptz>']
#     --from         โฟลเดอร์ที่มี base/ wal/ files/ (ดาวน์โหลดจาก off-site มาแล้ว [รอ cloud decision: คำสั่งดาวน์โหลด])
#     --from-volume  volume pgbackup ของ environment ต้นทางบนเครื่องเดียวกัน (ใช้ตอนซ้อม)
#     --base         ชุด base ที่ใช้ (ค่าเริ่ม = ชุดล่าสุด · ใช้ --target-time ต้องระบุชุดที่เริ่มก่อนเวลานั้น)
#     --target-time  กู้ถึงเวลานี้ (PITR) · ไม่ใส่ = ถึง WAL ล่าสุดใน archive
#   profile ใช้ไฟล์ env เดียวกับ deploy.sh (infra/deploy/<profile>.db.env/.env) · project = $TMS_PROJECT หรือ tms-<profile>
#   env: RESTORE_WAIT_SEC (3600) เพดานรอ replay WAL
#   ต้องเป็น project ที่ volume pgdata ยังว่าง (สคริปต์ปฏิเสธถ้ามีข้อมูล) — **ห้ามกู้ทับฐานที่ใช้งานอยู่**
# จบแล้ว: ฐานขึ้น + promote แล้ว + ไฟล์กลับที่เดิม → ต่อด้วย scripts/deploy.sh <profile> <tag> --skip-backup (migrate ต้องไม่มีอะไรค้าง)
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
profile=${1:?ใช้: restore-env.sh <profile> --from <dir>|--from-volume <vol> [--base ts] [--target-time t]}; shift
from=""; from_vol=""; base=""; target=""
while [ $# -gt 0 ]; do
  case $1 in
    --from) from=$2; shift 2 ;;
    --from-volume) from_vol=$2; shift 2 ;;
    --base) base=$2; shift 2 ;;
    --target-time) target=$2; shift 2 ;;
    *) echo "ไม่รู้จัก $1" >&2; exit 2 ;;
  esac
done
[ -n "$from$from_vol" ] || { echo "ต้องมี --from หรือ --from-volume" >&2; exit 2; }
dir="$root/infra/deploy"
export COMPOSE_PROJECT_NAME=${TMS_PROJECT:-tms-$profile}
export TMS_TAG=${TMS_TAG:-unused} TMS_APP_ENV_FILE="$dir/$profile.env"
dc() { docker compose -f "$dir/docker-compose.prod.yml" --env-file "$dir/$profile.db.env" --env-file "$dir/$profile.env" "$@"; }
step() { echo "[$(date '+%F %T')] $*"; }
if [ -n "$from" ]; then src=(-v "$(cd "$from" && pwd):/restore-src:ro"); else src=(-v "$from_vol:/restore-src:ro"); fi

step "สร้าง volume ของ project $COMPOSE_PROJECT_NAME (ยังไม่เริ่ม container)"
dc up --no-start postgres backup >/dev/null  # backup ใช้ volume files ด้วย → compose สร้างครบ 3 volume
pgdata_vol="${COMPOSE_PROJECT_NAME}_pgdata"; backup_vol="${COMPOSE_PROJECT_NAME}_pgbackup"; files_vol="${COMPOSE_PROJECT_NAME}_files"

step "คัดลอก backup เข้า environment ใหม่ + เตรียม PGDATA (restore.sh)"
docker run --rm "${src[@]}" -v "$pgdata_vol:/var/lib/postgresql/data" -v "$backup_vol:/backup" -v "$files_vol:/data/files" \
  -v "$root/scripts/backup:/scripts:ro" -e BASE="$base" -e TARGET="$target" postgres:16-alpine sh -euc '
  [ -z "$(ls -A /var/lib/postgresql/data 2>/dev/null)" ] || { echo "pgdata ไม่ว่าง — ยกเลิก" >&2; exit 1; }
  mkdir -p /backup/restore-src /backup/wal /backup/base /backup/files
  cp -a /restore-src/wal /backup/restore-src/
  # ไม่ระบุ --base = ชุดล่าสุด (กู้ถึงล่าสุด) · ใช้ --target-time ต้องระบุ --base ที่เริ่มก่อนเวลานั้นเอง
  [ -n "$BASE" ] || [ -z "$TARGET" ] || { echo "ใช้ --target-time ต้องระบุ --base ด้วย" >&2; exit 1; }
  [ -n "$BASE" ] || BASE=$(ls -1 /restore-src/base | grep -E "^[0-9]{8}T[0-9]{6}Z$" | sort | tail -n1)
  [ -n "$BASE" ] || { echo "ไม่พบ base backup ที่ใช้ได้" >&2; exit 1; }
  echo "ใช้ base $BASE"
  cp -a "/restore-src/base/$BASE" /backup/restore-src/base-$BASE
  chown -R postgres:postgres /backup /var/lib/postgresql/data
  su-exec postgres sh /scripts/restore.sh --base "/backup/restore-src/base-$BASE" --wal /backup/restore-src/wal \
    --pgdata /var/lib/postgresql/data ${TARGET:+--target-time "$TARGET"}
  snap=$(ls -1 /restore-src/files 2>/dev/null | grep -E "^files-.*\.tar\.gz$" | sort | tail -n1 || true)
  if [ -n "$snap" ]; then
    (cd /restore-src/files && sha256sum -c "$snap.sha256")
    tar -xzf "/restore-src/files/$snap" -C /data/files && chown -R 1000:1000 /data/files
    echo "ไฟล์: กู้จาก $snap"
  else echo "ไฟล์: ไม่มี snapshot"; fi
  if [ -d /restore-src/files-mirror ]; then
    (cd /restore-src/files-mirror && find . -type f ! -name .LAST_SYNC) | while IFS= read -r f; do
      [ -e "/data/files/$f" ] || { mkdir -p "/data/files/$(dirname "$f")"; cp -p "/restore-src/files-mirror/$f" "/data/files/$f"; }
    done
    chown -R 1000:1000 /data/files
    echo "ไฟล์: เติมไฟล์ใหม่หลัง snapshot จาก files-mirror (sync ล่าสุด $(cat /restore-src/files-mirror/.LAST_SYNC 2>/dev/null))"
  fi
'

step "เริ่ม postgres → replay WAL → promote"
dc up -d --wait postgres
# เพดานรอ replay WAL (วินาที) — ค่าเริ่ม 3600 (WAL หลายชั่วโมงอาจนานกว่า 10 นาที) · ปรับด้วย RESTORE_WAIT_SEC
for _ in $(seq 1 "${RESTORE_WAIT_SEC:-3600}"); do
  r=$(dc exec -T postgres sh -c 'psql -XtA -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select pg_is_in_recovery()"' 2>/dev/null || true)
  [ "$r" = f ] && break
  sleep 1
done
[ "$r" = f ] || { echo "ฐานยังอยู่ใน recovery — ดู log: docker compose logs postgres" >&2; exit 1; }
step "promote แล้ว — ล้างค่า recovery ที่ restore.sh ใส่ (กันใช้ซ้ำโดยไม่ตั้งใจ)"
dc exec -T postgres sh -c 'psql -XqAt -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
ALTER SYSTEM RESET restore_command;
ALTER SYSTEM RESET recovery_target_time;
ALTER SYSTEM RESET recovery_target_action;
ALTER SYSTEM RESET recovery_target_timeline;
SELECT pg_reload_conf();
SQL
step "promote แล้ว — ตรวจฐาน (verify-restore.sh)"
dc exec -T postgres sh -c 'PGUSER=$POSTGRES_USER PGDATABASE=$POSTGRES_DB sh -s' < "$root/scripts/backup/verify-restore.sh"
step "กู้ฐาน + ไฟล์เสร็จ — ต่อ: scripts/deploy.sh $profile <tag> --skip-backup"
