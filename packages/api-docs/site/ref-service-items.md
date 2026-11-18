# รายการค่าบริการ (service-items)

13 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`GET /v1/service-items`](#get-service-items) | `master:read` |
| [`POST /v1/service-items`](#post-service-items) | `master:write` |
| [`GET /v1/service-items/summary`](#get-service-items-summary) | `master:read` |
| [`GET /v1/service-items/next-code`](#get-service-items-next-code) | `master:write` |
| [`GET /v1/service-items/export`](#get-service-items-export) | `export:run` |
| [`PUT /v1/service-items/external/{externalId}`](#put-service-items-external-externalId) | `master:write` |
| [`PATCH /v1/service-items/external/{externalId}`](#patch-service-items-external-externalId) | `master:write` |
| [`GET /v1/service-items/{id}`](#get-service-items-id) | `master:read` |
| [`PATCH /v1/service-items/{id}`](#patch-service-items-id) | `master:write` |
| [`GET /v1/service-items/{id}/history`](#get-service-items-id-history) | `master:read` |
| [`POST /v1/service-items/{id}/deactivate`](#post-service-items-id-deactivate) | `master:write` |
| [`POST /v1/service-items/{id}/activate`](#post-service-items-id-activate) | `master:write` |
| [`POST /v1/service-items/{id}/delete`](#post-service-items-id-delete) | `master:write` |

## GET /v1/service-items {#get-service-items}

`GET /v1/service-items`

scope: `master:read` · operationId: `ServiceItems_list`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน (ใช้กับ sort เดิมเท่านั้น) |
| `updatedAfter` | query |   | `string` | คืนเฉพาะแถวที่ updatedAt > ค่านี้ (incremental pull — ใช้คู่ includeDeleted=true เพื่อรับรายการที่ถูกลบ) |
| `sort` | query |   | `string` ค่า: `code`, `updatedAt`, `-updatedAt` | code = เรียงตามรหัส (ค่าเริ่มต้นของหน้าจอ) · updatedAt/-updatedAt สำหรับ sync |
| `fields` | query |   | `string` | รายชื่อ field คั่นด้วย , เช่น id,legalName |
| `q` | query |   | `string` | ค้นหา — รหัส ชื่อ เลขผู้เสียภาษี หรือ externalId (ไม่สนตัวพิมพ์) |
| `status` | query |   | `string` | คั่นด้วย , เช่น active,inactive |
| `externalId` | query |   | `string` | externalId ตรงตัว (ใช้ตรวจว่ามีในระบบแล้วหรือยัง) |
| `includeDeleted` | query |   | `string` | true = รวมรายการที่ถูกลบ (tombstone มี `deletedAt`) — ให้ระบบที่ดึงแบบ incremental รู้ว่ารายการถูกลบ |
| `name` | query |   | `string` | ชื่อ/เงื่อนไขมีคำนี้ |
| `calcUnit` | query |   | `string` ค่า: `PER_TRIP`, `PER_HOUR`, `PER_NIGHT`, `PER_STOP`, `PERCENT_OF_FREIGHT`, `ACTUAL` |   |
| `vatType` | query |   | `string` ค่า: `EXEMPT_TRANSPORT`, `VAT_7`, `ZERO_RATED` |   |
| `side` | query |   | `string` ค่า: `SELL`, `BUY`, `BOTH` | ใช้ได้กับฝั่งนี้ (SELL = SELL+BOTH, BUY = BUY+BOTH, BOTH = เฉพาะทั้งสองฝั่ง) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `ServiceItemPageDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/service-items" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/service-items');
```

## POST /v1/service-items {#post-service-items}

`POST /v1/service-items`

scope: `master:write` · operationId: `ServiceItems_create`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `Idempotency-Key` | header |   | `string` |   |

**Request body** `CreateServiceItemDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `defaultPrice` |   | `string` | null ได้ | ราคาตั้งต้น (บาท ก่อน VAT) — PERCENT_OF_FREIGHT = เปอร์เซ็นต์ (≤ 100) · ACTUAL ต้องเป็น null (ตามใบเสร็จ) · null = ไม่มีราคาตั้งต้น (ใช้ rate card) | `500.00` |
| `fuelRefPrice` |   | `string` | null ได้ | ราคาน้ำมันอ้างอิง (฿/ลิตร) — ใช้กับ PERCENT_OF_FREIGHT เท่านั้น | `31.50` |
| `condition` |   | `string` | null ได้ |   | `ฟรี 2 ชม. แรก` |
| `side` |   | `string` | ค่า: `SELL`, `BUY`, `BOTH` | ใช้กับ: SELL = ฝั่งขาย (ลูกค้า), BUY = ฝั่งซื้อ (รถร่วม), BOTH = ทั้งสองฝั่ง (ค่าเริ่มต้น) |   |
| `isSurcharge` |   | `boolean` |   | เป็นค่าใช้จ่ายเพิ่ม (ค่ารอ ทางด่วน ยกของ) — false = ค่าขนส่งหลัก (ค่าเริ่มต้น true) |   |
| `nameEn` |   | `string` | null ได้ |   | `en name` |
| `defaultAccountCode` |   | `string` | null ได้ | รหัสบัญชีรายได้/ค่าใช้จ่ายตั้งต้น (ไม่บังคับ — mapping ERP อยู่ที่ connector) | `4110-01` |
| `name` | ใช่ | `string` |   | ชื่อรายการ (พิมพ์บนเอกสาร) — ห้ามซ้ำ (ไม่สนตัวพิมพ์) | `ค่ารอ` |
| `calcUnit` | ใช่ | `string` | ค่า: `PER_TRIP`, `PER_HOUR`, `PER_NIGHT`, `PER_STOP`, `PERCENT_OF_FREIGHT`, `ACTUAL` | หน่วยคิด: PER_TRIP ต่อเที่ยว, PER_HOUR ต่อชั่วโมง, PER_NIGHT ต่อคืน, PER_STOP ต่อจุด, PERCENT_OF_FREIGHT % ของค่าขนส่ง, ACTUAL ตามจริง (ตามใบเสร็จ) |   |
| `vatType` | ใช่ | `string` | ค่า: `EXEMPT_TRANSPORT`, `VAT_7`, `ZERO_RATED` | VAT ตั้งต้นของบรรทัด: EXEMPT_TRANSPORT = ยกเว้น (ค่าขนส่ง ม.81(1)(ณ)), VAT_7 = 7%, ZERO_RATED = 0% — snapshot ลงบรรทัดเอกสาร |   |
| `whtRate` | ใช่ | `string` | ค่า: `0.00`, `1.00`, `3.00` | หัก ณ ที่จ่าย (%) ตั้งต้นของบรรทัด: 1.00 ค่าขนส่ง, 3.00 ค่าบริการ, 0.00 ไม่หัก — คู่ EXEMPT_TRANSPORT+3.00 และ VAT_7+1.00 บันทึกได้แต่ได้คำเตือน `vat_wht_unusual` ใน `warnings` |   |
| `code` |   | `string` |   | รหัส — ไม่ส่ง = ระบบออกเลขถัดไป `AX-0001` (MD-002) | `WAIT` |
| `externalId` |   | `string` |   | รหัสในระบบต้นทาง — เรียกด้วย ext:{externalId} ได้ |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `201` |   | `ServiceItemWriteResultDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/service-items" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"name":"ค่ารอ","calcUnit":"PER_TRIP","vatType":"EXEMPT_TRANSPORT","whtRate":"0.00","code":"WAIT"}'
```

```ts
const { data, error } = await tms.POST('/v1/service-items', {
  body: {
    "name": "ค่ารอ",
    "calcUnit": "PER_TRIP",
    "vatType": "EXEMPT_TRANSPORT",
    "whtRate": "0.00",
    "code": "WAIT"
  },
});
```

## GET /v1/service-items/summary {#get-service-items-summary}

`GET /v1/service-items/summary`

scope: `master:read` · operationId: `ServiceItems_summary`

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `ServiceItemSummaryDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/service-items/summary" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/service-items/summary');
```

## GET /v1/service-items/next-code {#get-service-items-next-code}

`GET /v1/service-items/next-code`

scope: `master:write` · operationId: `ServiceItems_nextCode`

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | รหัสที่ระบบจะออกให้รายการใหม่ (`AX-0001`) | `NextCodeDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/service-items/next-code" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/service-items/next-code');
```

## GET /v1/service-items/export {#get-service-items-export}

`GET /v1/service-items/export`

scope: `export:run` · operationId: `ServiceItems_export`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน (ใช้กับ sort เดิมเท่านั้น) |
| `updatedAfter` | query |   | `string` | คืนเฉพาะแถวที่ updatedAt > ค่านี้ (incremental pull — ใช้คู่ includeDeleted=true เพื่อรับรายการที่ถูกลบ) |
| `sort` | query |   | `string` ค่า: `code`, `updatedAt`, `-updatedAt` | code = เรียงตามรหัส (ค่าเริ่มต้นของหน้าจอ) · updatedAt/-updatedAt สำหรับ sync |
| `fields` | query |   | `string` | รายชื่อ field คั่นด้วย , เช่น id,legalName |
| `q` | query |   | `string` | ค้นหา — รหัส ชื่อ เลขผู้เสียภาษี หรือ externalId (ไม่สนตัวพิมพ์) |
| `status` | query |   | `string` | คั่นด้วย , เช่น active,inactive |
| `externalId` | query |   | `string` | externalId ตรงตัว (ใช้ตรวจว่ามีในระบบแล้วหรือยัง) |
| `includeDeleted` | query |   | `string` | true = รวมรายการที่ถูกลบ (tombstone มี `deletedAt`) — ให้ระบบที่ดึงแบบ incremental รู้ว่ารายการถูกลบ |
| `name` | query |   | `string` | ชื่อ/เงื่อนไขมีคำนี้ |
| `calcUnit` | query |   | `string` ค่า: `PER_TRIP`, `PER_HOUR`, `PER_NIGHT`, `PER_STOP`, `PERCENT_OF_FREIGHT`, `ACTUAL` |   |
| `vatType` | query |   | `string` ค่า: `EXEMPT_TRANSPORT`, `VAT_7`, `ZERO_RATED` |   |
| `side` | query |   | `string` ค่า: `SELL`, `BUY`, `BOTH` | ใช้ได้กับฝั่งนี้ (SELL = SELL+BOTH, BUY = BUY+BOTH, BOTH = เฉพาะทั้งสองฝั่ง) |
| `format` | query |   | `string` ค่า: `xlsx`, `csv` |   |
| `ids` | query |   | `string` | ส่งออกเฉพาะ id เหล่านี้ (คั่นด้วย ,) — แถวที่เลือกในตาราง |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | ไฟล์ .xlsx หรือ .csv ตามตัวกรองเดียวกับรายการ (สูงสุด 10,000 แถว) |   |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`export:run`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/service-items/export" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/service-items/export');
```

## PUT /v1/service-items/external/{externalId} {#put-service-items-external-externalId}

`PUT /v1/service-items/external/{externalId}`

scope: `master:write` · operationId: `ServiceItems_upsertExternal`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `externalId` | path | ใช่ | `string` | เลขของระบบต้นทาง (ASCII ที่พิมพ์ได้ 1–100 ตัว ไม่มีช่องว่าง) — unique ต่อ tenant ต่อ resource |
| `If-Match` | header |   | `string` | ETag — ใช้เมื่อแถวมีอยู่แล้ว |

**Request body** `UpsertServiceItemDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `defaultPrice` |   | `string` | null ได้ | ราคาตั้งต้น (บาท ก่อน VAT) — PERCENT_OF_FREIGHT = เปอร์เซ็นต์ (≤ 100) · ACTUAL ต้องเป็น null (ตามใบเสร็จ) · null = ไม่มีราคาตั้งต้น (ใช้ rate card) | `500.00` |
| `fuelRefPrice` |   | `string` | null ได้ | ราคาน้ำมันอ้างอิง (฿/ลิตร) — ใช้กับ PERCENT_OF_FREIGHT เท่านั้น | `31.50` |
| `condition` |   | `string` | null ได้ |   | `ฟรี 2 ชม. แรก` |
| `side` |   | `string` | ค่า: `SELL`, `BUY`, `BOTH` | ใช้กับ: SELL = ฝั่งขาย (ลูกค้า), BUY = ฝั่งซื้อ (รถร่วม), BOTH = ทั้งสองฝั่ง (ค่าเริ่มต้น) |   |
| `isSurcharge` |   | `boolean` |   | เป็นค่าใช้จ่ายเพิ่ม (ค่ารอ ทางด่วน ยกของ) — false = ค่าขนส่งหลัก (ค่าเริ่มต้น true) |   |
| `nameEn` |   | `string` | null ได้ |   | `en name` |
| `defaultAccountCode` |   | `string` | null ได้ | รหัสบัญชีรายได้/ค่าใช้จ่ายตั้งต้น (ไม่บังคับ — mapping ERP อยู่ที่ connector) | `4110-01` |
| `name` | ใช่ | `string` |   | ชื่อรายการ (พิมพ์บนเอกสาร) — ห้ามซ้ำ (ไม่สนตัวพิมพ์) | `ค่ารอ` |
| `calcUnit` | ใช่ | `string` | ค่า: `PER_TRIP`, `PER_HOUR`, `PER_NIGHT`, `PER_STOP`, `PERCENT_OF_FREIGHT`, `ACTUAL` | หน่วยคิด: PER_TRIP ต่อเที่ยว, PER_HOUR ต่อชั่วโมง, PER_NIGHT ต่อคืน, PER_STOP ต่อจุด, PERCENT_OF_FREIGHT % ของค่าขนส่ง, ACTUAL ตามจริง (ตามใบเสร็จ) |   |
| `vatType` | ใช่ | `string` | ค่า: `EXEMPT_TRANSPORT`, `VAT_7`, `ZERO_RATED` | VAT ตั้งต้นของบรรทัด: EXEMPT_TRANSPORT = ยกเว้น (ค่าขนส่ง ม.81(1)(ณ)), VAT_7 = 7%, ZERO_RATED = 0% — snapshot ลงบรรทัดเอกสาร |   |
| `whtRate` | ใช่ | `string` | ค่า: `0.00`, `1.00`, `3.00` | หัก ณ ที่จ่าย (%) ตั้งต้นของบรรทัด: 1.00 ค่าขนส่ง, 3.00 ค่าบริการ, 0.00 ไม่หัก — คู่ EXEMPT_TRANSPORT+3.00 และ VAT_7+1.00 บันทึกได้แต่ได้คำเตือน `vat_wht_unusual` ใน `warnings` |   |
| `code` |   | `string` |   | ใช้ตอนสร้างเท่านั้น | `WAIT` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | มีอยู่แล้ว → อัปเดต (ส่งซ้ำได้ ไม่เกิดแถวใหม่) | `ServiceItemWriteResultDto` |
| `201` | ยังไม่มี → สร้าง | `ServiceItemWriteResultDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `409` | ขัดกับข้อมูลที่มีอยู่ (เช่น รหัส/ชื่อซ้ำ, สถานะไม่อนุญาตให้แก้) — [conflict](errors.md#conflict), [duplicate](errors.md#duplicate) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง (รวมทุกช่องใน errors[]) — externalId ใน path ผิดรูปแบบ = field `externalId` — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PUT "$TMS_BASE_URL/v1/service-items/external/<externalId>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"ค่ารอ","calcUnit":"PER_TRIP","vatType":"EXEMPT_TRANSPORT","whtRate":"0.00","code":"WAIT"}'
```

```ts
const { data, error } = await tms.PUT('/v1/service-items/external/{externalId}', {
  params: { path: { externalId: "…" } },
  body: {
    "name": "ค่ารอ",
    "calcUnit": "PER_TRIP",
    "vatType": "EXEMPT_TRANSPORT",
    "whtRate": "0.00",
    "code": "WAIT"
  },
});
```

## แก้บางช่องด้วย externalId {#patch-service-items-external-externalId}

`PATCH /v1/service-items/external/{externalId}`

scope: `master:write` · operationId: `ServiceItems_patchExternal`

เหมือน `PATCH /service-items/ext:{externalId}` (กติกาเดียวกับ PATCH ด้วย id) · ยังไม่มีแถวนี้ → 404 — สร้างใหม่ใช้ PUT

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `externalId` | path | ใช่ | `string` | เลขของระบบต้นทาง (ASCII ที่พิมพ์ได้ 1–100 ตัว ไม่มีช่องว่าง) — unique ต่อ tenant ต่อ resource |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `UpdateServiceItemDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `defaultPrice` |   | `string` | null ได้ | ราคาตั้งต้น (บาท ก่อน VAT) — PERCENT_OF_FREIGHT = เปอร์เซ็นต์ (≤ 100) · ACTUAL ต้องเป็น null (ตามใบเสร็จ) · null = ไม่มีราคาตั้งต้น (ใช้ rate card) | `500.00` |
| `fuelRefPrice` |   | `string` | null ได้ | ราคาน้ำมันอ้างอิง (฿/ลิตร) — ใช้กับ PERCENT_OF_FREIGHT เท่านั้น | `31.50` |
| `condition` |   | `string` | null ได้ |   | `ฟรี 2 ชม. แรก` |
| `side` |   | `string` | ค่า: `SELL`, `BUY`, `BOTH` | ใช้กับ: SELL = ฝั่งขาย (ลูกค้า), BUY = ฝั่งซื้อ (รถร่วม), BOTH = ทั้งสองฝั่ง (ค่าเริ่มต้น) |   |
| `isSurcharge` |   | `boolean` |   | เป็นค่าใช้จ่ายเพิ่ม (ค่ารอ ทางด่วน ยกของ) — false = ค่าขนส่งหลัก (ค่าเริ่มต้น true) |   |
| `nameEn` |   | `string` | null ได้ |   | `en name` |
| `defaultAccountCode` |   | `string` | null ได้ | รหัสบัญชีรายได้/ค่าใช้จ่ายตั้งต้น (ไม่บังคับ — mapping ERP อยู่ที่ connector) | `4110-01` |
| `code` |   | `string` |   | รหัสสงวนของระบบ (FREIGHT/EXTRA_STOP/FSC) แก้ไม่ได้ | `WAIT` |
| `name` |   | `string` |   |   | `ค่ารอ` |
| `calcUnit` |   | `string` | ค่า: `PER_TRIP`, `PER_HOUR`, `PER_NIGHT`, `PER_STOP`, `PERCENT_OF_FREIGHT`, `ACTUAL` |   |   |
| `vatType` |   | `string` | ค่า: `EXEMPT_TRANSPORT`, `VAT_7`, `ZERO_RATED` |   |   |
| `whtRate` |   | `string` | ค่า: `0.00`, `1.00`, `3.00` |   |   |
| `externalId` |   | `string` | null ได้ | null = ลบการผูก |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `ServiceItemWriteResultDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ยังไม่มีแถวที่ externalId นี้ (สร้างใหม่ใช้ PUT) หรืออยู่ tenant อื่น — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | ขัดกับข้อมูลที่มีอยู่ (เช่น รหัส/ชื่อซ้ำ, สถานะไม่อนุญาตให้แก้) — [conflict](errors.md#conflict), [duplicate](errors.md#duplicate) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง (รวมทุกช่องใน errors[]) — externalId ใน path ผิดรูปแบบ = field `externalId` — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PATCH "$TMS_BASE_URL/v1/service-items/external/<externalId>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"code":"WAIT","name":"ค่ารอ"}'
```

```ts
const { data, error } = await tms.PATCH('/v1/service-items/external/{externalId}', {
  params: { path: { externalId: "…" } },
  body: {
    "code": "WAIT",
    "name": "ค่ารอ"
  },
});
```

## GET /v1/service-items/{id} {#get-service-items-id}

`GET /v1/service-items/{id}`

scope: `master:read` · operationId: `ServiceItems_get`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `ServiceItemDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/service-items/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/service-items/{id}', {
  params: { path: { id: "…" } },
});
```

## PATCH /v1/service-items/{id} {#patch-service-items-id}

`PATCH /v1/service-items/{id}`

scope: `master:write` · operationId: `ServiceItems_update`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `UpdateServiceItemDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `defaultPrice` |   | `string` | null ได้ | ราคาตั้งต้น (บาท ก่อน VAT) — PERCENT_OF_FREIGHT = เปอร์เซ็นต์ (≤ 100) · ACTUAL ต้องเป็น null (ตามใบเสร็จ) · null = ไม่มีราคาตั้งต้น (ใช้ rate card) | `500.00` |
| `fuelRefPrice` |   | `string` | null ได้ | ราคาน้ำมันอ้างอิง (฿/ลิตร) — ใช้กับ PERCENT_OF_FREIGHT เท่านั้น | `31.50` |
| `condition` |   | `string` | null ได้ |   | `ฟรี 2 ชม. แรก` |
| `side` |   | `string` | ค่า: `SELL`, `BUY`, `BOTH` | ใช้กับ: SELL = ฝั่งขาย (ลูกค้า), BUY = ฝั่งซื้อ (รถร่วม), BOTH = ทั้งสองฝั่ง (ค่าเริ่มต้น) |   |
| `isSurcharge` |   | `boolean` |   | เป็นค่าใช้จ่ายเพิ่ม (ค่ารอ ทางด่วน ยกของ) — false = ค่าขนส่งหลัก (ค่าเริ่มต้น true) |   |
| `nameEn` |   | `string` | null ได้ |   | `en name` |
| `defaultAccountCode` |   | `string` | null ได้ | รหัสบัญชีรายได้/ค่าใช้จ่ายตั้งต้น (ไม่บังคับ — mapping ERP อยู่ที่ connector) | `4110-01` |
| `code` |   | `string` |   | รหัสสงวนของระบบ (FREIGHT/EXTRA_STOP/FSC) แก้ไม่ได้ | `WAIT` |
| `name` |   | `string` |   |   | `ค่ารอ` |
| `calcUnit` |   | `string` | ค่า: `PER_TRIP`, `PER_HOUR`, `PER_NIGHT`, `PER_STOP`, `PERCENT_OF_FREIGHT`, `ACTUAL` |   |   |
| `vatType` |   | `string` | ค่า: `EXEMPT_TRANSPORT`, `VAT_7`, `ZERO_RATED` |   |   |
| `whtRate` |   | `string` | ค่า: `0.00`, `1.00`, `3.00` |   |   |
| `externalId` |   | `string` | null ได้ | null = ลบการผูก |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `ServiceItemWriteResultDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PATCH "$TMS_BASE_URL/v1/service-items/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"code":"WAIT","name":"ค่ารอ"}'
```

```ts
const { data, error } = await tms.PATCH('/v1/service-items/{id}', {
  params: { path: { id: "…" } },
  body: {
    "code": "WAIT",
    "name": "ค่ารอ"
  },
});
```

## GET /v1/service-items/{id}/history {#get-service-items-id-history}

`GET /v1/service-items/{id}/history`

scope: `master:read` · operationId: `ServiceItems_history`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | ประวัติการแก้จาก audit log ใหม่สุดก่อน | `AuditPageDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/service-items/<id>/history" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/service-items/{id}/history', {
  params: { path: { id: "…" } },
});
```

## POST /v1/service-items/{id}/deactivate {#post-service-items-id-deactivate}

`POST /v1/service-items/{id}/deactivate`

scope: `master:write` · operationId: `ServiceItems_deactivate`

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
| `200` |   | `ServiceItemDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/service-items/<id>/deactivate" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"เลิกใช้บริการตั้งแต่ ธ.ค. 2569"}'
```

```ts
const { data, error } = await tms.POST('/v1/service-items/{id}/deactivate', {
  params: { path: { id: "…" } },
  body: {
    "reason": "เลิกใช้บริการตั้งแต่ ธ.ค. 2569"
  },
});
```

## POST /v1/service-items/{id}/activate {#post-service-items-id-activate}

`POST /v1/service-items/{id}/activate`

scope: `master:write` · operationId: `ServiceItems_activate`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `MasterOptionalReasonDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` |   | `string` | ยาว ≤ 500 |   |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `ServiceItemDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/service-items/<id>/activate" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{}'
```

```ts
const { data, error } = await tms.POST('/v1/service-items/{id}/activate', {
  params: { path: { id: "…" } },
  body: {},
});
```

## POST /v1/service-items/{id}/delete {#post-service-items-id-delete}

`POST /v1/service-items/{id}/delete`

scope: `master:write` · operationId: `ServiceItems_remove`

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
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/service-items/<id>/delete" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"เลิกใช้บริการตั้งแต่ ธ.ค. 2569"}'
```

```ts
const { data, error } = await tms.POST('/v1/service-items/{id}/delete', {
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

### NextCodeDto {#schema-NextCodeDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `code` | ใช่ | `string` |   |   | `CUS-0010` |

### ServiceItemDto {#schema-ServiceItemDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `svc_3f2a…` |
| `code` | ใช่ | `string` |   |   | `WAIT` |
| `externalId` | ใช่ | `string` | null ได้ |   |   |
| `name` | ใช่ | `string` |   |   | `ค่ารอ` |
| `nameEn` | ใช่ | `string` | null ได้ |   |   |
| `calcUnit` | ใช่ | `string` | ค่า: `PER_TRIP`, `PER_HOUR`, `PER_NIGHT`, `PER_STOP`, `PERCENT_OF_FREIGHT`, `ACTUAL` |   |   |
| `unitLabel` | ใช่ | `string` |   | ข้อความหน่วยบนเอกสาร | `ชั่วโมง` |
| `defaultPrice` | ใช่ | `string` | null ได้ |   | `200.00` |
| `fuelRefPrice` | ใช่ | `string` | null ได้ |   | `31.50` |
| `condition` | ใช่ | `string` | null ได้ |   |   |
| `vatType` | ใช่ | `string` | ค่า: `EXEMPT_TRANSPORT`, `VAT_7`, `ZERO_RATED` |   |   |
| `whtRate` | ใช่ | `string` | ค่า: `0.00`, `1.00`, `3.00` |   |   |
| `side` | ใช่ | `string` | ค่า: `SELL`, `BUY`, `BOTH` |   |   |
| `isSurcharge` | ใช่ | `boolean` |   |   |   |
| `defaultAccountCode` | ใช่ | `string` | null ได้ |   |   |
| `system` | ใช่ | `boolean` |   | แถวค่าเริ่มต้นที่ระบบสร้างให้ |   |
| `reserved` | ใช่ | `boolean` |   | รหัสสงวนของระบบ (FREIGHT/EXTRA_STOP/FSC — MD-158): ปิดใช้/ลบ/เปลี่ยนรหัสไม่ได้ |   |
| `usage` | ใช่ | `ServiceItemUsageDto` |   |   |   |
| `status` | ใช่ | `string` | ค่า: `active`, `inactive` |   |   |
| `deletedAt` |   | `string (date-time)` | null ได้ | มีค่าเฉพาะเมื่อขอ includeDeleted=true และรายการถูกลบแล้ว (tombstone) |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string (date-time)` |   |   |   |
| `updatedAt` | ใช่ | `string (date-time)` |   |   |   |

### ServiceItemPageDto {#schema-ServiceItemPageDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<ServiceItemDto>` |   |   |   |
| `nextCursor` | ใช่ | `string` | null ได้ |   |   |
| `hasMore` | ใช่ | `boolean` |   |   |   |

### ServiceItemSummaryDto {#schema-ServiceItemSummaryDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `total` | ใช่ | `number` |   | รายการทั้งหมด (ไม่รวมที่ลบ) |   |
| `active` | ใช่ | `number` |   |   |   |
| `inactive` | ใช่ | `number` |   |   |   |
| `vat7` | ใช่ | `number` |   | VAT 7% |   |
| `exempt` | ใช่ | `number` |   | ยกเว้น VAT |   |
| `zeroRated` | ใช่ | `number` |   | VAT 0% |   |

### ServiceItemWriteResultDto {#schema-ServiceItemWriteResultDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `svc_3f2a…` |
| `code` | ใช่ | `string` |   |   | `WAIT` |
| `externalId` | ใช่ | `string` | null ได้ |   |   |
| `name` | ใช่ | `string` |   |   | `ค่ารอ` |
| `nameEn` | ใช่ | `string` | null ได้ |   |   |
| `calcUnit` | ใช่ | `string` | ค่า: `PER_TRIP`, `PER_HOUR`, `PER_NIGHT`, `PER_STOP`, `PERCENT_OF_FREIGHT`, `ACTUAL` |   |   |
| `unitLabel` | ใช่ | `string` |   | ข้อความหน่วยบนเอกสาร | `ชั่วโมง` |
| `defaultPrice` | ใช่ | `string` | null ได้ |   | `200.00` |
| `fuelRefPrice` | ใช่ | `string` | null ได้ |   | `31.50` |
| `condition` | ใช่ | `string` | null ได้ |   |   |
| `vatType` | ใช่ | `string` | ค่า: `EXEMPT_TRANSPORT`, `VAT_7`, `ZERO_RATED` |   |   |
| `whtRate` | ใช่ | `string` | ค่า: `0.00`, `1.00`, `3.00` |   |   |
| `side` | ใช่ | `string` | ค่า: `SELL`, `BUY`, `BOTH` |   |   |
| `isSurcharge` | ใช่ | `boolean` |   |   |   |
| `defaultAccountCode` | ใช่ | `string` | null ได้ |   |   |
| `system` | ใช่ | `boolean` |   | แถวค่าเริ่มต้นที่ระบบสร้างให้ |   |
| `reserved` | ใช่ | `boolean` |   | รหัสสงวนของระบบ (FREIGHT/EXTRA_STOP/FSC — MD-158): ปิดใช้/ลบ/เปลี่ยนรหัสไม่ได้ |   |
| `usage` | ใช่ | `ServiceItemUsageDto` |   |   |   |
| `status` | ใช่ | `string` | ค่า: `active`, `inactive` |   |   |
| `deletedAt` |   | `string (date-time)` | null ได้ | มีค่าเฉพาะเมื่อขอ includeDeleted=true และรายการถูกลบแล้ว (tombstone) |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string (date-time)` |   |   |   |
| `updatedAt` | ใช่ | `string (date-time)` |   |   |   |
| `warnings` | ใช่ | `array<ServiceItemWarningDto>` |   |   |   |
