# คนขับ (drivers)

12 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`GET /v1/drivers`](#get-drivers) | `master:read` |
| [`POST /v1/drivers`](#post-drivers) | `master:write` |
| [`GET /v1/drivers/summary`](#get-drivers-summary) | `master:read` |
| [`GET /v1/drivers/next-code`](#get-drivers-next-code) | `master:write` |
| [`GET /v1/drivers/export`](#get-drivers-export) | `export:run` |
| [`PUT /v1/drivers/external/{externalId}`](#put-drivers-external-externalId) | `master:write` |
| [`PATCH /v1/drivers/external/{externalId}`](#patch-drivers-external-externalId) | `master:write` |
| [`GET /v1/drivers/{id}`](#get-drivers-id) | `master:read` |
| [`PATCH /v1/drivers/{id}`](#patch-drivers-id) | `master:write` |
| [`GET /v1/drivers/{id}/history`](#get-drivers-id-history) | `master:read` |
| [`POST /v1/drivers/{id}/status`](#post-drivers-id-status) | `master:write` |
| [`POST /v1/drivers/{id}/delete`](#post-drivers-id-delete) | `master:write` |

## GET /v1/drivers {#get-drivers}

`GET /v1/drivers`

scope: `master:read` · operationId: `Drivers_list`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน (ใช้กับ sort เดิมเท่านั้น) |
| `updatedAfter` | query |   | `string` | คืนเฉพาะแถวที่ updatedAt > ค่านี้ (incremental pull) |
| `sort` | query |   | `string` ค่า: `code`, `updatedAt`, `-updatedAt` | code = เรียงตามรหัส (ค่าเริ่มต้นของหน้าจอ) · updatedAt/-updatedAt สำหรับ sync |
| `fields` | query |   | `string` | รายชื่อ field คั่นด้วย, เช่น id,name |
| `q` | query |   | `string` | ค้นหา — รหัส ชื่อ เบอร์ เลขที่ใบขับขี่ externalId หรือ 4 หลักท้ายเลขบัตรประชาชน (ไม่สนตัวพิมพ์) |
| `status` | query |   | `string` | คั่นด้วย, เช่น active,on_leave |
| `externalId` | query |   | `string` | externalId ตรงตัว |
| `includeDeleted` | query |   | `string` | true = รวมรายการที่ถูกลบ (tombstone มี `deletedAt`) |
| `name` | query |   | `string` | ชื่อมีคำนี้ |
| `employmentType` | query |   | `string` ค่า: `EMPLOYEE_SALARIED`, `EMPLOYEE_PER_TRIP`, `CARRIER_DRIVER` |   |
| `licenceClass` | query |   | `string` ค่า: `PERSONAL`, `T1`, `T2`, `T3`, `T4` |   |
| `carrierId` | query |   | `string` | เฉพาะคนขับของผู้รับเหมานี้ (car_…) |
| `affiliation` | query |   | `string` | สังกัดมีคำนี้ — ชื่อผู้รับเหมา (คนขับรถร่วม) หรือชื่อบริษัทของ tenant (คนขับบริษัท) |
| `defaultVehicleId` | query |   | `string` | เฉพาะคนขับที่มีรถประจำคันนี้ (veh_…) |
| `licenceAlert` | query |   | `string` ค่า: `true`, `false` | true = ใบขับขี่หมดภายใน 30 วันหรือหมดแล้ว (ไม่นับคนขับปิดใช้งาน — ต้นแบบ "ใบขับขี่ใกล้หมดอายุ 30 วัน") · false = ไม่ใช่ |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `DriverPageDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/drivers" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/drivers');
```

## POST /v1/drivers {#post-drivers}

`POST /v1/drivers`

scope: `master:write` · operationId: `Drivers_create`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `Idempotency-Key` | header |   | `string` |   |

**Request body** `CreateDriverDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `nationalId` |   | `string` | null ได้ | เลขบัตรประชาชน 13 หลัก (ตรวจ check digit) — เก็บแบบเข้ารหัส ไม่คืนใน response (คืน `nationalIdLast4`) · null = ลบ | `3100500123457` |
| `licenceNo` |   | `string` | null ได้ |   | `58001234` |
| `carrierId` |   | `string` | null ได้ | รถร่วม/ผู้รับเหมาต้นสังกัด (car_… — บังคับเมื่อ CARRIER_DRIVER, ห้ามมีเมื่อเป็นคนขับบริษัท) | `car_…` |
| `defaultVehicleId` |   | `string` | null ได้ | รถประจำ (veh_…) — ไม่ปลดระวาง ไม่ใช่หาง; คนขับรถร่วมต้องเป็นรถของผู้รับเหมาเดียวกัน, คนขับบริษัทต้องเป็นรถบริษัท · null = ไม่มี | `veh_…` |
| `name` | ใช่ | `string` |   | ชื่อ-นามสกุล | `สมชาย ใจดี` |
| `phone` | ใช่ | `string` |   | เบอร์โทร (ไทย) — ห้ามซ้ำกับคนขับที่ยังไม่ปิดใช้งาน (ใช้ login แอปคนขับภายหลัง) | `081-234-5678` |
| `employmentType` | ใช่ | `string` | ค่า: `EMPLOYEE_SALARIED`, `EMPLOYEE_PER_TRIP`, `CARRIER_DRIVER` |   |   |
| `licenceClass` | ใช่ | `string` | ค่า: `PERSONAL`, `T1`, `T2`, `T3`, `T4` | PERSONAL = ส่วนบุคคล, T1–T4 = ท.1–ท.4 |   |
| `licenceExpiresOn` | ใช่ | `string (date)` |   | วันหมดอายุใบขับขี่ (ใช้ได้ถึงสิ้นวัน; 2000-01-01 – 2100-12-31) | `2028-03-31` |
| `code` |   | `string` |   | รหัส — ไม่ส่ง = ระบบออกเลขถัดไป | `DRV-0001` |
| `externalId` |   | `string` |   | รหัสในระบบต้นทาง — เรียกด้วย ext:{externalId} ได้ |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `201` |   | `DriverDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/drivers" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"name":"สมชาย ใจดี","phone":"081-234-5678","employmentType":"EMPLOYEE_SALARIED","licenceClass":"PERSONAL","licenceExpiresOn":"2028-03-31","code":"DRV-0001"}'
```

```ts
const { data, error } = await tms.POST('/v1/drivers', {
  body: {
    "name": "สมชาย ใจดี",
    "phone": "081-234-5678",
    "employmentType": "EMPLOYEE_SALARIED",
    "licenceClass": "PERSONAL",
    "licenceExpiresOn": "2028-03-31",
    "code": "DRV-0001"
  },
});
```

## GET /v1/drivers/summary {#get-drivers-summary}

`GET /v1/drivers/summary`

scope: `master:read` · operationId: `Drivers_summary`

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `DriverSummaryDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/drivers/summary" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/drivers/summary');
```

## GET /v1/drivers/next-code {#get-drivers-next-code}

`GET /v1/drivers/next-code`

scope: `master:write` · operationId: `Drivers_nextCode`

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | รหัสที่ระบบจะออกให้คนขับใหม่ (`DRV-0001`) | `NextCodeDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/drivers/next-code" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/drivers/next-code');
```

## GET /v1/drivers/export {#get-drivers-export}

`GET /v1/drivers/export`

scope: `export:run` · operationId: `Drivers_export`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน (ใช้กับ sort เดิมเท่านั้น) |
| `updatedAfter` | query |   | `string` | คืนเฉพาะแถวที่ updatedAt > ค่านี้ (incremental pull) |
| `sort` | query |   | `string` ค่า: `code`, `updatedAt`, `-updatedAt` | code = เรียงตามรหัส (ค่าเริ่มต้นของหน้าจอ) · updatedAt/-updatedAt สำหรับ sync |
| `fields` | query |   | `string` | รายชื่อ field คั่นด้วย, เช่น id,name |
| `q` | query |   | `string` | ค้นหา — รหัส ชื่อ เบอร์ เลขที่ใบขับขี่ externalId หรือ 4 หลักท้ายเลขบัตรประชาชน (ไม่สนตัวพิมพ์) |
| `status` | query |   | `string` | คั่นด้วย, เช่น active,on_leave |
| `externalId` | query |   | `string` | externalId ตรงตัว |
| `includeDeleted` | query |   | `string` | true = รวมรายการที่ถูกลบ (tombstone มี `deletedAt`) |
| `name` | query |   | `string` | ชื่อมีคำนี้ |
| `employmentType` | query |   | `string` ค่า: `EMPLOYEE_SALARIED`, `EMPLOYEE_PER_TRIP`, `CARRIER_DRIVER` |   |
| `licenceClass` | query |   | `string` ค่า: `PERSONAL`, `T1`, `T2`, `T3`, `T4` |   |
| `carrierId` | query |   | `string` | เฉพาะคนขับของผู้รับเหมานี้ (car_…) |
| `affiliation` | query |   | `string` | สังกัดมีคำนี้ — ชื่อผู้รับเหมา (คนขับรถร่วม) หรือชื่อบริษัทของ tenant (คนขับบริษัท) |
| `defaultVehicleId` | query |   | `string` | เฉพาะคนขับที่มีรถประจำคันนี้ (veh_…) |
| `licenceAlert` | query |   | `string` ค่า: `true`, `false` | true = ใบขับขี่หมดภายใน 30 วันหรือหมดแล้ว (ไม่นับคนขับปิดใช้งาน — ต้นแบบ "ใบขับขี่ใกล้หมดอายุ 30 วัน") · false = ไม่ใช่ |
| `format` | query |   | `string` ค่า: `xlsx`, `csv` |   |
| `ids` | query |   | `string` | ส่งออกเฉพาะ id เหล่านี้ (คั่นด้วย,) — แถวที่เลือกในตาราง |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | ไฟล์.xlsx หรือ.csv ตามตัวกรองเดียวกับรายการ (สูงสุด 10,000 แถว) — เลขบัตรประชาชนปิดบังเสมอ |   |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`export:run`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/drivers/export" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/drivers/export');
```

## PUT /v1/drivers/external/{externalId} {#put-drivers-external-externalId}

`PUT /v1/drivers/external/{externalId}`

scope: `master:write` · operationId: `Drivers_upsertExternal`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `externalId` | path | ใช่ | `string` | เลขของระบบต้นทาง (ASCII ที่พิมพ์ได้ 1–100 ตัว ไม่มีช่องว่าง) — unique ต่อ tenant ต่อ resource |
| `If-Match` | header |   | `string` | ETag — ใช้เมื่อแถวมีอยู่แล้ว |

**Request body** `UpsertDriverDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `nationalId` |   | `string` | null ได้ | เลขบัตรประชาชน 13 หลัก (ตรวจ check digit) — เก็บแบบเข้ารหัส ไม่คืนใน response (คืน `nationalIdLast4`) · null = ลบ | `3100500123457` |
| `licenceNo` |   | `string` | null ได้ |   | `58001234` |
| `carrierId` |   | `string` | null ได้ | รถร่วม/ผู้รับเหมาต้นสังกัด (car_… — บังคับเมื่อ CARRIER_DRIVER, ห้ามมีเมื่อเป็นคนขับบริษัท) | `car_…` |
| `defaultVehicleId` |   | `string` | null ได้ | รถประจำ (veh_…) — ไม่ปลดระวาง ไม่ใช่หาง; คนขับรถร่วมต้องเป็นรถของผู้รับเหมาเดียวกัน, คนขับบริษัทต้องเป็นรถบริษัท · null = ไม่มี | `veh_…` |
| `name` | ใช่ | `string` |   | ชื่อ-นามสกุล | `สมชาย ใจดี` |
| `phone` | ใช่ | `string` |   | เบอร์โทร (ไทย) — ห้ามซ้ำกับคนขับที่ยังไม่ปิดใช้งาน (ใช้ login แอปคนขับภายหลัง) | `081-234-5678` |
| `employmentType` | ใช่ | `string` | ค่า: `EMPLOYEE_SALARIED`, `EMPLOYEE_PER_TRIP`, `CARRIER_DRIVER` |   |   |
| `licenceClass` | ใช่ | `string` | ค่า: `PERSONAL`, `T1`, `T2`, `T3`, `T4` | PERSONAL = ส่วนบุคคล, T1–T4 = ท.1–ท.4 |   |
| `licenceExpiresOn` | ใช่ | `string (date)` |   | วันหมดอายุใบขับขี่ (ใช้ได้ถึงสิ้นวัน; 2000-01-01 – 2100-12-31) | `2028-03-31` |
| `code` |   | `string` |   | ใช้ตอนสร้างเท่านั้น | `DRV-0001` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | มีอยู่แล้ว → อัปเดต (ส่งซ้ำได้ ไม่เกิดแถวใหม่) | `DriverDto` |
| `201` | ยังไม่มี → สร้าง | `DriverDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `409` | ขัดกับข้อมูลที่มีอยู่ (เช่น รหัส/ชื่อซ้ำ, สถานะไม่อนุญาตให้แก้) — [conflict](errors.md#conflict), [duplicate](errors.md#duplicate) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง (รวมทุกช่องใน errors[]) — externalId ใน path ผิดรูปแบบ = field `externalId` — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PUT "$TMS_BASE_URL/v1/drivers/external/<externalId>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"สมชาย ใจดี","phone":"081-234-5678","employmentType":"EMPLOYEE_SALARIED","licenceClass":"PERSONAL","licenceExpiresOn":"2028-03-31","code":"DRV-0001"}'
```

```ts
const { data, error } = await tms.PUT('/v1/drivers/external/{externalId}', {
  params: { path: { externalId: "…" } },
  body: {
    "name": "สมชาย ใจดี",
    "phone": "081-234-5678",
    "employmentType": "EMPLOYEE_SALARIED",
    "licenceClass": "PERSONAL",
    "licenceExpiresOn": "2028-03-31",
    "code": "DRV-0001"
  },
});
```

## แก้บางช่องด้วย externalId {#patch-drivers-external-externalId}

`PATCH /v1/drivers/external/{externalId}`

scope: `master:write` · operationId: `Drivers_patchExternal`

เหมือน `PATCH /drivers/ext:{externalId}` (กติกาเดียวกับ PATCH ด้วย id) · ยังไม่มีแถวนี้ → 404 — สร้างใหม่ใช้ PUT

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `externalId` | path | ใช่ | `string` | เลขของระบบต้นทาง (ASCII ที่พิมพ์ได้ 1–100 ตัว ไม่มีช่องว่าง) — unique ต่อ tenant ต่อ resource |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `UpdateDriverDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `nationalId` |   | `string` | null ได้ | เลขบัตรประชาชน 13 หลัก (ตรวจ check digit) — เก็บแบบเข้ารหัส ไม่คืนใน response (คืน `nationalIdLast4`) · null = ลบ | `3100500123457` |
| `licenceNo` |   | `string` | null ได้ |   | `58001234` |
| `carrierId` |   | `string` | null ได้ | รถร่วม/ผู้รับเหมาต้นสังกัด (car_… — บังคับเมื่อ CARRIER_DRIVER, ห้ามมีเมื่อเป็นคนขับบริษัท) | `car_…` |
| `defaultVehicleId` |   | `string` | null ได้ | รถประจำ (veh_…) — ไม่ปลดระวาง ไม่ใช่หาง; คนขับรถร่วมต้องเป็นรถของผู้รับเหมาเดียวกัน, คนขับบริษัทต้องเป็นรถบริษัท · null = ไม่มี | `veh_…` |
| `name` |   | `string` |   |   | `สมชาย ใจดี` |
| `phone` |   | `string` |   |   | `081-234-5678` |
| `employmentType` |   | `string` | ค่า: `EMPLOYEE_SALARIED`, `EMPLOYEE_PER_TRIP`, `CARRIER_DRIVER` | เปลี่ยนเป็น/จาก CARRIER_DRIVER ต้องส่ง carrierId (หรือ null) ในคำขอเดียวกัน |   |
| `licenceClass` |   | `string` | ค่า: `PERSONAL`, `T1`, `T2`, `T3`, `T4` |   |   |
| `licenceExpiresOn` |   | `string (date)` |   |   | `2028-03-31` |
| `externalId` |   | `string` | null ได้ | null = ลบการผูก |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `DriverDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ยังไม่มีแถวที่ externalId นี้ (สร้างใหม่ใช้ PUT) หรืออยู่ tenant อื่น — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | ขัดกับข้อมูลที่มีอยู่ (เช่น รหัส/ชื่อซ้ำ, สถานะไม่อนุญาตให้แก้) — [conflict](errors.md#conflict), [duplicate](errors.md#duplicate) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง (รวมทุกช่องใน errors[]) — externalId ใน path ผิดรูปแบบ = field `externalId` — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PATCH "$TMS_BASE_URL/v1/drivers/external/<externalId>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"สมชาย ใจดี","phone":"081-234-5678","licenceExpiresOn":"2028-03-31"}'
```

```ts
const { data, error } = await tms.PATCH('/v1/drivers/external/{externalId}', {
  params: { path: { externalId: "…" } },
  body: {
    "name": "สมชาย ใจดี",
    "phone": "081-234-5678",
    "licenceExpiresOn": "2028-03-31"
  },
});
```

## GET /v1/drivers/{id} {#get-drivers-id}

`GET /v1/drivers/{id}`

scope: `master:read` · operationId: `Drivers_get`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `DriverDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/drivers/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/drivers/{id}', {
  params: { path: { id: "…" } },
});
```

## PATCH /v1/drivers/{id} {#patch-drivers-id}

`PATCH /v1/drivers/{id}`

scope: `master:write` · operationId: `Drivers_update`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `UpdateDriverDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `nationalId` |   | `string` | null ได้ | เลขบัตรประชาชน 13 หลัก (ตรวจ check digit) — เก็บแบบเข้ารหัส ไม่คืนใน response (คืน `nationalIdLast4`) · null = ลบ | `3100500123457` |
| `licenceNo` |   | `string` | null ได้ |   | `58001234` |
| `carrierId` |   | `string` | null ได้ | รถร่วม/ผู้รับเหมาต้นสังกัด (car_… — บังคับเมื่อ CARRIER_DRIVER, ห้ามมีเมื่อเป็นคนขับบริษัท) | `car_…` |
| `defaultVehicleId` |   | `string` | null ได้ | รถประจำ (veh_…) — ไม่ปลดระวาง ไม่ใช่หาง; คนขับรถร่วมต้องเป็นรถของผู้รับเหมาเดียวกัน, คนขับบริษัทต้องเป็นรถบริษัท · null = ไม่มี | `veh_…` |
| `name` |   | `string` |   |   | `สมชาย ใจดี` |
| `phone` |   | `string` |   |   | `081-234-5678` |
| `employmentType` |   | `string` | ค่า: `EMPLOYEE_SALARIED`, `EMPLOYEE_PER_TRIP`, `CARRIER_DRIVER` | เปลี่ยนเป็น/จาก CARRIER_DRIVER ต้องส่ง carrierId (หรือ null) ในคำขอเดียวกัน |   |
| `licenceClass` |   | `string` | ค่า: `PERSONAL`, `T1`, `T2`, `T3`, `T4` |   |   |
| `licenceExpiresOn` |   | `string (date)` |   |   | `2028-03-31` |
| `externalId` |   | `string` | null ได้ | null = ลบการผูก |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `DriverDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PATCH "$TMS_BASE_URL/v1/drivers/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"สมชาย ใจดี","phone":"081-234-5678","licenceExpiresOn":"2028-03-31"}'
```

```ts
const { data, error } = await tms.PATCH('/v1/drivers/{id}', {
  params: { path: { id: "…" } },
  body: {
    "name": "สมชาย ใจดี",
    "phone": "081-234-5678",
    "licenceExpiresOn": "2028-03-31"
  },
});
```

## GET /v1/drivers/{id}/history {#get-drivers-id-history}

`GET /v1/drivers/{id}/history`

scope: `master:read` · operationId: `Drivers_history`

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
curl -sS -X GET "$TMS_BASE_URL/v1/drivers/<id>/history" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/drivers/{id}/history', {
  params: { path: { id: "…" } },
});
```

## POST /v1/drivers/{id}/status {#post-drivers-id-status}

`POST /v1/drivers/{id}/status`

scope: `master:write` · operationId: `Drivers_status`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `DriverStatusDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `status` | ใช่ | `string` | ค่า: `active`, `on_leave`, `inactive` | active = พร้อมใช้, on_leave = ลาพัก (ไม่เสนอในการจัดรถ), inactive = ปิดใช้ (พ้นสภาพ — เบอร์/เลขบัตรนำไปใช้กับ record ใหม่ได้) |   |
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `ลาพักร้อน 3 วัน 12–14 พ.ย.` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `DriverDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/drivers/<id>/status" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"status":"active","reason":"ลาพักร้อน 3 วัน 12–14 พ.ย."}'
```

```ts
const { data, error } = await tms.POST('/v1/drivers/{id}/status', {
  params: { path: { id: "…" } },
  body: {
    "status": "active",
    "reason": "ลาพักร้อน 3 วัน 12–14 พ.ย."
  },
});
```

## POST /v1/drivers/{id}/delete {#post-drivers-id-delete}

`POST /v1/drivers/{id}/delete`

scope: `master:write` · operationId: `Drivers_remove`

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
curl -sS -X POST "$TMS_BASE_URL/v1/drivers/<id>/delete" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"เลิกใช้บริการตั้งแต่ ธ.ค. 2569"}'
```

```ts
const { data, error } = await tms.POST('/v1/drivers/{id}/delete', {
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

### DriverDto {#schema-DriverDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `drv_3f2a…` |
| `code` | ใช่ | `string` |   |   | `DRV-0001` |
| `externalId` | ใช่ | `string` | null ได้ |   |   |
| `name` | ใช่ | `string` |   |   | `สมชาย ใจดี` |
| `phone` | ใช่ | `string` |   |   | `081-234-5678` |
| `nationalIdLast4` | ใช่ | `string` | null ได้ | 4 หลักท้ายเลขบัตรประชาชน (แสดง •••• 3457) — เลขเต็มไม่มีใน API ดูได้ทาง reveal | `3457` |
| `licenceNo` | ใช่ | `string` | null ได้ |   |   |
| `licenceClass` | ใช่ | `string` | ค่า: `PERSONAL`, `T1`, `T2`, `T3`, `T4` · null ได้ |   |   |
| `licenceExpiresOn` | ใช่ | `string (date)` | null ได้ |   |   |
| `licenceStatus` | ใช่ | `string` | ค่า: `valid`, `expiring`, `expired`, `missing` |   |   |
| `licenceDaysToExpiry` | ใช่ | `number` | null ได้ | จำนวนวันถึงวันหมด (ติดลบ = หมดมาแล้ว) ตามวันนี้เวลาไทย |   |
| `employmentType` | ใช่ | `string` | ค่า: `EMPLOYEE_SALARIED`, `EMPLOYEE_PER_TRIP`, `CARRIER_DRIVER` |   |   |
| `carrier` | ใช่ | `DriverCarrierRefDto` | null ได้ |   |   |
| `defaultVehicle` | ใช่ | `DriverVehicleRefDto` | null ได้ |   |   |
| `status` | ใช่ | `string` | ค่า: `active`, `on_leave`, `inactive` |   |   |
| `statusReason` | ใช่ | `string` | null ได้ | เหตุผลการเปลี่ยนสถานะล่าสุด |   |
| `deletedAt` |   | `string (date-time)` |   | มีเฉพาะรายการที่ถูกลบ (tombstone) |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string` |   |   |   |
| `updatedAt` | ใช่ | `string` |   |   |   |

### DriverPageDto {#schema-DriverPageDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<DriverDto>` |   |   |   |
| `nextCursor` | ใช่ | `string` | null ได้ |   |   |
| `hasMore` | ใช่ | `boolean` |   |   |   |

### DriverSummaryDto {#schema-DriverSummaryDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `total` | ใช่ | `number` |   | คนขับทั้งหมด (ไม่รวมที่ลบ — รวมปิดใช้งาน) |   |
| `active` | ใช่ | `number` |   | พร้อมใช้ |   |
| `onLeave` | ใช่ | `number` |   | ลาพัก |   |
| `inactive` | ใช่ | `number` |   | ปิดใช้ |   |
| `licenceAlert` | ใช่ | `number` |   | คนขับ (ไม่ปิดใช้งาน) ที่ใบขับขี่หมดภายใน 30 วันหรือหมดแล้ว |   |
| `carrierDrivers` | ใช่ | `number` |   | คนขับรถร่วม (ไม่ปิดใช้งาน) |   |

### NextCodeDto {#schema-NextCodeDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `code` | ใช่ | `string` |   |   | `CUS-0010` |
