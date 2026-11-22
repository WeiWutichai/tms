# สินค้า (products)

13 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`GET /v1/products`](#get-products) | `master:read` |
| [`POST /v1/products`](#post-products) | `master:write` |
| [`GET /v1/products/summary`](#get-products-summary) | `master:read` |
| [`GET /v1/products/next-code`](#get-products-next-code) | `master:write` |
| [`GET /v1/products/export`](#get-products-export) | `export:run` |
| [`PUT /v1/products/external/{externalId}`](#put-products-external-externalId) | `master:write` |
| [`PATCH /v1/products/external/{externalId}`](#patch-products-external-externalId) | `master:write` |
| [`GET /v1/products/{id}`](#get-products-id) | `master:read` |
| [`PATCH /v1/products/{id}`](#patch-products-id) | `master:write` |
| [`GET /v1/products/{id}/history`](#get-products-id-history) | `master:read` |
| [`POST /v1/products/{id}/deactivate`](#post-products-id-deactivate) | `master:write` |
| [`POST /v1/products/{id}/activate`](#post-products-id-activate) | `master:write` |
| [`POST /v1/products/{id}/delete`](#post-products-id-delete) | `master:write` |

## GET /v1/products {#get-products}

`GET /v1/products`

scope: `master:read` · operationId: `Products_list`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน (ใช้กับ sort เดิมเท่านั้น) |
| `updatedAfter` | query |   | `string` | คืนเฉพาะแถวที่ updatedAt > ค่านี้ (incremental pull — ใช้คู่ includeDeleted=true เพื่อรับรายการที่ถูกลบ) |
| `sort` | query |   | `string` ค่า: `code`, `updatedAt`, `-updatedAt` | code = เรียงตามรหัส (ค่าเริ่มต้นของหน้าจอ) · updatedAt/-updatedAt สำหรับ sync |
| `fields` | query |   | `string` | รายชื่อ field คั่นด้วย, เช่น id,legalName |
| `q` | query |   | `string` | ค้นหา — รหัส ชื่อ เลขผู้เสียภาษี หรือ externalId (ไม่สนตัวพิมพ์) |
| `status` | query |   | `string` | คั่นด้วย, เช่น active,inactive |
| `externalId` | query |   | `string` | externalId ตรงตัว (ใช้ตรวจว่ามีในระบบแล้วหรือยัง) |
| `includeDeleted` | query |   | `string` | true = รวมรายการที่ถูกลบ (tombstone มี `deletedAt`) — ให้ระบบที่ดึงแบบ incremental รู้ว่ารายการถูกลบ |
| `name` | query |   | `string` | ชื่อหรือรหัสมีคำนี้ (ช่องกรองคอลัมน์ "สินค้า / รหัส") |
| `unitId` | query |   | `string` | หน่วยหลัก (`unt_…`) |
| `special` | query |   | `string` ค่า: `none`, `any`, `fragile`, `hazardous`, `temp` | none = ทั่วไป, any = มีประเภทพิเศษ, fragile/hazardous/temp = เปราะบาง/อันตราย/ควบคุมอุณหภูมิ |
| `customerId` | query |   | `string` | `cus_…` = สินค้าของลูกค้ารายนี้ · `none` = สินค้าที่ใช้ได้ทุกลูกค้า |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `ProductPageDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/products" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/products');
```

## POST /v1/products {#post-products}

`POST /v1/products`

scope: `master:write` · operationId: `Products_create`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `Idempotency-Key` | header |   | `string` |   |

**Request body** `CreateProductDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `customerId` |   | `string` | null ได้ | สินค้าของลูกค้ารายเดียว — null/ไม่ส่ง = ใช้ได้ทุกลูกค้า | `cus_3f2a…` |
| `weightPerUnitKg` |   | `number` | null ได้ | น้ำหนักต่อหน่วยหลัก (กก.) > 0 ทศนิยม 3 — บังคับเมื่อหน่วยเป็นชนิดนับ (COUNT); หน่วยน้ำหนัก = ตัวแปลงของหน่วย (ไม่ส่งได้) | `50` |
| `volumePerUnitCbm` |   | `number` | null ได้ | ปริมาตรต่อหน่วยหลัก (ลบ.ม.) ≥ 0 ทศนิยม 4 — หน่วยปริมาตร = ตัวแปลงของหน่วย | `0.035` |
| `altUnits` |   | `array<AltUnitInputDto>` |   | หน่วยแปลง (แทนทั้งชุด) ≤ 10 — ห้ามซ้ำ ห้ามเป็นหน่วยหลัก |   |
| `altUnits[].unitId` | ใช่ | `string` |   | หน่วยแปลง: `unt_…` หรือ `code:{รหัสหน่วย}` | `code:PLT` |
| `altUnits[].factorToBase` | ใช่ | `number` |   | 1 หน่วยนี้ = ? หน่วยหลัก (> 0) เช่น 1 พาเลท = 40 ถุง | `40` |
| `fragile` |   | `boolean` |   | เปราะบาง |   |
| `hazardous` |   | `boolean` |   | สินค้าอันตราย — ต้องมี unNumber + hazardClass (ต้องใช้รถป้าย HAZMAT) |   |
| `unNumber` |   | `string` | null ได้ | เลข UN 4 หลัก (รับ "UN1993") | `1993` |
| `hazardClass` |   | `string` | ค่า: `1.1`, `1.2`, `1.3`, `1.4`, `1.5`, `1.6`, `2.1`, `2.2`, `2.3`, `3`, `4.1`, `4.2`, `4.3`, `5.1`, `5.2`, `6.1`, `6.2`, `7`, `8`, `9` · null ได้ | class/division UN เช่น 3, 2.1, 4.3 | `3` |
| `tempControlled` |   | `boolean` |   | ควบคุมอุณหภูมิ — ต้องมี tempMinC/tempMaxC (ต้องใช้รถห้องเย็นที่ช่วงอุณหภูมิครอบคลุม) |   |
| `tempMinC` |   | `number` | null ได้ | °C -40…30, min < max | `2` |
| `tempMaxC` |   | `number` | null ได้ |   | `8` |
| `stackable` |   | `boolean` |   | วางซ้อนได้ (ค่าเริ่มต้น true) |   |
| `barcode` |   | `string` | null ได้ |   | `8851234567890` |
| `name` | ใช่ | `string` |   |   | `ปูนซีเมนต์ถุง 50 กก.` |
| `unitId` | ใช่ | `string` |   | หน่วยหลัก: `unt_…` หรือ `code:{รหัสหน่วย}` (หน่วยต้องใช้งานอยู่) | `code:BAG` |
| `code` |   | `string` |   | รหัส — ไม่ส่ง = ระบบออกเลขถัดไป `P-0001` | `P-0001` |
| `externalId` |   | `string` |   | รหัสในระบบต้นทาง — เรียกด้วย ext:{externalId} ได้ |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `201` |   | `ProductDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/products" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"name":"ปูนซีเมนต์ถุง 50 กก.","unitId":"code:BAG","code":"P-0001"}'
```

```ts
const { data, error } = await tms.POST('/v1/products', {
  body: {
    "name": "ปูนซีเมนต์ถุง 50 กก.",
    "unitId": "code:BAG",
    "code": "P-0001"
  },
});
```

## GET /v1/products/summary {#get-products-summary}

`GET /v1/products/summary`

scope: `master:read` · operationId: `Products_summary`

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `ProductSummaryDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/products/summary" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/products/summary');
```

## GET /v1/products/next-code {#get-products-next-code}

`GET /v1/products/next-code`

scope: `master:write` · operationId: `Products_nextCode`

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | รหัสที่ระบบจะออกให้สินค้าใหม่ (`P-0001`) | `NextCodeDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/products/next-code" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/products/next-code');
```

## GET /v1/products/export {#get-products-export}

`GET /v1/products/export`

scope: `export:run` · operationId: `Products_export`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน (ใช้กับ sort เดิมเท่านั้น) |
| `updatedAfter` | query |   | `string` | คืนเฉพาะแถวที่ updatedAt > ค่านี้ (incremental pull — ใช้คู่ includeDeleted=true เพื่อรับรายการที่ถูกลบ) |
| `sort` | query |   | `string` ค่า: `code`, `updatedAt`, `-updatedAt` | code = เรียงตามรหัส (ค่าเริ่มต้นของหน้าจอ) · updatedAt/-updatedAt สำหรับ sync |
| `fields` | query |   | `string` | รายชื่อ field คั่นด้วย, เช่น id,legalName |
| `q` | query |   | `string` | ค้นหา — รหัส ชื่อ เลขผู้เสียภาษี หรือ externalId (ไม่สนตัวพิมพ์) |
| `status` | query |   | `string` | คั่นด้วย, เช่น active,inactive |
| `externalId` | query |   | `string` | externalId ตรงตัว (ใช้ตรวจว่ามีในระบบแล้วหรือยัง) |
| `includeDeleted` | query |   | `string` | true = รวมรายการที่ถูกลบ (tombstone มี `deletedAt`) — ให้ระบบที่ดึงแบบ incremental รู้ว่ารายการถูกลบ |
| `name` | query |   | `string` | ชื่อหรือรหัสมีคำนี้ (ช่องกรองคอลัมน์ "สินค้า / รหัส") |
| `unitId` | query |   | `string` | หน่วยหลัก (`unt_…`) |
| `special` | query |   | `string` ค่า: `none`, `any`, `fragile`, `hazardous`, `temp` | none = ทั่วไป, any = มีประเภทพิเศษ, fragile/hazardous/temp = เปราะบาง/อันตราย/ควบคุมอุณหภูมิ |
| `customerId` | query |   | `string` | `cus_…` = สินค้าของลูกค้ารายนี้ · `none` = สินค้าที่ใช้ได้ทุกลูกค้า |
| `format` | query |   | `string` ค่า: `xlsx`, `csv` |   |
| `ids` | query |   | `string` | ส่งออกเฉพาะ id เหล่านี้ (คั่นด้วย,) — แถวที่เลือกในตาราง |
| `X-Step-Up` | header |   | `string` | stepUpToken จาก `POST /v1/auth/step-up` (ยืนยัน TOTP อายุ 5 นาที) — ผู้ใช้ต้องส่งเมื่อส่งออก: ผู้ใช้ทุกครั้ง ยกเว้นเลือกแถวเอง (`ids`) · รายงานและ `accounting-*` ทุกครั้ง ไม่งั้น 403 `step_up_required` · API key / OAuth client ไม่ต้อง |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | ไฟล์.xlsx หรือ.csv ตามตัวกรองเดียวกับรายการ (สูงสุด 10,000 แถว) |   |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`export:run`) · ต้องยืนยัน 2FA ซ้ำ (`step_up_required`) เมื่อส่งออก: ผู้ใช้ทุกครั้ง ยกเว้นเลือกแถวเอง (`ids`) · รายงานและ `accounting-*` ทุกครั้ง — [permission_denied](errors.md#permission_denied), [step_up_required](errors.md#step_up_required) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/products/export" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/products/export');
```

## PUT /v1/products/external/{externalId} {#put-products-external-externalId}

`PUT /v1/products/external/{externalId}`

scope: `master:write` · operationId: `Products_upsertExternal`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `externalId` | path | ใช่ | `string` | เลขของระบบต้นทาง (ASCII ที่พิมพ์ได้ 1–100 ตัว ไม่มีช่องว่าง) — unique ต่อ tenant ต่อ resource |
| `If-Match` | header |   | `string` | ETag — ใช้เมื่อแถวมีอยู่แล้ว |

**Request body** `UpsertProductDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `customerId` |   | `string` | null ได้ | สินค้าของลูกค้ารายเดียว — null/ไม่ส่ง = ใช้ได้ทุกลูกค้า | `cus_3f2a…` |
| `weightPerUnitKg` |   | `number` | null ได้ | น้ำหนักต่อหน่วยหลัก (กก.) > 0 ทศนิยม 3 — บังคับเมื่อหน่วยเป็นชนิดนับ (COUNT); หน่วยน้ำหนัก = ตัวแปลงของหน่วย (ไม่ส่งได้) | `50` |
| `volumePerUnitCbm` |   | `number` | null ได้ | ปริมาตรต่อหน่วยหลัก (ลบ.ม.) ≥ 0 ทศนิยม 4 — หน่วยปริมาตร = ตัวแปลงของหน่วย | `0.035` |
| `altUnits` |   | `array<AltUnitInputDto>` |   | หน่วยแปลง (แทนทั้งชุด) ≤ 10 — ห้ามซ้ำ ห้ามเป็นหน่วยหลัก |   |
| `altUnits[].unitId` | ใช่ | `string` |   | หน่วยแปลง: `unt_…` หรือ `code:{รหัสหน่วย}` | `code:PLT` |
| `altUnits[].factorToBase` | ใช่ | `number` |   | 1 หน่วยนี้ = ? หน่วยหลัก (> 0) เช่น 1 พาเลท = 40 ถุง | `40` |
| `fragile` |   | `boolean` |   | เปราะบาง |   |
| `hazardous` |   | `boolean` |   | สินค้าอันตราย — ต้องมี unNumber + hazardClass (ต้องใช้รถป้าย HAZMAT) |   |
| `unNumber` |   | `string` | null ได้ | เลข UN 4 หลัก (รับ "UN1993") | `1993` |
| `hazardClass` |   | `string` | ค่า: `1.1`, `1.2`, `1.3`, `1.4`, `1.5`, `1.6`, `2.1`, `2.2`, `2.3`, `3`, `4.1`, `4.2`, `4.3`, `5.1`, `5.2`, `6.1`, `6.2`, `7`, `8`, `9` · null ได้ | class/division UN เช่น 3, 2.1, 4.3 | `3` |
| `tempControlled` |   | `boolean` |   | ควบคุมอุณหภูมิ — ต้องมี tempMinC/tempMaxC (ต้องใช้รถห้องเย็นที่ช่วงอุณหภูมิครอบคลุม) |   |
| `tempMinC` |   | `number` | null ได้ | °C -40…30, min < max | `2` |
| `tempMaxC` |   | `number` | null ได้ |   | `8` |
| `stackable` |   | `boolean` |   | วางซ้อนได้ (ค่าเริ่มต้น true) |   |
| `barcode` |   | `string` | null ได้ |   | `8851234567890` |
| `name` | ใช่ | `string` |   |   | `ปูนซีเมนต์ถุง 50 กก.` |
| `unitId` | ใช่ | `string` |   | หน่วยหลัก: `unt_…` หรือ `code:{รหัสหน่วย}` (หน่วยต้องใช้งานอยู่) | `code:BAG` |
| `code` |   | `string` |   | ใช้ตอนสร้างเท่านั้น | `P-0001` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | มีอยู่แล้ว → อัปเดต (ส่งซ้ำได้ ไม่เกิดแถวใหม่) | `ProductDto` |
| `201` | ยังไม่มี → สร้าง | `ProductDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `409` | ขัดกับข้อมูลที่มีอยู่ (เช่น รหัส/ชื่อซ้ำ, สถานะไม่อนุญาตให้แก้) — [conflict](errors.md#conflict), [duplicate](errors.md#duplicate) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง (รวมทุกช่องใน errors[]) — externalId ใน path ผิดรูปแบบ = field `externalId` — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PUT "$TMS_BASE_URL/v1/products/external/<externalId>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"ปูนซีเมนต์ถุง 50 กก.","unitId":"code:BAG","code":"P-0001"}'
```

```ts
const { data, error } = await tms.PUT('/v1/products/external/{externalId}', {
  params: { path: { externalId: "…" } },
  body: {
    "name": "ปูนซีเมนต์ถุง 50 กก.",
    "unitId": "code:BAG",
    "code": "P-0001"
  },
});
```

## แก้บางช่องด้วย externalId {#patch-products-external-externalId}

`PATCH /v1/products/external/{externalId}`

scope: `master:write` · operationId: `Products_patchExternal`

เหมือน `PATCH /products/ext:{externalId}` (กติกาเดียวกับ PATCH ด้วย id) · ยังไม่มีแถวนี้ → 404 — สร้างใหม่ใช้ PUT

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `externalId` | path | ใช่ | `string` | เลขของระบบต้นทาง (ASCII ที่พิมพ์ได้ 1–100 ตัว ไม่มีช่องว่าง) — unique ต่อ tenant ต่อ resource |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `UpdateProductDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `customerId` |   | `string` | null ได้ | สินค้าของลูกค้ารายเดียว — null/ไม่ส่ง = ใช้ได้ทุกลูกค้า | `cus_3f2a…` |
| `weightPerUnitKg` |   | `number` | null ได้ | น้ำหนักต่อหน่วยหลัก (กก.) > 0 ทศนิยม 3 — บังคับเมื่อหน่วยเป็นชนิดนับ (COUNT); หน่วยน้ำหนัก = ตัวแปลงของหน่วย (ไม่ส่งได้) | `50` |
| `volumePerUnitCbm` |   | `number` | null ได้ | ปริมาตรต่อหน่วยหลัก (ลบ.ม.) ≥ 0 ทศนิยม 4 — หน่วยปริมาตร = ตัวแปลงของหน่วย | `0.035` |
| `altUnits` |   | `array<AltUnitInputDto>` |   | หน่วยแปลง (แทนทั้งชุด) ≤ 10 — ห้ามซ้ำ ห้ามเป็นหน่วยหลัก |   |
| `altUnits[].unitId` | ใช่ | `string` |   | หน่วยแปลง: `unt_…` หรือ `code:{รหัสหน่วย}` | `code:PLT` |
| `altUnits[].factorToBase` | ใช่ | `number` |   | 1 หน่วยนี้ = ? หน่วยหลัก (> 0) เช่น 1 พาเลท = 40 ถุง | `40` |
| `fragile` |   | `boolean` |   | เปราะบาง |   |
| `hazardous` |   | `boolean` |   | สินค้าอันตราย — ต้องมี unNumber + hazardClass (ต้องใช้รถป้าย HAZMAT) |   |
| `unNumber` |   | `string` | null ได้ | เลข UN 4 หลัก (รับ "UN1993") | `1993` |
| `hazardClass` |   | `string` | ค่า: `1.1`, `1.2`, `1.3`, `1.4`, `1.5`, `1.6`, `2.1`, `2.2`, `2.3`, `3`, `4.1`, `4.2`, `4.3`, `5.1`, `5.2`, `6.1`, `6.2`, `7`, `8`, `9` · null ได้ | class/division UN เช่น 3, 2.1, 4.3 | `3` |
| `tempControlled` |   | `boolean` |   | ควบคุมอุณหภูมิ — ต้องมี tempMinC/tempMaxC (ต้องใช้รถห้องเย็นที่ช่วงอุณหภูมิครอบคลุม) |   |
| `tempMinC` |   | `number` | null ได้ | °C -40…30, min < max | `2` |
| `tempMaxC` |   | `number` | null ได้ |   | `8` |
| `stackable` |   | `boolean` |   | วางซ้อนได้ (ค่าเริ่มต้น true) |   |
| `barcode` |   | `string` | null ได้ |   | `8851234567890` |
| `name` |   | `string` |   |   | `ปูนซีเมนต์ถุง 50 กก.` |
| `code` |   | `string` |   | แก้รหัส | `P-0001` |
| `unitId` |   | `string` |   |   | `code:BAG` |
| `externalId` |   | `string` | null ได้ | null = ลบการผูก |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `ProductDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ยังไม่มีแถวที่ externalId นี้ (สร้างใหม่ใช้ PUT) หรืออยู่ tenant อื่น — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | ขัดกับข้อมูลที่มีอยู่ (เช่น รหัส/ชื่อซ้ำ, สถานะไม่อนุญาตให้แก้) — [conflict](errors.md#conflict), [duplicate](errors.md#duplicate) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง (รวมทุกช่องใน errors[]) — externalId ใน path ผิดรูปแบบ = field `externalId` — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PATCH "$TMS_BASE_URL/v1/products/external/<externalId>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"ปูนซีเมนต์ถุง 50 กก.","code":"P-0001","unitId":"code:BAG"}'
```

```ts
const { data, error } = await tms.PATCH('/v1/products/external/{externalId}', {
  params: { path: { externalId: "…" } },
  body: {
    "name": "ปูนซีเมนต์ถุง 50 กก.",
    "code": "P-0001",
    "unitId": "code:BAG"
  },
});
```

## GET /v1/products/{id} {#get-products-id}

`GET /v1/products/{id}`

scope: `master:read` · operationId: `Products_get`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `ProductDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/products/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/products/{id}', {
  params: { path: { id: "…" } },
});
```

## PATCH /v1/products/{id} {#patch-products-id}

`PATCH /v1/products/{id}`

scope: `master:write` · operationId: `Products_update`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `UpdateProductDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `customerId` |   | `string` | null ได้ | สินค้าของลูกค้ารายเดียว — null/ไม่ส่ง = ใช้ได้ทุกลูกค้า | `cus_3f2a…` |
| `weightPerUnitKg` |   | `number` | null ได้ | น้ำหนักต่อหน่วยหลัก (กก.) > 0 ทศนิยม 3 — บังคับเมื่อหน่วยเป็นชนิดนับ (COUNT); หน่วยน้ำหนัก = ตัวแปลงของหน่วย (ไม่ส่งได้) | `50` |
| `volumePerUnitCbm` |   | `number` | null ได้ | ปริมาตรต่อหน่วยหลัก (ลบ.ม.) ≥ 0 ทศนิยม 4 — หน่วยปริมาตร = ตัวแปลงของหน่วย | `0.035` |
| `altUnits` |   | `array<AltUnitInputDto>` |   | หน่วยแปลง (แทนทั้งชุด) ≤ 10 — ห้ามซ้ำ ห้ามเป็นหน่วยหลัก |   |
| `altUnits[].unitId` | ใช่ | `string` |   | หน่วยแปลง: `unt_…` หรือ `code:{รหัสหน่วย}` | `code:PLT` |
| `altUnits[].factorToBase` | ใช่ | `number` |   | 1 หน่วยนี้ = ? หน่วยหลัก (> 0) เช่น 1 พาเลท = 40 ถุง | `40` |
| `fragile` |   | `boolean` |   | เปราะบาง |   |
| `hazardous` |   | `boolean` |   | สินค้าอันตราย — ต้องมี unNumber + hazardClass (ต้องใช้รถป้าย HAZMAT) |   |
| `unNumber` |   | `string` | null ได้ | เลข UN 4 หลัก (รับ "UN1993") | `1993` |
| `hazardClass` |   | `string` | ค่า: `1.1`, `1.2`, `1.3`, `1.4`, `1.5`, `1.6`, `2.1`, `2.2`, `2.3`, `3`, `4.1`, `4.2`, `4.3`, `5.1`, `5.2`, `6.1`, `6.2`, `7`, `8`, `9` · null ได้ | class/division UN เช่น 3, 2.1, 4.3 | `3` |
| `tempControlled` |   | `boolean` |   | ควบคุมอุณหภูมิ — ต้องมี tempMinC/tempMaxC (ต้องใช้รถห้องเย็นที่ช่วงอุณหภูมิครอบคลุม) |   |
| `tempMinC` |   | `number` | null ได้ | °C -40…30, min < max | `2` |
| `tempMaxC` |   | `number` | null ได้ |   | `8` |
| `stackable` |   | `boolean` |   | วางซ้อนได้ (ค่าเริ่มต้น true) |   |
| `barcode` |   | `string` | null ได้ |   | `8851234567890` |
| `name` |   | `string` |   |   | `ปูนซีเมนต์ถุง 50 กก.` |
| `code` |   | `string` |   | แก้รหัส | `P-0001` |
| `unitId` |   | `string` |   |   | `code:BAG` |
| `externalId` |   | `string` | null ได้ | null = ลบการผูก |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `ProductDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PATCH "$TMS_BASE_URL/v1/products/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"ปูนซีเมนต์ถุง 50 กก.","code":"P-0001","unitId":"code:BAG"}'
```

```ts
const { data, error } = await tms.PATCH('/v1/products/{id}', {
  params: { path: { id: "…" } },
  body: {
    "name": "ปูนซีเมนต์ถุง 50 กก.",
    "code": "P-0001",
    "unitId": "code:BAG"
  },
});
```

## GET /v1/products/{id}/history {#get-products-id-history}

`GET /v1/products/{id}/history`

scope: `master:read` · operationId: `Products_history`

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
curl -sS -X GET "$TMS_BASE_URL/v1/products/<id>/history" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/products/{id}/history', {
  params: { path: { id: "…" } },
});
```

## POST /v1/products/{id}/deactivate {#post-products-id-deactivate}

`POST /v1/products/{id}/deactivate`

scope: `master:write` · operationId: `Products_deactivate`

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
| `200` |   | `ProductDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/products/<id>/deactivate" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"เลิกใช้บริการตั้งแต่ ธ.ค. 2569"}'
```

```ts
const { data, error } = await tms.POST('/v1/products/{id}/deactivate', {
  params: { path: { id: "…" } },
  body: {
    "reason": "เลิกใช้บริการตั้งแต่ ธ.ค. 2569"
  },
});
```

## POST /v1/products/{id}/activate {#post-products-id-activate}

`POST /v1/products/{id}/activate`

scope: `master:write` · operationId: `Products_activate`

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
| `200` |   | `ProductDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/products/<id>/activate" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{}'
```

```ts
const { data, error } = await tms.POST('/v1/products/{id}/activate', {
  params: { path: { id: "…" } },
  body: {},
});
```

## POST /v1/products/{id}/delete {#post-products-id-delete}

`POST /v1/products/{id}/delete`

scope: `master:write` · operationId: `Products_remove`

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
curl -sS -X POST "$TMS_BASE_URL/v1/products/<id>/delete" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"เลิกใช้บริการตั้งแต่ ธ.ค. 2569"}'
```

```ts
const { data, error } = await tms.POST('/v1/products/{id}/delete', {
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

### ProductDto {#schema-ProductDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `prd_3f2a…` |
| `code` | ใช่ | `string` |   |   | `P-0001` |
| `externalId` | ใช่ | `string` | null ได้ |   |   |
| `name` | ใช่ | `string` |   |   | `ปูนซีเมนต์ถุง 50 กก.` |
| `customer` | ใช่ | `ProductCustomerRefDto` | null ได้ |   |   |
| `unit` | ใช่ | `ProductUnitRefDto` |   | หน่วยหลัก |   |
| `weightPerUnitKg` | ใช่ | `number` | null ได้ |   | `50` |
| `volumePerUnitCbm` | ใช่ | `number` | null ได้ |   | `0.035` |
| `altUnits` | ใช่ | `array<ProductAltUnitDto>` |   |   |   |
| `fragile` | ใช่ | `boolean` |   |   |   |
| `hazardous` | ใช่ | `boolean` |   |   |   |
| `unNumber` | ใช่ | `string` | null ได้ |   | `1993` |
| `hazardClass` | ใช่ | `string` | null ได้ |   | `3` |
| `tempControlled` | ใช่ | `boolean` |   |   |   |
| `tempMinC` | ใช่ | `number` | null ได้ |   | `2` |
| `tempMaxC` | ใช่ | `number` | null ได้ |   | `8` |
| `stackable` | ใช่ | `boolean` |   |   |   |
| `barcode` | ใช่ | `string` | null ได้ |   |   |
| `requiredCapabilities` | ใช่ | `array<string>` |   | ป้ายความสามารถของประเภทรถที่ต้องใช้ (คำนวณ): ควบคุมอุณหภูมิ → REFRIGERATED (ช่วงอุณหภูมิรถต้องครอบคลุม), อันตราย → HAZMAT |   |
| `status` | ใช่ | `string` | ค่า: `active`, `inactive` |   |   |
| `deletedAt` |   | `string (date-time)` | null ได้ | มีค่าเฉพาะเมื่อขอ includeDeleted=true และรายการถูกลบแล้ว (tombstone) |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string (date-time)` |   |   |   |
| `updatedAt` | ใช่ | `string (date-time)` |   |   |   |

### ProductPageDto {#schema-ProductPageDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<ProductDto>` |   |   |   |
| `nextCursor` | ใช่ | `string` | null ได้ |   |   |
| `hasMore` | ใช่ | `boolean` |   |   |   |

### ProductSummaryDto {#schema-ProductSummaryDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `total` | ใช่ | `number` |   | สินค้าทั้งหมด (ไม่รวมที่ลบ) |   |
| `active` | ใช่ | `number` |   |   |   |
| `inactive` | ใช่ | `number` |   |   |   |
| `general` | ใช่ | `number` |   | สินค้าทั่วไป (ไม่มีประเภทพิเศษ) |   |
| `special` | ใช่ | `number` |   | สินค้าประเภทพิเศษ (เปราะบาง/อันตราย/ควบคุมอุณหภูมิ อย่างน้อยหนึ่งอย่าง) |   |
| `unitsUsed` | ใช่ | `number` |   | จำนวนหน่วยหลักที่สินค้าใช้ (ไม่ซ้ำ) |   |
