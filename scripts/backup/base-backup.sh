#!/bin/sh
# ST9-T18 base backup (pg_basebackup) — รันใน container `backup` (image postgres:16-alpine) หรือเครื่องที่มี pg_basebackup 16
#   ผล: $BACKUP_DIR/base/<UTC ts>/{base.tar.gz, pg_wal.tar.gz, backup_manifest, meta.env, SHA256SUMS}
#   -X stream = ใส่ WAL ที่ต้องใช้ให้ base นี้ "กู้ได้ด้วยตัวเอง" · ต่อจากนั้นใช้ WAL archive ($BACKUP_DIR/wal) กู้ถึงเวลาที่ต้องการ (PITR)
# env: PGHOST PGPORT PGUSER(=tms_backup, REPLICATION) PGPASSWORD · BACKUP_DIR (ค่าเริ่ม /backup)
set -eu
BACKUP_DIR=${BACKUP_DIR:-/backup}
ts=$(date -u +%Y%m%dT%H%M%SZ)
dst="$BACKUP_DIR/base/$ts"
tmp="$BACKUP_DIR/base/.inprogress-$ts"
mkdir -p "$BACKUP_DIR/base"
trap 'rm -rf "$tmp" "$tmp.log"' EXIT
start=$(date +%s)
start_time=$(date -u '+%Y-%m-%d %H:%M:%S UTC')
pg_basebackup -D "$tmp" -Ft -z -X stream -c fast --label "tms-$ts" --manifest-checksums=SHA256 -v 2> "$tmp.log" \
  || { cat "$tmp.log" >&2; rm -f "$tmp.log"; exit 1; }
end=$(date +%s)
# "write-ahead log start point: 0/AA000028 on timeline 1" → ชื่อ segment 0000000100000000000000AA (segment 16 MB)
lsn=$(sed -n 's/.*write-ahead log start point: \([0-9A-F]*\/[0-9A-F]*\) on timeline \([0-9]*\).*/\1 \2/p' "$tmp.log" | head -n1)
rm -f "$tmp.log"
set -- $lsn
[ $# = 2 ] || { echo "base-backup: อ่านจุดเริ่ม WAL จาก pg_basebackup -v ไม่ได้" >&2; exit 1; }
hi=${1%/*}; lo=${1#*/}
start_wal=$(printf '%08X%08X%08X' "$2" "0x$hi" "$(( 0x$lo >> 24 ))")
{
  echo "LABEL=tms-$ts"
  echo "START_WAL=$start_wal"
  echo "START_TIME='$start_time'"
  echo "DURATION_SEC=$((end - start))"
  echo "SIZE_BYTES=$(du -sk "$tmp" | awk '{print $1 * 1024}')"
} > "$tmp/meta.env"
(cd "$tmp" && sha256sum base.tar.gz pg_wal.tar.gz backup_manifest > SHA256SUMS)
mv "$tmp" "$dst"
trap - EXIT
date -u +%Y-%m-%dT%H:%M:%SZ > "$BACKUP_DIR/base/LAST_SUCCESS"
echo "base-backup: $dst ($((end - start)) วิ, start WAL $start_wal)"
