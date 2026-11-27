#!/usr/bin/env bash
# P1-ST6-T07 สแกน CVE ของ image ที่ deploy (api runtime, migrate, web) — CVE ระดับ CRITICAL ที่มีรุ่นแก้แล้ว = exit 1
#   scripts/scan-images.sh                 สแกนเมื่อ branch แตะ infra/deploy, Dockerfile, .dockerignore, pnpm-lock.yaml หรือ .nvmrc
#                                          (เทียบ merge-base กับ origin/main รวมไฟล์ที่ยังไม่ commit) ไม่แตะ = ข้ามพร้อมข้อความ
#   SCAN_IMAGES=1 scripts/scan-images.sh   บังคับสแกน (release — go-live runbook / release-checklist บังคับ)
#   SCAN_IMAGES=0 scripts/scan-images.sh   ข้าม · ไม่มี docker / docker ไม่ทำงาน = ข้ามพร้อมข้อความ ไม่ทำให้ ci:local แดง
# tag ไม่ซ้ำต่อรอบ (<git sha>-<pid>) — หลาย lane รันพร้อมกันได้ · ลบ tag ทิ้งเมื่อจบ (layer cache ยังอยู่)
# ข้อยกเว้นรายตัว: infra/deploy/trivyignore (ต้องมีเหตุผล + วันทบทวน ทุกบรรทัด)
# [DECISION — lead 27 พ.ย. 2569, ย้อนได้] (1) นับเฉพาะ CRITICAL ที่มีรุ่นแก้แล้ว (--ignore-unfixed) — ตัวที่ distro ยังไม่ออก patch แก้ไม่ได้จากฝั่งเรา
#   และจะทำให้ gate แดงค้างตลอด · (2) ไม่มี docker ในเครื่อง = ข้าม (ไม่ใช่แดง) — GitHub CI job `scan-images` / เครื่อง release ต้องมี docker
#   · (3) Trivy ตรึงรุ่นด้วย digest (0.69.3 — ก่อนรุ่นที่ถูกเจาะ supply chain มี.ค. 2569) เปลี่ยนรุ่นต้องแก้ TRIVY_IMAGE ที่นี่ที่เดียว
#   · (4) สแกนอัตโนมัติเฉพาะเมื่อไฟล์ที่กำหนด image เปลี่ยน (build image ใช้เวลานาน) — release ต้องสแกนเสมอด้วย SCAN_IMAGES=1
set -euo pipefail
cd "$(dirname "$0")/.."
TRIVY_IMAGE="${TRIVY_IMAGE:-aquasec/trivy:0.69.3@sha256:bcc376de8d77cfe086a917230e818dc9f8528e3c852f7b1aff648949b6258d1c}"
REPO="tms-ci-scan"
TAG="$(git rev-parse --short HEAD 2>/dev/null || echo nogit)-$$"

skip() { printf '\033[1;33m⚠ ข้ามการสแกน CVE ของ image: %s\033[0m\n' "$1"; exit 0; }
case "${SCAN_IMAGES:-auto}" in
  0) skip "ตั้ง SCAN_IMAGES=0 ไว้ (release ต้องสแกนด้วย SCAN_IMAGES=1 — go-live runbook)" ;;
  1) ;;
  *)
    if base="$(git merge-base HEAD "${BASE:-origin/main}" 2>/dev/null)"; then
      changed="$( { git diff --name-only "$base"; git ls-files --others --exclude-standard; } \
        | grep -E '^(infra/deploy/|pnpm-lock\.yaml$|\.nvmrc$|\.dockerignore$)|Dockerfile' || true)"
      [ -n "$changed" ] || skip "branch นี้ไม่แตะไฟล์ที่กำหนด image (infra/deploy, Dockerfile, pnpm-lock.yaml, .nvmrc) — บังคับด้วย SCAN_IMAGES=1"
      echo "ไฟล์ที่กำหนด image เปลี่ยน: $(echo "$changed" | head -5 | tr '\n' ' ')"
    else
      echo "(หา merge-base กับ ${BASE:-origin/main} ไม่ได้ — สแกนไว้ก่อน)"
    fi
    ;;
esac
command -v docker >/dev/null 2>&1 || skip "ไม่พบคำสั่ง docker ในเครื่องนี้ (ติดตั้ง Docker แล้วรันใหม่ก่อน release)"
docker info >/dev/null 2>&1 || skip "docker daemon ไม่ทำงาน (เปิด Docker แล้วรันใหม่ก่อน release)"

cleanup() { docker image rm "$REPO/api:$TAG" "$REPO/migrate:$TAG" "$REPO/web:$TAG" >/dev/null 2>&1 || true; }
trap cleanup EXIT
# รุ่น playwright-core ตาม lockfile → layer Chromium ของ image runtime (api.Dockerfile ตรวจซ้ำว่าตรงกับ /app/node_modules)
PW_VERSION="$(sed -n 's/^  playwright-core@\([0-9][^:]*\):$/\1/p' pnpm-lock.yaml | head -1)"
echo "build image จาก working tree (tag $TAG — ครั้งแรกใช้เวลาหลายนาที ครั้งถัดไปใช้ cache) …"
docker build -q --build-arg "PLAYWRIGHT_CORE_VERSION=$PW_VERSION" -f infra/deploy/api.Dockerfile --target runtime -t "$REPO/api:$TAG" . >/dev/null
docker build -q --build-arg "PLAYWRIGHT_CORE_VERSION=$PW_VERSION" -f infra/deploy/api.Dockerfile --target migrate -t "$REPO/migrate:$TAG" . >/dev/null
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
