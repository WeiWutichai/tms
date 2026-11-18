# เที่ยววิ่ง (trips)

32 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`GET /v1/trips/summary`](#get-trips-summary) | `trips:read` |
| [`GET /v1/trips`](#get-trips) | `trips:read` |
| [`POST /v1/trips`](#post-trips) | `trips:assign` |
| [`POST /v1/trips/bulk-assign`](#post-trips-bulk-assign) | `trips:assign` |
| [`POST /v1/trips/send-all`](#post-trips-send-all) | `trips:dispatch` |
| [`GET /v1/trips/{id}`](#get-trips-id) | `trips:read` |
| [`POST /v1/trips/{id}/schedule`](#post-trips-id-schedule) | `trips:assign` |
| [`POST /v1/trips/{id}/attach`](#post-trips-id-attach) | `trips:assign` |
| [`POST /v1/trips/{id}/detach`](#post-trips-id-detach) | `trips:assign` |
| [`POST /v1/trips/{id}/reorder-stops`](#post-trips-id-reorder-stops) | `trips:assign` |
| [`POST /v1/trips/{id}/assign`](#post-trips-id-assign) | `trips:assign` |
| [`GET /v1/trips/{id}/hire-options`](#get-trips-id-hire-options) | `trips:assign` |
| [`POST /v1/trips/{id}/offer`](#post-trips-id-offer) | `trips:assign` |
| [`POST /v1/trips/{id}/dispatch`](#post-trips-id-dispatch) | `trips:dispatch` |
| [`POST /v1/trips/{id}/confirm-rules`](#post-trips-id-confirm-rules) | `trips:assign` |
| [`POST /v1/trips/{id}/complete`](#post-trips-id-complete) | `trips:close` |
| [`POST /v1/trips/{id}/cancel`](#post-trips-id-cancel) | `trips:assign` |
| [`GET /v1/trips/{id}/field-charges`](#get-trips-id-field-charges) | `trips:read` |
| [`POST /v1/trips/{id}/field-charges`](#post-trips-id-field-charges) | `trips:read` |
| [`POST /v1/do-surcharges/{id}/confirm`](#post-do-surcharges-id-confirm) | `invoices:draft` |
| [`POST /v1/do-surcharges/{id}/reject`](#post-do-surcharges-id-reject) | `invoices:draft` |
| [`POST /v1/do-surcharges/{id}/cancel`](#post-do-surcharges-id-cancel) | `prices.sell:write` |
| [`POST /v1/trip-costs/{id}/confirm`](#post-trip-costs-id-confirm) | `settlements:approve` |
| [`POST /v1/trip-costs/{id}/reject`](#post-trip-costs-id-reject) | `settlements:approve` |
| [`POST /v1/trip-costs/{id}/cancel`](#post-trip-costs-id-cancel) | `prices.buy:write` / `trips:dispatch` |
| [`GET /v1/trips/{id}/offer-link`](#get-trips-id-offer-link) | `trips:assign` |
| [`POST /v1/trips/{id}/offer-link`](#post-trips-id-offer-link) | `trips:assign` |
| [`GET /v1/trips/{id}/offers`](#get-trips-id-offers) | `trips:read` |
| [`POST /v1/trips/{id}/sheet`](#post-trips-id-sheet) | `trips:read` |
| [`POST /v1/trips/{id}/sheet/driver-link`](#post-trips-id-sheet-driver-link) | `trips:dispatch` |
| [`POST /v1/trips/{id}/sheet/driver-link/revoke`](#post-trips-id-sheet-driver-link-revoke) | `trips:dispatch` |
| [`POST /v1/trip-sheets`](#post-trip-sheets) | `trips:read` |

## ตัวนับเที่ยวของ dashboard ปฏิบัติการ {#get-trips-summary}

`GET /v1/trips/summary`

scope: `trips:read` · operationId: `Trips_summary`

นับด้วยตัวกรองชุดเดียวกับ `GET /trips` — `running` = `?status=IN_PROGRESS`, `offered` = `?status=OFFERED`

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `TripSummaryDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/trips/summary" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/trips/summary');
```

## GET /v1/trips {#get-trips}

`GET /v1/trips`

scope: `trips:read` · operationId: `Trips_list`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน |
| `updatedAfter` | query |   | `string` | คืนเฉพาะแถวที่ updatedAt > ค่านี้ (incremental pull) |
| `sort` | query |   | `string` ค่า: `updatedAt`, `-updatedAt` |   |
| `fields` | query |   | `string` | รายชื่อ field คั่นด้วย , เช่น id,legalName |
| `status` | query |   | `string` | สถานะ คั่นด้วย , (PLANNING / OFFERED / ASSIGNED / DISPATCHED / IN_PROGRESS / COMPLETED / COSTED / SETTLED / CANCELLED) |
| `dateFrom` | query |   | `string` | วันที่เที่ยวตั้งแต่ (YYYY-MM-DD) |
| `dateTo` | query |   | `string` | วันที่เที่ยวถึง (YYYY-MM-DD) |
| `vehicleId` | query |   | `string` |   |
| `driverId` | query |   | `string` | คนขับหลักหรือคนขับสำรอง |
| `carrierId` | query |   | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `TripPageDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/trips" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/trips');
```

## POST /v1/trips {#post-trips}

`POST /v1/trips`

scope: `trips:assign` · operationId: `Trips_create`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `Idempotency-Key` | header |   | `string` |   |

**Request body** `CreateTripDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `deliveryOrderIds` | ใช่ | `array<string>` |   | ใบส่งของ (DRAFT ไม่อยู่ในเที่ยวอื่น) | `["do_3f2a…"]` |
| `ruleKeys` |   | `array<string>` | ≤ 50 รายการ | กุญแจของกฎที่ค้างที่ผู้ใช้ยกเว้น/ยืนยัน (`warnings[].key` หรือ `blocks[].key`/`warnings[].key` ของ 409) — มีผลเฉพาะกฎเหล่านี้ · กุญแจที่ไม่ค้างแล้ว → 422 `not_pending` · บล็อกต้องมี scope `trips:override` · ต้องมี `overrideReason` | `["OVERWEIGHT\|v=…"]` |
| `overrideReason` |   | `string` | ยาว ≤ 500 · ยาว ≥ 10 · null ได้ | เหตุผล ≥ 10 ตัวอักษร (บันทึกใน audit) | `ลูกค้ายืนยันรับของเกินพิกัด แยกส่งรอบบ่ายไม่ได้` |
| `tripDate` | ใช่ | `string` |   | วันที่เที่ยว (YYYY-MM-DD) | `2026-11-13` |
| `plannedStartAt` |   | `string` | null ได้ | เริ่มวิ่งตามแผน | `2026-11-13T08:00:00+07:00` |
| `plannedEndAt` |   | `string` | null ได้ | จบตามแผน (≥ เริ่ม) | `2026-11-13T17:00:00+07:00` |
| `vehicleId` |   | `string` | null ได้ | รถที่วางแผนไว้ (กระดานวางแผน — ลาก SO ลงแถวรถ) · เที่ยวยังเป็น PLANNING ไม่มีคนขับ — จัดรถจริงที่ /assign | `veh_3f2a…` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `201` |   | `TripDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:assign`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress), [delivery_order_on_trip](errors.md#delivery_order_on_trip), [order_not_ready_for_delivery](errors.md#order_not_ready_for_delivery), [assignment_blocked](errors.md#assignment_blocked) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/trips" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"deliveryOrderIds":["do_3f2a…"],"ruleKeys":["OVERWEIGHT|v=…"],"tripDate":"2026-11-13"}'
```

```ts
const { data, error } = await tms.POST('/v1/trips', {
  body: {
    "deliveryOrderIds": [
      "do_3f2a…"
    ],
    "ruleKeys": [
      "OVERWEIGHT|v=…"
    ],
    "tripDate": "2026-11-13"
  },
});
```

## จัดรถ / จัดรถและปล่อยเที่ยว หลายเที่ยว {#post-trips-bulk-assign}

`POST /v1/trips/bulk-assign`

scope: `trips:assign` · operationId: `Trips_bulkAssign`

≤ 50 เที่ยว ทำทีละรายการแยกกัน (สำเร็จบางรายการได้) · PLANNING: จัดรถด้วยรถที่วางไว้ + คนขับประจำรถ · ASSIGNED: `dispatch` = ปล่อยรถ, ไม่ dispatch = ไม่เปลี่ยน · สถานะอื่น = 409 · ตอบ 207 เสมอเมื่อคำขอถูกต้อง — ดู `results[].status` / `problem` · `dispatch: true` ต้องมี `trips:dispatch`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `Idempotency-Key` | header |   | `string` |   |

**Request body** `BulkAssignTripsDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `items` | ใช่ | `array<BulkTripItemDto>` | ≤ 50 รายการ |   |   |
| `items[].tripId` | ใช่ | `string` |   |   | `trp_3f2a…` |
| `items[].version` |   | `number` |   | `version` ที่ผู้ใช้เห็น (แทน If-Match ต่อรายการ) — ไม่ตรง → รายการนั้น 412 | `3` |
| `items[].ruleKeys` |   | `array<string>` | ≤ 50 รายการ | กุญแจกฎที่ยกเว้น/ยืนยันของเที่ยวนี้ (ใช้ `overrideReason` ของคำขอ) |   |
| `dispatch` |   | `boolean` |   | true = จัดรถและปล่อยเที่ยว (เที่ยวที่จัดรถแล้ว = ปล่อยอย่างเดียว) — ต้องมี scope `trips:dispatch` เพิ่ม |   |
| `overrideReason` |   | `string` | ยาว ≤ 500 · ยาว ≥ 10 · null ได้ | เหตุผลการยกเว้น/ยืนยันกฎ (≥ 10 ตัวอักษร) — ใช้กับทุกรายการที่ส่ง `ruleKeys` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `207` | ผลต่อรายการ | `BulkTripResultsDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:assign`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/trips/bulk-assign" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"items":[{"tripId":"trp_3f2a…","version":3}]}'
```

```ts
const { data, error } = await tms.POST('/v1/trips/bulk-assign', {
  body: {
    "items": [
      {
        "tripId": "trp_3f2a…",
        "version": 3
      }
    ]
  },
});
```

## ส่งแผนทั้งวัน (ปล่อยทุกเที่ยวของวัน) {#post-trips-send-all}

`POST /v1/trips/send-all`

scope: `trips:dispatch` · operationId: `Trips_sendAll`

ไม่ส่ง `items` = ทุกเที่ยว PLANNING/OFFERED/ASSIGNED ของวันนั้น (≤ 400) · ส่ง `items` = เฉพาะที่เลือก (ต้องเป็นเที่ยวของวันนั้น) · แต่ละเที่ยวทำแยกกันเหมือน `bulk-assign` + `dispatch: true` (ติดกฎ/ไม่มีรถ/รอรถร่วมตอบ = ไม่ผ่านพร้อม `problem`) · เที่ยวที่ส่งแล้ว = `UNCHANGED` · `dryRun` = ตรวจล่วงหน้าไม่เปลี่ยนข้อมูล · ตอบ 207 พร้อม `day` (ส่งครบ = มีเที่ยวและทุกเที่ยวปล่อยรถแล้ว) · ต้องมี `trips:dispatch` + `trips:assign` · audit `trip.sent_all`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `Idempotency-Key` | header |   | `string` |   |

**Request body** `SendAllTripsDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `date` | ใช่ | `string` |   | วันเที่ยว (เวลาไทย) | `2026-11-18` |
| `items` |   | `array<BulkTripItemDto>` | ≤ 400 รายการ | เฉพาะเที่ยวที่ติ๊ก (+ `version` ที่เห็น) — ไม่ส่ง = ทุกเที่ยวของวันที่ยังไม่ส่ง (PLANNING/OFFERED/ASSIGNED ณ ตอนทำ) |   |
| `items[].tripId` | ใช่ | `string` |   |   | `trp_3f2a…` |
| `items[].version` |   | `number` |   | `version` ที่ผู้ใช้เห็น (แทน If-Match ต่อรายการ) — ไม่ตรง → รายการนั้น 412 | `3` |
| `items[].ruleKeys` |   | `array<string>` | ≤ 50 รายการ | กุญแจกฎที่ยกเว้น/ยืนยันของเที่ยวนี้ (ใช้ `overrideReason` ของคำขอ) |   |
| `overrideReason` |   | `string` | ยาว ≤ 500 · ยาว ≥ 10 · null ได้ | เหตุผลการยกเว้น/ยืนยันกฎ (≥ 10 ตัวอักษร) — ใช้กับทุกรายการที่ส่ง `ruleKeys` |   |
| `dryRun` |   | `boolean` |   | true = ตรวจล่วงหน้า: ประเมินทุกขั้นเหมือนส่งจริง (กฎ T14 ตอนปล่อยรถ) แล้วย้อนทั้งหมด — ไม่เปลี่ยนข้อมูล ไม่ลง audit/event · `outcome` = ผลที่คาดว่าจะได้ · `day` = สถานะปัจจุบัน |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `207` | ผลต่อรายการ + สถานะของวัน | `SendAllTripsResultDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:dispatch`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/trips/send-all" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"date":"2026-11-18"}'
```

```ts
const { data, error } = await tms.POST('/v1/trips/send-all', {
  body: {
    "date": "2026-11-18"
  },
});
```

## GET /v1/trips/{id} {#get-trips-id}

`GET /v1/trips/{id}`

scope: `trips:read` · operationId: `Trips_get`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `TripDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบเที่ยว (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/trips/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/trips/{id}', {
  params: { path: { id: "…" } },
});
```

## POST /v1/trips/{id}/schedule {#post-trips-id-schedule}

`POST /v1/trips/{id}/schedule`

scope: `trips:assign` · operationId: `Trips_schedule`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `Idempotency-Key` | header |   | `string` |   |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `ScheduleTripDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `ruleKeys` |   | `array<string>` | ≤ 50 รายการ | กุญแจของกฎที่ค้างที่ผู้ใช้ยกเว้น/ยืนยัน (`warnings[].key` หรือ `blocks[].key`/`warnings[].key` ของ 409) — มีผลเฉพาะกฎเหล่านี้ · กุญแจที่ไม่ค้างแล้ว → 422 `not_pending` · บล็อกต้องมี scope `trips:override` · ต้องมี `overrideReason` | `["OVERWEIGHT\|v=…"]` |
| `overrideReason` |   | `string` | ยาว ≤ 500 · ยาว ≥ 10 · null ได้ | เหตุผล ≥ 10 ตัวอักษร (บันทึกใน audit) | `ลูกค้ายืนยันรับของเกินพิกัด แยกส่งรอบบ่ายไม่ได้` |
| `tripDate` |   | `string` |   | วันที่เที่ยว (YYYY-MM-DD) | `2026-11-13` |
| `plannedStartAt` |   | `string` | null ได้ |   | `2026-11-13T08:00:00+07:00` |
| `plannedEndAt` |   | `string` | null ได้ |   | `2026-11-13T11:00:00+07:00` |
| `vehicleId` |   | `string` | null ได้ | ย้ายไปรถคันอื่น (เฉพาะ PLANNING — ASSIGNED ใช้ /assign) · null = ถอดรถที่วางไว้ | `veh_3f2a…` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `TripDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:assign`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบเที่ยว (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress), [assignment_blocked](errors.md#assignment_blocked) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/trips/<id>/schedule" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"ruleKeys":["OVERWEIGHT|v=…"],"tripDate":"2026-11-13"}'
```

```ts
const { data, error } = await tms.POST('/v1/trips/{id}/schedule', {
  params: { path: { id: "…" } },
  body: {
    "ruleKeys": [
      "OVERWEIGHT|v=…"
    ],
    "tripDate": "2026-11-13"
  },
});
```

## เพิ่มใบส่งของเข้าเที่ยว {#post-trips-id-attach}

`POST /v1/trips/{id}/attach`

scope: `trips:assign` · operationId: `Trips_attach`

กฎตอนจัด (ST3-T14) **ไม่บังคับตอนเพิ่ม/ถอด DO** — ตรวจใหม่และเก็บใน `warnings` (กระดานแสดงเป็นค้างยกเว้น/ยืนยัน) แล้วบังคับอีกครั้งตอน `/dispatch` (บล็อกค้าง → 409 `assignment_blocked`, คำเตือนค้าง → 409 `assignment_warnings`) · น้ำหนักที่เพิ่มขึ้นทำให้การยืนยัน "น้ำหนักเกิน" เดิมหมดผล

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `Idempotency-Key` | header |   | `string` |   |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `AttachDeliveryOrdersDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `deliveryOrderIds` | ใช่ | `array<string>` |   | ใบส่งของ (DRAFT ไม่อยู่ในเที่ยวอื่น) | `["do_3f2a…"]` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `TripDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:assign`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบเที่ยว (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress), [delivery_order_on_trip](errors.md#delivery_order_on_trip), [order_not_ready_for_delivery](errors.md#order_not_ready_for_delivery) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/trips/<id>/attach" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"deliveryOrderIds":["do_3f2a…"]}'
```

```ts
const { data, error } = await tms.POST('/v1/trips/{id}/attach', {
  params: { path: { id: "…" } },
  body: {
    "deliveryOrderIds": [
      "do_3f2a…"
    ]
  },
});
```

## POST /v1/trips/{id}/detach {#post-trips-id-detach}

`POST /v1/trips/{id}/detach`

scope: `trips:assign` · operationId: `Trips_detach`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `Idempotency-Key` | header |   | `string` |   |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `DetachDeliveryOrdersDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `deliveryOrderIds` | ใช่ | `array<string>` |   | ใบส่งของ (DRAFT ไม่อยู่ในเที่ยวอื่น) | `["do_3f2a…"]` |
| `note` |   | `string` | ยาว ≤ 500 · null ได้ |   | `ย้ายไปรถคันอื่น` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `TripDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:assign`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบเที่ยว (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress), [trip_has_loaded_orders](errors.md#trip_has_loaded_orders) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/trips/<id>/detach" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"deliveryOrderIds":["do_3f2a…"]}'
```

```ts
const { data, error } = await tms.POST('/v1/trips/{id}/detach', {
  params: { path: { id: "…" } },
  body: {
    "deliveryOrderIds": [
      "do_3f2a…"
    ]
  },
});
```

## เรียงลำดับจุดแวะของเที่ยว {#post-trips-id-reorder-stops}

`POST /v1/trips/{id}/reorder-stops`

scope: `trips:assign` · operationId: `Trips_reorderStops`

ส่ง id ของจุดแวะทุกจุดตามลำดับใหม่ · ลำดับเท่าเดิม = ไม่เปลี่ยน version · จุดส่งก่อนจุดรับของใบส่งของเดียวกัน → 422 `stop_order_invalid` พร้อม `violations[]` · ระยะ/เวลา: route master ก่อน ไม่มี → ค่าประมาณจากพิกัด (เส้นตรง × 1.3, 50 กม./ชม.) ไม่มีทั้งคู่ = ไม่ทราบ

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `Idempotency-Key` | header |   | `string` |   |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `ReorderStopsDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `stopIds` | ใช่ | `array<string>` |   | จุดแวะทุกจุดของเที่ยว (`stops[].id`) ตามลำดับใหม่ — ขาด/เกิน/ซ้ำ → 422 `stop_set_mismatch` · จุดส่งของใบส่งของอยู่ก่อนจุดรับของใบเดียวกัน → 422 `stop_order_invalid` | `["stp_3f2a…","stp_8c1d…","stp_77b0…"]` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `TripDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:assign`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบเที่ยว (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch), [stop_order_invalid](errors.md#stop_order_invalid) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/trips/<id>/reorder-stops" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"stopIds":["stp_3f2a…","stp_8c1d…","stp_77b0…"]}'
```

```ts
const { data, error } = await tms.POST('/v1/trips/{id}/reorder-stops', {
  params: { path: { id: "…" } },
  body: {
    "stopIds": [
      "stp_3f2a…",
      "stp_8c1d…",
      "stp_77b0…"
    ]
  },
});
```

## จัดรถ / จัดรถและปล่อยเที่ยว {#post-trips-id-assign}

`POST /v1/trips/{id}/assign`

scope: `trips:assign` · operationId: `Trips_assign`

PLANNING → ASSIGNED (รถบริษัท) · ASSIGNED → ASSIGNED (เปลี่ยนรถ/คนขับก่อนปล่อยรถ — docs/01 §4.2) · OFFERED → ASSIGNED (รถร่วมรับงาน) · `dispatch: true` → ปล่อยรถต่อทันที (atomic; ต้องมี `trips:dispatch`; คำเตือนที่ยังไม่ยืนยัน → 409 `assignment_warnings`)

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `Idempotency-Key` | header |   | `string` |   |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `AssignTripDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `ruleKeys` |   | `array<string>` | ≤ 50 รายการ | กุญแจของกฎที่ค้างที่ผู้ใช้ยกเว้น/ยืนยัน (`warnings[].key` หรือ `blocks[].key`/`warnings[].key` ของ 409) — มีผลเฉพาะกฎเหล่านี้ · กุญแจที่ไม่ค้างแล้ว → 422 `not_pending` · บล็อกต้องมี scope `trips:override` · ต้องมี `overrideReason` | `["OVERWEIGHT\|v=…"]` |
| `overrideReason` |   | `string` | ยาว ≤ 500 · ยาว ≥ 10 · null ได้ | เหตุผล ≥ 10 ตัวอักษร (บันทึกใน audit) | `ลูกค้ายืนยันรับของเกินพิกัด แยกส่งรอบบ่ายไม่ได้` |
| `vehicleId` | ใช่ | `string` |   | รถหลัก (ไม่ใช่หาง) | `veh_3f2a…` |
| `driverId` |   | `string` | null ได้ | คนขับ — ไม่ส่ง = คนขับประจำของรถ (มีคนเดียว) · รถบริษัทต้องมีคนขับ | `drv_3f2a…` |
| `reliefDriverId` |   | `string` | null ได้ | คนขับสำรอง (งานทางไกล) | `drv_3f2a…` |
| `trailerId` |   | `string` | null ได้ | หาง (รถที่ unitRole = TRAILER) | `veh_3f2a…` |
| `dispatch` |   | `boolean` |   | ST3-T17 "จัดรถและปล่อยเที่ยว" (docs/04 D2 Assign & dispatch) — จัดรถแล้วปล่อยรถในคำขอเดียว (atomic: ปล่อยไม่ได้ = ไม่จัดรถด้วย) · ต้องมี scope `trips:dispatch` เพิ่ม · ตรวจกฎแบบตอนปล่อยรถ: คำเตือนที่ยังไม่ยืนยัน → 409 `assignment_warnings` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `TripDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:assign`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบเที่ยว (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress), [trip_empty](errors.md#trip_empty), [offer_required](errors.md#offer_required), [carrier_change_requires_cancel](errors.md#carrier_change_requires_cancel), [assignment_blocked](errors.md#assignment_blocked), [assignment_warnings](errors.md#assignment_warnings) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/trips/<id>/assign" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"ruleKeys":["OVERWEIGHT|v=…"],"vehicleId":"veh_3f2a…"}'
```

```ts
const { data, error } = await tms.POST('/v1/trips/{id}/assign', {
  params: { path: { id: "…" } },
  body: {
    "ruleKeys": [
      "OVERWEIGHT|v=…"
    ],
    "vehicleId": "veh_3f2a…"
  },
});
```

## GET /v1/trips/{id}/hire-options {#get-trips-id-hire-options}

`GET /v1/trips/{id}/hire-options`

scope: `trips:assign` · operationId: `Trips_hireOptions`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `vehicleTypeId` | query |   | `string` | ประเภทรถที่จะจ้าง (ใช้หา rate card ขาซื้อ) — ไม่ส่ง = ตามเที่ยว/ใบสั่งขาย |
| `change` | query |   | `string` ค่า: `true`, `false` | ST3-T25 ตัวเลือกสำหรับเปลี่ยนผู้รับเหมา: `true` = ไม่รวมผู้รับเหมาของการจ้างที่ใช้งานอยู่ (เลือกซ้ำไม่ได้ · ไม่นับเป็นถูกสุด) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `HireOptionsDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`prices.buy:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบเที่ยว (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/trips/<id>/hire-options" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/trips/{id}/hire-options', {
  params: { path: { id: "…" } },
});
```

## POST /v1/trips/{id}/offer {#post-trips-id-offer}

`POST /v1/trips/{id}/offer`

scope: `trips:assign` · operationId: `Trips_offer`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `Idempotency-Key` | header |   | `string` |   |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `OfferTripDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `carrierId` | ใช่ | `string` |   | รถร่วมที่จ้าง (ลิงก์รับงาน = ST3-T23) | `car_3f2a…` |
| `cost` |   | `string` | null ได้ | ราคาซื้อที่ตกลงต่อเที่ยว (บาท ก่อน VAT ก่อนหัก ณ ที่จ่าย, > 0, ทศนิยม ≤ 2) — ไม่ส่ง = ราคาตาม rate card ขาซื้อของรายนี้ (ไม่มี rate card → 422 `cost_required`) | `6800.00` |
| `selectionReason` |   | `string` | ยาว ≤ 500 · ยาว ≥ 10 · null ได้ | เหตุผลที่เลือกรายนี้ — **บังคับ (≥ 10 ตัวอักษร)** เมื่อราคาที่จ้างสูงกว่ารายที่ถูกสุด หรือไม่มีราคาจาก rate card ให้เทียบ (422 `selection_reason_required`) · เลือกรายที่ถูกสุด = ระบบเขียนเหตุผลให้ | `รายที่ถูกกว่ารถไม่ว่างช่วงเช้า ลูกค้าต้องการรถเข้าก่อน 8 โมง` |
| `vehicleTypeId` |   | `string` | null ได้ | ประเภทรถที่จ้าง (ใช้หา rate card ขาซื้อ) — ไม่ส่ง = ตามเที่ยว/ใบสั่งขาย | `vty_3f2a…` |
| `replaceOffer` |   | `boolean` |   | ST3-T24 "ส่งรายถัดไป" ระหว่างรอตอบ: true = ปิดการจ้างที่รอตอบซึ่งครบเวลาตอบ N ชม. แล้ว (WITHDRAWN — ลิงก์เดิมใช้ไม่ได้, ค่าจ้างเดิมกลับรายการ) แล้วจ้างรายนี้ในคำขอเดียว · ยังไม่ครบเวลา → 409 `offer_not_timed_out` · ไม่ส่ง = เที่ยวต้องเป็น PLANNING |   |
| `replaceNote` |   | `string` | ยาว ≤ 500 · null ได้ | ST3-T24 หมายเหตุการถอนรายเดิมเมื่อ `replaceOffer` (ไม่บังคับ) — ต่อท้ายเหตุผลระบบ "… ไม่ตอบรับใน N ชม. — ส่งรายถัดไป" | `โทรตามแล้วไม่รับสาย` |
| `changeReason` |   | `string` | ยาว ≤ 500 · ยาว ≥ 10 · null ได้ | ST3-T25 เปลี่ยนผู้รับเหมา (docs/04 D3): ส่งค่านี้ = ยกเลิกการจ้างที่ใช้งานอยู่แล้วจ้างรายนี้ในคำขอเดียว — รอตอบ (OFFERED) ได้ทุกเวลา, รับงานแล้ว (ASSIGNED) ได้ก่อนปล่อยรถ · การจ้างเดิม → WITHDRAWN (ประวัติคงอยู่ — `GET /trips/{id}/offers`), ลิงก์เดิมใช้ไม่ได้, ค่าจ้างที่ยังไม่จ่ายกลับรายการ, รถ/คนขับของรายเดิมถูกล้าง · เหตุผล ≥ 10 ตัวอักษร (422 `changeReason`) · รายเดิม → 422 `same_carrier` · ปล่อยรถแล้ว/ไม่มีการจ้าง → 409 `carrier_change_not_allowed` | `รถของผู้รับเหมาเดิมเสียกลางทางก่อนเข้ารับสินค้า` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `TripDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:assign`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบเที่ยว (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress), [trip_empty](errors.md#trip_empty), [offer_closed](errors.md#offer_closed), [offer_not_timed_out](errors.md#offer_not_timed_out), [carrier_change_not_allowed](errors.md#carrier_change_not_allowed) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/trips/<id>/offer" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"carrierId":"car_3f2a…"}'
```

```ts
const { data, error } = await tms.POST('/v1/trips/{id}/offer', {
  params: { path: { id: "…" } },
  body: {
    "carrierId": "car_3f2a…"
  },
});
```

## POST /v1/trips/{id}/dispatch {#post-trips-id-dispatch}

`POST /v1/trips/{id}/dispatch`

scope: `trips:dispatch` · operationId: `Trips_dispatch`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `Idempotency-Key` | header |   | `string` |   |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `DispatchTripDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `ruleKeys` |   | `array<string>` | ≤ 50 รายการ | กุญแจของกฎที่ค้างที่ผู้ใช้ยกเว้น/ยืนยัน (`warnings[].key` หรือ `blocks[].key`/`warnings[].key` ของ 409) — มีผลเฉพาะกฎเหล่านี้ · กุญแจที่ไม่ค้างแล้ว → 422 `not_pending` · บล็อกต้องมี scope `trips:override` · ต้องมี `overrideReason` | `["OVERWEIGHT\|v=…"]` |
| `overrideReason` |   | `string` | ยาว ≤ 500 · ยาว ≥ 10 · null ได้ | เหตุผล ≥ 10 ตัวอักษร (บันทึกใน audit) | `ลูกค้ายืนยันรับของเกินพิกัด แยกส่งรอบบ่ายไม่ได้` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `TripDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:dispatch`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบเที่ยว (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress), [trip_empty](errors.md#trip_empty), [assignment_blocked](errors.md#assignment_blocked), [assignment_warnings](errors.md#assignment_warnings) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/trips/<id>/dispatch" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"ruleKeys":["OVERWEIGHT|v=…"]}'
```

```ts
const { data, error } = await tms.POST('/v1/trips/{id}/dispatch', {
  params: { path: { id: "…" } },
  body: {
    "ruleKeys": [
      "OVERWEIGHT|v=…"
    ]
  },
});
```

## POST /v1/trips/{id}/confirm-rules {#post-trips-id-confirm-rules}

`POST /v1/trips/{id}/confirm-rules`

scope: `trips:assign` · operationId: `Trips_confirmRules`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `Idempotency-Key` | header |   | `string` |   |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `ConfirmRulesDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `ruleKeys` | ใช่ | `array<string>` | ≤ 50 รายการ | กุญแจของกฎที่ค้าง (`warnings[].key`) — บล็อกต้องมี scope `trips:override` |   |
| `overrideReason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 | เหตุผล ≥ 10 ตัวอักษร (บันทึกใน audit) | `ลูกค้ายืนยันรับของเกินพิกัด แยกส่งรอบบ่ายไม่ได้` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `TripDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:assign`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบเที่ยว (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress), [assignment_blocked](errors.md#assignment_blocked) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/trips/<id>/confirm-rules" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"ruleKeys":["string"],"overrideReason":"ลูกค้ายืนยันรับของเกินพิกัด แยกส่งรอบบ่ายไม่ได้"}'
```

```ts
const { data, error } = await tms.POST('/v1/trips/{id}/confirm-rules', {
  params: { path: { id: "…" } },
  body: {
    "ruleKeys": [
      "string"
    ],
    "overrideReason": "ลูกค้ายืนยันรับของเกินพิกัด แยกส่งรอบบ่ายไม่ได้"
  },
});
```

## POST /v1/trips/{id}/complete {#post-trips-id-complete}

`POST /v1/trips/{id}/complete`

scope: `trips:close` · operationId: `Trips_complete`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `Idempotency-Key` | header |   | `string` |   |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `TripDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:close`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบเที่ยว (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress), [trip_stops_open](errors.md#trip_stops_open) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/trips/<id>/complete" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)"
```

```ts
const { data, error } = await tms.POST('/v1/trips/{id}/complete', {
  params: { path: { id: "…" } },
});
```

## POST /v1/trips/{id}/cancel {#post-trips-id-cancel}

`POST /v1/trips/{id}/cancel`

scope: `trips:assign` · operationId: `Trips_cancel`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `Idempotency-Key` | header |   | `string` |   |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `CancelTripDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `ลูกค้ายกเลิกการส่งทั้งเที่ยว` |
| `reasonCodeId` |   | `string` | null ได้ | เหตุผลมาตรฐานหมวด CANCEL | `rsn_3f2a…` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `TripDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:assign`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบเที่ยว (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress), [trip_has_loaded_orders](errors.md#trip_has_loaded_orders) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/trips/<id>/cancel" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"ลูกค้ายกเลิกการส่งทั้งเที่ยว"}'
```

```ts
const { data, error } = await tms.POST('/v1/trips/{id}/cancel', {
  params: { path: { id: "…" } },
  body: {
    "reason": "ลูกค้ายกเลิกการส่งทั้งเที่ยว"
  },
});
```

## GET /v1/trips/{id}/field-charges {#get-trips-id-field-charges}

`GET /v1/trips/{id}/field-charges`

scope: `trips:read` · operationId: `TripFieldCharges_list`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `FieldChargeListDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบเที่ยว (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/trips/<id>/field-charges" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/trips/{id}/field-charges', {
  params: { path: { id: "…" } },
});
```

## บันทึกค่าใช้จ่ายหน้างาน (ฝั่งขาย/ซื้อ/ทั้งคู่) — รอผู้วางบิลยืนยัน {#post-trips-id-field-charges}

`POST /v1/trips/{id}/field-charges`

scope: `trips:read` · operationId: `TripFieldCharges_create`

เที่ยวต้องปล่อยรถแล้ว (DISPATCHED / IN_PROGRESS / COMPLETED) · ฝั่งขายต้องระบุ DO ในเที่ยว · ธงภาษี (vatType, whtRate) คัดลอกจากรายการบริการ ณ เวลาบันทึก · ฝั่งซื้อไม่คำนวณ VAT (รอนักบัญชี)

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Request body** `CreateFieldChargeDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `side` | ใช่ | `string` | ค่า: `SELL`, `BUY`, `BOTH` | SELL = เก็บเงินลูกค้า (บรรทัดเพิ่มในใบแจ้งหนี้ของ DO) · BUY = ต้นทุนเที่ยว (จ่ายรถร่วม/คนขับ) · BOTH = ทั้งสองฝั่ง ใช้รูปหลักฐานเดียวกัน |   |
| `serviceItemId` | ใช่ | `string` |   | รายการบริการ (ค่าบริการเสริม `isSurcharge` ที่ใช้งานอยู่ ฝั่งตรงกับบรรทัด — ไม่รับหน่วย % ของค่าขนส่ง) | `svc_…` |
| `deliveryOrderId` |   | `string` |   | ใบส่งของในเที่ยวนี้ — บังคับเมื่อ side = SELL/BOTH | `do_…` |
| `qty` |   | `string` |   | จำนวน (ทศนิยม ≤ 3 ตำแหน่ง, > 0) ของฝั่งขาย — ไม่ส่ง = 1 | `1` |
| `sellUnitPrice` |   | `string` |   | ราคาขายต่อหน่วยก่อน VAT (บาท) — บังคับเมื่อ side = SELL/BOTH · ต้องมีสิทธิ์ `prices.sell:write` (เห็นเมื่อมี `prices.sell:read`) | `500.00` |
| `costAmount` |   | `string` |   | ยอดต้นทุนฝั่งซื้อ (บาท ตามใบเสร็จ) — บังคับเมื่อ side = BUY/BOTH · ต้องมีสิทธิ์ `prices.buy:write` หรือ `trips:dispatch` + `prices.buy:read` (ผู้จ่ายงานบันทึกหน้างาน — ยืนยันโดยผู้อื่น) · ตอบกลับเป็น `buyAmount` | `180.00` |
| `evidenceDocumentId` |   | `string` |   | รูป/ไฟล์ใบเสร็จ (บังคับ — spec M15) จาก POST /v1/documents (kind RECEIPT, อัปโหลดเสร็จแล้ว, ยังไม่ผูกกับรายการอื่น) · ไม่ส่ง → 422 `evidence_required` | `doc_…` |
| `note` |   | `string` | ยาว ≤ 500 |   | `รอคิวลงสินค้า 3 ชม.` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `201` | บรรทัดที่สร้าง (1–2 บรรทัด) | `FieldChargeListDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`prices.sell:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบเที่ยว (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/trips/<id>/field-charges" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"side":"SELL","serviceItemId":"svc_…","deliveryOrderId":"do_…","qty":"1","sellUnitPrice":"500.00","costAmount":"180.00","evidenceDocumentId":"doc_…","note":"รอคิวลงสินค้า 3 ชม."}'
```

```ts
const { data, error } = await tms.POST('/v1/trips/{id}/field-charges', {
  params: { path: { id: "…" } },
  body: {
    "side": "SELL",
    "serviceItemId": "svc_…",
    "deliveryOrderId": "do_…",
    "qty": "1",
    "sellUnitPrice": "500.00",
    "costAmount": "180.00",
    "evidenceDocumentId": "doc_…",
    "note": "รอคิวลงสินค้า 3 ชม."
  },
});
```

## ยืนยันค่าใช้จ่ายหน้างานฝั่งขาย (ผู้วางบิล · ผู้บันทึกเองไม่ได้) — เหตุผล ≥ 10 ตัวอักษร {#post-do-surcharges-id-confirm}

`POST /v1/do-surcharges/{id}/confirm`

scope: `invoices:draft` · operationId: `DoSurcharges_confirm`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag (version) — ไม่ตรง → 412 |

**Request body** `FieldChargeReasonDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `ตรวจใบเสร็จแล้ว ตรงกับที่ตกลงกับลูกค้า` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `FieldChargeDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:draft`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบเที่ยว (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/do-surcharges/<id>/confirm" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"ตรวจใบเสร็จแล้ว ตรงกับที่ตกลงกับลูกค้า"}'
```

```ts
const { data, error } = await tms.POST('/v1/do-surcharges/{id}/confirm', {
  params: { path: { id: "…" } },
  body: {
    "reason": "ตรวจใบเสร็จแล้ว ตรงกับที่ตกลงกับลูกค้า"
  },
});
```

## ปฏิเสธค่าใช้จ่ายหน้างานฝั่งขาย (ผู้วางบิล · ผู้บันทึกเองไม่ได้) — เหตุผล ≥ 10 ตัวอักษร {#post-do-surcharges-id-reject}

`POST /v1/do-surcharges/{id}/reject`

scope: `invoices:draft` · operationId: `DoSurcharges_reject`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag (version) — ไม่ตรง → 412 |

**Request body** `FieldChargeReasonDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `ตรวจใบเสร็จแล้ว ตรงกับที่ตกลงกับลูกค้า` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `FieldChargeDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:draft`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบเที่ยว (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/do-surcharges/<id>/reject" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"ตรวจใบเสร็จแล้ว ตรงกับที่ตกลงกับลูกค้า"}'
```

```ts
const { data, error } = await tms.POST('/v1/do-surcharges/{id}/reject', {
  params: { path: { id: "…" } },
  body: {
    "reason": "ตรวจใบเสร็จแล้ว ตรงกับที่ตกลงกับลูกค้า"
  },
});
```

## ยกเลิกค่าใช้จ่ายหน้างานฝั่งขายที่ยังรอยืนยัน — เหตุผล ≥ 10 ตัวอักษร {#post-do-surcharges-id-cancel}

`POST /v1/do-surcharges/{id}/cancel`

scope: `prices.sell:write` · operationId: `DoSurcharges_cancel`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag (version) — ไม่ตรง → 412 |

**Request body** `FieldChargeReasonDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `ตรวจใบเสร็จแล้ว ตรงกับที่ตกลงกับลูกค้า` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `FieldChargeDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`prices.sell:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบเที่ยว (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/do-surcharges/<id>/cancel" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"ตรวจใบเสร็จแล้ว ตรงกับที่ตกลงกับลูกค้า"}'
```

```ts
const { data, error } = await tms.POST('/v1/do-surcharges/{id}/cancel', {
  params: { path: { id: "…" } },
  body: {
    "reason": "ตรวจใบเสร็จแล้ว ตรงกับที่ตกลงกับลูกค้า"
  },
});
```

## ยืนยันค่าใช้จ่ายหน้างานฝั่งซื้อ (ผู้อนุมัติ settlement — `settlements:approve` · ผู้บันทึกเองไม่ได้) — เหตุผล ≥ 10 ตัวอักษร {#post-trip-costs-id-confirm}

`POST /v1/trip-costs/{id}/confirm`

scope: `settlements:approve` · operationId: `TripCosts_confirm`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag (version) — ไม่ตรง → 412 |

**Request body** `FieldChargeReasonDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `ตรวจใบเสร็จแล้ว ตรงกับที่ตกลงกับลูกค้า` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `FieldChargeDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settlements:approve`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบเที่ยว (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/trip-costs/<id>/confirm" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"ตรวจใบเสร็จแล้ว ตรงกับที่ตกลงกับลูกค้า"}'
```

```ts
const { data, error } = await tms.POST('/v1/trip-costs/{id}/confirm', {
  params: { path: { id: "…" } },
  body: {
    "reason": "ตรวจใบเสร็จแล้ว ตรงกับที่ตกลงกับลูกค้า"
  },
});
```

## ปฏิเสธค่าใช้จ่ายหน้างานฝั่งซื้อ (ผู้อนุมัติ settlement — `settlements:approve` · ผู้บันทึกเองไม่ได้) — เหตุผล ≥ 10 ตัวอักษร {#post-trip-costs-id-reject}

`POST /v1/trip-costs/{id}/reject`

scope: `settlements:approve` · operationId: `TripCosts_reject`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag (version) — ไม่ตรง → 412 |

**Request body** `FieldChargeReasonDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `ตรวจใบเสร็จแล้ว ตรงกับที่ตกลงกับลูกค้า` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `FieldChargeDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settlements:approve`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบเที่ยว (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/trip-costs/<id>/reject" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"ตรวจใบเสร็จแล้ว ตรงกับที่ตกลงกับลูกค้า"}'
```

```ts
const { data, error } = await tms.POST('/v1/trip-costs/{id}/reject', {
  params: { path: { id: "…" } },
  body: {
    "reason": "ตรวจใบเสร็จแล้ว ตรงกับที่ตกลงกับลูกค้า"
  },
});
```

## ยกเลิกค่าใช้จ่ายหน้างานฝั่งซื้อที่ยังรอยืนยัน — เหตุผล ≥ 10 ตัวอักษร {#post-trip-costs-id-cancel}

`POST /v1/trip-costs/{id}/cancel`

scope: `prices.buy:write` หรือ `trips:dispatch` · operationId: `TripCosts_cancel`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag (version) — ไม่ตรง → 412 |

**Request body** `FieldChargeReasonDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `ตรวจใบเสร็จแล้ว ตรงกับที่ตกลงกับลูกค้า` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `FieldChargeDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`prices.buy:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบเที่ยว (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/trip-costs/<id>/cancel" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"ตรวจใบเสร็จแล้ว ตรงกับที่ตกลงกับลูกค้า"}'
```

```ts
const { data, error } = await tms.POST('/v1/trip-costs/{id}/cancel', {
  params: { path: { id: "…" } },
  body: {
    "reason": "ตรวจใบเสร็จแล้ว ตรงกับที่ตกลงกับลูกค้า"
  },
});
```

## GET /v1/trips/{id}/offer-link {#get-trips-id-offer-link}

`GET /v1/trips/{id}/offer-link`

scope: `trips:assign` · operationId: `TripOffers_link`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | ลิงก์ข้อเสนองานที่ใช้ได้ของการจ้างปัจจุบัน (รอตอบ/รับแล้ว) — `link: null` เมื่อไม่มี · ห้าม cache (มี token) | `OfferLinkStateDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:assign`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบเที่ยว (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/trips/<id>/offer-link" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/trips/{id}/offer-link', {
  params: { path: { id: "…" } },
});
```

## POST /v1/trips/{id}/offer-link {#post-trips-id-offer-link}

`POST /v1/trips/{id}/offer-link`

scope: `trips:assign` · operationId: `TripOffers_reissue`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `201` | ออกลิงก์ใหม่ให้ข้อเสนอที่รอตอบ (ลิงก์เดิมถูกเพิกถอน + audit) — อายุเท่าเดิม ไม่ต่อเวลาตอบ · ST4-T08: รับงานแล้ว (เที่ยวยังไม่จบ) = ออกลิงก์งาน (`/link/pod/…`) ใหม่ · อื่น → 409 `offer_closed` | `OfferLinkDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:assign`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบเที่ยว (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress), [offer_closed](errors.md#offer_closed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/trips/<id>/offer-link" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)"
```

```ts
const { data, error } = await tms.POST('/v1/trips/{id}/offer-link', {
  params: { path: { id: "…" } },
});
```

## GET /v1/trips/{id}/offers {#get-trips-id-offers}

`GET /v1/trips/{id}/offers`

scope: `trips:read` · operationId: `TripOffers_history`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | ประวัติการจ้างรถร่วมของเที่ยว (ใหม่สุดก่อน: รอตอบ/รับ/ปฏิเสธ+เหตุผล/หมดเวลา/ถอน + การส่งลิงก์) — ราคาซื้อเห็นเมื่อมี `prices.buy:read` | `SubconOfferListDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบเที่ยว (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/trips/<id>/offers" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/trips/{id}/offers', {
  params: { path: { id: "…" } },
});
```

## สร้าง PDF ใบคุมรถของเที่ยว (A4) — ต้องมี `trips:read` + `documents:write` {#post-trips-id-sheet}

`POST /v1/trips/{id}/sheet`

scope: `trips:read` · operationId: `TripSheets_trip`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `201` |   | `TripSheetDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบเที่ยว (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress), [trip_empty](errors.md#trip_empty) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |
| `503` | `service_busy` (คิวสร้าง PDF เต็ม) / `pdf_render_timeout` (สร้างไม่ทันเวลา) — ลองใหม่ |   |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/trips/<id>/sheet" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)"
```

```ts
const { data, error } = await tms.POST('/v1/trips/{id}/sheet', {
  params: { path: { id: "…" } },
});
```

## ส่งให้คนขับ: สร้างใบคุมรถใหม่ + ลิงก์เปิด PDF ไม่ต้อง login (72 ชม.) สำหรับคัดลอกส่ง — `trips:dispatch` {#post-trips-id-sheet-driver-link}

`POST /v1/trips/{id}/sheet/driver-link`

scope: `trips:dispatch` · operationId: `TripSheets_driverLink`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `201` |   | `TripSheetLinkDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:dispatch`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบเที่ยว (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress), [trip_empty](errors.md#trip_empty) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |
| `503` | `service_busy` (คิวสร้าง PDF เต็ม) / `pdf_render_timeout` (สร้างไม่ทันเวลา) — ลองใหม่ |   |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/trips/<id>/sheet/driver-link" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)"
```

```ts
const { data, error } = await tms.POST('/v1/trips/{id}/sheet/driver-link', {
  params: { path: { id: "…" } },
});
```

## เพิกถอนลิงก์ใบคุมรถที่ส่งให้คนขับทั้งหมดของเที่ยว (เหตุผล ≥ 10 + audit) — `trips:dispatch` · เปิดลิงก์เดิม → 404 {#post-trips-id-sheet-driver-link-revoke}

`POST /v1/trips/{id}/sheet/driver-link/revoke`

scope: `trips:dispatch` · operationId: `TripSheets_revoke`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Request body** `RevokeTripSheetLinksDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `ส่งลิงก์ผิดคน ขอยกเลิกลิงก์เดิม` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `RevokeTripSheetLinksResultDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:dispatch`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบเที่ยว (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/trips/<id>/sheet/driver-link/revoke" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"ส่งลิงก์ผิดคน ขอยกเลิกลิงก์เดิม"}'
```

```ts
const { data, error } = await tms.POST('/v1/trips/{id}/sheet/driver-link/revoke', {
  params: { path: { id: "…" } },
  body: {
    "reason": "ส่งลิงก์ผิดคน ขอยกเลิกลิงก์เดิม"
  },
});
```

## ใบงานประจำวัน: PDF ใบคุมรถทุกเที่ยวของวัน (หรือของรถคันเดียว) 1 เที่ยว/หน้า — ไม่มีเที่ยว → 422 `no_trips` {#post-trip-sheets}

`POST /v1/trip-sheets`

scope: `trips:read` · operationId: `TripSheets_day`

**Request body** `DailyTripSheetDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `date` | ใช่ | `string` |   | วันเที่ยว (เวลาไทย) | `2026-11-18` |
| `vehicleId` |   | `string` |   | เฉพาะรถคันนี้ — ไม่ส่ง = ทุกคัน | `veh_…` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `201` |   | `TripSheetDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |
| `503` | `service_busy` (คิวสร้าง PDF เต็ม) / `pdf_render_timeout` (สร้างไม่ทันเวลา) — ลองใหม่ |   |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/trip-sheets" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"date":"2026-11-18","vehicleId":"veh_…"}'
```

```ts
const { data, error } = await tms.POST('/v1/trip-sheets', {
  body: {
    "date": "2026-11-18",
    "vehicleId": "veh_…"
  },
});
```

## Schema ของ response {#schemas}

### BulkTripResultsDto {#schema-BulkTripResultsDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `results` | ใช่ | `array<BulkTripResultDto>` |   | ผลต่อรายการ เรียงตามคำขอ |   |
| `succeeded` | ใช่ | `number` |   | จัดรถ/ปล่อยสำเร็จ (ไม่นับ `UNCHANGED`) | `3` |
| `unchanged` | ใช่ | `number` |   | จัดรถแล้วอยู่ก่อน ไม่เปลี่ยน | `0` |
| `failed` | ใช่ | `number` |   |   | `1` |

### FieldChargeDto {#schema-FieldChargeDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   | ฝั่งขาย `dsc_…` (do_surcharge) · ฝั่งซื้อ `tco_…` | `dsc_…` |
| `side` | ใช่ | `string` | ค่า: `SELL`, `BUY` |   |   |
| `status` | ใช่ | `string` | ค่า: `PENDING_CONFIRM`, `CONFIRMED`, `REJECTED`, `CANCELLED` |   |   |
| `tripId` | ใช่ | `string` |   |   | `trp_…` |
| `deliveryOrderId` | ใช่ | `string` | null ได้ |   | `do_…` |
| `doNo` | ใช่ | `string` | null ได้ |   | `DO-2611-00001` |
| `serviceItemId` | ใช่ | `string` |   |   | `svc_…` |
| `serviceItemCode` | ใช่ | `string` |   | รหัสรายการ ณ เวลาบันทึก (snapshot) | `WAIT` |
| `description` | ใช่ | `string` |   | ชื่อรายการ ณ เวลาบันทึก (snapshot) | `ค่ารอ` |
| `unitLabel` | ใช่ | `string` | null ได้ |   | `ชั่วโมง` |
| `vatType` | ใช่ | `string` | ค่า: `VAT_7`, `EXEMPT_TRANSPORT`, `ZERO_RATED` · null ได้ | ชนิด VAT (snapshot จากรายการบริการ) |   |
| `whtRate` | ใช่ | `string` | null ได้ | หัก ณ ที่จ่าย % (snapshot) | `3.00` |
| `qty` | ใช่ | `string` | null ได้ | จำนวน (ฝั่งขาย) | `1` |
| `sellUnitPrice` |   | `string` |   | ราคาต่อหน่วยฝั่งขาย — เห็นเมื่อมี `prices.sell:read` | `500.00` |
| `sellAmount` |   | `string` |   | ยอดฝั่งขายก่อน VAT = จำนวน × ราคา (ปัดครึ่งขึ้นเป็นสตางค์) — เห็นเมื่อมี `prices.sell:read` | `500.00` |
| `buyAmount` |   | `string` |   | ยอดต้นทุนฝั่งซื้อ — เห็นเมื่อมี `prices.buy:read` | `180.00` |
| `costType` | ใช่ | `string` | null ได้ | ชนิดต้นทุน (ฝั่งซื้อ: TOLL / OTHER) | `TOLL` |
| `pairedId` | ใช่ | `string` | null ได้ | บรรทัดอีกฝั่งที่บันทึกคู่กัน (side = BOTH) |   |
| `evidence` | ใช่ | `FieldChargeEvidenceDto` | null ได้ |   |   |
| `note` | ใช่ | `string` | null ได้ |   |   |
| `createdBy` | ใช่ | `string` | null ได้ |   |   |
| `createdByName` | ใช่ | `string` | null ได้ |   |   |
| `createdAt` | ใช่ | `string (date-time)` |   |   |   |
| `decidedBy` | ใช่ | `string` | null ได้ |   |   |
| `decidedByName` | ใช่ | `string` | null ได้ |   |   |
| `decidedAt` | ใช่ | `string (date-time)` | null ได้ |   |   |
| `decisionReason` | ใช่ | `string` | null ได้ |   |   |
| `version` | ใช่ | `number` |   |   |   |

### FieldChargeListDto {#schema-FieldChargeListDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<FieldChargeDto>` |   |   |   |

### HireOptionsDto {#schema-HireOptionsDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `tripId` | ใช่ | `string` |   |   | `trp_3f2a…` |
| `tripNo` | ใช่ | `string` |   |   | `TRP-6911-0001` |
| `origin` | ใช่ | `HireSiteDto` | null ได้ | จุดแรกของเที่ยว |   |
| `destination` | ใช่ | `HireSiteDto` | null ได้ | จุดสุดท้ายของเที่ยว |   |
| `vehicleTypeId` | ใช่ | `string` | null ได้ |   | `vty_3f2a…` |
| `vehicleTypeName` | ใช่ | `string` | null ได้ |   | `6 ล้อ` |
| `sellAmount` |   | `string` | null ได้ | รายได้ของเที่ยว (ผลรวมรายได้ DO ก่อน VAT) — เห็นเมื่อมี `prices.sell:read` · null = ยังไม่มีราคา | `9500.00` |
| `buyCheapestAmount` |   | `string` | null ได้ | ราคาต่ำสุดจาก rate card ขาซื้อของตัวเลือก — null = ไม่มีให้เทียบ (การจ้างต้องมีเหตุผล) | `6500.00` |
| `options` | ใช่ | `array<HireOptionDto>` |   | รถร่วมที่ใช้งานอยู่ทุกราย — ราคาถูกก่อน แล้วรายที่คิดราคาไม่ได้ตามชื่อ |   |

### OfferLinkDto {#schema-OfferLinkDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `offerId` | ใช่ | `string` |   |   | `sco_3f2a…` |
| `linkId` | ใช่ | `string` |   |   | `mlk_3f2a…` |
| `url` | ใช่ | `string` |   |   | `https://app.example/link/offer/ml1.…` |
| `expiresAt` | ใช่ | `string` |   |   |   |
| `issuedAt` | ใช่ | `string` |   |   |   |

### OfferLinkStateDto {#schema-OfferLinkStateDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `channels` | ใช่ | `OfferChannelsDto` |   |   |   |
| `link` | ใช่ | `OfferLinkDto` | null ได้ | null = ไม่มีลิงก์ที่ใช้ได้ (ยังไม่จ้าง / ปฏิเสธ-หมดเวลา-ยกเลิกแล้ว / ลิงก์หมดอายุ) |   |
| `podLink` | ใช่ | `OfferLinkDto` | null ได้ | ST4-T08 ลิงก์งานหลังรับงาน (`/link/pod/…` — ค้น DO + กดถึง/ออก, POD ST4-T09) · null = ยังไม่รับงาน/เพิกถอนแล้ว · ออกใหม่ด้วย POST offer-link |   |

### RevokeTripSheetLinksResultDto {#schema-RevokeTripSheetLinksResultDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `revoked` | ใช่ | `number` |   | จำนวนลิงก์ที่เพิกถอน (0 = ไม่มีลิงก์ที่ใช้ได้อยู่) | `1` |

### SendAllTripsResultDto {#schema-SendAllTripsResultDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `results` | ใช่ | `array<BulkTripResultDto>` |   | ผลต่อรายการ เรียงตามคำขอ |   |
| `succeeded` | ใช่ | `number` |   | จัดรถ/ปล่อยสำเร็จ (ไม่นับ `UNCHANGED`) | `3` |
| `unchanged` | ใช่ | `number` |   | จัดรถแล้วอยู่ก่อน ไม่เปลี่ยน | `0` |
| `failed` | ใช่ | `number` |   |   | `1` |
| `day` | ใช่ | `DaySendStateDto` |   | สถานะการส่งของวันหลังทำ |   |

### SubconOfferListDto {#schema-SubconOfferListDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<SubconOfferDto>` |   |   |   |

### TripDto {#schema-TripDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `trp_3f2a…` |
| `tripNo` | ใช่ | `string` |   |   | `TRP-6911-0001` |
| `tripDate` | ใช่ | `string` |   |   | `2026-11-13` |
| `status` | ใช่ | `string` | ค่า: `PLANNING`, `OFFERED`, `ASSIGNED`, `DISPATCHED`, `IN_PROGRESS`, `COMPLETED`, `COSTED`, `SETTLED`, `CANCELLED` |   |   |
| `plannedStartAt` | ใช่ | `string` | null ได้ |   |   |
| `plannedEndAt` | ใช่ | `string` | null ได้ |   |   |
| `vehicle` | ใช่ | `TripVehicleDto` | null ได้ |   |   |
| `trailer` | ใช่ | `TripTrailerDto` | null ได้ |   |   |
| `driver` | ใช่ | `TripDriverDto` | null ได้ |   |   |
| `reliefDriver` | ใช่ | `TripDriverDto` | null ได้ | คนขับสำรอง |   |
| `carrier` | ใช่ | `TripCarrierDto` | null ได้ |   |   |
| `assignmentStatus` | ใช่ | `string` | ค่า: `OFFERED`, `ACCEPTED`, `REJECTED`, `EXPIRED` · null ได้ |   |   |
| `offeredAt` | ใช่ | `string` | null ได้ |   |   |
| `offerExpiresAt` | ใช่ | `string` | null ได้ | ข้อเสนอหมดอายุ (48 ชม.) |   |
| `hire` | ใช่ | `TripHireDto` | null ได้ | ST3-T22 การจ้างรถร่วมที่ใช้งานอยู่ (รอตอบ/รับแล้ว) — ราคาซื้อเห็นเมื่อมี `prices.buy:read` |   |
| `assignedAt` | ใช่ | `string` | null ได้ |   |   |
| `dispatchedAt` | ใช่ | `string` | null ได้ |   |   |
| `completedAt` | ใช่ | `string` | null ได้ |   |   |
| `cancelledAt` | ใช่ | `string` | null ได้ |   |   |
| `cancelReason` | ใช่ | `string` | null ได้ |   |   |
| `stops` | ใช่ | `array<TripStopDto>` |   |   |   |
| `deliveryOrders` | ใช่ | `array<TripDeliveryOrderDto>` |   |   |   |
| `rescheduledDeliveryOrders` | ใช่ | `array<TripRescheduledDoDto>` |   | ST4-T12 DO ที่ส่งไม่สำเร็จในเที่ยวนี้แล้วนัดส่งใหม่ (ใบเดิม CANCELLED) — "ส่งไม่สำเร็จ · นัดส่งใหม่" · มีค่าเฉพาะ GET /trips/{id} (อื่น = []) |   |
| `weightKg` | ใช่ | `string` |   | น้ำหนักรวมของ DO ในเที่ยว (กก.) | `5400` |
| `route` | ใช่ | `TripRouteSummaryDto` |   | ST3-T16 ระยะ/เวลารวมตามลำดับจุดปัจจุบัน (คำนวณใหม่ทุกครั้งที่จุดเปลี่ยน) |   |
| `warnings` | ใช่ | `array<TripWarningDto>` |   | ผลตรวจกฎตอนจัดล่าสุด (ST3-T14 — D-07: block = กฎเอกสาร, warning = ต้องยืนยันก่อนปล่อยรถ) |   |
| `ruleOverrides` | ใช่ | `array<TripRuleOverrideDto>` |   | ประวัติการยกเว้น/ยืนยันกฎของเที่ยว (เรียงตามเวลา) |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string` |   |   |   |
| `updatedAt` | ใช่ | `string` |   |   |   |

### TripPageDto {#schema-TripPageDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<TripDto>` |   |   |   |
| `nextCursor` | ใช่ | `string` | null ได้ |   |   |
| `hasMore` | ใช่ | `boolean` |   |   |   |

### TripSheetDto {#schema-TripSheetDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `document` | ใช่ | `DocumentDto` |   | ไฟล์ PDF ที่สร้าง (`downloadUrl` อายุ 5 นาที) |   |
| `tripIds` | ใช่ | `array<string>` |   | เที่ยวในไฟล์ (ตามลำดับหน้า) | `["trp_…"]` |
| `tripNos` | ใช่ | `array<string>` |   |   | `["TRP-2611-0041"]` |

### TripSheetLinkDto {#schema-TripSheetLinkDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `document` | ใช่ | `DocumentDto` |   | ไฟล์ PDF ที่สร้าง (`downloadUrl` อายุ 5 นาที) |   |
| `tripIds` | ใช่ | `array<string>` |   | เที่ยวในไฟล์ (ตามลำดับหน้า) | `["trp_…"]` |
| `tripNos` | ใช่ | `array<string>` |   |   | `["TRP-2611-0041"]` |
| `url` | ใช่ | `string` |   | ลิงก์เปิด PDF โดยไม่ต้อง login — คัดลอกส่งให้คนขับ (LINE/SMS ของคนขับโดยตรง = ST4) | `https://api.example/v1/public/trip-sheets/ml1.…` |
| `expiresAt` | ใช่ | `string (date-time)` |   |   |   |

### TripSummaryDto {#schema-TripSummaryDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `running` | ใช่ | `number` |   | เที่ยวกำลังวิ่ง = `status=IN_PROGRESS` (ทุกวันที่ — spec/09 §1) |   |
| `offered` | ใช่ | `number` |   | งานรถร่วมรอตอบ = `status=OFFERED` (ทุกวันที่) |   |
