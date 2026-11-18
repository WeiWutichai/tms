# ตารางงาน (schedule)

4 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`GET /v1/schedule-entries`](#get-schedule-entries) | `trips:read` |
| [`POST /v1/schedule-entries`](#post-schedule-entries) | `trips:assign` / `master:write` |
| [`GET /v1/schedule-entries/{id}`](#get-schedule-entries-id) | `trips:read` |
| [`POST /v1/schedule-entries/{id}/cancel`](#post-schedule-entries-id-cancel) | `trips:assign` / `master:write` |

## GET /v1/schedule-entries {#get-schedule-entries}

`GET /v1/schedule-entries`

scope: `trips:read` · operationId: `Schedule_list`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `from` | query | ใช่ | `string (date)` | วันแรก (วันไทย) |
| `to` | query | ใช่ | `string (date)` | วันสุดท้าย (รวม) — ช่วงไม่เกิน 62 วัน |
| `driverId` | query |   | `string` | เฉพาะคนขับคนนี้ |
| `vehicleId` | query |   | `string` | เฉพาะรถคันนี้ |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | รายการที่ยังไม่ยกเลิกซึ่งทับช่วง from–to (≤ 62 วัน) เรียงวันเริ่ม | `ScheduleEntryListDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/schedule-entries" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/schedule-entries');
```

## POST /v1/schedule-entries {#post-schedule-entries}

`POST /v1/schedule-entries`

scope: `trips:assign` หรือ `master:write` · operationId: `Schedule_create`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `Idempotency-Key` | header |   | `string` |   |

**Request body** `CreateScheduleEntryDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `kind` | ใช่ | `string` | ค่า: `LEAVE`, `NOTE` | LEAVE = วันลาคนขับ (ต้องมี driverId) · NOTE = โน้ตรายวันของคนขับหรือรถ (อย่างใดอย่างหนึ่ง) |   |
| `driverId` |   | `string` |   |   | `drv_…` |
| `vehicleId` |   | `string` |   | เฉพาะ NOTE | `veh_…` |
| `startsOn` | ใช่ | `string (date)` |   | วันแรก (วันไทย) | `2026-11-18` |
| `endsOn` | ใช่ | `string (date)` |   | วันสุดท้าย (รวม) ≥ startsOn · ช่วงไม่เกิน 366 วันรวมวันแรกและวันสุดท้าย | `2026-11-19` |
| `note` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 1 | เหตุผลการลา / ข้อความโน้ต | `ลาป่วย` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `201` | ใส่วันลา/โน้ต — วันลาทับวันลาเดิมของคนขับคนเดียวกัน → 409 `conflict` (`existing`) · ใส่วันลาแล้วตรวจกฎเที่ยวที่ยังไม่จบของคนขับในช่วงนั้นใหม่ | `ScheduleEntryDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:assign`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `409` | วันลาทับวันลาเดิมของคนขับ (`conflict`) / ยกเลิกไปแล้ว (`invalid_state_transition`) — [conflict](errors.md#conflict), [invalid_state_transition](errors.md#invalid_state_transition) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/schedule-entries" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"kind":"LEAVE","driverId":"drv_…","vehicleId":"veh_…","startsOn":"2026-11-18","endsOn":"2026-11-19","note":"ลาป่วย"}'
```

```ts
const { data, error } = await tms.POST('/v1/schedule-entries', {
  body: {
    "kind": "LEAVE",
    "driverId": "drv_…",
    "vehicleId": "veh_…",
    "startsOn": "2026-11-18",
    "endsOn": "2026-11-19",
    "note": "ลาป่วย"
  },
});
```

## GET /v1/schedule-entries/{id} {#get-schedule-entries-id}

`GET /v1/schedule-entries/{id}`

scope: `trips:read` · operationId: `Schedule_get`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `ScheduleEntryDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบรายการ (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/schedule-entries/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/schedule-entries/{id}', {
  params: { path: { id: "…" } },
});
```

## POST /v1/schedule-entries/{id}/cancel {#post-schedule-entries-id-cancel}

`POST /v1/schedule-entries/{id}/cancel`

scope: `trips:assign` หรือ `master:write` · operationId: `Schedule_cancel`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `CancelScheduleEntryDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 | เหตุผล (ลง audit) |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `ScheduleEntryDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:assign`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบรายการ (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | วันลาทับวันลาเดิมของคนขับ (`conflict`) / ยกเลิกไปแล้ว (`invalid_state_transition`) — [conflict](errors.md#conflict), [invalid_state_transition](errors.md#invalid_state_transition) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/schedule-entries/<id>/cancel" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"string"}'
```

```ts
const { data, error } = await tms.POST('/v1/schedule-entries/{id}/cancel', {
  params: { path: { id: "…" } },
  body: {
    "reason": "string"
  },
});
```

## Schema ของ response {#schemas}

### ScheduleEntryDto {#schema-ScheduleEntryDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `sch_…` |
| `kind` | ใช่ | `string` | ค่า: `LEAVE`, `NOTE` |   |   |
| `driver` | ใช่ | `ScheduleEntryDriverDto` | null ได้ |   |   |
| `vehicle` | ใช่ | `ScheduleEntryVehicleDto` | null ได้ |   |   |
| `startsOn` | ใช่ | `string (date)` |   |   |   |
| `endsOn` | ใช่ | `string (date)` |   |   |   |
| `note` | ใช่ | `string` |   | เหตุผลการลา / ข้อความโน้ต |   |
| `cancelledAt` | ใช่ | `string (date-time)` | null ได้ |   |   |
| `cancelReason` | ใช่ | `string` | null ได้ |   |   |
| `createdAt` | ใช่ | `string (date-time)` |   |   |   |
| `version` | ใช่ | `number` |   |   |   |

### ScheduleEntryListDto {#schema-ScheduleEntryListDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<ScheduleEntryDto>` |   |   |   |
