#!/usr/bin/env bash
# ST0-T03 build image ทั้ง 3 ตัวจาก commit ปัจจุบัน: <repo>/api:<tag>, <repo>/migrate:<tag>, <repo>/web:<tag>
#   scripts/deploy/build-images.sh [tag] [--push]
#   tag ค่าเริ่ม = git short sha (+ "-dirty" ถ้ามีไฟล์ค้าง — ห้ามใช้ tag dirty กับ production)
#   --push = ส่งขึ้น registry ($TMS_IMAGE_REPO ต้องตั้ง) [รอ cloud decision: registry]
# ก่อน build สำหรับ production: pnpm ci:local ต้องเขียว (CLAUDE.md) · release-checklist
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
tag=""; push=0
for a in "$@"; do case $a in --push) push=1 ;; *) tag=$a ;; esac; done
if [ -z "$tag" ]; then
  tag=$(git -C "$root" rev-parse --short=12 HEAD)
  [ -z "$(git -C "$root" status --porcelain)" ] || tag="$tag-dirty"
fi
repo=${TMS_IMAGE_REPO:-tms}
rev=$(git -C "$root" rev-parse HEAD)
# รุ่น Chromium ของ image runtime ตาม playwright-core ใน lockfile (api.Dockerfile ตรวจซ้ำ)
pw=$(sed -n 's/^  playwright-core@\([0-9][^:]*\):$/\1/p' "$root/pnpm-lock.yaml" | head -1)
labels=(--build-arg "PLAYWRIGHT_CORE_VERSION=$pw" --label "org.opencontainers.image.revision=$rev" --label "org.opencontainers.image.version=$tag")
cd "$root"
docker build -f infra/deploy/api.Dockerfile --target runtime "${labels[@]}" -t "$repo/api:$tag" .
docker build -f infra/deploy/api.Dockerfile --target migrate "${labels[@]}" -t "$repo/migrate:$tag" .
docker build -f infra/deploy/web.Dockerfile "${labels[@]}" -t "$repo/web:$tag" .
if [ $push = 1 ]; then
  [ -n "${TMS_IMAGE_REPO:-}" ] || { echo "--push ต้องตั้ง TMS_IMAGE_REPO" >&2; exit 1; }
  for i in api migrate web; do docker push "$repo/$i:$tag"; done
fi
echo "$tag"
