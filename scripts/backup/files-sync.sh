#!/bin/sh
# ST9-T18 สำเนาไฟล์ใหม่แบบต่อเนื่อง (ระหว่างรอบ snapshot 6 ชม.) → $BACKUP_DIR/files-mirror (เพิ่มอย่างเดียว ไม่ลบ ไม่ทับ)
#   ทำให้ RPO ของไฟล์ (POD/ไฟล์แนบที่ผู้ใช้อัปโหลด ซึ่ง render ใหม่ไม่ได้) ≈ FILES_SYNC_MINUTES แทน 6 ชม.
#   ไฟล์ของระบบเขียนครั้งเดียว ไม่แก้ทับ → คัดลอกเฉพาะ path ที่ยังไม่มี (busybox `cp -n` ข้ามทั้งโฟลเดอร์ที่มีอยู่แล้ว จึงไล่ทีละไฟล์) · ตอนกู้: แตก snapshot ล่าสุดแล้วเติมจาก mirror (restore-env.sh)
# env: FILES_DIR (/data/files) · BACKUP_DIR (/backup) · FILES_SYNC_MIN_AGE_MIN (2)
set -eu
BACKUP_DIR=${BACKUP_DIR:-/backup}
FILES_DIR=${FILES_DIR:-/data/files}
M="$BACKUP_DIR/files-mirror"
mkdir -p "$M"
n=0
cd "$FILES_DIR"
# ข้ามไฟล์ที่แก้ล่าสุดไม่ถึง FILES_SYNC_MIN_AGE_MIN (2) นาที — อาจกำลังเขียนอยู่ (API เขียนลง path จริงตรง ๆ) · รอบถัดไปจะได้
find . -type f -mmin +"${FILES_SYNC_MIN_AGE_MIN:-2}" > "$M/.list.tmp"
while IFS= read -r f; do
  [ -e "$M/$f" ] && continue
  mkdir -p "$M/$(dirname "$f")"
  cp "$f" "$M/$f.tmp" && touch -r "$f" "$M/$f.tmp" && mv "$M/$f.tmp" "$M/$f"
  n=$((n + 1))
done < "$M/.list.tmp"
rm -f "$M/.list.tmp"
[ "$n" = 0 ] || echo "files-sync: สำเนาไฟล์ใหม่ $n ไฟล์"
date -u +%Y-%m-%dT%H:%M:%SZ > "$BACKUP_DIR/files-mirror/.LAST_SYNC"
