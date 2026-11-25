#!/usr/bin/env bash
# ST0-T03 ตรวจไฟล์ env ก่อน deploy (checklist G-14 ของ runbook) — exit 1 ถ้าพบปัญหา
#   scripts/deploy/check-env.sh <profile>     (อ่าน infra/deploy/<profile>.db.env + <profile>.env — ไม่ source ไฟล์, อ่านทีละบรรทัด)
set -uo pipefail
profile=${1:?ใช้: check-env.sh <profile>}
root=$(cd "$(dirname "$0")/../.." && pwd)
db="$root/infra/deploy/$profile.db.env"; app="$root/infra/deploy/$profile.env"
err=0
fail() { echo "✗ $*"; err=1; }
for f in "$db" "$app"; do
  [ -f "$f" ] || { echo "✗ ไม่พบ $f (สร้างด้วย scripts/deploy/gen-secrets.sh $profile)"; exit 1; }
  # GNU stat ก่อน (บน Linux `stat -f` = ข้อมูล file system ไม่ใช่สิทธิ์ไฟล์) แล้วค่อย BSD/macOS
  perm=$(stat -c %a "$f" 2>/dev/null || stat -f %Lp "$f")
  [ "$perm" = 600 ] || fail "$f ควรมีสิทธิ์ 600 (ตอนนี้ $perm)"
done
val() { # val <file> <KEY> → ค่าบรรทัดสุดท้ายที่ไม่ใช่ comment
  grep -E "^$2=" "$1" | tail -n1 | cut -d= -f2- || true
}
has() { [ -n "$(val "$1" "$2")" ]; }

for k in POSTGRES_PASSWORD POSTGRES_APP_PASSWORD POSTGRES_PLATFORM_PASSWORD POSTGRES_BACKUP_PASSWORD OAUTH_KEYS_HOST_DIR TMS_DOMAIN; do
  has "$db" "$k" || fail "$profile.db.env: ต้องตั้ง $k"
done
for k in POSTGRES_PASSWORD POSTGRES_APP_PASSWORD POSTGRES_PLATFORM_PASSWORD POSTGRES_BACKUP_PASSWORD; do
  v=$(val "$db" "$k"); [ -z "$v" ] || [[ "$v" =~ ^[A-Za-z0-9]{24,}$ ]] || fail "$k ต้องเป็นตัวอักษร/ตัวเลข ≥ 24 ตัว (ใส่ใน URL ตรง ๆ)"
done
dom=$(val "$db" TMS_DOMAIN)
if [ -n "$dom" ] && [ "${dom#:}" = "$dom" ]; then has "$db" ACME_EMAIL || fail "TMS_DOMAIN เป็นโดเมนจริง ต้องตั้ง ACME_EMAIL (ใบรับรอง TLS)"; fi
keys=$(val "$db" OAUTH_KEYS_HOST_DIR)
[ -z "$keys" ] || ls "$keys"/*.pem >/dev/null 2>&1 || fail "OAUTH_KEYS_HOST_DIR ($keys) ไม่มีไฟล์ .pem"

node_env=$(val "$app" NODE_ENV)
case "$node_env" in production|staging) ;; *) fail "NODE_ENV ต้องเป็น production หรือ staging (ตอนนี้ '$node_env')" ;; esac
for k in AUTH_JWT_SECRET FIELD_ENCRYPTION_KEYS BLIND_INDEX_KEY API_KEY_PEPPER DOCUMENT_URL_SECRET MAGIC_LINK_SECRET METRICS_TOKEN TRUST_PROXY PUBLIC_WEB_BASE_URL PUBLIC_API_BASE_URL EMAIL_SMTP_URL EMAIL_FROM; do
  has "$app" "$k" || fail "$profile.env: ต้องตั้ง $k"
done
for k in AUTH_JWT_SECRET API_KEY_PEPPER DOCUMENT_URL_SECRET MAGIC_LINK_SECRET; do
  v=$(val "$app" "$k"); [ -z "$v" ] || [ ${#v} -ge 32 ] || fail "$k ต้องยาว ≥ 32 ตัว"
done
v=$(val "$app" METRICS_TOKEN); [ -z "$v" ] || [ ${#v} -ge 24 ] || fail "METRICS_TOKEN ต้องยาว ≥ 24 ตัว"
# ค่าตัวอย่างของ repo (.env.example) — API/worker ไม่ยอมเริ่มอยู่แล้ว (R2-M01) แต่จับให้ได้ก่อน deploy
grep -q "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=" "$app" && fail "FIELD_ENCRYPTION_KEYS ใช้กุญแจ dev ของ .env.example"
grep -q "YmxpbmQtaW5kZXgtZGV2LW9ubHktMDEyMzQ1Njc4OWE=" "$app" && fail "BLIND_INDEX_KEY ใช้กุญแจ dev ของ .env.example"
for k in AUTH_DEV_SECRET WEBHOOK_ALLOW_PRIVATE_TARGETS; do has "$app" "$k" && fail "ห้ามตั้ง $k นอก dev/test"; done
[ "$(val "$app" TRIP_COSTING_ENABLED)" = 0 ] && fail "TRIP_COSTING_ENABLED=0 (ปิดต้นทุนเที่ยว) — G-14 ห้ามปิดใน production"
[ "$(val "$app" EMAIL_TRANSPORT)" = log ] && fail "EMAIL_TRANSPORT=log ใช้ได้เฉพาะ dev/test"
[ "$(val "$app" GEO_PROVIDER)" = mock ] && fail "GEO_PROVIDER=mock ใช้ได้เฉพาะ dev/test"
if [ "$node_env" = production ]; then
  has "$app" ERP_DEMO_ADAPTERS && fail "production ห้ามตั้ง ERP_DEMO_ADAPTERS (G-14)"
fi
if [ $err = 0 ]; then echo "✓ env ของ $profile ผ่าน"; fi
exit $err
