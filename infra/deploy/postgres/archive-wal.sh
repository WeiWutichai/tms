#!/bin/sh
# ST9-T18 archive_command: archive-wal.sh %p %f → $WAL_ARCHIVE_DIR/<segment>.gz (gzip — ส่วนท้ายที่ว่างของ segment 16 MB บีบเหลือไม่กี่ KB)
# กติกา PostgreSQL: exit 0 = เก็บสำเร็จแน่นอนแล้วเท่านั้น · ไฟล์ชื่อซ้ำ: ตรงกันทุก byte = 0 (กรณี archive ซ้ำหลัง crash) · ไม่ตรง = ล้ม (ห้ามทับ)
set -eu
src=$1; name=$2
dir=${WAL_ARCHIVE_DIR:-/backup/wal}
dst="$dir/$name.gz"
if [ -f "$dst" ]; then
  gunzip -c "$dst" | cmp -s - "$src" && exit 0
  echo "archive-wal: $dst มีอยู่แล้วและเนื้อหาไม่ตรง — ไม่ทับ" >&2
  exit 1
fi
gzip -1 -c "$src" > "$dst.tmp"
sync "$dst.tmp" 2>/dev/null || sync
mv "$dst.tmp" "$dst"
