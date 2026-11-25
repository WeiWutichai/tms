#!/usr/bin/env bash
# ST0-T03 deploy / rollback ด้วย image tag (runbook docs/ops/st9-t23-go-live-runbook.md §2)
#
#   scripts/deploy.sh <profile> <tag>              deploy: ตรวจ env → backup ก่อน (D-1) → migrate (D-2) → ขึ้น api/worker/web/proxy (D-3) → readyz
#   scripts/deploy.sh <profile> --rollback [tag]   rollback (R-1): ถอย image ไป tag ก่อนหน้า (หรือที่ระบุ) — ไม่ย้อน migration (expand-only)
#   ตัวเลือก: --skip-backup (เฉพาะ environment ที่ยังไม่มีข้อมูล) · --no-proxy (ไม่ขึ้น Caddy — ใช้ตอนซ้อมที่ไม่มีพอร์ต 80)
#
#   profile = staging | production | ชื่ออื่น (ซ้อม) → ไฟล์ infra/deploy/<profile>.db.env + <profile>.env · project compose = tms-<profile>
#   (ตั้ง TMS_PROJECT=<ชื่อ> เพื่อเปลี่ยนชื่อ project — เช่นซ้อมกู้คืน)
#   ประวัติ tag ที่ขึ้น: infra/deploy/state/<profile>.history (ใช้หา tag ก่อนหน้าตอน rollback)
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
profile=""; tag=""; rollback=0; skip_backup=0; no_proxy=0
for a in "$@"; do
  case $a in
    --rollback) rollback=1 ;;
    --skip-backup) skip_backup=1 ;;
    --no-proxy) no_proxy=1 ;;
    -*) echo "ไม่รู้จัก $a" >&2; exit 2 ;;
    *) if [ -z "$profile" ]; then profile=$a; else tag=$a; fi ;;
  esac
done
[ -n "$profile" ] || { sed -n '2,12p' "$0"; exit 2; }
dir="$root/infra/deploy"
hist="$dir/state/$profile.history"
mkdir -p "$dir/state"
if [ $rollback = 1 ] && [ -z "$tag" ]; then
  cur=$(tail -n1 "$hist" 2>/dev/null | awk '{print $2}')
  tag=$(awk -v c="$cur" '$2 != c {t=$2} END {print t}' "$hist" 2>/dev/null)
  [ -n "$tag" ] || { echo "ไม่พบ tag ก่อนหน้าใน $hist — ระบุ tag เอง" >&2; exit 1; }
  echo "rollback: $cur → $tag"
fi
[ -n "$tag" ] || { echo "ต้องระบุ tag" >&2; exit 2; }
[[ "$profile" != production || "$tag" != *-dirty ]] || { echo "production ห้ามใช้ image tag -dirty" >&2; exit 1; }

bash "$root/scripts/deploy/check-env.sh" "$profile"

export TMS_TAG=$tag
export TMS_APP_ENV_FILE="$dir/$profile.env"
export COMPOSE_PROJECT_NAME=${TMS_PROJECT:-tms-$profile}
dc() { docker compose -f "$dir/docker-compose.prod.yml" --env-file "$dir/$profile.db.env" --env-file "$dir/$profile.env" "$@"; }
step() { echo "[$(date '+%F %T')] $*"; }

if [ -n "${TMS_IMAGE_REPO:-}" ]; then step "ดึง image $TMS_IMAGE_REPO/*:$tag"; dc --profile migrate pull api web migrate; fi
for i in api web $([ $rollback = 1 ] || echo migrate); do
  docker image inspect "${TMS_IMAGE_REPO:-tms}/$i:$tag" >/dev/null 2>&1 || { echo "ไม่พบ image ${TMS_IMAGE_REPO:-tms}/$i:$tag (scripts/deploy/build-images.sh $tag)" >&2; exit 1; }
done

step "ฐานข้อมูล + backup (project $COMPOSE_PROJECT_NAME)"
dc up -d --wait postgres backup

if [ $skip_backup = 0 ]; then
  step "D-1 base backup ก่อน deploy"
  dc exec -T backup sh /scripts/base-backup.sh
fi

if [ $rollback = 0 ]; then
  step "D-2 migration (prisma migrate deploy + bootstrap-tenants)"
  dc --profile migrate run --rm migrate
else
  step "R-1 rollback: ไม่รัน migration (schema ใหม่ใช้กับโค้ดเก่าได้ — expand-only)"
fi

services=(api worker web); [ $no_proxy = 1 ] || services+=(proxy)
step "D-3 ขึ้น ${services[*]} ที่ tag $tag"
dc up -d --wait "${services[@]}"

step "ตรวจ /v1/readyz"
ok=0
for _ in $(seq 1 30); do
  if out=$(dc exec -T api node -e "fetch('http://127.0.0.1:4410/v1/readyz').then(async r=>{console.log(r.status, await r.text());process.exit(r.status===200?0:1)}).catch(e=>{console.log(e.message);process.exit(1)})"); then ok=1; break; fi
  sleep 2
done
echo "$out"
[ $ok = 1 ] || { echo "readyz ไม่ผ่าน — พิจารณา rollback: scripts/deploy.sh $profile --rollback" >&2; exit 1; }
if [ $no_proxy = 0 ]; then
  step "ตรวจ proxy → web (หน้าแรก)"
  ok=0
  for _ in $(seq 1 15); do
    dc exec -T api node -e "fetch('http://proxy/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" && { ok=1; break; }
    sleep 2
  done
  [ $ok = 1 ] || { echo "proxy ไม่ตอบ — ดู: docker compose logs proxy" >&2; exit 1; }
fi
echo "$(date -u +%FT%TZ) $tag $([ $rollback = 1 ] && echo rollback || echo deploy)" >> "$hist"
step "เสร็จ — ต่อด้วย smoke D-4 (runbook §2) และดู error rate 15 นาที (D-5)"
