#!/usr/bin/env bash
# ตั้ง "lane" ให้ worktree นี้ — ฐานข้อมูล + พอร์ตของตัวเอง เพื่อรัน dev / pnpm test / pnpm ci:local ขนานกับ worktree อื่นได้
# ใช้: bash scripts/lane-init.sh <lane> <portBase>
#   เช่น bash scripts/lane-init.sh l2 4600 →
#     ฐาน dev tms_l2 (test: tms_l2_test, e2e: tms_l2_e2e — test/e2e สร้างเองตอนรัน)
#     E2E_API_PORT=4600 · E2E_WEB_PORT=4601 · API_PORT=4602 · WEB_PORT=4603
# ทำ: เขียน/แก้ .env (ไม่มีไฟล์ = คัดลอก .env.example) → สร้างฐาน tms_<lane> ถ้ายังไม่มี → build package ที่ API ใช้ → migrate → seed
# ต้องมี PostgreSQL จาก `pnpm db:up` (worktree ใช้ container เดียวกันได้ — แยกกันที่ชื่อฐาน) และ `pnpm install` แล้ว
# ไม่ลบ/ล้างฐานใด ๆ · รันซ้ำได้ (migrate/seed เป็น idempotent)
set -euo pipefail
cd "$(dirname "$0")/.."

lane="${1:-}"; base="${2:-}"
if ! [[ "$lane" =~ ^[a-z0-9]+$ ]] || ! [[ "$base" =~ ^[0-9]+$ ]] || [ "$base" -lt 1024 ] || [ "$base" -gt 65000 ]; then
  echo "ใช้: bash scripts/lane-init.sh <lane: a-z0-9> <portBase: 1024-65000>   เช่น  bash scripts/lane-init.sh l2 4600" >&2
  exit 2
fi
db="tms_${lane}"
case "$lane" in test|e2e|qa) echo "✘ ชื่อ lane \"$lane\" ชนกับ suffix ของฐาน test/e2e" >&2; exit 2 ;; esac

for p in "$base" "$((base + 1))" "$((base + 2))" "$((base + 3))"; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then echo "⚠ พอร์ต $p มีโปรแกรมใช้อยู่ (lsof -iTCP:$p -sTCP:LISTEN)" >&2; fi
done

[ -f .env ] || cp .env.example .env
# ตั้งค่า KEY=VALUE ใน .env (มีอยู่แล้ว = แทนที่, ไม่มี = ต่อท้าย)
setenv() {
  local k="$1" v="$2"
  if grep -qE "^${k}=" .env; then
    K="$k" V="$v" perl -0pi -e 's/^\Q$ENV{K}\E=.*$/$ENV{K}=$ENV{V}/m' .env
  else
    printf '%s=%s\n' "$k" "$v" >> .env
  fi
}
# เปลี่ยนเฉพาะชื่อฐานใน connection string (คง user/password/host/port/query เดิม)
for k in DATABASE_URL APP_DATABASE_URL PLATFORM_DATABASE_URL; do
  cur="$(grep -E "^${k}=" .env | head -1 | cut -d= -f2-)"
  [ -n "$cur" ] || { echo "✘ .env ไม่มี $k" >&2; exit 1; }
  setenv "$k" "$(CUR="$cur" DB="$db" node -e 'const u=new URL(process.env.CUR);u.pathname="/"+process.env.DB;console.log(u.toString())')"
done
setenv E2E_API_PORT "$base"
setenv E2E_WEB_PORT "$((base + 1))"
setenv API_PORT "$((base + 2))"
setenv WEB_PORT "$((base + 3))"

set -a; . ./.env; set +a
echo "lane $lane: ฐาน $db · E2E API $E2E_API_PORT / web $E2E_WEB_PORT · dev API $API_PORT / web $WEB_PORT"

pnpm -s --filter @tms/api exec prisma generate >/dev/null

# สร้างฐาน dev ของ lane (ต่อฐาน postgres ด้วย owner ใน DATABASE_URL)
(cd apps/api && DB="$db" node -e '
const { PrismaClient } = require("@prisma/client");
const u = new URL(process.env.DATABASE_URL); u.pathname = "/postgres";
const admin = new PrismaClient({ datasources: { db: { url: u.toString() } } });
(async () => {
  const rows = await admin.$queryRawUnsafe("SELECT 1 FROM pg_database WHERE datname = $1", process.env.DB);
  if (rows.length === 0) { await admin.$executeRawUnsafe(`CREATE DATABASE "${process.env.DB}"`); console.log("สร้างฐาน " + process.env.DB); }
  else console.log("มีฐาน " + process.env.DB + " แล้ว");
  await admin.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
')

pnpm -s --filter "@tms/api^..." build >/dev/null
pnpm -s --filter @tms/api db:migrate
pnpm -s --filter @tms/api db:seed

cat <<EOF

✔ lane $lane พร้อม
  dev:    set -a; . ./.env; set +a; pnpm --filter @tms/api dev   → http://localhost:$API_PORT/v1
          pnpm --filter @tms/web dev                               → http://localhost:$WEB_PORT (proxy /v1 → $API_PORT)
  test:   pnpm test        (ฐาน ${db}_test)
  CI:     pnpm ci:local    (ฐาน ${db}_test + ${db}_e2e · E2E พอร์ต $E2E_API_PORT/$E2E_WEB_PORT)
EOF
