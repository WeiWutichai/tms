#!/bin/sh
# ST9-T18 ตรวจความสด (ใช้กับ cron/monitoring ภายนอก): exit 1 ถ้า
#   base backup สำเร็จล่าสุดเก่ากว่า MAX_BASE_AGE_HOURS (7 = รอบ 6 ชม. + เผื่อ) หรือ
#   WAL ที่ archive ล่าสุดเก่ากว่า MAX_WAL_AGE_MIN (15 — archive_timeout 60 วิ แต่ไม่มีงานเขียนก็ไม่สลับ segment)
# env: BACKUP_DIR (/backup)
set -eu
BACKUP_DIR=${BACKUP_DIR:-/backup}
now=$(date +%s); rc=0
last=$(cat "$BACKUP_DIR/base/LAST_SUCCESS" 2>/dev/null || echo "")
if [ -z "$last" ]; then echo "ยังไม่มี base backup สำเร็จ"; rc=1
else
  age=$(( (now - $(date -u -d "$(echo "$last" | sed 's/T/ /; s/Z//')" +%s)) / 3600 ))
  echo "base ล่าสุด $last (${age} ชม.)"; [ "$age" -lt "${MAX_BASE_AGE_HOURS:-7}" ] || rc=1
fi
w=$(ls -1t "$BACKUP_DIR/wal" 2>/dev/null | grep -E '^[0-9A-F]{24}\.gz$' | head -n1 || true)
if [ -z "$w" ]; then echo "ยังไม่มี WAL ใน archive"; rc=1
else
  wage=$(( (now - $(stat -c %Y "$BACKUP_DIR/wal/$w")) / 60 ))
  echo "WAL ล่าสุด $w (${wage} นาที)"; [ "$wage" -lt "${MAX_WAL_AGE_MIN:-15}" ] || rc=1
fi
exit $rc
