# วางแผน (planning)

2 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`GET /v1/planning/board`](#get-planning-board) | `trips:read` |
| [`GET /v1/planning/eligibility`](#get-planning-eligibility) | `trips:read` |

## GET /v1/planning/board {#get-planning-board}

`GET /v1/planning/board`

scope: `trips:read` · operationId: `Planning_board`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `date` | query |   | `string` | วันแรกของกระดาน (YYYY-MM-DD) — ไม่ส่ง = วันนี้ (เวลาไทย) |
| `days` | query |   | `number` ค่า: `1`, `7` | จำนวนวัน: 1 = วันเดียว · 7 = 7 วัน |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `PlanningBoardDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/planning/board" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/planning/board');
```

## GET /v1/planning/eligibility {#get-planning-eligibility}

`GET /v1/planning/eligibility`

scope: `trips:read` · operationId: `Planning_eligibility`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `orderId` | query |   | `string` | SO (การ์ดใน "SO รอจัด") → ประเมินรถทุกคันบนกระดาน |
| `vehicleId` | query |   | `string` | รถ (แถวรถ) → ประเมิน SO รอจัดทุกใบ |
| `tripId` | query |   | `string` | เที่ยว ("ย้ายไปรถอื่น") → ประเมินรถทุกคันกับ DO ทั้งหมดของเที่ยว ในช่วงวิ่งของเที่ยว (รวมซ้อนเวลา) |
| `date` | query |   | `string` | วันแรก (YYYY-MM-DD) ที่ตรวจเอกสารรถ/ใบขับขี่ — ไม่ส่ง = วันนี้ (เวลาไทย) · ไม่ใช้กับ `tripId` |
| `days` | query |   | `number` ค่า: `1`, `7` | จำนวนวัน: 1 / 7 |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `PlanningEligibilityDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบเที่ยว (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/planning/eligibility" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/planning/eligibility');
```

## Schema ของ response {#schemas}

### PlanningBoardDto {#schema-PlanningBoardDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `from` | ใช่ | `string` |   |   | `2026-11-13` |
| `to` | ใช่ | `string` |   |   | `2026-11-13` |
| `today` | ใช่ | `string` |   | วันนี้ (เวลาไทย) | `2026-11-13` |
| `vehicles` | ใช่ | `array<BoardVehicleDto>` |   | แถวรถ: รถบริษัท → รถร่วม (PLN-049) |   |
| `trips` | ใช่ | `array<BoardTripDto>` |   | เที่ยวในช่วง (± 1 วัน — เที่ยวข้ามคืน) ยกเว้นที่ยกเลิก |   |
| `pool` | ใช่ | `array<BoardPoolOrderDto>` |   | SO รอจัด (จัดกลุ่ม DO ตาม SO) เรียงกำหนดส่ง |   |
| `days` | ใช่ | `array<DaySendStateDto>` |   | สถานะการส่งต่อวันในช่วง from–to — นับตามวันเที่ยว `tripDate` |   |
| `schedule` | ใช่ | `array<ScheduleEntryDto>` |   | วันลาคนขับ/โน้ตรายวันที่ทับช่วง from–to — ไม่รวมที่ยกเลิก · ชุดเดียวกับ GET /v1/schedule-entries |   |

### PlanningEligibilityDto {#schema-PlanningEligibilityDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `from` | ใช่ | `string` |   |   | `2026-11-13` |
| `to` | ใช่ | `string` |   |   | `2026-11-19` |
| `subject` | ใช่ | `string` | ค่า: `ORDER`, `VEHICLE`, `TRIP` |   |   |
| `items` | ใช่ | `array<EligibilityItemDto>` |   | ORDER/TRIP = หนึ่งรายการต่อรถ · VEHICLE = หนึ่งรายการต่อ SO รอจัด |   |
