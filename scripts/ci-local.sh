#!/usr/bin/env bash
# รันขั้นตอนเดียวกับ .github/workflows/ci.yml ในเครื่อง — ต้องเขียวทั้งหมดก่อน push / เปิด PR (PO สั่ง 10 พ.ย. 2569)
# ใช้: pnpm ci:local            (เทียบ OpenAPI กับ origin/main)
#      BASE=origin/xyz pnpm ci:local
# ต้องมี PostgreSQL จาก `pnpm db:up` และไฟล์ .env
set -euo pipefail
cd "$(dirname "$0")/.."
BASE="${BASE:-origin/main}"
step() { printf '\n\033[1;34m▶ %s\033[0m\n' "$1"; }
start=$(date +%s)

step "ไม่มีไฟล์ค้างที่ยังไม่ commit (CI เห็นเฉพาะที่ commit)"
if [ -n "$(git status --porcelain)" ]; then git status --short; echo "✘ มีไฟล์ยังไม่ commit"; exit 1; fi

step "migrate ฐาน dev ให้ล่าสุด"
(set -a; . ./.env; set +a; pnpm -s --filter "@tms/api^..." build >/dev/null && pnpm -s --filter @tms/api db:migrate >/dev/null) # build package ที่ API ใช้ แล้ว migrate + bootstrap tenant (ทางเดียวกับ CI/test/e2e)
pnpm -s --filter @tms/api exec prisma generate >/dev/null

step "lint";        pnpm -s lint
step "typecheck";   pnpm -s typecheck
step "test (unit + integration + isolation + seed + PDF golden + KRS contract)"; pnpm -s test
step "OpenAPI ตรงกับโค้ด"; pnpm -s --filter @tms/api openapi:check
step "OpenAPI breaking-change gate เทียบ $BASE"
git fetch -q origin || true
if git show "$BASE:packages/contracts/openapi.json" > /tmp/tms-base-openapi.json 2>/dev/null; then
  pnpm -s --filter @tms/api openapi:diff /tmp/tms-base-openapi.json
else
  echo "(ไม่มี openapi.json บน $BASE — ข้าม)"
fi
step "build";       pnpm -s build
step "E2E";         pnpm -s e2e
step "CVE gate (critical)"; pnpm -s audit --audit-level=critical

printf '\n\033[1;32m✔ CI ในเครื่องเขียวทั้งหมด (%ss) — push ได้\033[0m\n' "$(( $(date +%s) - start ))"
