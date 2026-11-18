# รถ (vehicles)

14 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`GET /v1/vehicles`](#get-vehicles) | `master:read` |
| [`POST /v1/vehicles`](#post-vehicles) | `master:write` |
| [`GET /v1/vehicles/summary`](#get-vehicles-summary) | `master:read` |
| [`GET /v1/vehicles/export`](#get-vehicles-export) | `export:run` |
| [`PUT /v1/vehicles/external/{externalId}`](#put-vehicles-external-externalId) | `master:write` |
| [`PATCH /v1/vehicles/external/{externalId}`](#patch-vehicles-external-externalId) | `master:write` |
| [`GET /v1/vehicles/{id}`](#get-vehicles-id) | `master:read` |
| [`PATCH /v1/vehicles/{id}`](#patch-vehicles-id) | `master:write` |
| [`GET /v1/vehicles/{id}/history`](#get-vehicles-id-history) | `master:read` |
| [`POST /v1/vehicles/{id}/status`](#post-vehicles-id-status) | `master:write` |
| [`POST /v1/vehicles/{id}/delete`](#post-vehicles-id-delete) | `master:write` |
| [`GET /v1/vehicles/{id}/odometer`](#get-vehicles-id-odometer) | `master:read` |
| [`POST /v1/vehicles/{id}/odometer`](#post-vehicles-id-odometer) | `master:write` |
| [`POST /v1/vehicles/{id}/odometer/correct`](#post-vehicles-id-odometer-correct) | `master:write` |

## GET /v1/vehicles {#get-vehicles}

`GET /v1/vehicles`

scope: `master:read` · operationId: `Vehicles_list`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน (ใช้กับ sort เดิมเท่านั้น) |
| `updatedAfter` | query |   | `string` | คืนเฉพาะแถวที่ updatedAt > ค่านี้ (incremental pull) |
| `sort` | query |   | `string` ค่า: `plate`, `updatedAt`, `-updatedAt` | plate = เรียงตามทะเบียน (ค่าเริ่มต้นของหน้าจอ) · updatedAt/-updatedAt สำหรับ sync |
| `fields` | query |   | `string` | รายชื่อ field คั่นด้วย , เช่น id,plate |
| `q` | query |   | `string` | ค้นหา — ทะเบียน ยี่ห้อ รุ่น เลขตัวถัง หรือ externalId (ไม่สนตัวพิมพ์) |
| `status` | query |   | `string` | คั่นด้วย , เช่น ready,maintenance |
| `externalId` | query |   | `string` | externalId ตรงตัว |
| `includeDeleted` | query |   | `string` | true = รวมรายการที่ถูกลบ (tombstone มี `deletedAt`) |
| `plate` | query |   | `string` | ทะเบียนมีคำนี้ (ไม่สนช่องว่าง/ขีด) |
| `vehicleTypeId` | query |   | `string` | ประเภทรถ (vty_…) |
| `ownership` | query |   | `string` ค่า: `OWN`, `SUBCONTRACT` |   |
| `carrierId` | query |   | `string` | เฉพาะรถของผู้รับเหมานี้ (car_…) |
| `unitRole` | query |   | `string` ค่า: `SINGLE`, `TRACTOR`, `TRAILER` |   |
| `unpaired` | query |   | `string` | true = เฉพาะที่ยังไม่จับคู่หัวลาก-หาง |
| `docAlert` | query |   | `string` ค่า: `true`, `false` | true = มีเอกสารฉบับปัจจุบันหมดภายใน 30 วันหรือหมดแล้ว (ไม่นับรถปลดระวาง) · false = ไม่มี — คำนวณตามวันนี้ (ไม่สัมพันธ์กับ updatedAt) |
| `busy` | query |   | `string` ค่า: `true`, `false` | ST9-T01 true = กำลังใช้งาน (เป็นรถหรือหางของเที่ยวที่ปล่อยแล้วยังไม่ปิด — DISPATCHED/IN_PROGRESS — และไม่ได้ซ่อม/ปลดระวาง) · false = ส่วนกลับ |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `VehiclePageDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/vehicles" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/vehicles');
```

## POST /v1/vehicles {#post-vehicles}

`POST /v1/vehicles`

scope: `master:write` · operationId: `Vehicles_create`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `Idempotency-Key` | header |   | `string` |   |

**Request body** `CreateVehicleDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `unitRole` |   | `string` | ค่า: `SINGLE`, `TRACTOR`, `TRAILER` | SINGLE = รถเดี่ยว, TRACTOR = หัวลาก, TRAILER = หาง (จับคู่ได้เฉพาะหัวลากกับหาง) |   |
| `carrierId` |   | `string` | null ได้ | รถร่วม: ผู้รับเหมาเจ้าของรถ — บังคับเมื่อ ownership = SUBCONTRACT (ไม่ส่ง → 422) | `car_…` |
| `payloadKg` |   | `number` |   | น้ำหนักบรรทุก (กก.) > 0 — ไม่ส่งตอนสร้าง = ค่าของประเภทรถ | `6000` |
| `volumeCbm` |   | `number` | null ได้ | ปริมาตร (ลบ.ม.) | `32` |
| `tareWeightKg` |   | `number` | null ได้ | น้ำหนักรถเปล่า (กก.) | `3300` |
| `grossWeightKg` |   | `number` | null ได้ | น้ำหนักรวมตามทะเบียน (กก.) — น้ำหนักบรรทุก ≤ น้ำหนักรวม − น้ำหนักเปล่า | `9500` |
| `gpsProvider` |   | `string` | null ได้ | ค่าย GPS | `Cartrack` |
| `gpsDeviceId` |   | `string` | null ได้ | เลขอุปกรณ์ GPS (IMEI) — ต้องมีค่าย GPS, ห้ามซ้ำในค่ายเดียวกัน | `356938035643809` |
| `chassisNo` |   | `string` | null ได้ | เลขตัวถัง — ห้ามซ้ำ | `MPATFR86JMT000417` |
| `engineNo` |   | `string` | null ได้ | เลขเครื่องยนต์ |   |
| `brand` |   | `string` | null ได้ |   | `Isuzu` |
| `model` |   | `string` | null ได้ |   | `FRR 210` |
| `year` |   | `number` | null ได้ | ปีผลิต (ค.ศ.) 1980 – ปีหน้า (spec/06 FLT-A) | `2021` |
| `color` |   | `string` | null ได้ |   | `ขาว` |
| `fuelType` |   | `string` | ค่า: `DIESEL`, `GASOLINE`, `NGV`, `LPG`, `EV`, `HYBRID` · null ได้ |   |   |
| `tankCapacityL` |   | `number` | null ได้ | ความจุถัง (ลิตร) 20–2,000 | `200` |
| `odometerKm` |   | `number` |   | เลขไมล์ (กม.) — สร้าง = ค่าเริ่มต้น · แก้ = บันทึกค่าใหม่ (น้อยกว่าเดิม → 422 `odometer_backwards`; แก้ค่าผิดใช้ POST /{id}/odometer/correct) | `148220` |
| `pairedVehicleId` |   | `string` | null ได้ | หัวลาก ↔ หาง ที่จับคู่ (ต้องเป็นหัวลากกับหาง) — ตั้งแล้วเห็นทั้งสองฝั่ง · null = ปลดคู่ | `veh_…` |
| `purchaseCost` |   | `string` | null ได้ | ราคาซื้อ (บาท) — ต้องมีสิทธิ์ reports.finance:read (ไม่มี → 403) | `1450000.00` |
| `purchasedOn` |   | `string (date)` | null ได้ |   | `2021-11-04` |
| `depreciationMethod` |   | `string` | ค่า: `STRAIGHT_LINE` · null ได้ | วิธีคิดค่าเสื่อม (เส้นตรง N ปี — ต้องมีราคาซื้อและจำนวนปี) |   |
| `depreciationYears` |   | `number` | null ได้ | อายุใช้งาน (ปี) 1–30 | `10` |
| `salvageValue` |   | `string` | null ได้ | มูลค่าซาก ≤ ราคาซื้อ | `400000.00` |
| `photoDocumentIds` |   | `array<string>` |   | รูปรถ — id ไฟล์จาก /v1/documents (ST1-T08) สูงสุด 10 รูป | `["doc_…"]` |
| `plate` | ใช่ | `string` |   | ทะเบียน (ไม่รวมจังหวัด) — ห้ามซ้ำกับคันที่ยังไม่ปลดระวาง | `70-1234` |
| `plateProvince` | ใช่ | `string` | ค่า: `TH-10`, `TH-11`, `TH-12`, `TH-13`, `TH-14`, `TH-15`, `TH-16`, `TH-17`, `TH-18`, `TH-19`, `TH-20`, `TH-21`, `TH-22`, `TH-23`, `TH-24`, `TH-25`, `TH-26`, `TH-27`, `TH-30`, `TH-31`, `TH-32`, `TH-33`, `TH-34`, `TH-35`, `TH-36`, `TH-37`, `TH-38`, `TH-39`, `TH-40`, `TH-41`, `TH-42`, `TH-43`, `TH-44`, `TH-45`, `TH-46`, `TH-47`, `TH-48`, `TH-49`, `TH-50`, `TH-51`, `TH-52`, `TH-53`, `TH-54`, `TH-55`, `TH-56`, `TH-57`, `TH-58`, `TH-60`, `TH-61`, `TH-62`, `TH-63`, `TH-64`, `TH-65`, `TH-66`, `TH-67`, `TH-70`, `TH-71`, `TH-72`, `TH-73`, `TH-74`, `TH-75`, `TH-76`, `TH-77`, `TH-80`, `TH-81`, `TH-82`, `TH-83`, `TH-84`, `TH-85`, `TH-86`, `TH-90`, `TH-91`, `TH-92`, `TH-93`, `TH-94`, `TH-95`, `TH-96` | จังหวัดบนป้าย (ISO 3166-2:TH) | `TH-10` |
| `vehicleTypeId` | ใช่ | `string` |   | ประเภทรถ (ใช้งานอยู่) | `vty_…` |
| `ownership` | ใช่ | `string` | ค่า: `OWN`, `SUBCONTRACT` | OWN = รถบริษัท, SUBCONTRACT = รถร่วม (ต้องมี carrierId) |   |
| `externalId` |   | `string` |   | รหัสในระบบต้นทาง — เรียกด้วย ext:{externalId} ได้ |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `201` | สร้างแล้ว — เกินโควตารถ: `quotaExceeded: true` + header `Warning: 299` (ยังสร้างได้) | `VehicleDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/vehicles" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"payloadKg":6000,"odometerKm":148220,"photoDocumentIds":["doc_…"],"plate":"70-1234","plateProvince":"TH-10","vehicleTypeId":"vty_…","ownership":"OWN"}'
```

```ts
const { data, error } = await tms.POST('/v1/vehicles', {
  body: {
    "payloadKg": 6000,
    "odometerKm": 148220,
    "photoDocumentIds": [
      "doc_…"
    ],
    "plate": "70-1234",
    "plateProvince": "TH-10",
    "vehicleTypeId": "vty_…",
    "ownership": "OWN"
  },
});
```

## GET /v1/vehicles/summary {#get-vehicles-summary}

`GET /v1/vehicles/summary`

scope: `master:read` · operationId: `Vehicles_summary`

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `VehicleSummaryDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/vehicles/summary" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/vehicles/summary');
```

## GET /v1/vehicles/export {#get-vehicles-export}

`GET /v1/vehicles/export`

scope: `export:run` · operationId: `Vehicles_export`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน (ใช้กับ sort เดิมเท่านั้น) |
| `updatedAfter` | query |   | `string` | คืนเฉพาะแถวที่ updatedAt > ค่านี้ (incremental pull) |
| `sort` | query |   | `string` ค่า: `plate`, `updatedAt`, `-updatedAt` | plate = เรียงตามทะเบียน (ค่าเริ่มต้นของหน้าจอ) · updatedAt/-updatedAt สำหรับ sync |
| `fields` | query |   | `string` | รายชื่อ field คั่นด้วย , เช่น id,plate |
| `q` | query |   | `string` | ค้นหา — ทะเบียน ยี่ห้อ รุ่น เลขตัวถัง หรือ externalId (ไม่สนตัวพิมพ์) |
| `status` | query |   | `string` | คั่นด้วย , เช่น ready,maintenance |
| `externalId` | query |   | `string` | externalId ตรงตัว |
| `includeDeleted` | query |   | `string` | true = รวมรายการที่ถูกลบ (tombstone มี `deletedAt`) |
| `plate` | query |   | `string` | ทะเบียนมีคำนี้ (ไม่สนช่องว่าง/ขีด) |
| `vehicleTypeId` | query |   | `string` | ประเภทรถ (vty_…) |
| `ownership` | query |   | `string` ค่า: `OWN`, `SUBCONTRACT` |   |
| `carrierId` | query |   | `string` | เฉพาะรถของผู้รับเหมานี้ (car_…) |
| `unitRole` | query |   | `string` ค่า: `SINGLE`, `TRACTOR`, `TRAILER` |   |
| `unpaired` | query |   | `string` | true = เฉพาะที่ยังไม่จับคู่หัวลาก-หาง |
| `docAlert` | query |   | `string` ค่า: `true`, `false` | true = มีเอกสารฉบับปัจจุบันหมดภายใน 30 วันหรือหมดแล้ว (ไม่นับรถปลดระวาง) · false = ไม่มี — คำนวณตามวันนี้ (ไม่สัมพันธ์กับ updatedAt) |
| `busy` | query |   | `string` ค่า: `true`, `false` | ST9-T01 true = กำลังใช้งาน (เป็นรถหรือหางของเที่ยวที่ปล่อยแล้วยังไม่ปิด — DISPATCHED/IN_PROGRESS — และไม่ได้ซ่อม/ปลดระวาง) · false = ส่วนกลับ |
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
curl -sS -X GET "$TMS_BASE_URL/v1/vehicles/export" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/vehicles/export');
```

## PUT /v1/vehicles/external/{externalId} {#put-vehicles-external-externalId}

`PUT /v1/vehicles/external/{externalId}`

scope: `master:write` · operationId: `Vehicles_upsertExternal`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `externalId` | path | ใช่ | `string` | เลขของระบบต้นทาง (ASCII ที่พิมพ์ได้ 1–100 ตัว ไม่มีช่องว่าง) — unique ต่อ tenant ต่อ resource |
| `If-Match` | header |   | `string` | ETag — ใช้เมื่อแถวมีอยู่แล้ว |

**Request body** `UpsertVehicleDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `unitRole` |   | `string` | ค่า: `SINGLE`, `TRACTOR`, `TRAILER` | SINGLE = รถเดี่ยว, TRACTOR = หัวลาก, TRAILER = หาง (จับคู่ได้เฉพาะหัวลากกับหาง) |   |
| `carrierId` |   | `string` | null ได้ | รถร่วม: ผู้รับเหมาเจ้าของรถ — บังคับเมื่อ ownership = SUBCONTRACT (ไม่ส่ง → 422) | `car_…` |
| `payloadKg` |   | `number` |   | น้ำหนักบรรทุก (กก.) > 0 — ไม่ส่งตอนสร้าง = ค่าของประเภทรถ | `6000` |
| `volumeCbm` |   | `number` | null ได้ | ปริมาตร (ลบ.ม.) | `32` |
| `tareWeightKg` |   | `number` | null ได้ | น้ำหนักรถเปล่า (กก.) | `3300` |
| `grossWeightKg` |   | `number` | null ได้ | น้ำหนักรวมตามทะเบียน (กก.) — น้ำหนักบรรทุก ≤ น้ำหนักรวม − น้ำหนักเปล่า | `9500` |
| `gpsProvider` |   | `string` | null ได้ | ค่าย GPS | `Cartrack` |
| `gpsDeviceId` |   | `string` | null ได้ | เลขอุปกรณ์ GPS (IMEI) — ต้องมีค่าย GPS, ห้ามซ้ำในค่ายเดียวกัน | `356938035643809` |
| `chassisNo` |   | `string` | null ได้ | เลขตัวถัง — ห้ามซ้ำ | `MPATFR86JMT000417` |
| `engineNo` |   | `string` | null ได้ | เลขเครื่องยนต์ |   |
| `brand` |   | `string` | null ได้ |   | `Isuzu` |
| `model` |   | `string` | null ได้ |   | `FRR 210` |
| `year` |   | `number` | null ได้ | ปีผลิต (ค.ศ.) 1980 – ปีหน้า (spec/06 FLT-A) | `2021` |
| `color` |   | `string` | null ได้ |   | `ขาว` |
| `fuelType` |   | `string` | ค่า: `DIESEL`, `GASOLINE`, `NGV`, `LPG`, `EV`, `HYBRID` · null ได้ |   |   |
| `tankCapacityL` |   | `number` | null ได้ | ความจุถัง (ลิตร) 20–2,000 | `200` |
| `odometerKm` |   | `number` |   | เลขไมล์ (กม.) — สร้าง = ค่าเริ่มต้น · แก้ = บันทึกค่าใหม่ (น้อยกว่าเดิม → 422 `odometer_backwards`; แก้ค่าผิดใช้ POST /{id}/odometer/correct) | `148220` |
| `pairedVehicleId` |   | `string` | null ได้ | หัวลาก ↔ หาง ที่จับคู่ (ต้องเป็นหัวลากกับหาง) — ตั้งแล้วเห็นทั้งสองฝั่ง · null = ปลดคู่ | `veh_…` |
| `purchaseCost` |   | `string` | null ได้ | ราคาซื้อ (บาท) — ต้องมีสิทธิ์ reports.finance:read (ไม่มี → 403) | `1450000.00` |
| `purchasedOn` |   | `string (date)` | null ได้ |   | `2021-11-04` |
| `depreciationMethod` |   | `string` | ค่า: `STRAIGHT_LINE` · null ได้ | วิธีคิดค่าเสื่อม (เส้นตรง N ปี — ต้องมีราคาซื้อและจำนวนปี) |   |
| `depreciationYears` |   | `number` | null ได้ | อายุใช้งาน (ปี) 1–30 | `10` |
| `salvageValue` |   | `string` | null ได้ | มูลค่าซาก ≤ ราคาซื้อ | `400000.00` |
| `photoDocumentIds` |   | `array<string>` |   | รูปรถ — id ไฟล์จาก /v1/documents (ST1-T08) สูงสุด 10 รูป | `["doc_…"]` |
| `plate` | ใช่ | `string` |   | ทะเบียน (ไม่รวมจังหวัด) — ห้ามซ้ำกับคันที่ยังไม่ปลดระวาง | `70-1234` |
| `plateProvince` | ใช่ | `string` | ค่า: `TH-10`, `TH-11`, `TH-12`, `TH-13`, `TH-14`, `TH-15`, `TH-16`, `TH-17`, `TH-18`, `TH-19`, `TH-20`, `TH-21`, `TH-22`, `TH-23`, `TH-24`, `TH-25`, `TH-26`, `TH-27`, `TH-30`, `TH-31`, `TH-32`, `TH-33`, `TH-34`, `TH-35`, `TH-36`, `TH-37`, `TH-38`, `TH-39`, `TH-40`, `TH-41`, `TH-42`, `TH-43`, `TH-44`, `TH-45`, `TH-46`, `TH-47`, `TH-48`, `TH-49`, `TH-50`, `TH-51`, `TH-52`, `TH-53`, `TH-54`, `TH-55`, `TH-56`, `TH-57`, `TH-58`, `TH-60`, `TH-61`, `TH-62`, `TH-63`, `TH-64`, `TH-65`, `TH-66`, `TH-67`, `TH-70`, `TH-71`, `TH-72`, `TH-73`, `TH-74`, `TH-75`, `TH-76`, `TH-77`, `TH-80`, `TH-81`, `TH-82`, `TH-83`, `TH-84`, `TH-85`, `TH-86`, `TH-90`, `TH-91`, `TH-92`, `TH-93`, `TH-94`, `TH-95`, `TH-96` | จังหวัดบนป้าย (ISO 3166-2:TH) | `TH-10` |
| `vehicleTypeId` | ใช่ | `string` |   | ประเภทรถ (ใช้งานอยู่) | `vty_…` |
| `ownership` | ใช่ | `string` | ค่า: `OWN`, `SUBCONTRACT` | OWN = รถบริษัท, SUBCONTRACT = รถร่วม (ต้องมี carrierId) |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | มีอยู่แล้ว → อัปเดต (ส่งซ้ำได้ ไม่เกิดแถวใหม่) | `VehicleDto` |
| `201` | ยังไม่มี → สร้าง | `VehicleDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `409` | ขัดกับข้อมูลที่มีอยู่ (เช่น รหัส/ชื่อซ้ำ, สถานะไม่อนุญาตให้แก้) — [conflict](errors.md#conflict), [duplicate](errors.md#duplicate) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง (รวมทุกช่องใน errors[]) — externalId ใน path ผิดรูปแบบ = field `externalId` — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PUT "$TMS_BASE_URL/v1/vehicles/external/<externalId>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"payloadKg":6000,"odometerKm":148220,"photoDocumentIds":["doc_…"],"plate":"70-1234","plateProvince":"TH-10","vehicleTypeId":"vty_…","ownership":"OWN"}'
```

```ts
const { data, error } = await tms.PUT('/v1/vehicles/external/{externalId}', {
  params: { path: { externalId: "…" } },
  body: {
    "payloadKg": 6000,
    "odometerKm": 148220,
    "photoDocumentIds": [
      "doc_…"
    ],
    "plate": "70-1234",
    "plateProvince": "TH-10",
    "vehicleTypeId": "vty_…",
    "ownership": "OWN"
  },
});
```

## แก้บางช่องด้วย externalId {#patch-vehicles-external-externalId}

`PATCH /v1/vehicles/external/{externalId}`

scope: `master:write` · operationId: `Vehicles_patchExternal`

เหมือน `PATCH /vehicles/ext:{externalId}` (กติกาเดียวกับ PATCH ด้วย id) · ยังไม่มีแถวนี้ → 404 — สร้างใหม่ใช้ PUT

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `externalId` | path | ใช่ | `string` | เลขของระบบต้นทาง (ASCII ที่พิมพ์ได้ 1–100 ตัว ไม่มีช่องว่าง) — unique ต่อ tenant ต่อ resource |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `UpdateVehicleDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `unitRole` |   | `string` | ค่า: `SINGLE`, `TRACTOR`, `TRAILER` | SINGLE = รถเดี่ยว, TRACTOR = หัวลาก, TRAILER = หาง (จับคู่ได้เฉพาะหัวลากกับหาง) |   |
| `carrierId` |   | `string` | null ได้ | รถร่วม: ผู้รับเหมาเจ้าของรถ — บังคับเมื่อ ownership = SUBCONTRACT (ไม่ส่ง → 422) | `car_…` |
| `payloadKg` |   | `number` |   | น้ำหนักบรรทุก (กก.) > 0 — ไม่ส่งตอนสร้าง = ค่าของประเภทรถ | `6000` |
| `volumeCbm` |   | `number` | null ได้ | ปริมาตร (ลบ.ม.) | `32` |
| `tareWeightKg` |   | `number` | null ได้ | น้ำหนักรถเปล่า (กก.) | `3300` |
| `grossWeightKg` |   | `number` | null ได้ | น้ำหนักรวมตามทะเบียน (กก.) — น้ำหนักบรรทุก ≤ น้ำหนักรวม − น้ำหนักเปล่า | `9500` |
| `gpsProvider` |   | `string` | null ได้ | ค่าย GPS | `Cartrack` |
| `gpsDeviceId` |   | `string` | null ได้ | เลขอุปกรณ์ GPS (IMEI) — ต้องมีค่าย GPS, ห้ามซ้ำในค่ายเดียวกัน | `356938035643809` |
| `chassisNo` |   | `string` | null ได้ | เลขตัวถัง — ห้ามซ้ำ | `MPATFR86JMT000417` |
| `engineNo` |   | `string` | null ได้ | เลขเครื่องยนต์ |   |
| `brand` |   | `string` | null ได้ |   | `Isuzu` |
| `model` |   | `string` | null ได้ |   | `FRR 210` |
| `year` |   | `number` | null ได้ | ปีผลิต (ค.ศ.) 1980 – ปีหน้า (spec/06 FLT-A) | `2021` |
| `color` |   | `string` | null ได้ |   | `ขาว` |
| `fuelType` |   | `string` | ค่า: `DIESEL`, `GASOLINE`, `NGV`, `LPG`, `EV`, `HYBRID` · null ได้ |   |   |
| `tankCapacityL` |   | `number` | null ได้ | ความจุถัง (ลิตร) 20–2,000 | `200` |
| `odometerKm` |   | `number` |   | เลขไมล์ (กม.) — สร้าง = ค่าเริ่มต้น · แก้ = บันทึกค่าใหม่ (น้อยกว่าเดิม → 422 `odometer_backwards`; แก้ค่าผิดใช้ POST /{id}/odometer/correct) | `148220` |
| `pairedVehicleId` |   | `string` | null ได้ | หัวลาก ↔ หาง ที่จับคู่ (ต้องเป็นหัวลากกับหาง) — ตั้งแล้วเห็นทั้งสองฝั่ง · null = ปลดคู่ | `veh_…` |
| `purchaseCost` |   | `string` | null ได้ | ราคาซื้อ (บาท) — ต้องมีสิทธิ์ reports.finance:read (ไม่มี → 403) | `1450000.00` |
| `purchasedOn` |   | `string (date)` | null ได้ |   | `2021-11-04` |
| `depreciationMethod` |   | `string` | ค่า: `STRAIGHT_LINE` · null ได้ | วิธีคิดค่าเสื่อม (เส้นตรง N ปี — ต้องมีราคาซื้อและจำนวนปี) |   |
| `depreciationYears` |   | `number` | null ได้ | อายุใช้งาน (ปี) 1–30 | `10` |
| `salvageValue` |   | `string` | null ได้ | มูลค่าซาก ≤ ราคาซื้อ | `400000.00` |
| `photoDocumentIds` |   | `array<string>` |   | รูปรถ — id ไฟล์จาก /v1/documents (ST1-T08) สูงสุด 10 รูป | `["doc_…"]` |
| `plate` |   | `string` |   |   | `70-1234` |
| `plateProvince` |   | `string` | ค่า: `TH-10`, `TH-11`, `TH-12`, `TH-13`, `TH-14`, `TH-15`, `TH-16`, `TH-17`, `TH-18`, `TH-19`, `TH-20`, `TH-21`, `TH-22`, `TH-23`, `TH-24`, `TH-25`, `TH-26`, `TH-27`, `TH-30`, `TH-31`, `TH-32`, `TH-33`, `TH-34`, `TH-35`, `TH-36`, `TH-37`, `TH-38`, `TH-39`, `TH-40`, `TH-41`, `TH-42`, `TH-43`, `TH-44`, `TH-45`, `TH-46`, `TH-47`, `TH-48`, `TH-49`, `TH-50`, `TH-51`, `TH-52`, `TH-53`, `TH-54`, `TH-55`, `TH-56`, `TH-57`, `TH-58`, `TH-60`, `TH-61`, `TH-62`, `TH-63`, `TH-64`, `TH-65`, `TH-66`, `TH-67`, `TH-70`, `TH-71`, `TH-72`, `TH-73`, `TH-74`, `TH-75`, `TH-76`, `TH-77`, `TH-80`, `TH-81`, `TH-82`, `TH-83`, `TH-84`, `TH-85`, `TH-86`, `TH-90`, `TH-91`, `TH-92`, `TH-93`, `TH-94`, `TH-95`, `TH-96` |   |   |
| `vehicleTypeId` |   | `string` |   |   | `vty_…` |
| `ownership` |   | `string` | ค่า: `OWN`, `SUBCONTRACT` |   |   |
| `externalId` |   | `string` | null ได้ | null = ลบการผูก |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `VehicleDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ยังไม่มีแถวที่ externalId นี้ (สร้างใหม่ใช้ PUT) หรืออยู่ tenant อื่น — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | ขัดกับข้อมูลที่มีอยู่ (เช่น รหัส/ชื่อซ้ำ, สถานะไม่อนุญาตให้แก้) — [conflict](errors.md#conflict), [duplicate](errors.md#duplicate) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง (รวมทุกช่องใน errors[]) — externalId ใน path ผิดรูปแบบ = field `externalId` — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PATCH "$TMS_BASE_URL/v1/vehicles/external/<externalId>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"payloadKg":6000,"odometerKm":148220,"photoDocumentIds":["doc_…"],"plate":"70-1234","vehicleTypeId":"vty_…"}'
```

```ts
const { data, error } = await tms.PATCH('/v1/vehicles/external/{externalId}', {
  params: { path: { externalId: "…" } },
  body: {
    "payloadKg": 6000,
    "odometerKm": 148220,
    "photoDocumentIds": [
      "doc_…"
    ],
    "plate": "70-1234",
    "vehicleTypeId": "vty_…"
  },
});
```

## GET /v1/vehicles/{id} {#get-vehicles-id}

`GET /v1/vehicles/{id}`

scope: `master:read` · operationId: `Vehicles_get`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `VehicleDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/vehicles/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/vehicles/{id}', {
  params: { path: { id: "…" } },
});
```

## PATCH /v1/vehicles/{id} {#patch-vehicles-id}

`PATCH /v1/vehicles/{id}`

scope: `master:write` · operationId: `Vehicles_update`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `UpdateVehicleDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `unitRole` |   | `string` | ค่า: `SINGLE`, `TRACTOR`, `TRAILER` | SINGLE = รถเดี่ยว, TRACTOR = หัวลาก, TRAILER = หาง (จับคู่ได้เฉพาะหัวลากกับหาง) |   |
| `carrierId` |   | `string` | null ได้ | รถร่วม: ผู้รับเหมาเจ้าของรถ — บังคับเมื่อ ownership = SUBCONTRACT (ไม่ส่ง → 422) | `car_…` |
| `payloadKg` |   | `number` |   | น้ำหนักบรรทุก (กก.) > 0 — ไม่ส่งตอนสร้าง = ค่าของประเภทรถ | `6000` |
| `volumeCbm` |   | `number` | null ได้ | ปริมาตร (ลบ.ม.) | `32` |
| `tareWeightKg` |   | `number` | null ได้ | น้ำหนักรถเปล่า (กก.) | `3300` |
| `grossWeightKg` |   | `number` | null ได้ | น้ำหนักรวมตามทะเบียน (กก.) — น้ำหนักบรรทุก ≤ น้ำหนักรวม − น้ำหนักเปล่า | `9500` |
| `gpsProvider` |   | `string` | null ได้ | ค่าย GPS | `Cartrack` |
| `gpsDeviceId` |   | `string` | null ได้ | เลขอุปกรณ์ GPS (IMEI) — ต้องมีค่าย GPS, ห้ามซ้ำในค่ายเดียวกัน | `356938035643809` |
| `chassisNo` |   | `string` | null ได้ | เลขตัวถัง — ห้ามซ้ำ | `MPATFR86JMT000417` |
| `engineNo` |   | `string` | null ได้ | เลขเครื่องยนต์ |   |
| `brand` |   | `string` | null ได้ |   | `Isuzu` |
| `model` |   | `string` | null ได้ |   | `FRR 210` |
| `year` |   | `number` | null ได้ | ปีผลิต (ค.ศ.) 1980 – ปีหน้า (spec/06 FLT-A) | `2021` |
| `color` |   | `string` | null ได้ |   | `ขาว` |
| `fuelType` |   | `string` | ค่า: `DIESEL`, `GASOLINE`, `NGV`, `LPG`, `EV`, `HYBRID` · null ได้ |   |   |
| `tankCapacityL` |   | `number` | null ได้ | ความจุถัง (ลิตร) 20–2,000 | `200` |
| `odometerKm` |   | `number` |   | เลขไมล์ (กม.) — สร้าง = ค่าเริ่มต้น · แก้ = บันทึกค่าใหม่ (น้อยกว่าเดิม → 422 `odometer_backwards`; แก้ค่าผิดใช้ POST /{id}/odometer/correct) | `148220` |
| `pairedVehicleId` |   | `string` | null ได้ | หัวลาก ↔ หาง ที่จับคู่ (ต้องเป็นหัวลากกับหาง) — ตั้งแล้วเห็นทั้งสองฝั่ง · null = ปลดคู่ | `veh_…` |
| `purchaseCost` |   | `string` | null ได้ | ราคาซื้อ (บาท) — ต้องมีสิทธิ์ reports.finance:read (ไม่มี → 403) | `1450000.00` |
| `purchasedOn` |   | `string (date)` | null ได้ |   | `2021-11-04` |
| `depreciationMethod` |   | `string` | ค่า: `STRAIGHT_LINE` · null ได้ | วิธีคิดค่าเสื่อม (เส้นตรง N ปี — ต้องมีราคาซื้อและจำนวนปี) |   |
| `depreciationYears` |   | `number` | null ได้ | อายุใช้งาน (ปี) 1–30 | `10` |
| `salvageValue` |   | `string` | null ได้ | มูลค่าซาก ≤ ราคาซื้อ | `400000.00` |
| `photoDocumentIds` |   | `array<string>` |   | รูปรถ — id ไฟล์จาก /v1/documents (ST1-T08) สูงสุด 10 รูป | `["doc_…"]` |
| `plate` |   | `string` |   |   | `70-1234` |
| `plateProvince` |   | `string` | ค่า: `TH-10`, `TH-11`, `TH-12`, `TH-13`, `TH-14`, `TH-15`, `TH-16`, `TH-17`, `TH-18`, `TH-19`, `TH-20`, `TH-21`, `TH-22`, `TH-23`, `TH-24`, `TH-25`, `TH-26`, `TH-27`, `TH-30`, `TH-31`, `TH-32`, `TH-33`, `TH-34`, `TH-35`, `TH-36`, `TH-37`, `TH-38`, `TH-39`, `TH-40`, `TH-41`, `TH-42`, `TH-43`, `TH-44`, `TH-45`, `TH-46`, `TH-47`, `TH-48`, `TH-49`, `TH-50`, `TH-51`, `TH-52`, `TH-53`, `TH-54`, `TH-55`, `TH-56`, `TH-57`, `TH-58`, `TH-60`, `TH-61`, `TH-62`, `TH-63`, `TH-64`, `TH-65`, `TH-66`, `TH-67`, `TH-70`, `TH-71`, `TH-72`, `TH-73`, `TH-74`, `TH-75`, `TH-76`, `TH-77`, `TH-80`, `TH-81`, `TH-82`, `TH-83`, `TH-84`, `TH-85`, `TH-86`, `TH-90`, `TH-91`, `TH-92`, `TH-93`, `TH-94`, `TH-95`, `TH-96` |   |   |
| `vehicleTypeId` |   | `string` |   |   | `vty_…` |
| `ownership` |   | `string` | ค่า: `OWN`, `SUBCONTRACT` |   |   |
| `externalId` |   | `string` | null ได้ | null = ลบการผูก |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `VehicleDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PATCH "$TMS_BASE_URL/v1/vehicles/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"payloadKg":6000,"odometerKm":148220,"photoDocumentIds":["doc_…"],"plate":"70-1234","vehicleTypeId":"vty_…"}'
```

```ts
const { data, error } = await tms.PATCH('/v1/vehicles/{id}', {
  params: { path: { id: "…" } },
  body: {
    "payloadKg": 6000,
    "odometerKm": 148220,
    "photoDocumentIds": [
      "doc_…"
    ],
    "plate": "70-1234",
    "vehicleTypeId": "vty_…"
  },
});
```

## GET /v1/vehicles/{id}/history {#get-vehicles-id-history}

`GET /v1/vehicles/{id}/history`

scope: `master:read` · operationId: `Vehicles_history`

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
curl -sS -X GET "$TMS_BASE_URL/v1/vehicles/<id>/history" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/vehicles/{id}/history', {
  params: { path: { id: "…" } },
});
```

## POST /v1/vehicles/{id}/status {#post-vehicles-id-status}

`POST /v1/vehicles/{id}/status`

scope: `master:write` · operationId: `Vehicles_status`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `VehicleStatusDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `status` | ใช่ | `string` | ค่า: `ready`, `maintenance`, `parked`, `retired` | ready = พร้อมใช้, maintenance = ซ่อม, parked = จอด, retired = ปลดระวาง (ย้อนกลับไม่ได้ — ต้องไม่มีเที่ยวค้าง) |   |
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `เข้าอู่เปลี่ยนคลัตช์ 3 วัน` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `VehicleDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/vehicles/<id>/status" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"status":"ready","reason":"เข้าอู่เปลี่ยนคลัตช์ 3 วัน"}'
```

```ts
const { data, error } = await tms.POST('/v1/vehicles/{id}/status', {
  params: { path: { id: "…" } },
  body: {
    "status": "ready",
    "reason": "เข้าอู่เปลี่ยนคลัตช์ 3 วัน"
  },
});
```

## POST /v1/vehicles/{id}/delete {#post-vehicles-id-delete}

`POST /v1/vehicles/{id}/delete`

scope: `master:write` · operationId: `Vehicles_remove`

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
curl -sS -X POST "$TMS_BASE_URL/v1/vehicles/<id>/delete" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"เลิกใช้บริการตั้งแต่ ธ.ค. 2569"}'
```

```ts
const { data, error } = await tms.POST('/v1/vehicles/{id}/delete', {
  params: { path: { id: "…" } },
  body: {
    "reason": "เลิกใช้บริการตั้งแต่ ธ.ค. 2569"
  },
});
```

## GET /v1/vehicles/{id}/odometer {#get-vehicles-id-odometer}

`GET /v1/vehicles/{id}/odometer`

scope: `master:read` · operationId: `Vehicles_readings`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `limit` | query |   | `number` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | ประวัติเลขไมล์ ใหม่สุดก่อน (spec/06 FLT-O) | `OdometerPageDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/vehicles/<id>/odometer" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/vehicles/{id}/odometer', {
  params: { path: { id: "…" } },
});
```

## POST /v1/vehicles/{id}/odometer {#post-vehicles-id-odometer}

`POST /v1/vehicles/{id}/odometer`

scope: `master:write` · operationId: `Vehicles_record`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `Idempotency-Key` | header |   | `string` |   |
| `If-Match` | header |   | `string` | ETag ของรถ — ไม่ตรง → 412 |

**Request body** `OdometerReadingInput`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `readingKm` | ใช่ | `number` |   |   | `150120.5` |
| `readAt` |   | `string (date-time)` |   | เวลาที่อ่านเลขไมล์ (ไม่ส่ง = ตอนนี้) — ห้ามเป็นอนาคต |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `201` |   | `OdometerResultDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/vehicles/<id>/odometer" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"readingKm":150120.5}'
```

```ts
const { data, error } = await tms.POST('/v1/vehicles/{id}/odometer', {
  params: { path: { id: "…" } },
  body: {
    "readingKm": 150120.5
  },
});
```

## POST /v1/vehicles/{id}/odometer/correct {#post-vehicles-id-odometer-correct}

`POST /v1/vehicles/{id}/odometer/correct`

scope: `master:write` · operationId: `Vehicles_correct`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `If-Match` | header |   | `string` | ETag ของรถ — ไม่ตรง → 412 |

**Request body** `OdometerCorrectionInput`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `readingId` |   | `string` |   | แถวที่จะแก้ (ต้องยังเป็น ACCEPTED) — ไม่ส่ง = แถวล่าสุด | `odo_…` |
| `readingKm` | ใช่ | `number` |   |   | `148200` |
| `reasonType` | ใช่ | `string` | ค่า: `TYPO`, `METER_REPLACED`, `GPS_ERROR`, `MISSED_ENTRY`, `OTHER` | TYPO = พิมพ์ผิด, METER_REPLACED = เปลี่ยนเรือนไมล์, GPS_ERROR, MISSED_ENTRY = ลืมบันทึก, OTHER |   |
| `note` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `พิมพ์เลขเกินมา 1 หลักเมื่อวาน` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `OdometerResultDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/vehicles/<id>/odometer/correct" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"readingId":"odo_…","readingKm":148200,"reasonType":"TYPO","note":"พิมพ์เลขเกินมา 1 หลักเมื่อวาน"}'
```

```ts
const { data, error } = await tms.POST('/v1/vehicles/{id}/odometer/correct', {
  params: { path: { id: "…" } },
  body: {
    "readingId": "odo_…",
    "readingKm": 148200,
    "reasonType": "TYPO",
    "note": "พิมพ์เลขเกินมา 1 หลักเมื่อวาน"
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

### OdometerPageDto {#schema-OdometerPageDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<OdometerReadingDto>` |   |   |   |

### OdometerResultDto {#schema-OdometerResultDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reading` | ใช่ | `OdometerReadingDto` |   |   |   |
| `vehicle` | ใช่ | `VehicleDto` |   |   |   |

### VehicleDto {#schema-VehicleDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `veh_3f2a…` |
| `plate` | ใช่ | `string` |   |   | `70-1234` |
| `plateProvince` | ใช่ | `string` | ค่า: `TH-10`, `TH-11`, `TH-12`, `TH-13`, `TH-14`, `TH-15`, `TH-16`, `TH-17`, `TH-18`, `TH-19`, `TH-20`, `TH-21`, `TH-22`, `TH-23`, `TH-24`, `TH-25`, `TH-26`, `TH-27`, `TH-30`, `TH-31`, `TH-32`, `TH-33`, `TH-34`, `TH-35`, `TH-36`, `TH-37`, `TH-38`, `TH-39`, `TH-40`, `TH-41`, `TH-42`, `TH-43`, `TH-44`, `TH-45`, `TH-46`, `TH-47`, `TH-48`, `TH-49`, `TH-50`, `TH-51`, `TH-52`, `TH-53`, `TH-54`, `TH-55`, `TH-56`, `TH-57`, `TH-58`, `TH-60`, `TH-61`, `TH-62`, `TH-63`, `TH-64`, `TH-65`, `TH-66`, `TH-67`, `TH-70`, `TH-71`, `TH-72`, `TH-73`, `TH-74`, `TH-75`, `TH-76`, `TH-77`, `TH-80`, `TH-81`, `TH-82`, `TH-83`, `TH-84`, `TH-85`, `TH-86`, `TH-90`, `TH-91`, `TH-92`, `TH-93`, `TH-94`, `TH-95`, `TH-96` |   | `TH-10` |
| `externalId` | ใช่ | `string` | null ได้ |   |   |
| `vehicleType` | ใช่ | `VehicleTypeRefDto` |   |   |   |
| `unitRole` | ใช่ | `string` | ค่า: `SINGLE`, `TRACTOR`, `TRAILER` |   |   |
| `ownership` | ใช่ | `string` | ค่า: `OWN`, `SUBCONTRACT` |   |   |
| `carrier` | ใช่ | `VehicleRefDto` | null ได้ | ผู้รับเหมา (รถร่วม) |   |
| `payloadKg` | ใช่ | `number` | null ได้ |   |   |
| `volumeCbm` | ใช่ | `number` | null ได้ |   |   |
| `tareWeightKg` | ใช่ | `number` | null ได้ |   |   |
| `grossWeightKg` | ใช่ | `number` | null ได้ |   |   |
| `gpsProvider` | ใช่ | `string` | null ได้ |   |   |
| `gpsDeviceId` | ใช่ | `string` | null ได้ |   |   |
| `chassisNo` | ใช่ | `string` | null ได้ |   |   |
| `engineNo` | ใช่ | `string` | null ได้ |   |   |
| `brand` | ใช่ | `string` | null ได้ |   |   |
| `model` | ใช่ | `string` | null ได้ |   |   |
| `year` | ใช่ | `number` | null ได้ |   |   |
| `color` | ใช่ | `string` | null ได้ |   |   |
| `fuelType` | ใช่ | `string` | ค่า: `DIESEL`, `GASOLINE`, `NGV`, `LPG`, `EV`, `HYBRID` · null ได้ |   |   |
| `tankCapacityL` | ใช่ | `number` | null ได้ |   |   |
| `odometerKm` | ใช่ | `number` | null ได้ | เลขไมล์ปัจจุบัน (กม.) |   |
| `odometerSource` | ใช่ | `string` | null ได้ |   | `MANUAL` |
| `odometerUpdatedAt` | ใช่ | `string (date-time)` | null ได้ |   |   |
| `paired` | ใช่ | `PairedVehicleDto` | null ได้ | หัวลาก/หางที่จับคู่ |   |
| `purchaseCost` |   | `string` | null ได้ | ราคาซื้อ — มีเฉพาะผู้มีสิทธิ์ reports.finance:read (ข้อมูลการเงินรถ spec/06 FLT-A) |   |
| `purchasedOn` |   | `string (date)` | null ได้ |   |   |
| `depreciationMethod` |   | `string` | ค่า: `STRAIGHT_LINE` · null ได้ |   |   |
| `depreciationYears` |   | `number` | null ได้ |   |   |
| `salvageValue` |   | `string` | null ได้ |   |   |
| `photoDocumentIds` | ใช่ | `array<string>` |   |   |   |
| `status` | ใช่ | `string` | ค่า: `ready`, `maintenance`, `parked`, `retired` |   |   |
| `statusReason` | ใช่ | `string` | null ได้ | เหตุผลของสถานะล่าสุด |   |
| `retiredAt` | ใช่ | `string (date-time)` | null ได้ |   |   |
| `deletedAt` |   | `string (date-time)` | null ได้ | มีค่าเฉพาะเมื่อขอ includeDeleted=true และรายการถูกลบแล้ว (tombstone) |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string (date-time)` |   |   |   |
| `updatedAt` | ใช่ | `string (date-time)` |   |   |   |
| `quotaExceeded` |   | `boolean` |   | มีเฉพาะในผลการสร้าง: true = รถที่นับโควตา (ยังไม่ปลดระวาง) เกินโควตาของ tenant แล้ว — soft limit ยังสร้างได้ (header `Warning: 299` ด้วย) |   |
| `docAlert` |   | `VehicleDocAlertDto` |   | มีเฉพาะในรายการ (GET /vehicles): เอกสารใกล้หมด 30 วัน/หมดแล้วของคันนี้ (รถปลดระวาง = 0) — ST2-T07 · คำนวณจากเอกสารและวันนี้ทุกครั้ง **ไม่ทำให้ `updatedAt` ของรถเปลี่ยน** — ผู้ที่ sync แบบ `updatedAfter` ให้ดึงเอกสารจาก `GET /vehicle-documents` แทน |   |

### VehiclePageDto {#schema-VehiclePageDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<VehicleDto>` |   |   |   |
| `nextCursor` | ใช่ | `string` | null ได้ |   |   |
| `hasMore` | ใช่ | `boolean` |   |   |   |

### VehicleSummaryDto {#schema-VehicleSummaryDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `total` | ใช่ | `number` |   | รถทั้งหมด (ไม่รวมที่ลบ — รวมปลดระวาง) |   |
| `ready` | ใช่ | `number` |   |   |   |
| `maintenance` | ใช่ | `number` |   |   |   |
| `parked` | ใช่ | `number` |   |   |   |
| `retired` | ใช่ | `number` |   |   |   |
| `subcontract` | ใช่ | `number` |   | รถร่วม (ไม่นับปลดระวาง) |   |
| `docAlert` | ใช่ | `number` |   | รถ (ไม่ปลดระวาง) ที่มีเอกสารฉบับปัจจุบันหมดภายใน 30 วันหรือหมดแล้ว |   |
| `quota` | ใช่ | `VehicleQuotaDto` |   |   |   |
| `fleet` | ใช่ | `VehicleFleetTodayDto` |   |   |   |
