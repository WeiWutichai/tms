# ตารางราคา (rate-cards)

13 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`GET /v1/rate-cards`](#get-rate-cards) | `master:read` |
| [`POST /v1/rate-cards`](#post-rate-cards) | `prices.sell:write` / `prices.buy:write` |
| [`GET /v1/rate-cards/summary`](#get-rate-cards-summary) | `master:read` |
| [`GET /v1/rate-cards/export`](#get-rate-cards-export) | `export:run` |
| [`PUT /v1/rate-cards/external/{externalId}`](#put-rate-cards-external-externalId) | `prices.sell:write` / `prices.buy:write` |
| [`PATCH /v1/rate-cards/external/{externalId}`](#patch-rate-cards-external-externalId) | `prices.sell:write` / `prices.buy:write` |
| [`GET /v1/rate-cards/{id}`](#get-rate-cards-id) | `master:read` |
| [`PATCH /v1/rate-cards/{id}`](#patch-rate-cards-id) | `prices.sell:write` / `prices.buy:write` |
| [`GET /v1/rate-cards/{id}/history`](#get-rate-cards-id-history) | `master:read` |
| [`POST /v1/rate-cards/{id}/revise`](#post-rate-cards-id-revise) | `prices.sell:write` / `prices.buy:write` |
| [`POST /v1/rate-cards/{id}/approve`](#post-rate-cards-id-approve) | `prices.sell:write` / `prices.buy:write` |
| [`POST /v1/rate-cards/{id}/cancel`](#post-rate-cards-id-cancel) | `prices.sell:write` / `prices.buy:write` |
| [`POST /v1/rate-cards/{id}/delete`](#post-rate-cards-id-delete) | `prices.sell:write` / `prices.buy:write` |

## GET /v1/rate-cards {#get-rate-cards}

`GET /v1/rate-cards`

scope: `master:read` · operationId: `RateCards_list`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน (ใช้กับ sort เดิมเท่านั้น) |
| `updatedAfter` | query |   | `string` | คืนเฉพาะแถวที่ updatedAt > ค่านี้ (incremental pull) |
| `sort` | query |   | `string` ค่า: `code`, `updatedAt`, `-updatedAt` | code = เรียงตามรหัส (ค่าเริ่มต้นของหน้าจอ) · updatedAt/-updatedAt สำหรับ sync |
| `fields` | query |   | `string` | รายชื่อ field คั่นด้วย, เช่น id,code |
| `q` | query |   | `string` | ค้นหา — รหัส ชื่อลูกค้า/ผู้รับเหมา ชื่อ/รหัสต้นทางหรือปลายทาง externalId (ไม่สนตัวพิมพ์) |
| `side` | query |   | `string` ค่า: `SELL`, `BUY` | ฝั่ง — ไม่ส่ง: มี carrierId = BUY ไม่งั้น SELL · ขัดกับ customerId/carrierId → 422 `wrong_side` |
| `status` | query |   | `string` | สถานะ คั่นด้วย, (draft / pending_approval / active / expired / retired) — active/expired คิดจากวันที่ (เวลาไทย) |
| `nearExpiry` | query |   | `string` ค่า: `true`, `false` | true = ใช้งานอยู่และหมดอายุภายใน 30 วัน (ต้นแบบ "หมดอายุใน 30 วัน") |
| `customerId` | query |   | `string` | เฉพาะลูกค้านี้ (cus_…) |
| `carrierId` | query |   | `string` | เฉพาะรถร่วมนี้ (car_…) — ขาซื้อ |
| `party` | query |   | `string` | ชื่อ/รหัสลูกค้า (ขาขาย) หรือผู้รับเหมา (ขาซื้อ) มีคำนี้ (ตัวกรองคอลัมน์แรก) |
| `originId` | query |   | `string` | ต้นทางตรงตัว (loc_…) |
| `destinationId` | query |   | `string` | ปลายทางตรงตัว (loc_…) |
| `route` | query |   | `string` | ชื่อ/รหัสต้นทางหรือปลายทางมีคำนี้ (ตัวกรองคอลัมน์ "เส้นทาง") |
| `vehicleTypeId` | query |   | `string` | ประเภทรถ (vty_…) |
| `pricingModel` | query |   | `string` ค่า: `PER_TRIP`, `PER_KM`, `PER_TON`, `PER_CBM`, `PER_UNIT` |   |
| `externalId` | query |   | `string` | externalId ตรงตัว |
| `includeDeleted` | query |   | `string` | true = รวมร่างที่ถูกลบ (tombstone มี `deletedAt`) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `RateCardPageDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/rate-cards" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/rate-cards');
```

## POST /v1/rate-cards {#post-rate-cards}

`POST /v1/rate-cards`

scope: `prices.sell:write` หรือ `prices.buy:write` · operationId: `RateCards_create`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `Idempotency-Key` | header |   | `string` |   |

**Request body** `CreateRateCardDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `pricingModel` |   | `string` | ค่า: `PER_TRIP`, `PER_KM`, `PER_TON`, `PER_CBM`, `PER_UNIT` | สูตรราคา |   |
| `unitId` |   | `string` | null ได้ | หน่วยนับ (ชนิด COUNT เช่น ชิ้น พาเลท) — บังคับเมื่อ PER_UNIT, สูตรอื่นต้องเป็น null | `unt_3f2a…` |
| `sellRate` |   | `string` |   | ราคาขายต่อหน่วยของสูตร (บาท) — ต่อเที่ยว/กม./ตัน/ลบ.ม./หน่วย · rate ขาขาย · ต้องมีสิทธิ์ `prices.sell:write` (เห็นเมื่อมี `prices.sell:read`) | `6500.00` |
| `sellMinCharge` |   | `string` | null ได้ | ขั้นต่ำต่อเที่ยว (บาท) — ผล = max(ราคาคำนวณ, ขั้นต่ำ) · null = ไม่มี | `1500.00` |
| `sellExtraStopRate` |   | `string` | null ได้ | ค่าจุดเพิ่มต่อจุด เมื่อจำนวนจุดเกิน `includedStops` · null = ไม่คิด | `300.00` |
| `buyRate` |   | `string` |   | ราคาซื้อต่อหน่วยของสูตร (บาท) — rate ขาซื้อ · ต้องมีสิทธิ์ `prices.buy:write` (เห็นเมื่อมี `prices.buy:read`) | `5200.00` |
| `buyMinCharge` |   | `string` | null ได้ | ขั้นต่ำต่อเที่ยว (บาท) ขาซื้อ · null = ไม่มี | `1200.00` |
| `buyExtraStopRate` |   | `string` | null ได้ | ค่าจุดเพิ่มต่อจุด ขาซื้อ (เกิน `includedStops`) · null = ไม่คิด | `250.00` |
| `includedStops` |   | `number` | ≥ 0 · ≤ 99 | จำนวนจุดที่รวมในราคา (N) — ค่าเริ่มต้น 2 (รับ 1 + ส่ง 1) | `2` |
| `validFrom` |   | `string (date)` |   | มีผลตั้งแต่ (รวมวันนี้) | `2026-11-01` |
| `validTo` |   | `string (date)` | null ได้ | ถึง (รวมวันนี้) ≥ validFrom · null = ไม่มีวันหมด | `2027-10-31` |
| `accessorials` |   | `array<RateAccessorialInputDto>` |   | ราคาค่าบริการเสริมเฉพาะ rate นี้ — ส่ง = แทนทั้งชุด (ไม่ส่ง = คงเดิม) · สูงสุด 50 รายการ ห้ามซ้ำ |   |
| `accessorials[].serviceItemId` | ใช่ | `string` |   | ค่าบริการเสริม (`service-items`) ฝั่งขาย/ทั้งคู่ | `svc_3f2a…` |
| `accessorials[].sellPrice` |   | `string` |   | ราคาขาย (บาท ก่อน VAT) ทศนิยม ≤ 2 — rate ขาขายเท่านั้น · ต้องมีสิทธิ์ `prices.sell:write` | `300.00` |
| `accessorials[].buyPrice` |   | `string` |   | ราคาซื้อ (บาท ก่อน VAT) ทศนิยม ≤ 2 — rate ขาซื้อเท่านั้น · ต้องมีสิทธิ์ `prices.buy:write` | `250.00` |
| `notes` |   | `string` | ยาว ≤ 1000 · null ได้ | หมายเหตุ |   |
| `customerId` |   | `string` |   | ลูกค้า (ขาขายเท่านั้น) | `cus_3f2a…` |
| `carrierId` |   | `string` |   | รถร่วม/ผู้รับเหมา | `car_3f2a…` |
| `originId` |   | `string` |   | ต้นทาง (สถานที่) | `loc_3f2a…` |
| `destinationId` |   | `string` |   | ปลายทาง (สถานที่) — ต่างจากต้นทาง | `loc_8c1d…` |
| `vehicleTypeId` |   | `string` |   | ประเภทรถ | `vty_3f2a…` |
| `serviceItemId` |   | `string` |   | รายการบนเอกสารที่กำหนด vat_type/wht_rate ของค่าขนส่งจาก rate นี้ — ไม่ส่งตอนสร้าง = ค่าขนส่ง (FREIGHT) | `svc_3f2a…` |
| `side` |   | `string` | ค่า: `SELL`, `BUY` | ฝั่ง — SELL (ลูกค้า, ต้องมี `prices.sell:write`) · BUY (รถร่วม, ต้องมี `prices.buy:write`) |   |
| `code` |   | `string` |   | รหัส — ไม่ส่ง = ระบบออกเลขถัดไป (ขาขาย RC-S-0001 · ขาซื้อ RC-B-0001) | `RC-S-0001` |
| `externalId` |   | `string` |   | รหัสในระบบต้นทาง — เรียกด้วย ext:{externalId} ได้ |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `201` |   | `RateCardDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`prices.sell:write` / `prices.buy:write` — มีตัวใดตัวหนึ่งก็พอ) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/rate-cards" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"sellRate":"6500.00","buyRate":"5200.00","includedStops":2,"validFrom":"2026-11-01","customerId":"cus_3f2a…","carrierId":"car_3f2a…","originId":"loc_3f2a…","destinationId":"loc_8c1d…","vehicleTypeId":"vty_3f2a…","serviceItemId":"svc_3f2a…","code":"RC-S-0001"}'
```

```ts
const { data, error } = await tms.POST('/v1/rate-cards', {
  body: {
    "sellRate": "6500.00",
    "buyRate": "5200.00",
    "includedStops": 2,
    "validFrom": "2026-11-01",
    "customerId": "cus_3f2a…",
    "carrierId": "car_3f2a…",
    "originId": "loc_3f2a…",
    "destinationId": "loc_8c1d…",
    "vehicleTypeId": "vty_3f2a…",
    "serviceItemId": "svc_3f2a…",
    "code": "RC-S-0001"
  },
});
```

## GET /v1/rate-cards/summary {#get-rate-cards-summary}

`GET /v1/rate-cards/summary`

scope: `master:read` · operationId: `RateCards_summary`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `side` | query |   | `string` ค่า: `SELL`, `BUY` | ฝั่ง — ไม่ส่ง: มี carrierId = BUY ไม่งั้น SELL · ขัดกัน → 422 `wrong_side` |
| `customerId` | query |   | `string` | เฉพาะลูกค้านี้ (cus_…) |
| `carrierId` | query |   | `string` | เฉพาะรถร่วมนี้ (car_…) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `RateCardSummaryDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/rate-cards/summary" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/rate-cards/summary');
```

## GET /v1/rate-cards/export {#get-rate-cards-export}

`GET /v1/rate-cards/export`

scope: `export:run` · operationId: `RateCards_export`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน (ใช้กับ sort เดิมเท่านั้น) |
| `updatedAfter` | query |   | `string` | คืนเฉพาะแถวที่ updatedAt > ค่านี้ (incremental pull) |
| `sort` | query |   | `string` ค่า: `code`, `updatedAt`, `-updatedAt` | code = เรียงตามรหัส (ค่าเริ่มต้นของหน้าจอ) · updatedAt/-updatedAt สำหรับ sync |
| `fields` | query |   | `string` | รายชื่อ field คั่นด้วย, เช่น id,code |
| `q` | query |   | `string` | ค้นหา — รหัส ชื่อลูกค้า/ผู้รับเหมา ชื่อ/รหัสต้นทางหรือปลายทาง externalId (ไม่สนตัวพิมพ์) |
| `side` | query |   | `string` ค่า: `SELL`, `BUY` | ฝั่ง — ไม่ส่ง: มี carrierId = BUY ไม่งั้น SELL · ขัดกับ customerId/carrierId → 422 `wrong_side` |
| `status` | query |   | `string` | สถานะ คั่นด้วย, (draft / pending_approval / active / expired / retired) — active/expired คิดจากวันที่ (เวลาไทย) |
| `nearExpiry` | query |   | `string` ค่า: `true`, `false` | true = ใช้งานอยู่และหมดอายุภายใน 30 วัน (ต้นแบบ "หมดอายุใน 30 วัน") |
| `customerId` | query |   | `string` | เฉพาะลูกค้านี้ (cus_…) |
| `carrierId` | query |   | `string` | เฉพาะรถร่วมนี้ (car_…) — ขาซื้อ |
| `party` | query |   | `string` | ชื่อ/รหัสลูกค้า (ขาขาย) หรือผู้รับเหมา (ขาซื้อ) มีคำนี้ (ตัวกรองคอลัมน์แรก) |
| `originId` | query |   | `string` | ต้นทางตรงตัว (loc_…) |
| `destinationId` | query |   | `string` | ปลายทางตรงตัว (loc_…) |
| `route` | query |   | `string` | ชื่อ/รหัสต้นทางหรือปลายทางมีคำนี้ (ตัวกรองคอลัมน์ "เส้นทาง") |
| `vehicleTypeId` | query |   | `string` | ประเภทรถ (vty_…) |
| `pricingModel` | query |   | `string` ค่า: `PER_TRIP`, `PER_KM`, `PER_TON`, `PER_CBM`, `PER_UNIT` |   |
| `externalId` | query |   | `string` | externalId ตรงตัว |
| `includeDeleted` | query |   | `string` | true = รวมร่างที่ถูกลบ (tombstone มี `deletedAt`) |
| `format` | query |   | `string` ค่า: `xlsx`, `csv` |   |
| `ids` | query |   | `string` | ส่งออกเฉพาะ id เหล่านี้ (คั่นด้วย,) — แถวที่เลือกในตาราง |
| `X-Step-Up` | header |   | `string` | stepUpToken จาก `POST /v1/auth/step-up` (ยืนยัน TOTP อายุ 5 นาที) — ผู้ใช้ต้องส่งเมื่อส่งออกทั้งบริษัท: ไม่มีตัวกรองที่จำกัดแถว (ไม่มี filter/`ids` หรือค่าว่าง/`all`) หรือ resource `accounting-*` ไม่งั้น 403 `step_up_required` · API key / OAuth client ไม่ต้อง |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | ไฟล์.xlsx หรือ.csv ตามตัวกรองเดียวกับรายการ (สูงสุด 10,000 แถว) — คอลัมน์ราคาเฉพาะผู้มี `prices.sell:read` (ขาขาย) / `prices.buy:read` (ขาซื้อ) |   |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`export:run`) · ต้องยืนยัน 2FA ซ้ำ (`step_up_required`) เมื่อส่งออกทั้งบริษัท: ไม่มีตัวกรองที่จำกัดแถว (ไม่มี filter/`ids` หรือค่าว่าง/`all`) หรือ resource `accounting-*` — [permission_denied](errors.md#permission_denied), [step_up_required](errors.md#step_up_required) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/rate-cards/export" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/rate-cards/export');
```

## PUT /v1/rate-cards/external/{externalId} {#put-rate-cards-external-externalId}

`PUT /v1/rate-cards/external/{externalId}`

scope: `prices.sell:write` หรือ `prices.buy:write` · operationId: `RateCards_upsertExternal`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `externalId` | path | ใช่ | `string` | เลขของระบบต้นทาง (ASCII ที่พิมพ์ได้ 1–100 ตัว ไม่มีช่องว่าง) — unique ต่อ tenant ต่อ resource |
| `If-Match` | header |   | `string` | ETag — ใช้เมื่อแถวมีอยู่แล้ว |

**Request body** `UpsertRateCardDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `pricingModel` |   | `string` | ค่า: `PER_TRIP`, `PER_KM`, `PER_TON`, `PER_CBM`, `PER_UNIT` | สูตรราคา |   |
| `unitId` |   | `string` | null ได้ | หน่วยนับ (ชนิด COUNT เช่น ชิ้น พาเลท) — บังคับเมื่อ PER_UNIT, สูตรอื่นต้องเป็น null | `unt_3f2a…` |
| `sellRate` |   | `string` |   | ราคาขายต่อหน่วยของสูตร (บาท) — ต่อเที่ยว/กม./ตัน/ลบ.ม./หน่วย · rate ขาขาย · ต้องมีสิทธิ์ `prices.sell:write` (เห็นเมื่อมี `prices.sell:read`) | `6500.00` |
| `sellMinCharge` |   | `string` | null ได้ | ขั้นต่ำต่อเที่ยว (บาท) — ผล = max(ราคาคำนวณ, ขั้นต่ำ) · null = ไม่มี | `1500.00` |
| `sellExtraStopRate` |   | `string` | null ได้ | ค่าจุดเพิ่มต่อจุด เมื่อจำนวนจุดเกิน `includedStops` · null = ไม่คิด | `300.00` |
| `buyRate` |   | `string` |   | ราคาซื้อต่อหน่วยของสูตร (บาท) — rate ขาซื้อ · ต้องมีสิทธิ์ `prices.buy:write` (เห็นเมื่อมี `prices.buy:read`) | `5200.00` |
| `buyMinCharge` |   | `string` | null ได้ | ขั้นต่ำต่อเที่ยว (บาท) ขาซื้อ · null = ไม่มี | `1200.00` |
| `buyExtraStopRate` |   | `string` | null ได้ | ค่าจุดเพิ่มต่อจุด ขาซื้อ (เกิน `includedStops`) · null = ไม่คิด | `250.00` |
| `includedStops` |   | `number` | ≥ 0 · ≤ 99 | จำนวนจุดที่รวมในราคา (N) — ค่าเริ่มต้น 2 (รับ 1 + ส่ง 1) | `2` |
| `validFrom` |   | `string (date)` |   | มีผลตั้งแต่ (รวมวันนี้) | `2026-11-01` |
| `validTo` |   | `string (date)` | null ได้ | ถึง (รวมวันนี้) ≥ validFrom · null = ไม่มีวันหมด | `2027-10-31` |
| `accessorials` |   | `array<RateAccessorialInputDto>` |   | ราคาค่าบริการเสริมเฉพาะ rate นี้ — ส่ง = แทนทั้งชุด (ไม่ส่ง = คงเดิม) · สูงสุด 50 รายการ ห้ามซ้ำ |   |
| `accessorials[].serviceItemId` | ใช่ | `string` |   | ค่าบริการเสริม (`service-items`) ฝั่งขาย/ทั้งคู่ | `svc_3f2a…` |
| `accessorials[].sellPrice` |   | `string` |   | ราคาขาย (บาท ก่อน VAT) ทศนิยม ≤ 2 — rate ขาขายเท่านั้น · ต้องมีสิทธิ์ `prices.sell:write` | `300.00` |
| `accessorials[].buyPrice` |   | `string` |   | ราคาซื้อ (บาท ก่อน VAT) ทศนิยม ≤ 2 — rate ขาซื้อเท่านั้น · ต้องมีสิทธิ์ `prices.buy:write` | `250.00` |
| `notes` |   | `string` | ยาว ≤ 1000 · null ได้ | หมายเหตุ |   |
| `customerId` |   | `string` |   | ลูกค้า (ขาขายเท่านั้น) | `cus_3f2a…` |
| `carrierId` |   | `string` |   | รถร่วม/ผู้รับเหมา | `car_3f2a…` |
| `originId` |   | `string` |   | ต้นทาง (สถานที่) | `loc_3f2a…` |
| `destinationId` |   | `string` |   | ปลายทาง (สถานที่) — ต่างจากต้นทาง | `loc_8c1d…` |
| `vehicleTypeId` |   | `string` |   | ประเภทรถ | `vty_3f2a…` |
| `serviceItemId` |   | `string` |   | รายการบนเอกสารที่กำหนด vat_type/wht_rate ของค่าขนส่งจาก rate นี้ — ไม่ส่งตอนสร้าง = ค่าขนส่ง (FREIGHT) | `svc_3f2a…` |
| `side` |   | `string` | ค่า: `SELL`, `BUY` | ฝั่ง — ใช้ตอนสร้าง; แถวที่มีอยู่แล้วต้องเป็นฝั่งเดิม (ต่าง → 422 `side_locked`) |   |
| `code` |   | `string` |   | ใช้ตอนสร้างเท่านั้น | `RC-S-0001` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | มีอยู่แล้ว (ร่าง) → แก้ (ส่งซ้ำได้ ไม่เกิดแถวใหม่) | `RateCardDto` |
| `201` | ยังไม่มี → สร้างร่าง | `RateCardDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`prices.sell:write` / `prices.buy:write` — มีตัวใดตัวหนึ่งก็พอ) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `409` | ขัดกับข้อมูลที่มีอยู่ (เช่น รหัส/ชื่อซ้ำ, สถานะไม่อนุญาตให้แก้) — [conflict](errors.md#conflict), [duplicate](errors.md#duplicate) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง (รวมทุกช่องใน errors[]) — externalId ใน path ผิดรูปแบบ = field `externalId` — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PUT "$TMS_BASE_URL/v1/rate-cards/external/<externalId>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"sellRate":"6500.00","buyRate":"5200.00","includedStops":2,"validFrom":"2026-11-01","customerId":"cus_3f2a…","carrierId":"car_3f2a…","originId":"loc_3f2a…","destinationId":"loc_8c1d…","vehicleTypeId":"vty_3f2a…","serviceItemId":"svc_3f2a…","code":"RC-S-0001"}'
```

```ts
const { data, error } = await tms.PUT('/v1/rate-cards/external/{externalId}', {
  params: { path: { externalId: "…" } },
  body: {
    "sellRate": "6500.00",
    "buyRate": "5200.00",
    "includedStops": 2,
    "validFrom": "2026-11-01",
    "customerId": "cus_3f2a…",
    "carrierId": "car_3f2a…",
    "originId": "loc_3f2a…",
    "destinationId": "loc_8c1d…",
    "vehicleTypeId": "vty_3f2a…",
    "serviceItemId": "svc_3f2a…",
    "code": "RC-S-0001"
  },
});
```

## แก้บางช่องด้วย externalId {#patch-rate-cards-external-externalId}

`PATCH /v1/rate-cards/external/{externalId}`

scope: `prices.sell:write` หรือ `prices.buy:write` · operationId: `RateCards_patchExternal`

เหมือน `PATCH /rate-cards/ext:{externalId}` (กติกาเดียวกับ PATCH ด้วย id) · ยังไม่มีแถวนี้ → 404 — สร้างใหม่ใช้ PUT

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `externalId` | path | ใช่ | `string` | เลขของระบบต้นทาง (ASCII ที่พิมพ์ได้ 1–100 ตัว ไม่มีช่องว่าง) — unique ต่อ tenant ต่อ resource |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `UpdateRateCardDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `pricingModel` |   | `string` | ค่า: `PER_TRIP`, `PER_KM`, `PER_TON`, `PER_CBM`, `PER_UNIT` | สูตรราคา |   |
| `unitId` |   | `string` | null ได้ | หน่วยนับ (ชนิด COUNT เช่น ชิ้น พาเลท) — บังคับเมื่อ PER_UNIT, สูตรอื่นต้องเป็น null | `unt_3f2a…` |
| `sellRate` |   | `string` |   | ราคาขายต่อหน่วยของสูตร (บาท) — ต่อเที่ยว/กม./ตัน/ลบ.ม./หน่วย · rate ขาขาย · ต้องมีสิทธิ์ `prices.sell:write` (เห็นเมื่อมี `prices.sell:read`) | `6500.00` |
| `sellMinCharge` |   | `string` | null ได้ | ขั้นต่ำต่อเที่ยว (บาท) — ผล = max(ราคาคำนวณ, ขั้นต่ำ) · null = ไม่มี | `1500.00` |
| `sellExtraStopRate` |   | `string` | null ได้ | ค่าจุดเพิ่มต่อจุด เมื่อจำนวนจุดเกิน `includedStops` · null = ไม่คิด | `300.00` |
| `buyRate` |   | `string` |   | ราคาซื้อต่อหน่วยของสูตร (บาท) — rate ขาซื้อ · ต้องมีสิทธิ์ `prices.buy:write` (เห็นเมื่อมี `prices.buy:read`) | `5200.00` |
| `buyMinCharge` |   | `string` | null ได้ | ขั้นต่ำต่อเที่ยว (บาท) ขาซื้อ · null = ไม่มี | `1200.00` |
| `buyExtraStopRate` |   | `string` | null ได้ | ค่าจุดเพิ่มต่อจุด ขาซื้อ (เกิน `includedStops`) · null = ไม่คิด | `250.00` |
| `includedStops` |   | `number` | ≥ 0 · ≤ 99 | จำนวนจุดที่รวมในราคา (N) — ค่าเริ่มต้น 2 (รับ 1 + ส่ง 1) | `2` |
| `validFrom` |   | `string (date)` |   | มีผลตั้งแต่ (รวมวันนี้) | `2026-11-01` |
| `validTo` |   | `string (date)` | null ได้ | ถึง (รวมวันนี้) ≥ validFrom · null = ไม่มีวันหมด | `2027-10-31` |
| `accessorials` |   | `array<RateAccessorialInputDto>` |   | ราคาค่าบริการเสริมเฉพาะ rate นี้ — ส่ง = แทนทั้งชุด (ไม่ส่ง = คงเดิม) · สูงสุด 50 รายการ ห้ามซ้ำ |   |
| `accessorials[].serviceItemId` | ใช่ | `string` |   | ค่าบริการเสริม (`service-items`) ฝั่งขาย/ทั้งคู่ | `svc_3f2a…` |
| `accessorials[].sellPrice` |   | `string` |   | ราคาขาย (บาท ก่อน VAT) ทศนิยม ≤ 2 — rate ขาขายเท่านั้น · ต้องมีสิทธิ์ `prices.sell:write` | `300.00` |
| `accessorials[].buyPrice` |   | `string` |   | ราคาซื้อ (บาท ก่อน VAT) ทศนิยม ≤ 2 — rate ขาซื้อเท่านั้น · ต้องมีสิทธิ์ `prices.buy:write` | `250.00` |
| `notes` |   | `string` | ยาว ≤ 1000 · null ได้ | หมายเหตุ |   |
| `customerId` |   | `string` |   | ลูกค้า (ขาขายเท่านั้น) | `cus_3f2a…` |
| `carrierId` |   | `string` |   | รถร่วม/ผู้รับเหมา | `car_3f2a…` |
| `originId` |   | `string` |   | ต้นทาง (สถานที่) | `loc_3f2a…` |
| `destinationId` |   | `string` |   | ปลายทาง (สถานที่) — ต่างจากต้นทาง | `loc_8c1d…` |
| `vehicleTypeId` |   | `string` |   | ประเภทรถ | `vty_3f2a…` |
| `serviceItemId` |   | `string` |   | รายการบนเอกสารที่กำหนด vat_type/wht_rate ของค่าขนส่งจาก rate นี้ — ไม่ส่งตอนสร้าง = ค่าขนส่ง (FREIGHT) | `svc_3f2a…` |
| `externalId` |   | `string` | null ได้ | null = ลบการผูก |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `RateCardDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`prices.sell:write` / `prices.buy:write` — มีตัวใดตัวหนึ่งก็พอ) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ยังไม่มีแถวที่ externalId นี้ (สร้างใหม่ใช้ PUT) หรืออยู่ tenant อื่น — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | ขัดกับข้อมูลที่มีอยู่ (เช่น รหัส/ชื่อซ้ำ, สถานะไม่อนุญาตให้แก้) — [conflict](errors.md#conflict), [duplicate](errors.md#duplicate) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง (รวมทุกช่องใน errors[]) — externalId ใน path ผิดรูปแบบ = field `externalId` — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PATCH "$TMS_BASE_URL/v1/rate-cards/external/<externalId>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"sellRate":"6500.00","buyRate":"5200.00","includedStops":2,"validFrom":"2026-11-01","customerId":"cus_3f2a…","carrierId":"car_3f2a…","originId":"loc_3f2a…","destinationId":"loc_8c1d…","vehicleTypeId":"vty_3f2a…","serviceItemId":"svc_3f2a…"}'
```

```ts
const { data, error } = await tms.PATCH('/v1/rate-cards/external/{externalId}', {
  params: { path: { externalId: "…" } },
  body: {
    "sellRate": "6500.00",
    "buyRate": "5200.00",
    "includedStops": 2,
    "validFrom": "2026-11-01",
    "customerId": "cus_3f2a…",
    "carrierId": "car_3f2a…",
    "originId": "loc_3f2a…",
    "destinationId": "loc_8c1d…",
    "vehicleTypeId": "vty_3f2a…",
    "serviceItemId": "svc_3f2a…"
  },
});
```

## GET /v1/rate-cards/{id} {#get-rate-cards-id}

`GET /v1/rate-cards/{id}`

scope: `master:read` · operationId: `RateCards_get`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `RateCardDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/rate-cards/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/rate-cards/{id}', {
  params: { path: { id: "…" } },
});
```

## PATCH /v1/rate-cards/{id} {#patch-rate-cards-id}

`PATCH /v1/rate-cards/{id}`

scope: `prices.sell:write` หรือ `prices.buy:write` · operationId: `RateCards_update`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `UpdateRateCardDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `pricingModel` |   | `string` | ค่า: `PER_TRIP`, `PER_KM`, `PER_TON`, `PER_CBM`, `PER_UNIT` | สูตรราคา |   |
| `unitId` |   | `string` | null ได้ | หน่วยนับ (ชนิด COUNT เช่น ชิ้น พาเลท) — บังคับเมื่อ PER_UNIT, สูตรอื่นต้องเป็น null | `unt_3f2a…` |
| `sellRate` |   | `string` |   | ราคาขายต่อหน่วยของสูตร (บาท) — ต่อเที่ยว/กม./ตัน/ลบ.ม./หน่วย · rate ขาขาย · ต้องมีสิทธิ์ `prices.sell:write` (เห็นเมื่อมี `prices.sell:read`) | `6500.00` |
| `sellMinCharge` |   | `string` | null ได้ | ขั้นต่ำต่อเที่ยว (บาท) — ผล = max(ราคาคำนวณ, ขั้นต่ำ) · null = ไม่มี | `1500.00` |
| `sellExtraStopRate` |   | `string` | null ได้ | ค่าจุดเพิ่มต่อจุด เมื่อจำนวนจุดเกิน `includedStops` · null = ไม่คิด | `300.00` |
| `buyRate` |   | `string` |   | ราคาซื้อต่อหน่วยของสูตร (บาท) — rate ขาซื้อ · ต้องมีสิทธิ์ `prices.buy:write` (เห็นเมื่อมี `prices.buy:read`) | `5200.00` |
| `buyMinCharge` |   | `string` | null ได้ | ขั้นต่ำต่อเที่ยว (บาท) ขาซื้อ · null = ไม่มี | `1200.00` |
| `buyExtraStopRate` |   | `string` | null ได้ | ค่าจุดเพิ่มต่อจุด ขาซื้อ (เกิน `includedStops`) · null = ไม่คิด | `250.00` |
| `includedStops` |   | `number` | ≥ 0 · ≤ 99 | จำนวนจุดที่รวมในราคา (N) — ค่าเริ่มต้น 2 (รับ 1 + ส่ง 1) | `2` |
| `validFrom` |   | `string (date)` |   | มีผลตั้งแต่ (รวมวันนี้) | `2026-11-01` |
| `validTo` |   | `string (date)` | null ได้ | ถึง (รวมวันนี้) ≥ validFrom · null = ไม่มีวันหมด | `2027-10-31` |
| `accessorials` |   | `array<RateAccessorialInputDto>` |   | ราคาค่าบริการเสริมเฉพาะ rate นี้ — ส่ง = แทนทั้งชุด (ไม่ส่ง = คงเดิม) · สูงสุด 50 รายการ ห้ามซ้ำ |   |
| `accessorials[].serviceItemId` | ใช่ | `string` |   | ค่าบริการเสริม (`service-items`) ฝั่งขาย/ทั้งคู่ | `svc_3f2a…` |
| `accessorials[].sellPrice` |   | `string` |   | ราคาขาย (บาท ก่อน VAT) ทศนิยม ≤ 2 — rate ขาขายเท่านั้น · ต้องมีสิทธิ์ `prices.sell:write` | `300.00` |
| `accessorials[].buyPrice` |   | `string` |   | ราคาซื้อ (บาท ก่อน VAT) ทศนิยม ≤ 2 — rate ขาซื้อเท่านั้น · ต้องมีสิทธิ์ `prices.buy:write` | `250.00` |
| `notes` |   | `string` | ยาว ≤ 1000 · null ได้ | หมายเหตุ |   |
| `customerId` |   | `string` |   | ลูกค้า (ขาขายเท่านั้น) | `cus_3f2a…` |
| `carrierId` |   | `string` |   | รถร่วม/ผู้รับเหมา | `car_3f2a…` |
| `originId` |   | `string` |   | ต้นทาง (สถานที่) | `loc_3f2a…` |
| `destinationId` |   | `string` |   | ปลายทาง (สถานที่) — ต่างจากต้นทาง | `loc_8c1d…` |
| `vehicleTypeId` |   | `string` |   | ประเภทรถ | `vty_3f2a…` |
| `serviceItemId` |   | `string` |   | รายการบนเอกสารที่กำหนด vat_type/wht_rate ของค่าขนส่งจาก rate นี้ — ไม่ส่งตอนสร้าง = ค่าขนส่ง (FREIGHT) | `svc_3f2a…` |
| `externalId` |   | `string` | null ได้ | null = ลบการผูก |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `RateCardDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`prices.sell:write` / `prices.buy:write` — มีตัวใดตัวหนึ่งก็พอ) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PATCH "$TMS_BASE_URL/v1/rate-cards/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"sellRate":"6500.00","buyRate":"5200.00","includedStops":2,"validFrom":"2026-11-01","customerId":"cus_3f2a…","carrierId":"car_3f2a…","originId":"loc_3f2a…","destinationId":"loc_8c1d…","vehicleTypeId":"vty_3f2a…","serviceItemId":"svc_3f2a…"}'
```

```ts
const { data, error } = await tms.PATCH('/v1/rate-cards/{id}', {
  params: { path: { id: "…" } },
  body: {
    "sellRate": "6500.00",
    "buyRate": "5200.00",
    "includedStops": 2,
    "validFrom": "2026-11-01",
    "customerId": "cus_3f2a…",
    "carrierId": "car_3f2a…",
    "originId": "loc_3f2a…",
    "destinationId": "loc_8c1d…",
    "vehicleTypeId": "vty_3f2a…",
    "serviceItemId": "svc_3f2a…"
  },
});
```

## GET /v1/rate-cards/{id}/history {#get-rate-cards-id-history}

`GET /v1/rate-cards/{id}/history`

scope: `master:read` · operationId: `RateCards_history`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | ประวัติการแก้จาก audit log ใหม่สุดก่อน (ราคาถูกตัดตามสิทธิ์ `prices.sell:read` / `prices.buy:read`) | `AuditPageDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/rate-cards/<id>/history" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/rate-cards/{id}/history', {
  params: { path: { id: "…" } },
});
```

## POST /v1/rate-cards/{id}/revise {#post-rate-cards-id-revise}

`POST /v1/rate-cards/{id}/revise`

scope: `prices.sell:write` หรือ `prices.buy:write` · operationId: `RateCards_revise`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `If-Match` | header |   | `string` | ETag ของฉบับเดิม — ไม่ตรง → 412 |

**Request body** `ReviseRateCardDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `pricingModel` |   | `string` | ค่า: `PER_TRIP`, `PER_KM`, `PER_TON`, `PER_CBM`, `PER_UNIT` | สูตรราคา |   |
| `unitId` |   | `string` | null ได้ | หน่วยนับ (ชนิด COUNT เช่น ชิ้น พาเลท) — บังคับเมื่อ PER_UNIT, สูตรอื่นต้องเป็น null | `unt_3f2a…` |
| `sellRate` |   | `string` |   | ราคาขายต่อหน่วยของสูตร (บาท) — ต่อเที่ยว/กม./ตัน/ลบ.ม./หน่วย · rate ขาขาย · ต้องมีสิทธิ์ `prices.sell:write` (เห็นเมื่อมี `prices.sell:read`) | `6500.00` |
| `sellMinCharge` |   | `string` | null ได้ | ขั้นต่ำต่อเที่ยว (บาท) — ผล = max(ราคาคำนวณ, ขั้นต่ำ) · null = ไม่มี | `1500.00` |
| `sellExtraStopRate` |   | `string` | null ได้ | ค่าจุดเพิ่มต่อจุด เมื่อจำนวนจุดเกิน `includedStops` · null = ไม่คิด | `300.00` |
| `buyRate` |   | `string` |   | ราคาซื้อต่อหน่วยของสูตร (บาท) — rate ขาซื้อ · ต้องมีสิทธิ์ `prices.buy:write` (เห็นเมื่อมี `prices.buy:read`) | `5200.00` |
| `buyMinCharge` |   | `string` | null ได้ | ขั้นต่ำต่อเที่ยว (บาท) ขาซื้อ · null = ไม่มี | `1200.00` |
| `buyExtraStopRate` |   | `string` | null ได้ | ค่าจุดเพิ่มต่อจุด ขาซื้อ (เกิน `includedStops`) · null = ไม่คิด | `250.00` |
| `includedStops` |   | `number` | ≥ 0 · ≤ 99 | จำนวนจุดที่รวมในราคา (N) — ค่าเริ่มต้น 2 (รับ 1 + ส่ง 1) | `2` |
| `validFrom` |   | `string (date)` |   | มีผลตั้งแต่ (รวมวันนี้) | `2026-11-01` |
| `validTo` |   | `string (date)` | null ได้ | ถึง (รวมวันนี้) ≥ validFrom · null = ไม่มีวันหมด | `2027-10-31` |
| `accessorials` |   | `array<RateAccessorialInputDto>` |   | ราคาค่าบริการเสริมเฉพาะ rate นี้ — ส่ง = แทนทั้งชุด (ไม่ส่ง = คงเดิม) · สูงสุด 50 รายการ ห้ามซ้ำ |   |
| `accessorials[].serviceItemId` | ใช่ | `string` |   | ค่าบริการเสริม (`service-items`) ฝั่งขาย/ทั้งคู่ | `svc_3f2a…` |
| `accessorials[].sellPrice` |   | `string` |   | ราคาขาย (บาท ก่อน VAT) ทศนิยม ≤ 2 — rate ขาขายเท่านั้น · ต้องมีสิทธิ์ `prices.sell:write` | `300.00` |
| `accessorials[].buyPrice` |   | `string` |   | ราคาซื้อ (บาท ก่อน VAT) ทศนิยม ≤ 2 — rate ขาซื้อเท่านั้น · ต้องมีสิทธิ์ `prices.buy:write` | `250.00` |
| `notes` |   | `string` | ยาว ≤ 1000 · null ได้ | หมายเหตุ |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `201` | ร่างฉบับใหม่ | `RateCardDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`prices.sell:write` / `prices.buy:write` — มีตัวใดตัวหนึ่งก็พอ) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/rate-cards/<id>/revise" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"sellRate":"6500.00","buyRate":"5200.00","includedStops":2,"validFrom":"2026-11-01"}'
```

```ts
const { data, error } = await tms.POST('/v1/rate-cards/{id}/revise', {
  params: { path: { id: "…" } },
  body: {
    "sellRate": "6500.00",
    "buyRate": "5200.00",
    "includedStops": 2,
    "validFrom": "2026-11-01"
  },
});
```

## POST /v1/rate-cards/{id}/approve {#post-rate-cards-id-approve}

`POST /v1/rate-cards/{id}/approve`

scope: `prices.sell:write` หรือ `prices.buy:write` · operationId: `RateCards_approve`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `MasterReasonDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `เลิกใช้บริการตั้งแต่ ธ.ค. 2569` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `RateCardDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`prices.sell:write` / `prices.buy:write` — มีตัวใดตัวหนึ่งก็พอ) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/rate-cards/<id>/approve" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"เลิกใช้บริการตั้งแต่ ธ.ค. 2569"}'
```

```ts
const { data, error } = await tms.POST('/v1/rate-cards/{id}/approve', {
  params: { path: { id: "…" } },
  body: {
    "reason": "เลิกใช้บริการตั้งแต่ ธ.ค. 2569"
  },
});
```

## POST /v1/rate-cards/{id}/cancel {#post-rate-cards-id-cancel}

`POST /v1/rate-cards/{id}/cancel`

scope: `prices.sell:write` หรือ `prices.buy:write` · operationId: `RateCards_cancel`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `MasterReasonDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `เลิกใช้บริการตั้งแต่ ธ.ค. 2569` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `RateCardDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`prices.sell:write` / `prices.buy:write` — มีตัวใดตัวหนึ่งก็พอ) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/rate-cards/<id>/cancel" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"เลิกใช้บริการตั้งแต่ ธ.ค. 2569"}'
```

```ts
const { data, error } = await tms.POST('/v1/rate-cards/{id}/cancel', {
  params: { path: { id: "…" } },
  body: {
    "reason": "เลิกใช้บริการตั้งแต่ ธ.ค. 2569"
  },
});
```

## POST /v1/rate-cards/{id}/delete {#post-rate-cards-id-delete}

`POST /v1/rate-cards/{id}/delete`

scope: `prices.sell:write` หรือ `prices.buy:write` · operationId: `RateCards_remove`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `MasterReasonDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `เลิกใช้บริการตั้งแต่ ธ.ค. 2569` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `204` |   |   |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`prices.sell:write` / `prices.buy:write` — มีตัวใดตัวหนึ่งก็พอ) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/rate-cards/<id>/delete" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"เลิกใช้บริการตั้งแต่ ธ.ค. 2569"}'
```

```ts
const { data, error } = await tms.POST('/v1/rate-cards/{id}/delete', {
  params: { path: { id: "…" } },
  body: {
    "reason": "เลิกใช้บริการตั้งแต่ ธ.ค. 2569"
  },
});
```

## Schema ของ response {#schemas}

### AuditPageDto {#schema-AuditPageDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<AuditEntryDto>` |   |   |   |
| `nextCursor` | ใช่ | `string` | null ได้ |   |   |
| `hasMore` | ใช่ | `boolean` |   |   |   |

### RateCardDto {#schema-RateCardDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `rcd_3f2a…` |
| `code` | ใช่ | `string` |   |   | `RC-S-0001` |
| `revision` | ใช่ | `number` |   | ฉบับที่ | `1` |
| `parentId` | ใช่ | `string` | null ได้ | ฉบับก่อนหน้า (rcd_…) |   |
| `side` | ใช่ | `string` | ค่า: `SELL`, `BUY` |   |   |
| `customer` | ใช่ | `RatePartyRefDto` | null ได้ | ลูกค้า (ขาขาย) |   |
| `carrier` | ใช่ | `RatePartyRefDto` | null ได้ | รถร่วม/ผู้รับเหมา (ขาซื้อ) |   |
| `origin` | ใช่ | `RateSiteRefDto` |   |   |   |
| `destination` | ใช่ | `RateSiteRefDto` |   |   |   |
| `vehicleType` | ใช่ | `RateVehicleTypeRefDto` |   |   |   |
| `pricingModel` | ใช่ | `string` | ค่า: `PER_TRIP`, `PER_KM`, `PER_TON`, `PER_CBM`, `PER_UNIT`, `PER_DAY` |   |   |
| `unit` | ใช่ | `RateUnitRefDto` | null ได้ |   |   |
| `sellRate` |   | `string` |   | ราคาขายต่อหน่วยของสูตร — rate ขาขาย (เห็นเมื่อมี `prices.sell:read`) | `6500.00` |
| `sellMinCharge` |   | `string` | null ได้ |   | `1500.00` |
| `sellExtraStopRate` |   | `string` | null ได้ |   | `300.00` |
| `buyRate` |   | `string` |   | ราคาซื้อต่อหน่วยของสูตร — rate ขาซื้อ (เห็นเมื่อมี `prices.buy:read`) | `5200.00` |
| `buyMinCharge` |   | `string` | null ได้ |   | `1200.00` |
| `buyExtraStopRate` |   | `string` | null ได้ |   | `250.00` |
| `includedStops` | ใช่ | `number` |   |   | `2` |
| `serviceItem` | ใช่ | `RateServiceItemRefDto` |   |   |   |
| `accessorials` | ใช่ | `array<RateAccessorialDto>` |   |   |   |
| `validFrom` | ใช่ | `string (date)` |   |   | `2026-11-01` |
| `validTo` | ใช่ | `string (date)` | null ได้ |   | `2027-10-31` |
| `status` | ใช่ | `string` | ค่า: `draft`, `pending_approval`, `active`, `expired`, `retired` |   |   |
| `nearExpiry` | ใช่ | `boolean` |   | ใช้งานอยู่และหมดอายุภายใน 30 วัน (NEAR_EXPIRY) |   |
| `daysToExpiry` | ใช่ | `number` | null ได้ | จำนวนวันถึงวันหมด (ติดลบ = หมดแล้ว) · null = ไม่มีวันหมด |   |
| `approvedAt` | ใช่ | `string (date-time)` | null ได้ |   |   |
| `notes` | ใช่ | `string` | null ได้ |   |   |
| `externalId` | ใช่ | `string` | null ได้ |   |   |
| `deletedAt` |   | `string (date-time)` | null ได้ |   |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string (date-time)` |   |   |   |
| `updatedAt` | ใช่ | `string (date-time)` |   |   |   |

### RateCardPageDto {#schema-RateCardPageDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<RateCardDto>` |   |   |   |
| `nextCursor` | ใช่ | `string` | null ได้ |   |   |
| `hasMore` | ใช่ | `boolean` |   |   |   |

### RateCardSummaryDto {#schema-RateCardSummaryDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `total` | ใช่ | `number` |   | rate ทั้งหมด (ไม่รวมที่ลบ) |   |
| `draft` | ใช่ | `number` |   | ร่าง (รออนุมัติ) |   |
| `pendingApproval` | ใช่ | `number` |   | รออนุมัติ (P1) |   |
| `active` | ใช่ | `number` |   | ใช้งาน (มีผล) |   |
| `nearExpiry` | ใช่ | `number` |   | ใช้งานและหมดอายุใน 30 วัน |   |
| `expired` | ใช่ | `number` |   | หมดอายุ |   |
| `retired` | ใช่ | `number` |   | ยกเลิก/ถูกแทน |   |
