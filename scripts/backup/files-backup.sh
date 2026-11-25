#!/bin/sh
# ST9-T18 สำรองไฟล์ (PDF/POD/ไฟล์แนบ — FILES_ROOT) เป็น snapshot ตามรอบ base backup → "versioned" ตามจำนวน snapshot ที่เก็บ (30 วัน)
#   ผล: $BACKUP_DIR/files/files-<UTC ts>.tar.gz  (+ .sha256)
#   ไฟล์ที่ระบบเขียนแล้วไม่แก้ทับ (PDF ฉบับใหม่ = ไฟล์ใหม่) → snapshot ล่าสุด + base backup ล่าสุด สอดคล้องกันพอสำหรับกู้
#   เมื่อย้ายไป object storage ที่เปิด versioning: เลิกใช้สคริปต์นี้ [รอ cloud decision]
# env: FILES_DIR (ค่าเริ่ม /data/files) · BACKUP_DIR (ค่าเริ่ม /backup)
set -eu
BACKUP_DIR=${BACKUP_DIR:-/backup}
FILES_DIR=${FILES_DIR:-/data/files}
ts=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$BACKUP_DIR/files"
out="$BACKUP_DIR/files/files-$ts.tar.gz"
tar -czf "$out.tmp" -C "$FILES_DIR" .
mv "$out.tmp" "$out"
(cd "$BACKUP_DIR/files" && sha256sum "files-$ts.tar.gz" > "files-$ts.tar.gz.sha256")
echo "files-backup: $out ($(du -h "$out" | cut -f1))"
