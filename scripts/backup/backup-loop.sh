#!/bin/sh
# ST9-T18 ตัววนของ container `backup` (docker-compose.prod.yml)
#   ทุก BACKUP_INTERVAL_HOURS (6) ชม.: base backup → files snapshot → prune
#   ทุก FILES_SYNC_MINUTES (15) นาที: files-sync (สำเนาไฟล์ใหม่) 
#   หลังทุกรอบ: BACKUP_OFFSITE_CMD (ถ้าตั้ง) คัดลอก /backup ออกนอกเครื่อง [รอ cloud decision]
# ล้มรอบไหน = log + รอรอบถัดไป (LAST_SUCCESS ไม่ขยับ → check-backup.sh / alert จับได้)
set -u
here=$(dirname "$0")
interval=$(( ${BACKUP_INTERVAL_HOURS:-6} * 3600 ))
tick=$(( ${FILES_SYNC_MINUTES:-15} * 60 ))
offsite() { [ -z "${BACKUP_OFFSITE_CMD:-}" ] || sh -c "$BACKUP_OFFSITE_CMD" || echo "backup-loop: off-site copy ล้ม $(date -u +%FT%TZ)" >&2; }
until pg_isready -q; do sleep 5; done
next_full=0
while true; do
  now=$(date +%s)
  if [ "$now" -ge "$next_full" ]; then
    echo "backup-loop: เริ่มรอบเต็ม $(date -u +%FT%TZ)"
    if sh "$here/base-backup.sh" && sh "$here/files-backup.sh" && sh "$here/prune.sh"; then
      echo "backup-loop: รอบเต็มสำเร็จ $(date -u +%FT%TZ)"
      next_full=$(( now + interval ))
    else
      echo "backup-loop: รอบเต็มล้ม $(date -u +%FT%TZ) — ลองใหม่ในรอบถัดไป" >&2
      next_full=$(( now + tick ))
    fi
  fi
  sh "$here/files-sync.sh" || echo "backup-loop: files-sync ล้ม $(date -u +%FT%TZ)" >&2
  offsite
  sleep "$tick"
done
