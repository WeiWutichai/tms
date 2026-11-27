#!/usr/bin/env bash
# รันขั้นตอนเดียวกับ .github/workflows/ci.yml ในเครื่อง — ต้องเขียวทั้งหมดก่อน push / เปิด PR (PO สั่ง 10 พ.ย. 2569)
# ใช้: pnpm ci:local            (เทียบ OpenAPI กับ origin/main)
#      BASE=origin/xyz pnpm ci:local
# ต้องมี PostgreSQL จาก `pnpm db:up` และไฟล์ .env
# ทุกขั้นใช้ .env ของ worktree นี้ (ฐาน dev/test/e2e + พอร์ต E2E) — หลาย worktree รันพร้อมกันได้ถ้าแต่ละอันเป็น lane ของตัวเอง
# (scripts/lane-init.sh — ดู HANDOFF §ทำงานขนาน)
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "✘ ไม่มีไฟล์ .env (cp .env.example .env หรือ scripts/lane-init.sh)"; exit 1; }
set -a; . ./.env; set +a
tmp="$(mktemp -d "${TMPDIR:-/tmp}/tms-ci-local.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
db="${DATABASE_URL##*/}"; db="${db%%\?*}"
echo "ฐาน dev: $db (test: ${db}_test · e2e: ${db}_e2e) · พอร์ต E2E: API ${E2E_API_PORT:-4510} / web ${E2E_WEB_PORT:-4520}"
BASE="${BASE:-origin/main}"
step() { printf '\n\033[1;34m▶ %s\033[0m\n' "$1"; }
start=$(date +%s)

step "Node ตรงกับ .nvmrc (P1-ST6-T07 — CI และ image ใช้รุ่นเดียวกัน)"
# เทียบเฉพาะ major · .nvmrc แบบ alias (เช่น lts/*) แปลงผ่าน nvm · ไม่ตรงและมี nvm = สลับให้เองแล้วตรวจซ้ำ
node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo none; }
nvmrc="$(tr -d ' \n' < .nvmrc)"
want_major() {
  local v="${nvmrc#v}"
  if [[ "$v" =~ ^[0-9]+ ]]; then echo "${BASH_REMATCH[0]}"
  elif command -v nvm >/dev/null 2>&1; then v="$(nvm version "$nvmrc" 2>/dev/null || true)"; v="${v#v}"; echo "${v%%.*}"
  else echo "$nvmrc"; fi
}
want="$(want_major)"; have="$(node_major)"
if [ "$have" != "$want" ] && [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  set +u; . "${NVM_DIR:-$HOME/.nvm}/nvm.sh" --no-use || true; nvm use --silent >/dev/null 2>&1 || true; set -u
  want="$(want_major)"; have="$(node_major)"
  [ "$have" = "$want" ] && echo "สลับเป็น Node $(node -v) ด้วย nvm (ตาม .nvmrc)"
fi
if [ "$have" != "$want" ]; then echo "✘ ใช้ Node $(node -v 2>/dev/null) แต่ .nvmrc = $nvmrc — รัน \`nvm install && nvm use\` แล้วลองใหม่"; exit 1; fi
command -v pnpm >/dev/null 2>&1 || { echo "✘ Node $(node -v) ยังไม่มี pnpm — รัน \`corepack enable && corepack prepare pnpm@<รุ่นใน package.json packageManager> --activate\`"; exit 1; }
echo "Node $(node -v) · pnpm $(pnpm -v)"

step "ไม่มีไฟล์ค้างที่ยังไม่ commit (CI เห็นเฉพาะที่ commit)"
if [ -n "$(git status --porcelain)" ]; then git status --short; echo "✘ มีไฟล์ยังไม่ commit"; exit 1; fi

step "migrate ฐาน dev ให้ล่าสุด"
(pnpm -s --filter "@tms/api^..." build >/dev/null && pnpm -s --filter @tms/api db:migrate >/dev/null) # build package ที่ API ใช้ แล้ว migrate + bootstrap tenant (ทางเดียวกับ CI/test/e2e)
pnpm -s --filter @tms/api exec prisma generate >/dev/null

step "lint";        pnpm -s lint
step "typecheck";   pnpm -s typecheck
step "test (unit + integration + isolation + seed + PDF golden + KRS contract)"; pnpm -s test
step "OpenAPI ตรงกับโค้ด"; pnpm -s --filter @tms/api openapi:check
step "เอกสาร API / Postman / llms.txt ตรงกับ openapi.json (ST7-T12)"; pnpm -s --filter @tms/api-docs docs:check
step "help center ตรงกับบทความ/catalog error · ลิงก์และภาพไม่ขาด (P1-ST6-T01)"; pnpm -s --filter "@tms/help-center^..." build >/dev/null && pnpm -s --filter @tms/help-center docs:check
step "OpenAPI breaking-change gate เทียบ $BASE"
git fetch -q origin || true
if git show "$BASE:packages/contracts/openapi.json" > "$tmp/base-openapi.json" 2>/dev/null; then
  pnpm -s --filter @tms/api openapi:diff "$tmp/base-openapi.json"
else
  echo "(ไม่มี openapi.json บน $BASE — ข้าม)"
fi
step "build";       pnpm -s build
step "E2E";         pnpm -s e2e
step "CVE gate (critical)"; pnpm -s audit --audit-level=critical
step "CVE ของ image ที่ deploy (critical — P1-ST6-T07)"; bash scripts/scan-images.sh

printf '\n\033[1;32m✔ CI ในเครื่องเขียวทั้งหมด (%ss) — push ได้\033[0m\n' "$(( $(date +%s) - start ))"
