#!/bin/sh
# ST9-T18 กู้ฐานจาก base backup + WAL archive ลง PGDATA ใหม่ (ห้ามชี้ไปที่ PGDATA ที่มีข้อมูล — สคริปต์ปฏิเสธ)
# รันในเครื่อง/คอนเทนเนอร์ที่มี PostgreSQL 16 (image postgres:16-alpine) ในฐานะผู้ใช้ postgres:
#   restore.sh --base <dir ของ base backup> --wal <dir WAL archive> --pgdata <dir ว่าง> [--target-time '2026-11-25 10:00:00+07']
#   ไม่ใส่ --target-time = กู้ถึง WAL ล่าสุดที่มีใน archive (RPO ต่ำสุด)
# แล้วเริ่ม postgres ตามปกติด้วย PGDATA นั้น → replay WAL → promote เป็นฐานหลักเอง (timeline ใหม่)
# หลังขึ้น: scripts/backup/verify-restore.sh · ตั้ง archive ของ environment ใหม่ให้เป็นที่ใหม่ (ห้ามเขียนทับ archive ต้นทาง)
set -eu
base=""; wal=""; pgdata=""; target=""
while [ $# -gt 0 ]; do
  case $1 in
    --base) base=$2; shift 2 ;;
    --wal) wal=$2; shift 2 ;;
    --pgdata) pgdata=$2; shift 2 ;;
    --target-time) target=$2; shift 2 ;;
    *) echo "ไม่รู้จัก $1" >&2; exit 2 ;;
  esac
done
[ -n "$base" ] && [ -n "$wal" ] && [ -n "$pgdata" ] || { echo "ต้องมี --base --wal --pgdata" >&2; exit 2; }
[ -f "$base/base.tar.gz" ] || { echo "ไม่พบ $base/base.tar.gz" >&2; exit 1; }
if [ -d "$pgdata" ] && [ -n "$(ls -A "$pgdata" 2>/dev/null)" ]; then
  echo "PGDATA $pgdata ไม่ว่าง — ไม่กู้ทับ" >&2; exit 1
fi
(cd "$base" && sha256sum -c SHA256SUMS) || { echo "checksum ของ base backup ไม่ตรง" >&2; exit 1; }
mkdir -p "$pgdata"; chmod 700 "$pgdata"
tar -xzf "$base/base.tar.gz" -C "$pgdata"
[ -f "$base/pg_wal.tar.gz" ] && tar -xzf "$base/pg_wal.tar.gz" -C "$pgdata/pg_wal"
{
  echo ""
  echo "# --- ST9-T18 restore $(date -u +%FT%TZ) จาก $base ---"
  echo "restore_command = 'gunzip -c $wal/%f.gz > %p'"
  echo "recovery_target_timeline = 'latest'"
  echo "recovery_target_action = 'promote'"
  [ -n "$target" ] && echo "recovery_target_time = '$target'"
} >> "$pgdata/postgresql.auto.conf"
touch "$pgdata/recovery.signal"
echo "restore: เตรียม $pgdata แล้ว — เริ่ม postgres เพื่อ replay WAL${target:+ ถึง $target}"
