#!/usr/bin/env bash
# ST0-T03 สร้างไฟล์ env + กุญแจ OAuth ของ environment ใหม่ ด้วยค่าสุ่มจาก openssl ในเครื่อง (ไม่ส่งออกนอกเครื่อง)
#   scripts/deploy/gen-secrets.sh <profile>   → infra/deploy/<profile>.db.env, <profile>.env, keys-<profile>/<วันที่>.pem
# ไม่เขียนทับไฟล์ที่มีอยู่ · ค่าที่ต้องกรอกเอง (โดเมน, SMTP) ยังว่าง → check-env.sh จะบอก
# production: เมื่อเลือก cloud แล้วให้ย้ายค่าพวกนี้เข้า secret manager [รอ cloud decision] — ไฟล์นี้ใช้ได้ระหว่างนั้น (สิทธิ์ 600)
set -euo pipefail
profile=${1:?ใช้: gen-secrets.sh <profile>}
root=$(cd "$(dirname "$0")/../.." && pwd)
dir="$root/infra/deploy"
db="$dir/$profile.db.env"; app="$dir/$profile.env"; keys="$dir/keys-$profile"
for f in "$db" "$app"; do [ ! -e "$f" ] || { echo "มี $f อยู่แล้ว — ไม่เขียนทับ" >&2; exit 1; }; done
hex() { openssl rand -hex "${1:-24}"; }
b64() { openssl rand -base64 32; }
umask 077
sed -e "s|^POSTGRES_PASSWORD=$|POSTGRES_PASSWORD=$(hex)|" \
    -e "s|^POSTGRES_APP_PASSWORD=$|POSTGRES_APP_PASSWORD=$(hex)|" \
    -e "s|^POSTGRES_PLATFORM_PASSWORD=$|POSTGRES_PLATFORM_PASSWORD=$(hex)|" \
    -e "s|^POSTGRES_BACKUP_PASSWORD=$|POSTGRES_BACKUP_PASSWORD=$(hex)|" \
    -e "s|^OAUTH_KEYS_HOST_DIR=$|OAUTH_KEYS_HOST_DIR=$keys|" \
    "$dir/env/db.env.example" > "$db"
node_env=production; [ "$profile" = staging ] && node_env=staging
sed -e "s|^NODE_ENV=production$|NODE_ENV=$node_env|" \
    -e "s|^AUTH_JWT_SECRET=$|AUTH_JWT_SECRET=$(hex 32)|" \
    -e "s|^FIELD_ENCRYPTION_KEYS=$|FIELD_ENCRYPTION_KEYS=k$(date +%Y%m%d):$(b64)|" \
    -e "s|^BLIND_INDEX_KEY=$|BLIND_INDEX_KEY=$(b64)|" \
    -e "s|^API_KEY_PEPPER=$|API_KEY_PEPPER=$(hex 32)|" \
    -e "s|^DOCUMENT_URL_SECRET=$|DOCUMENT_URL_SECRET=$(hex 32)|" \
    -e "s|^MAGIC_LINK_SECRET=$|MAGIC_LINK_SECRET=$(hex 32)|" \
    -e "s|^METRICS_TOKEN=$|METRICS_TOKEN=$(hex 24)|" \
    "$dir/env/app.env.example" > "$app"
mkdir -p "$keys"
[ -n "$(ls "$keys"/*.pem 2>/dev/null)" ] || openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$keys/$(date +%Y-%m-%d).pem" 2>/dev/null
# container อ่านด้วยผู้ใช้ node (uid 1000): เป็น root บน Linux → chown 1000 + 700/600 · อื่น ๆ (ซ้อมในเครื่อง) → 755/644
if [ "$(id -u)" = 0 ]; then chown -R 1000:1000 "$keys"; chmod 700 "$keys"; chmod 600 "$keys"/*.pem
else chmod 755 "$keys"; chmod 644 "$keys"/*.pem; echo "คำเตือน: บนเซิร์ฟเวอร์ให้ sudo chown -R 1000:1000 $keys && chmod 700/600"; fi
echo "สร้างแล้ว: $db · $app · $keys"
echo "ต้องกรอกเอง: TMS_DOMAIN/ACME_EMAIL ($db) · PUBLIC_*_BASE_URL, EMAIL_SMTP_URL ($app) แล้วรัน scripts/deploy/check-env.sh $profile"
echo "สำรองไฟล์ทั้งสอง + กุญแจไว้นอกเครื่อง (เช่น password manager ของทีม) — FIELD_ENCRYPTION_KEYS/BLIND_INDEX_KEY หาย = ข้อมูลเข้ารหัสอ่านไม่ได้"
