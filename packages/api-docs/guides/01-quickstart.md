# เริ่มต้นใช้งาน (Quickstart)

สร้างใบสั่งขนส่ง (order) แรกใน **Sandbox** ภายใน 15 นาที — ข้อมูล Sandbox แยกจากข้อมูลจริงทั้งหมด ลองได้ไม่ต้องกลัวพัง

## สิ่งที่ต้องมี

- บัญชีผู้ใช้ TMS ที่เข้าเมนู **ตั้งค่า → นักพัฒนา / Open API** ได้ (เจ้าของ/ผู้ดูแล หรือบทบาทที่มีสิทธิ์ตั้งค่า) และแพ็กเกจที่เปิด Open API
- บริษัทตั้งนิติบุคคล (ตั้งค่า → นิติบุคคลและสาขา) แล้วอย่างน้อย 1 ราย — Sandbox ได้สำเนานิติบุคคลของบริษัทไปใช้ออกบิล
- เครื่องที่มี `bash`, `curl` และ `jq` หรือ Node.js 20 ขึ้นไป (ถ้าจะใช้ TypeScript SDK)

## 1. สร้าง API key ของ Sandbox

1. เข้า **ตั้งค่า → นักพัฒนา / Open API** แล้วกดสวิตช์มุมขวาเป็น **Sandbox** (ครั้งแรกระบบสร้าง Sandbox ของบริษัทให้อัตโนมัติ · ระหว่างอยู่โหมดนี้หน้าจะมีแถบสีส้ม "SANDBOX")
2. แท็บ **API keys** → **สร้าง API key** → ตั้งชื่อ เช่น `quickstart` และเลือก scope: `companies:read` `master:read` `master:write` `orders:read` `orders:write` (ถ้าจะลองยิง webhook จำลองต่อ เพิ่ม `settings:read` และ `events:read`)
3. คัดลอก secret ที่ขึ้นต้นด้วย `tk_test_` — **แสดงครั้งเดียว** เก็บไว้ใน secret manager ห้ามใส่ในโค้ดฝั่ง browser

โหมดของคำขอขึ้นกับ key ไม่ใช่ URL: key `tk_test_` เข้าถึงได้เฉพาะข้อมูล Sandbox, key `tk_live_` เฉพาะข้อมูลจริง

## 2. ตั้งค่าตัวแปร

ทุกคำสั่งใช้ `curl --fail-with-body` และ `jq -e` ร่วมกับ `set -euo pipefail` — คำขอไหนไม่สำเร็จ สคริปต์หยุดทันทีและ curl แสดง `curl: (22) … error: <HTTP status>` (รันคำสั่งนั้นซ้ำโดยตัด `| jq …` ออกเพื่อดู error แบบ problem+json — ดู [รหัส error](errors.md))

```bash
set -euo pipefail
export TMS_BASE_URL="https://api.tms.example"   # base URL ที่ได้รับจากผู้ให้บริการ (ไม่ต้องใส่ /v1)
export TMS_API_KEY="tk_test_..."                # secret จากขั้นที่ 1
```

ทดสอบว่า key ใช้ได้ (ได้ `200` และรายการ `{"data":[...],"nextCursor":...,"hasMore":...}`):

```bash
curl -sS --fail-with-body "$TMS_BASE_URL/v1/orders?limit=1" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

## 3. เลือกนิติบุคคลที่ออกบิล

บริษัทที่มีนิติบุคคลมากกว่า 1 ราย ต้องระบุ `billingCompanyId` ทุกใบ (หรือตั้ง "ออกบิลในนาม" ที่ลูกค้า/ค่าตั้งต้นของบริษัท) — ไม่งั้นได้ `422 validation_failed` ที่มี `errors[].code = routing_not_configured` (`errors[].field = billingCompanyId`)

```bash
COMPANY_ID=$(curl -sS --fail-with-body "$TMS_BASE_URL/v1/companies?limit=50" \
  -H "Authorization: Bearer $TMS_API_KEY" | jq -er '.data[0].id')
