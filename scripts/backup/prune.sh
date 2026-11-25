#!/bin/sh
# ST9-T18 ลบ backup เกินอายุ — เป้า plan/01: กู้ย้อนได้ทุกจุดในช่วง RETENTION_DAYS (30) วัน
#   base: เก็บทุกชุดที่ใหม่กว่าเส้นตัด + ชุดล่าสุดที่เก่ากว่าเส้นตัด 1 ชุด (จุดเริ่มกู้ของวันที่ 30)
#   WAL : ลบเฉพาะ segment ที่เก่ากว่า START_WAL ของ base ที่เก่าสุดที่ยังเก็บ (pg_archivecleanup)
#   files: snapshot เก่ากว่าเส้นตัด (เก็บล่าสุดที่เก่ากว่าเส้นตัด 1 ชุดเช่นกัน) · files-mirror ไม่ลบ (เพิ่มอย่างเดียว — ขนาด ≈ ไฟล์จริง)
# env: BACKUP_DIR (/backup) · RETENTION_DAYS (30) · DRY_RUN=1 แสดงอย่างเดียว
set -eu
BACKUP_DIR=${BACKUP_DIR:-/backup}
RETENTION_DAYS=${RETENTION_DAYS:-30}
cutoff=$(date -u -d "@$(( $(date +%s) - RETENTION_DAYS * 86400 ))" +%Y%m%dT%H%M%SZ)
run() { if [ "${DRY_RUN:-0}" = 1 ]; then echo "DRY_RUN: $*"; else "$@"; fi; }

# --- base ที่ค้างจากรอบที่ถูกฆ่ากลางทาง (.inprogress-*) เก่ากว่า 1 วัน ---
find "$BACKUP_DIR/base" -maxdepth 1 -name ".inprogress-*" -mmin +1440 2>/dev/null | while IFS= read -r d; do echo "prune: ลบ base ค้าง $d"; run rm -rf "$d"; done

# --- base ---
bases=$(ls -1 "$BACKUP_DIR/base" 2>/dev/null | grep -E '^[0-9]{8}T[0-9]{6}Z$' | sort || true)
keep_from=""
for b in $bases; do [ "$b" \< "$cutoff" ] || [ "$b" = "$cutoff" ] && keep_from=$b; done
[ -n "$keep_from" ] || keep_from=$(echo "$bases" | head -n1)
for b in $bases; do
  [ "$b" \< "$keep_from" ] && { echo "prune: ลบ base $b"; run rm -rf "$BACKUP_DIR/base/$b"; }
done
oldest=$(ls -1 "$BACKUP_DIR/base" 2>/dev/null | grep -E '^[0-9]{8}T[0-9]{6}Z$' | sort | head -n1 || true)
if [ -n "$oldest" ] && [ -f "$BACKUP_DIR/base/$oldest/meta.env" ]; then
  START_WAL=$(sed -n 's/^START_WAL=//p' "$BACKUP_DIR/base/$oldest/meta.env")
  echo "prune: ลบ WAL ก่อน $START_WAL (base เก่าสุด $oldest)"
  if [ "${DRY_RUN:-0}" = 1 ]; then pg_archivecleanup -n -x .gz "$BACKUP_DIR/wal" "$START_WAL"
  else pg_archivecleanup -x .gz "$BACKUP_DIR/wal" "$START_WAL"; fi
fi

# --- files ---
snaps=$(ls -1 "$BACKUP_DIR/files" 2>/dev/null | sed -n 's/^files-\([0-9]\{8\}T[0-9]\{6\}Z\)\.tar\.gz$/\1/p' | sort || true)
keep_from=""
for s in $snaps; do [ "$s" \< "$cutoff" ] || [ "$s" = "$cutoff" ] && keep_from=$s; done
for s in $snaps; do
  [ -n "$keep_from" ] && [ "$s" \< "$keep_from" ] && { echo "prune: ลบ files-$s"; run rm -f "$BACKUP_DIR/files/files-$s.tar.gz" "$BACKUP_DIR/files/files-$s.tar.gz.sha256"; }
done
exit 0
