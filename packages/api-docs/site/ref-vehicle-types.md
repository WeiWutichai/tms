# ประเภทรถ (vehicle-types)

13 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`GET /v1/vehicle-types`](#get-vehicle-types) | `master:read` |
| [`POST /v1/vehicle-types`](#post-vehicle-types) | `master:write` |
| [`GET /v1/vehicle-types/summary`](#get-vehicle-types-summary) | `master:read` |
| [`GET /v1/vehicle-types/next-code`](#get-vehicle-types-next-code) | `master:write` |
| [`GET /v1/vehicle-types/export`](#get-vehicle-types-export) | `export:run` |
| [`PUT /v1/vehicle-types/external/{externalId}`](#put-vehicle-types-external-externalId) | `master:write` |
| [`PATCH /v1/vehicle-types/external/{externalId}`](#patch-vehicle-types-external-externalId) | `master:write` |
| [`GET /v1/vehicle-types/{id}`](#get-vehicle-types-id) | `master:read` |
| [`PATCH /v1/vehicle-types/{id}`](#patch-vehicle-types-id) | `master:write` |
| [`GET /v1/vehicle-types/{id}/history`](#get-vehicle-types-id-history) | `master:read` |
| [`POST /v1/vehicle-types/{id}/deactivate`](#post-vehicle-types-id-deactivate) | `master:write` |
| [`POST /v1/vehicle-types/{id}/activate`](#post-vehicle-types-id-activate) | `master:write` |
| [`POST /v1/vehicle-types/{id}/delete`](#post-vehicle-types-id-delete) | `master:write` |

## GET /v1/vehicle-types {#get-vehicle-types}

`GET /v1/vehicle-types`

scope: `master:read` · operationId: `VehicleTypes_list`

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
| `name` | query |   | `string` | ชื่อมีคำนี้ |
| `vehicleClass` | query |   | `string` ค่า: `4W`, `6W`, `10W`, `TRAILER`, `SEMI_TRAILER` |   |
| `minLicenceClass` | query |   | `string` ค่า: `PERSONAL`, `T1`, `T2`, `T3`, `T4` |   |
| `capability` | query |   | `string` ค่า: `REFRIGERATED`, `CRANE`, `CONTAINER`, `HAZMAT` | มีป้ายนี้ |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `VehicleTypePageDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/vehicle-types" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/vehicle-types');
```

## POST /v1/vehicle-types {#post-vehicle-types}

`POST /v1/vehicle-types`

scope: `master:write` · operationId: `VehicleTypes_create`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `Idempotency-Key` | header |   | `string` |   |

**Request body** `CreateVehicleTypeDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `volumeCbm` |   | `number` | null ได้ | ปริมาตร (ลบ.ม.) | `40` |
| `capabilityTags` |   | `array<string>` |   | ความสามารถพิเศษ: REFRIGERATED = ห้องเย็น (ต้องมี tempMinC/tempMaxC), CRANE = ติดเครน, CONTAINER = ลากตู้คอนเทนเนอร์, HAZMAT = ขนสินค้าอันตรายได้ |   |
| `tempMinC` |   | `number` | null ได้ | ห้องเย็น: อุณหภูมิต่ำสุด (°C) — ส่งคู่กับ tempMaxC และ min < max | `0` |
| `tempMaxC` |   | `number` | null ได้ |   | `8` |
| `name` | ใช่ | `string` |   | ชื่อประเภทรถ — ห้ามซ้ำ (ไม่สนตัวพิมพ์) | `10 ล้อ ตู้แห้ง` |
| `vehicleClass` | ใช่ | `string` | ค่า: `4W`, `6W`, `10W`, `TRAILER`, `SEMI_TRAILER` | ชั้นรถ: 4W = 4 ล้อ, 6W = 6 ล้อ, 10W = 10 ล้อ, TRAILER = พ่วง, SEMI_TRAILER = หัวลาก + หางเทรลเลอร์ — เทียบกับ "รถเข้าได้สูงสุด" ของสถานที่ |   |
| `payloadKg` | ใช่ | `number` |   | น้ำหนักบรรทุกมาตรฐาน (กก.) > 0 | `15000` |
| `minLicenceClass` | ใช่ | `string` | ค่า: `PERSONAL`, `T1`, `T2`, `T3`, `T4` | ใบขับขี่ขั้นต่ำ: PERSONAL = ส่วนบุคคล, T1–T4 = ท.1–ท.4 |   |
| `code` |   | `string` |   | รหัส — ไม่ส่ง = ระบบออกเลขถัดไป `VT-0001` | `10W-DRY` |
| `externalId` |   | `string` |   | รหัสในระบบต้นทาง — เรียกด้วย ext:{externalId} ได้ |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `201` |   | `VehicleTypeDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/vehicle-types" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"name":"10 ล้อ ตู้แห้ง","vehicleClass":"4W","payloadKg":15000,"minLicenceClass":"PERSONAL","code":"10W-DRY"}'
```

```ts
const { data, error } = await tms.POST('/v1/vehicle-types', {
  body: {
    "name": "10 ล้อ ตู้แห้ง",
    "vehicleClass": "4W",
    "payloadKg": 15000,
    "minLicenceClass": "PERSONAL",
    "code": "10W-DRY"
  },
});
```

## GET /v1/vehicle-types/summary {#get-vehicle-types-summary}

`GET /v1/vehicle-types/summary`

scope: `master:read` · operationId: `VehicleTypes_summary`

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `VehicleTypeSummaryDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/vehicle-types/summary" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/vehicle-types/summary');
```

## GET /v1/vehicle-types/next-code {#get-vehicle-types-next-code}

`GET /v1/vehicle-types/next-code`

scope: `master:write` · operationId: `VehicleTypes_nextCode`

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | รหัสที่ระบบจะออกให้ประเภทรถใหม่ (`VT-0001`) | `NextCodeDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/vehicle-types/next-code" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/vehicle-types/next-code');
```

## GET /v1/vehicle-types/export {#get-vehicle-types-export}

`GET /v1/vehicle-types/export`

scope: `export:run` · operationId: `VehicleTypes_export`

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
| `name` | query |   | `string` | ชื่อมีคำนี้ |
| `vehicleClass` | query |   | `string` ค่า: `4W`, `6W`, `10W`, `TRAILER`, `SEMI_TRAILER` |   |
| `minLicenceClass` | query |   | `string` ค่า: `PERSONAL`, `T1`, `T2`, `T3`, `T4` |   |
| `capability` | query |   | `string` ค่า: `REFRIGERATED`, `CRANE`, `CONTAINER`, `HAZMAT` | มีป้ายนี้ |
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
curl -sS -X GET "$TMS_BASE_URL/v1/vehicle-types/export" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/vehicle-types/export');
```

## PUT /v1/vehicle-types/external/{externalId} {#put-vehicle-types-external-externalId}

`PUT /v1/vehicle-types/external/{externalId}`

scope: `master:write` · operationId: `VehicleTypes_upsertExternal`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `externalId` | path | ใช่ | `string` | เลขของระบบต้นทาง (ASCII ที่พิมพ์ได้ 1–100 ตัว ไม่มีช่องว่าง) — unique ต่อ tenant ต่อ resource |
| `If-Match` | header |   | `string` | ETag — ใช้เมื่อแถวมีอยู่แล้ว |

**Request body** `UpsertVehicleTypeDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `volumeCbm` |   | `number` | null ได้ | ปริมาตร (ลบ.ม.) | `40` |
| `capabilityTags` |   | `array<string>` |   | ความสามารถพิเศษ: REFRIGERATED = ห้องเย็น (ต้องมี tempMinC/tempMaxC), CRANE = ติดเครน, CONTAINER = ลากตู้คอนเทนเนอร์, HAZMAT = ขนสินค้าอันตรายได้ |   |
| `tempMinC` |   | `number` | null ได้ | ห้องเย็น: อุณหภูมิต่ำสุด (°C) — ส่งคู่กับ tempMaxC และ min < max | `0` |
| `tempMaxC` |   | `number` | null ได้ |   | `8` |
| `name` | ใช่ | `string` |   | ชื่อประเภทรถ — ห้ามซ้ำ (ไม่สนตัวพิมพ์) | `10 ล้อ ตู้แห้ง` |
| `vehicleClass` | ใช่ | `string` | ค่า: `4W`, `6W`, `10W`, `TRAILER`, `SEMI_TRAILER` | ชั้นรถ: 4W = 4 ล้อ, 6W = 6 ล้อ, 10W = 10 ล้อ, TRAILER = พ่วง, SEMI_TRAILER = หัวลาก + หางเทรลเลอร์ — เทียบกับ "รถเข้าได้สูงสุด" ของสถานที่ |   |
| `payloadKg` | ใช่ | `number` |   | น้ำหนักบรรทุกมาตรฐาน (กก.) > 0 | `15000` |
| `minLicenceClass` | ใช่ | `string` | ค่า: `PERSONAL`, `T1`, `T2`, `T3`, `T4` | ใบขับขี่ขั้นต่ำ: PERSONAL = ส่วนบุคคล, T1–T4 = ท.1–ท.4 |   |
| `code` |   | `string` |   | ใช้ตอนสร้างเท่านั้น | `10W-DRY` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | มีอยู่แล้ว → อัปเดต (ส่งซ้ำได้ ไม่เกิดแถวใหม่) | `VehicleTypeDto` |
| `201` | ยังไม่มี → สร้าง | `VehicleTypeDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `409` | ขัดกับข้อมูลที่มีอยู่ (เช่น รหัส/ชื่อซ้ำ, สถานะไม่อนุญาตให้แก้) — [conflict](errors.md#conflict), [duplicate](errors.md#duplicate) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง (รวมทุกช่องใน errors[]) — externalId ใน path ผิดรูปแบบ = field `externalId` — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PUT "$TMS_BASE_URL/v1/vehicle-types/external/<externalId>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"10 ล้อ ตู้แห้ง","vehicleClass":"4W","payloadKg":15000,"minLicenceClass":"PERSONAL","code":"10W-DRY"}'
```

```ts
const { data, error } = await tms.PUT('/v1/vehicle-types/external/{externalId}', {
  params: { path: { externalId: "…" } },
  body: {
    "name": "10 ล้อ ตู้แห้ง",
    "vehicleClass": "4W",
    "payloadKg": 15000,
    "minLicenceClass": "PERSONAL",
    "code": "10W-DRY"
  },
});
```

## แก้บางช่องด้วย externalId {#patch-vehicle-types-external-externalId}

`PATCH /v1/vehicle-types/external/{externalId}`

scope: `master:write` · operationId: `VehicleTypes_patchExternal`

เหมือน `PATCH /vehicle-types/ext:{externalId}` (กติกาเดียวกับ PATCH ด้วย id) · ยังไม่มีแถวนี้ → 404 — สร้างใหม่ใช้ PUT

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `externalId` | path | ใช่ | `string` | เลขของระบบต้นทาง (ASCII ที่พิมพ์ได้ 1–100 ตัว ไม่มีช่องว่าง) — unique ต่อ tenant ต่อ resource |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `UpdateVehicleTypeDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `volumeCbm` |   | `number` | null ได้ | ปริมาตร (ลบ.ม.) | `40` |
| `capabilityTags` |   | `array<string>` |   | ความสามารถพิเศษ: REFRIGERATED = ห้องเย็น (ต้องมี tempMinC/tempMaxC), CRANE = ติดเครน, CONTAINER = ลากตู้คอนเทนเนอร์, HAZMAT = ขนสินค้าอันตรายได้ |   |
| `tempMinC` |   | `number` | null ได้ | ห้องเย็น: อุณหภูมิต่ำสุด (°C) — ส่งคู่กับ tempMaxC และ min < max | `0` |
| `tempMaxC` |   | `number` | null ได้ |   | `8` |
| `name` |   | `string` |   |   | `10 ล้อ ตู้แห้ง` |
| `vehicleClass` |   | `string` | ค่า: `4W`, `6W`, `10W`, `TRAILER`, `SEMI_TRAILER` |   |   |
| `payloadKg` |   | `number` |   |   | `15000` |
| `minLicenceClass` |   | `string` | ค่า: `PERSONAL`, `T1`, `T2`, `T3`, `T4` |   |   |
| `externalId` |   | `string` | null ได้ | null = ลบการผูก |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `VehicleTypeDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ยังไม่มีแถวที่ externalId นี้ (สร้างใหม่ใช้ PUT) หรืออยู่ tenant อื่น — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | ขัดกับข้อมูลที่มีอยู่ (เช่น รหัส/ชื่อซ้ำ, สถานะไม่อนุญาตให้แก้) — [conflict](errors.md#conflict), [duplicate](errors.md#duplicate) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง (รวมทุกช่องใน errors[]) — externalId ใน path ผิดรูปแบบ = field `externalId` — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PATCH "$TMS_BASE_URL/v1/vehicle-types/external/<externalId>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"10 ล้อ ตู้แห้ง","payloadKg":15000}'
```

```ts
const { data, error } = await tms.PATCH('/v1/vehicle-types/external/{externalId}', {
  params: { path: { externalId: "…" } },
  body: {
    "name": "10 ล้อ ตู้แห้ง",
    "payloadKg": 15000
  },
});
```

## GET /v1/vehicle-types/{id} {#get-vehicle-types-id}

`GET /v1/vehicle-types/{id}`

scope: `master:read` · operationId: `VehicleTypes_get`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `VehicleTypeDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/vehicle-types/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/vehicle-types/{id}', {
  params: { path: { id: "…" } },
});
```

## PATCH /v1/vehicle-types/{id} {#patch-vehicle-types-id}

`PATCH /v1/vehicle-types/{id}`

scope: `master:write` · operationId: `VehicleTypes_update`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `UpdateVehicleTypeDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `volumeCbm` |   | `number` | null ได้ | ปริมาตร (ลบ.ม.) | `40` |
| `capabilityTags` |   | `array<string>` |   | ความสามารถพิเศษ: REFRIGERATED = ห้องเย็น (ต้องมี tempMinC/tempMaxC), CRANE = ติดเครน, CONTAINER = ลากตู้คอนเทนเนอร์, HAZMAT = ขนสินค้าอันตรายได้ |   |
| `tempMinC` |   | `number` | null ได้ | ห้องเย็น: อุณหภูมิต่ำสุด (°C) — ส่งคู่กับ tempMaxC และ min < max | `0` |
| `tempMaxC` |   | `number` | null ได้ |   | `8` |
| `name` |   | `string` |   |   | `10 ล้อ ตู้แห้ง` |
| `vehicleClass` |   | `string` | ค่า: `4W`, `6W`, `10W`, `TRAILER`, `SEMI_TRAILER` |   |   |
| `payloadKg` |   | `number` |   |   | `15000` |
| `minLicenceClass` |   | `string` | ค่า: `PERSONAL`, `T1`, `T2`, `T3`, `T4` |   |   |
| `externalId` |   | `string` | null ได้ | null = ลบการผูก |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `VehicleTypeDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PATCH "$TMS_BASE_URL/v1/vehicle-types/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"10 ล้อ ตู้แห้ง","payloadKg":15000}'
```

```ts
const { data, error } = await tms.PATCH('/v1/vehicle-types/{id}', {
  params: { path: { id: "…" } },
  body: {
    "name": "10 ล้อ ตู้แห้ง",
    "payloadKg": 15000
  },
});
```

## GET /v1/vehicle-types/{id}/history {#get-vehicle-types-id-history}

`GET /v1/vehicle-types/{id}/history`

scope: `master:read` · operationId: `VehicleTypes_history`

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
curl -sS -X GET "$TMS_BASE_URL/v1/vehicle-types/<id>/history" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/vehicle-types/{id}/history', {
  params: { path: { id: "…" } },
});
```

## POST /v1/vehicle-types/{id}/deactivate {#post-vehicle-types-id-deactivate}

`POST /v1/vehicle-types/{id}/deactivate`

scope: `master:write` · operationId: `VehicleTypes_deactivate`

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
| `200` |   | `VehicleTypeDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/vehicle-types/<id>/deactivate" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"เลิกใช้บริการตั้งแต่ ธ.ค. 2569"}'
```

```ts
const { data, error } = await tms.POST('/v1/vehicle-types/{id}/deactivate', {
  params: { path: { id: "…" } },
  body: {
    "reason": "เลิกใช้บริการตั้งแต่ ธ.ค. 2569"
  },
});
```

## POST /v1/vehicle-types/{id}/activate {#post-vehicle-types-id-activate}

`POST /v1/vehicle-types/{id}/activate`

scope: `master:write` · operationId: `VehicleTypes_activate`

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
| `200` |   | `VehicleTypeDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/vehicle-types/<id>/activate" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{}'
```

```ts
const { data, error } = await tms.POST('/v1/vehicle-types/{id}/activate', {
  params: { path: { id: "…" } },
  body: {},
});
```

## POST /v1/vehicle-types/{id}/delete {#post-vehicle-types-id-delete}

`POST /v1/vehicle-types/{id}/delete`

scope: `master:write` · operationId: `VehicleTypes_remove`

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
curl -sS -X POST "$TMS_BASE_URL/v1/vehicle-types/<id>/delete" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"เลิกใช้บริการตั้งแต่ ธ.ค. 2569"}'
```

```ts
const { data, error } = await tms.POST('/v1/vehicle-types/{id}/delete', {
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

### VehicleTypeDto {#schema-VehicleTypeDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `vty_3f2a…` |
| `code` | ใช่ | `string` |   |   | `10W` |
| `externalId` | ใช่ | `string` | null ได้ |   |   |
| `name` | ใช่ | `string` |   |   | `10 ล้อ` |
| `vehicleClass` | ใช่ | `string` | ค่า: `4W`, `6W`, `10W`, `TRAILER`, `SEMI_TRAILER` |   |   |
| `sizeRank` | ใช่ | `number` |   | ขนาดเทียบข้อจำกัดสถานที่ — คำนวณจากชั้นรถ |   |
| `payloadKg` | ใช่ | `number` | null ได้ |   | `15000` |
| `volumeCbm` | ใช่ | `number` | null ได้ |   | `40` |
| `minLicenceClass` | ใช่ | `string` | ค่า: `PERSONAL`, `T1`, `T2`, `T3`, `T4` · null ได้ |   |   |
| `capabilityTags` | ใช่ | `array<string>` |   |   |   |
| `tempMinC` | ใช่ | `number` | null ได้ |   | `0` |
| `tempMaxC` | ใช่ | `number` | null ได้ |   | `8` |
| `system` | ใช่ | `boolean` |   | แถวค่าเริ่มต้นที่ระบบสร้างให้ (แก้/ปิดใช้/ลบได้เหมือนแถวอื่น) |   |
| `usage` | ใช่ | `VehicleTypeUsageDto` |   |   |   |
| `status` | ใช่ | `string` | ค่า: `active`, `inactive` |   |   |
| `deletedAt` |   | `string (date-time)` | null ได้ | มีค่าเฉพาะเมื่อขอ includeDeleted=true และรายการถูกลบแล้ว (tombstone) |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string (date-time)` |   |   |   |
| `updatedAt` | ใช่ | `string (date-time)` |   |   |   |

### VehicleTypePageDto {#schema-VehicleTypePageDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<VehicleTypeDto>` |   |   |   |
| `nextCursor` | ใช่ | `string` | null ได้ |   |   |
| `hasMore` | ใช่ | `boolean` |   |   |   |

### VehicleTypeSummaryDto {#schema-VehicleTypeSummaryDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `total` | ใช่ | `number` |   | ประเภทรถทั้งหมด (ไม่รวมที่ลบ) |   |
| `active` | ใช่ | `number` |   |   |   |
| `inactive` | ใช่ | `number` |   |   |   |
| `vehicles` | ใช่ | `number` |   | รถในทะเบียน (ไม่นับที่ปลดระวาง) |   |
| `rateCards` | ใช่ | `number` |   | rate card ที่อ้างประเภทรถ |   |