echo "$COMPANY_ID"
```

## 4. สร้างลูกค้า

ทุกขั้นใช้ `PUT …/external/{externalId}` (upsert ด้วยรหัสของระบบคุณ) — รันซ้ำได้ ได้รายการเดิม ไม่สร้างซ้ำ

```bash
CUSTOMER_ID=$(curl -sS --fail-with-body -X PUT "$TMS_BASE_URL/v1/customers/external/QS-CUS-001" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"legalName":"บริษัท ลูกค้าทดลอง จำกัด"}' | jq -er .id)
echo "$CUSTOMER_ID"
```

## 5. สร้างจุดรับและจุดส่ง

```bash
PICKUP_ID=$(curl -sS --fail-with-body -X PUT "$TMS_BASE_URL/v1/customer-sites/external/QS-SITE-PICKUP" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"คลังสินค้าบางนา","kind":"PICKUP","customerId":"'"$CUSTOMER_ID"'","address":{"line1":"99 ถ.บางนา-ตราด ต.บางแก้ว อ.บางพลี จ.สมุทรปราการ 10540"}}' | jq -er .id)
```

```bash
DROPOFF_ID=$(curl -sS --fail-with-body -X PUT "$TMS_BASE_URL/v1/customer-sites/external/QS-SITE-DROPOFF" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"ร้านค้าปลายทาง ชลบุรี","kind":"DROPOFF","customerId":"'"$CUSTOMER_ID"'","address":{"line1":"1 ถ.สุขุมวิท ต.บ้านสวน อ.เมืองชลบุรี จ.ชลบุรี 20000"}}' | jq -er .id)
```

## 6. สร้างใบสั่งขนส่ง

วันรับของ = พรุ่งนี้ตามเวลาไทย (คำสั่ง `date` รองรับทั้ง macOS และ Linux)

```bash
PICKUP_DATE=$(TZ=Asia/Bangkok date -v+1d +%F 2>/dev/null || TZ=Asia/Bangkok date -d tomorrow +%F)
ORDER_ID=$(curl -sS --fail-with-body -X PUT "$TMS_BASE_URL/v1/orders/external/QS-ORDER-001" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"customer":{"id":"'"$CUSTOMER_ID"'"},"billingCompanyId":"'"$COMPANY_ID"'","requestedDate":"'"$PICKUP_DATE"'","stops":[{"type":"PICKUP","siteId":"'"$PICKUP_ID"'","windowStart":"'"$PICKUP_DATE"'T08:00:00+07:00"},{"type":"DELIVERY","siteId":"'"$DROPOFF_ID"'","windowEnd":"'"$PICKUP_DATE"'T17:00:00+07:00"}],"lines":[{"description":"น้ำดื่มบรรจุขวด","qty":"120","unit":"ลัง","weightKg":"1800"}]}' | jq -er .id)
echo "$ORDER_ID"
```

ได้ `201` (สร้างใหม่) หรือ `200` (รันซ้ำ = อัปเดตใบเดิม) และ `id` ขึ้นต้นด้วย `ord_` — สถานะ `received` หรือ `on_hold` — ใน Sandbox ใหม่ใบนี้จะเป็น `on_hold` เหตุ `RATE_MISSING` (ยังไม่มีตารางราคาของลูกค้า/เส้นทางนี้; ดู `holdReason` / `holdCodes`) ซึ่งถือว่ารับใบสำเร็จแล้ว — ใบจะไปต่อเมื่อมีราคาที่อนุมัติ หรือตั้งราคาเอง

## 7. อ่านใบสั่งกลับ

```bash
curl -sS --fail-with-body "$TMS_BASE_URL/v1/orders/$ORDER_ID" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

เสร็จแล้ว — ใบนี้อยู่ใน Sandbox ตรวจได้ผ่าน API (`GET /v1/orders`) เท่านั้น: หน้าจอ **ใบสั่งขนส่ง** ในเว็บแสดงข้อมูลจริงเสมอ ไม่แสดงข้อมูล Sandbox

## ทำแบบเดียวกันด้วย TypeScript SDK

ติดตั้ง `@tms/sdk` (ดู [TypeScript SDK](sdk.md)) แล้วรันไฟล์นี้ด้วย `TMS_BASE_URL=… TMS_API_KEY=… npx tsx quickstart.ts`

<!-- include: examples/quickstart.ts -->

## ขั้นต่อไป

- [ยืนยันตัวตน](authentication.md) — OAuth2 client credentials, scope, IP allowlist
- [แนวทางการใช้ API](conventions.md) — Idempotency-Key, pagination, ETag/If-Match, รูปแบบ error
- Webhook: สมัคร endpoint (ต้องเป็น `https://`) ในหน้าเว็บ **นักพัฒนา / Open API → Webhooks** โหมด Sandbox — API key อ่านข้อมูล webhook ได้อย่างเดียว สร้าง/แก้ endpoint ไม่ได้ · ยิง event จำลองด้วย `POST /v1/test/events/trigger` (key ต้องมี `settings:read`; ดูผลส่งที่ `GET /v1/webhook-deliveries` ใช้ `settings:read`, ดู event ที่ `GET /v1/events/{id}` ใช้ `events:read`) — ดู [Sandbox](sandbox.md) และ [Webhook และการตรวจลายเซ็น](webhooks.md)
- [ใบสั่งขนส่ง (orders)](ref-orders.md) — ทุก endpoint ของ orders
