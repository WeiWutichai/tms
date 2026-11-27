#!/usr/bin/env bash
# P1-ST6-T07 สแกน CVE ของ image ที่ deploy (api runtime, migrate, web) — CVE ระดับ CRITICAL ที่มีรุ่นแก้แล้ว = exit 1
#   scripts/scan-images.sh            build image จาก working tree ปัจจุบัน (tag ci-scan) แล้วสแกนด้วย Trivy (docker image)
#   SCAN_IMAGES=0 scripts/scan-images.sh   ข้าม (บอกเหตุชัด) · ไม่มี docker / docker ไม่ทำงาน = ข้ามพร้อมข้อความ ไม่ทำให้ ci:local แดง
# ข้อยกเว้นรายตัว: infra/deploy/trivyignore (ต้องมีเหตุผล + วันหมดอายุ ทุกบรรทัด)
# [DECISION — lead 27 พ.ย. 2569, ย้อนได้] (1) นับเฉพาะ CRITICAL ที่มีรุ่นแก้แล้ว (--ignore-unfixed) — ตัวที่ distro ยังไม่ออก patch แก้ไม่ได้จากฝั่งเรา
#   และจะทำให้ gate แดงค้างตลอด · (2) ไม่มี docker ในเครื่อง = ข้าม (ไม่ใช่แดง) ตามที่ lead สั่ง — GitHub CI / เครื่อง release ต้องมี docker
#   · (3) Trivy ตรึงรุ่นด้วย digest (0.69.3 — ก่อนรุ่นที่ถูกเจาะ supply chain มี.ค. 2569) เปลี่ยนรุ่นต้องแก้ TRIVY_IMAGE ที่นี่ที่เดียว
set -euo pipefail
cd "$(dirname "$0")/.."
TRIVY_IMAGE="${TRIVY_IMAGE:-aquasec/trivy:0.69.3@sha256:bcc376de8d77cfe086a917230e818dc9f8528e3c852f7b1aff648949b6258d1c}"
REPO="tms-ci-scan"
TAG="ci-scan"

skip() { printf '\033[1;33m⚠ ข้ามการสแกน CVE ของ image: %s\033[0m\n' "$1"; exit 0; }
[ "${SCAN_IMAGES:-1}" = "0" ] && skip "ตั้ง SCAN_IMAGES=0 ไว้ (ต้องสแกนก่อน release — release-checklist)"
command -v docker >/dev/null 2>&1 || skip "ไม่พบคำสั่ง docker ในเครื่องนี้ (ติดตั้ง Docker แล้วรันใหม่ก่อน release)"
docker info >/dev/null 2>&1 || skip "docker daemon ไม่ทำงาน (เปิด Docker แล้วรันใหม่ก่อน release)"

echo "build image จาก working tree (tag $TAG — ครั้งแรกใช้เวลาหลายนาที ครั้งถัดไปใช้ cache) …"
docker build -q -f infra/deploy/api.Dockerfile --target runtime -t "$REPO/api:$TAG" . >/dev/null
docker build -q -f infra/deploy/api.Dockerfile --target migrate -t "$REPO/migrate:$TAG" . >/dev/null
docker build -q -f infra/deploy/web.Dockerfile -t "$REPO/web:$TAG" . >/dev/null

mount=(); ignore=()
if [ -f infra/deploy/trivyignore ]; then mount=(-v "$PWD/infra/deploy/trivyignore:/trivyignore:ro"); ignore=(--ignorefile /trivyignore); fi
fail=0
for img in api migrate web; do
  echo "สแกน $REPO/$img:$TAG (CRITICAL, มีรุ่นแก้แล้ว) …"
  # ฐานข้อมูล CVE เก็บใน volume tms-trivy-cache (ไม่โหลดใหม่ทุกครั้ง)
  if ! docker run --rm \
      -v /var/run/docker.sock:/var/run/docker.sock \
      -v tms-trivy-cache:/root/.cache/trivy ${mount[@]+"${mount[@]}"} \
      "$TRIVY_IMAGE" image --quiet --scanners vuln --severity CRITICAL --ignore-unfixed \
      --exit-code 1 --no-progress ${ignore[@]+"${ignore[@]}"} \
      "$REPO/$img:$TAG"; then
    fail=1
  fi
done
if [ $fail = 1 ]; then
  echo "✘ image มี CVE ระดับ CRITICAL ที่แก้ได้ — อัปเดต base image / dependency (หรือบันทึกข้อยกเว้นใน infra/deploy/trivyignore พร้อมเหตุผล)"
  exit 1
fi
echo "✔ image ไม่มี CVE ระดับ CRITICAL ที่แก้ได้ (api, migrate, web)"
