# จุดส่ง (stops)

10 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`GET /v1/stops/{id}`](#get-stops-id) | `trips:read` |
| [`GET /v1/stops/{id}/events`](#get-stops-id-events) | `trips:read` |
| [`POST /v1/stops/{id}/arrive`](#post-stops-id-arrive) | `trips:dispatch` |
| [`POST /v1/stops/{id}/depart`](#post-stops-id-depart) | `trips:dispatch` |
| [`POST /v1/stops/{id}/complete`](#post-stops-id-complete) | `trips:dispatch` |
| [`POST /v1/stops/{id}/fail`](#post-stops-id-fail) | `trips:dispatch` |
| [`GET /v1/trips/{id}/events`](#get-trips-id-events) | `trips:read` |
| [`GET /v1/stop-event-flags`](#get-stop-event-flags) | `trips:read` |
| [`GET /v1/stop-event-flags/summary`](#get-stop-event-flags-summary) | `trips:read` |
| [`POST /v1/stop-event-flags/{id}/resolve`](#post-stop-event-flags-id-resolve) | `trips:dispatch` |

## จุดแวะเดียว — สถานะ เวลา และ DO ที่รับ/ส่งที่จุดนี้ {#get-stops-id}

`GET /v1/stops/{id}`

scope: `trips:read` · operationId: `Stops_get`

สถานะ/เวลาเป็นค่าที่ไล่จาก event แล้ว · จุดที่ถอดออกแล้วยังเปิดได้ (`removedAt`) · ลำดับ event ทั้งหมด `GET /v1/stops/{id}/events` · จุดทั้งเที่ยว `GET /v1/trips/{id}` (`stops[]`)

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `StopDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบจุดแวะ (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/stops/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/stops/{id}', {
  params: { path: { id: "…" } },
});
```

## ลำดับ event ของจุด (เรียงตาม occurredAt) + สถานะที่มีผล {#get-stops-id-events}

`GET /v1/stops/{id}/events`

scope: `trips:read` · operationId: `Stops_events`

ทุก event ของจุด (รวมที่ขัดลำดับ/มาหลังปิด/ผู้จัดรถไม่ใช้) เรียง `occurredAt` → ชนิด (ออก → ถึง → ปิด) → `receivedAt` พร้อมผลของแต่ละตัว (`seqStatus`) และสถานะที่มีผลของจุด ลง `trip_stop` แล้ว (เที่ยวที่จบ/ยกเลิกไม่ไล่ต่อ)

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `StopEventSequenceDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบจุดแวะ (รวมของบริษัทอื่น) — จุดที่ถอดออกแล้วยังรับ event ได้ (ธง LATE: STOP_REMOVED) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/stops/<id>/events" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/stops/{id}/events', {
  params: { path: { id: "…" } },
});
```

## ถึงจุด {#post-stops-id-arrive}

`POST /v1/stops/{id}/arrive`

scope: `trips:dispatch` · operationId: `Stops_arrive`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `Idempotency-Key` | header |   | `string` |   |

**Request body** `ArriveStopDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `clientEventId` | ใช่ | `string (uuid)` |   | UUID ที่ client สร้างตอนกดปุ่ม (UUIDv4) — unique ต่อบริษัท: ส่งซ้ำ (จุด + ชนิดเดิม) → **200 + event เดิม** ไม่สร้างแถวใหม่ · ใช้กับจุด/ชนิดอื่น → 409 `stop_event_duplicate` | `6f1d3c1e-8a7b-4c2d-9e0f-1a2b3c4d5e6f` |
| `occurredAt` | ใช่ | `string (date-time)` |   | เวลาที่เกิดจริงบนเครื่อง (RFC 3339 `YYYY-MM-DDTHH:MM:SS[.fff]` + `Z`/`±HH:MM` — รับ `±HHMM`) — ใช้เรียงลำดับและเป็นเวลาถึง/ออก · บันทึกย้อนหลังได้ | `2026-11-17T09:42:00+07:00` |
| `lat` |   | `number` | ≥ -90 · ≤ 90 · null ได้ | ละติจูด ณ เวลากด (ส่งคู่กับ lng; เก็บทศนิยม 6 ตำแหน่ง) — null/ไม่ส่ง = ไม่ได้ให้สิทธิ์ตำแหน่ง | `13.6447` |
| `lng` |   | `number` | ≥ -180 · ≤ 180 · null ได้ |   | `100.6089` |
| `accuracyM` |   | `number` | ≥ 0 · ≤ 9999999 · null ได้ | ความแม่นของพิกัด (เมตร) | `12.5` |
| `reasonCodeId` |   | `string` | null ได้ | เหตุผลมาตรฐาน — ถึง/ออก: ล่าช้า (DELAY) หรือกดนอกรัศมี (OVERRIDE) ไม่บังคับ · ส่งไม่สำเร็จ: บังคับ (DELIVERY_FAILED / REJECTED_BY_RECEIVER) | `rsn_3f2a…` |
| `note` |   | `string` | ยาว ≤ 500 · null ได้ | หมายเหตุ (บังคับเมื่อเหตุผลที่เลือกตั้ง "ต้องมีหมายเหตุ") |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | ส่งซ้ำ (clientEventId + จุด + ชนิดเดิม) → event เดิม ไม่สร้างแถวใหม่ | `StopEventDto` |
| `201` | สร้าง event ใหม่ | `StopEventDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:dispatch`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบจุดแวะ (รวมของบริษัทอื่น) — จุดที่ถอดออกแล้วยังรับ event ได้ (ธง LATE: STOP_REMOVED) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | เที่ยวยังไม่ปล่อยรถ / clientEventId ถูกใช้กับ event อื่น (คนละจุดหรือคนละชนิด) / ชนกับการแก้ไขพร้อมกัน — [trip_not_in_progress](errors.md#trip_not_in_progress), [stop_event_duplicate](errors.md#stop_event_duplicate), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/stops/<id>/arrive" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"clientEventId":"6f1d3c1e-8a7b-4c2d-9e0f-1a2b3c4d5e6f","occurredAt":"2026-11-17T09:42:00+07:00"}'
```

```ts
const { data, error } = await tms.POST('/v1/stops/{id}/arrive', {
  params: { path: { id: "…" } },
  body: {
    "clientEventId": "6f1d3c1e-8a7b-4c2d-9e0f-1a2b3c4d5e6f",
    "occurredAt": "2026-11-17T09:42:00+07:00"
  },
});
```

## ออกเดินทางมุ่งหน้าไปจุดนี้ {#post-stops-id-depart}

`POST /v1/stops/{id}/depart`

scope: `trips:dispatch` · operationId: `Stops_depart`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `Idempotency-Key` | header |   | `string` |   |

**Request body** `DepartStopDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `clientEventId` | ใช่ | `string (uuid)` |   | UUID ที่ client สร้างตอนกดปุ่ม (UUIDv4) — unique ต่อบริษัท: ส่งซ้ำ (จุด + ชนิดเดิม) → **200 + event เดิม** ไม่สร้างแถวใหม่ · ใช้กับจุด/ชนิดอื่น → 409 `stop_event_duplicate` | `6f1d3c1e-8a7b-4c2d-9e0f-1a2b3c4d5e6f` |
| `occurredAt` | ใช่ | `string (date-time)` |   | เวลาที่เกิดจริงบนเครื่อง (RFC 3339 `YYYY-MM-DDTHH:MM:SS[.fff]` + `Z`/`±HH:MM` — รับ `±HHMM`) — ใช้เรียงลำดับและเป็นเวลาถึง/ออก · บันทึกย้อนหลังได้ | `2026-11-17T09:42:00+07:00` |
| `lat` |   | `number` | ≥ -90 · ≤ 90 · null ได้ | ละติจูด ณ เวลากด (ส่งคู่กับ lng; เก็บทศนิยม 6 ตำแหน่ง) — null/ไม่ส่ง = ไม่ได้ให้สิทธิ์ตำแหน่ง | `13.6447` |
| `lng` |   | `number` | ≥ -180 · ≤ 180 · null ได้ |   | `100.6089` |
| `accuracyM` |   | `number` | ≥ 0 · ≤ 9999999 · null ได้ | ความแม่นของพิกัด (เมตร) | `12.5` |
| `reasonCodeId` |   | `string` | null ได้ | เหตุผลมาตรฐาน — ถึง/ออก: ล่าช้า (DELAY) หรือกดนอกรัศมี (OVERRIDE) ไม่บังคับ · ส่งไม่สำเร็จ: บังคับ (DELIVERY_FAILED / REJECTED_BY_RECEIVER) | `rsn_3f2a…` |
| `note` |   | `string` | ยาว ≤ 500 · null ได้ | หมายเหตุ (บังคับเมื่อเหตุผลที่เลือกตั้ง "ต้องมีหมายเหตุ") |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | ส่งซ้ำ (clientEventId + จุด + ชนิดเดิม) → event เดิม ไม่สร้างแถวใหม่ | `StopEventDto` |
| `201` | สร้าง event ใหม่ | `StopEventDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:dispatch`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบจุดแวะ (รวมของบริษัทอื่น) — จุดที่ถอดออกแล้วยังรับ event ได้ (ธง LATE: STOP_REMOVED) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | เที่ยวยังไม่ปล่อยรถ / clientEventId ถูกใช้กับ event อื่น (คนละจุดหรือคนละชนิด) / ชนกับการแก้ไขพร้อมกัน — [trip_not_in_progress](errors.md#trip_not_in_progress), [stop_event_duplicate](errors.md#stop_event_duplicate), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/stops/<id>/depart" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"clientEventId":"6f1d3c1e-8a7b-4c2d-9e0f-1a2b3c4d5e6f","occurredAt":"2026-11-17T09:42:00+07:00"}'
```

```ts
const { data, error } = await tms.POST('/v1/stops/{id}/depart', {
  params: { path: { id: "…" } },
  body: {
    "clientEventId": "6f1d3c1e-8a7b-4c2d-9e0f-1a2b3c4d5e6f",
    "occurredAt": "2026-11-17T09:42:00+07:00"
  },
});
```

## ปิดงานที่จุด พร้อมผล (ส่งสำเร็จ / บางส่วน / ไม่สำเร็จ / ของยังอยู่บนรถ) {#post-stops-id-complete}

`POST /v1/stops/{id}/complete`

scope: `trips:dispatch` · operationId: `Stops_complete`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `Idempotency-Key` | header |   | `string` |   |

**Request body** `CompleteStopDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `clientEventId` | ใช่ | `string (uuid)` |   | UUID ที่ client สร้างตอนกดปุ่ม (UUIDv4) — unique ต่อบริษัท: ส่งซ้ำ (จุด + ชนิดเดิม) → **200 + event เดิม** ไม่สร้างแถวใหม่ · ใช้กับจุด/ชนิดอื่น → 409 `stop_event_duplicate` | `6f1d3c1e-8a7b-4c2d-9e0f-1a2b3c4d5e6f` |
| `occurredAt` | ใช่ | `string (date-time)` |   | เวลาที่เกิดจริงบนเครื่อง (RFC 3339 `YYYY-MM-DDTHH:MM:SS[.fff]` + `Z`/`±HH:MM` — รับ `±HHMM`) — ใช้เรียงลำดับและเป็นเวลาถึง/ออก · บันทึกย้อนหลังได้ | `2026-11-17T09:42:00+07:00` |
| `lat` |   | `number` | ≥ -90 · ≤ 90 · null ได้ | ละติจูด ณ เวลากด (ส่งคู่กับ lng; เก็บทศนิยม 6 ตำแหน่ง) — null/ไม่ส่ง = ไม่ได้ให้สิทธิ์ตำแหน่ง | `13.6447` |
| `lng` |   | `number` | ≥ -180 · ≤ 180 · null ได้ |   | `100.6089` |
| `accuracyM` |   | `number` | ≥ 0 · ≤ 9999999 · null ได้ | ความแม่นของพิกัด (เมตร) | `12.5` |
| `reasonCodeId` |   | `string` | null ได้ | เหตุผลมาตรฐาน — ถึง/ออก: ล่าช้า (DELAY) หรือกดนอกรัศมี (OVERRIDE) ไม่บังคับ · ส่งไม่สำเร็จ: บังคับ (DELIVERY_FAILED / REJECTED_BY_RECEIVER) | `rsn_3f2a…` |
| `note` |   | `string` | ยาว ≤ 500 · null ได้ | หมายเหตุ (บังคับเมื่อเหตุผลที่เลือกตั้ง "ต้องมีหมายเหตุ") |   |
| `outcome` | ใช่ | `string` | ค่า: `DELIVERED`, `PARTIAL`, `FAILED`, `UNDELIVERED_RETAIN` | DELIVERED = ส่งสำเร็จ · PARTIAL = ส่งบางส่วน · FAILED = ส่งไม่สำเร็จ · UNDELIVERED_RETAIN = ส่งไม่สำเร็จ ของยังอยู่บนรถ (FAILED/UNDELIVERED_RETAIN บังคับเหตุผล) |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | ส่งซ้ำ (clientEventId + จุด + ชนิดเดิม) → event เดิม ไม่สร้างแถวใหม่ | `StopEventDto` |
| `201` | สร้าง event ใหม่ | `StopEventDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:dispatch`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบจุดแวะ (รวมของบริษัทอื่น) — จุดที่ถอดออกแล้วยังรับ event ได้ (ธง LATE: STOP_REMOVED) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | เที่ยวยังไม่ปล่อยรถ / clientEventId ถูกใช้กับ event อื่น (คนละจุดหรือคนละชนิด) / ชนกับการแก้ไขพร้อมกัน — [trip_not_in_progress](errors.md#trip_not_in_progress), [stop_event_duplicate](errors.md#stop_event_duplicate), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/stops/<id>/complete" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"clientEventId":"6f1d3c1e-8a7b-4c2d-9e0f-1a2b3c4d5e6f","occurredAt":"2026-11-17T09:42:00+07:00","outcome":"DELIVERED"}'
```

```ts
const { data, error } = await tms.POST('/v1/stops/{id}/complete', {
  params: { path: { id: "…" } },
  body: {
    "clientEventId": "6f1d3c1e-8a7b-4c2d-9e0f-1a2b3c4d5e6f",
    "occurredAt": "2026-11-17T09:42:00+07:00",
    "outcome": "DELIVERED"
  },
});
```

## ส่งไม่สำเร็จ (เหตุผลบังคับ) {#post-stops-id-fail}

`POST /v1/stops/{id}/fail`

scope: `trips:dispatch` · operationId: `Stops_fail`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `Idempotency-Key` | header |   | `string` |   |

**Request body** `FailStopDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `clientEventId` | ใช่ | `string (uuid)` |   | UUID ที่ client สร้างตอนกดปุ่ม (UUIDv4) — unique ต่อบริษัท: ส่งซ้ำ (จุด + ชนิดเดิม) → **200 + event เดิม** ไม่สร้างแถวใหม่ · ใช้กับจุด/ชนิดอื่น → 409 `stop_event_duplicate` | `6f1d3c1e-8a7b-4c2d-9e0f-1a2b3c4d5e6f` |
| `occurredAt` | ใช่ | `string (date-time)` |   | เวลาที่เกิดจริงบนเครื่อง (RFC 3339 `YYYY-MM-DDTHH:MM:SS[.fff]` + `Z`/`±HH:MM` — รับ `±HHMM`) — ใช้เรียงลำดับและเป็นเวลาถึง/ออก · บันทึกย้อนหลังได้ | `2026-11-17T09:42:00+07:00` |
| `lat` |   | `number` | ≥ -90 · ≤ 90 · null ได้ | ละติจูด ณ เวลากด (ส่งคู่กับ lng; เก็บทศนิยม 6 ตำแหน่ง) — null/ไม่ส่ง = ไม่ได้ให้สิทธิ์ตำแหน่ง | `13.6447` |
| `lng` |   | `number` | ≥ -180 · ≤ 180 · null ได้ |   | `100.6089` |
| `accuracyM` |   | `number` | ≥ 0 · ≤ 9999999 · null ได้ | ความแม่นของพิกัด (เมตร) | `12.5` |
| `reasonCodeId` |   | `string` | null ได้ | เหตุผลมาตรฐาน — ถึง/ออก: ล่าช้า (DELAY) หรือกดนอกรัศมี (OVERRIDE) ไม่บังคับ · ส่งไม่สำเร็จ: บังคับ (DELIVERY_FAILED / REJECTED_BY_RECEIVER) | `rsn_3f2a…` |
| `note` |   | `string` | ยาว ≤ 500 · null ได้ | หมายเหตุ (บังคับเมื่อเหตุผลที่เลือกตั้ง "ต้องมีหมายเหตุ") |   |
| `outcome` |   | `string` | ค่า: `FAILED`, `UNDELIVERED_RETAIN` · null ได้ | ไม่ส่ง = ไม่ระบุ · UNDELIVERED_RETAIN = ของยังอยู่บนรถ |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | ส่งซ้ำ (clientEventId + จุด + ชนิดเดิม) → event เดิม ไม่สร้างแถวใหม่ | `StopEventDto` |
| `201` | สร้าง event ใหม่ | `StopEventDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:dispatch`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบจุดแวะ (รวมของบริษัทอื่น) — จุดที่ถอดออกแล้วยังรับ event ได้ (ธง LATE: STOP_REMOVED) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | เที่ยวยังไม่ปล่อยรถ / clientEventId ถูกใช้กับ event อื่น (คนละจุดหรือคนละชนิด) / ชนกับการแก้ไขพร้อมกัน — [trip_not_in_progress](errors.md#trip_not_in_progress), [stop_event_duplicate](errors.md#stop_event_duplicate), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/stops/<id>/fail" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"clientEventId":"6f1d3c1e-8a7b-4c2d-9e0f-1a2b3c4d5e6f","occurredAt":"2026-11-17T09:42:00+07:00"}'
```

```ts
const { data, error } = await tms.POST('/v1/stops/{id}/fail', {
  params: { path: { id: "…" } },
  body: {
    "clientEventId": "6f1d3c1e-8a7b-4c2d-9e0f-1a2b3c4d5e6f",
    "occurredAt": "2026-11-17T09:42:00+07:00"
  },
});
```

## ไทม์ไลน์ event หน้างานของเที่ยว (ทุกจุด) พร้อมชื่อผู้บันทึก {#get-trips-id-events}

`GET /v1/trips/{id}/events`

scope: `trips:read` · operationId: `TripEvents_timeline`

เรียงตามลำดับจุด (จุดที่ถอดแล้วอยู่ท้าย) แล้วตามลำดับที่มีผลของจุด · `recordedByName` = ชื่อผู้ใช้ภายในที่บันทึก (บันทึกแทนคนขับผ่านเว็บ) · `flags` ไม่ว่าง = รอผู้จัดรถตัดสินในศูนย์ข้อยกเว้น

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `TripTimelineDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบเที่ยว (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/trips/<id>/events" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/trips/{id}/events', {
  params: { path: { id: "…" } },
});
```

## รายการธงของ stop event (ล่าสุดก่อน) {#get-stop-event-flags}

`GET /v1/stop-event-flags`

scope: `trips:read` · operationId: `StopEventFlags_list`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน |
| `status` | query |   | `string` ค่า: `open`, `resolved`, `all` |   |
| `flag` | query |   | `string` ค่า: `LATE`, `SEQUENCE_CONFLICT`, `PICKUP_NOT_DONE`, `CLOCK_SKEW`, `OUTCOME_MISMATCH` |   |
| `resolvedToday` | query |   | `string` | true = เฉพาะที่ตัดสินวันนี้ (เวลาไทย) — การ์ด "ปิดแล้ววันนี้" |
| `q` | query |   | `string` | ค้นเลขเที่ยว / ทะเบียนรถ / ชื่อจุด / เลข DO / ชื่อลูกค้า |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `StopEventFlagPageDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/stop-event-flags" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/stop-event-flags');
```

## ตัวเลขสรุปธง (ใหม่ / ตัดสินแล้ว / ตัดสินแล้ววันนี้) {#get-stop-event-flags-summary}

`GET /v1/stop-event-flags/summary`

scope: `trips:read` · operationId: `StopEventFlags_summary`

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `StopEventFlagSummaryDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/stop-event-flags/summary" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/stop-event-flags/summary');
```

## ตัดสินธง: ใช้ (ACCEPT) / ไม่ใช้ (IGNORE) event นี้ — เหตุผลบังคับ {#post-stop-event-flags-id-resolve}

`POST /v1/stop-event-flags/{id}/resolve`

scope: `trips:dispatch` · operationId: `StopEventFlags_resolve`

สร้างแถวใหม่ใน `stop_event_resolution` (ไม่แก้ event) + audit `stop_event.resolve` แล้วคำนวณลำดับของจุดใหม่ · การตัดสินมีผลตราบที่ชุดธงไม่เปลี่ยน — ธงเปลี่ยน (event อื่นมาถึง) = หมดผล กลับเป็น "ใหม่" ตัดสินใหม่ได้

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Request body** `ResolveStopEventFlagDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `decision` | ใช่ | `string` | ค่า: `ACCEPT`, `IGNORE` | ACCEPT = ใช้ event นี้ (นับในลำดับแม้ขัด/มาหลังปิด) · IGNORE = ไม่ใช้ (เก็บเป็นประวัติ ไม่นับ) |   |
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 | เหตุผล (บังคับ ≥ 10 ตัวอักษร — ลง audit) |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `StopEventFlagDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:dispatch`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ event (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | ไม่มีธงให้ตัดสิน / ตัดสินไปแล้ว — [stop_event_not_flagged](errors.md#stop_event_not_flagged), [stop_event_already_resolved](errors.md#stop_event_already_resolved) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/stop-event-flags/<id>/resolve" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"decision":"ACCEPT","reason":"string"}'
```

```ts
const { data, error } = await tms.POST('/v1/stop-event-flags/{id}/resolve', {
  params: { path: { id: "…" } },
  body: {
    "decision": "ACCEPT",
    "reason": "string"
  },
});
```

## Schema ของ response {#schemas}

### StopDto {#schema-StopDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `stp_3f2a…` |
| `tripId` | ใช่ | `string` |   |   | `trp_3f2a…` |
| `tripNo` | ใช่ | `string` |   |   | `TRP-6911-0001` |
| `tripStatus` | ใช่ | `string` |   | สถานะเที่ยว (PLANNING / ASSIGNED / DISPATCHED / IN_PROGRESS / COMPLETED / CANCELLED) | `IN_PROGRESS` |
| `sequence` | ใช่ | `number` |   |   | `2` |
| `type` | ใช่ | `string` | ค่า: `PICKUP`, `DELIVERY`, `RETURN` |   |   |
| `siteId` | ใช่ | `string` |   |   | `loc_3f2a…` |
| `siteName` | ใช่ | `string` |   |   | `คลังสินค้าบางนา` |
| `status` | ใช่ | `string` | ค่า: `PENDING`, `ARRIVED`, `COMPLETED`, `FAILED`, `SKIPPED` |   | `ARRIVED` |
| `outcome` | ใช่ | `string` | ค่า: `DELIVERED`, `PARTIAL`, `FAILED`, `UNDELIVERED_RETAIN` · null ได้ | ผลของจุดที่ปิดแล้ว |   |
| `windowStart` | ใช่ | `string (date-time)` | null ได้ |   | `2026-11-19T09:00:00+07:00` |
| `windowEnd` | ใช่ | `string (date-time)` | null ได้ |   |   |
| `plannedArrival` | ใช่ | `string (date-time)` | null ได้ |   |   |
| `plannedDeparture` | ใช่ | `string (date-time)` | null ได้ |   |   |
| `arrivedAt` | ใช่ | `string (date-time)` | null ได้ | เวลาถึงจุด |   |
| `departedAt` | ใช่ | `string (date-time)` | null ได้ | เวลาออกจากจุด |   |
| `deliveryOrderIds` | ใช่ | `array<string>` |   | DO ที่รับ (PICKUP) / ส่ง (DELIVERY) ที่จุดนี้ | `["do_3f2a…"]` |
| `lastEventId` | ใช่ | `string` | null ได้ | event ล่าสุดที่เปลี่ยนสถานะจุด — ลำดับทั้งหมดจาก `GET /v1/stops/{id}/events` | `evt_3f2a…` |
| `removedAt` | ใช่ | `string (date-time)` | null ได้ | จุดที่ถอดออกจากเที่ยวแล้ว (ไม่ลบจริง) — ยังเปิดดูและรับ event ได้ (ธง LATE: STOP_REMOVED) |   |

### StopEventDto {#schema-StopEventDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `evt_3f2a…` |
| `stopId` | ใช่ | `string` |   |   | `stp_3f2a…` |
| `tripId` | ใช่ | `string` |   |   | `trp_3f2a…` |
| `type` | ใช่ | `string` | ค่า: `ARRIVE`, `DEPART`, `LOADED`, `COMPLETE`, `FAIL` |   |   |
| `outcome` | ใช่ | `string` | ค่า: `DELIVERED`, `PARTIAL`, `FAILED`, `UNDELIVERED_RETAIN` · null ได้ |   |   |
| `clientEventId` | ใช่ | `string (uuid)` |   |   |   |
| `occurredAt` | ใช่ | `string (date-time)` |   | เวลาเกิดจริงบนเครื่อง (UTC) |   |
| `receivedAt` | ใช่ | `string (date-time)` |   | เวลาที่ server รับ (UTC) |   |
| `appliedAt` | ใช่ | `string (date-time)` | null ได้ | เวลาที่ event ถูกนับในสถานะจุด/เที่ยว/DO (projection) — null = ไม่นับ (ขัดลำดับ/มาหลังปิด/เวลาเพี้ยนที่ยังไม่ตัดสิน, ผู้จัดรถไม่ใช้, หรือเที่ยวจบ/ยกเลิกแล้ว = ประวัติเท่านั้น) |   |
| `lat` | ใช่ | `number` | null ได้ |   |   |
| `lng` | ใช่ | `number` | null ได้ |   |   |
| `accuracyM` | ใช่ | `number` | null ได้ |   |   |
| `source` | ใช่ | `string` | ค่า: `APP`, `LINK`, `WEB`, `API`, `GPS` | WEB = ผู้ใช้บันทึกแทนผ่านเว็บ/ผู้ใช้ภายใน · LINK = ลิงก์รถร่วม · API = ระบบภายนอก |   |
| `recordedBy` | ใช่ | `string` | null ได้ | ผู้บันทึก (user id) |   |
| `reason` | ใช่ | `StopEventReasonDto` | null ได้ |   |   |
| `note` | ใช่ | `string` | null ได้ |   |   |
| `sequenceConflict` | ใช่ | `boolean` |   | ขัด state machine ของจุดเมื่อเรียงตาม occurredAt (เช่น ปิดงานก่อนถึงจุด) — คำนวณใหม่ทุกครั้งที่มี event/การตัดสินใหม่ของจุด |   |
| `clockSkew` | ใช่ | `boolean` |   | occurredAt อนาคตเกิน 5 นาที หรือย้อนหลังเกิน 24 ชม. จาก receivedAt (ธง ไม่แก้เวลา) |   |
| `lateReason` | ใช่ | `string` | ค่า: `STOP_REMOVED`, `TRIP_CANCELLED`, `TRIP_COMPLETED`, `BILLING_LOCKED` · null ได้ | event มาหลังจุดถูกถอด / เที่ยวยกเลิก / เที่ยวจบ — รับเก็บเป็นประวัติ ไม่นับจนกว่าผู้จัดรถยอมรับ |   |
| `flags` | ใช่ | `array<string>` |   | ธงที่รอผู้จัดรถตัดสิน (หน้า ศูนย์ข้อยกเว้น) — ว่าง = ปกติ |   |

### StopEventFlagDto {#schema-StopEventFlagDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   | id ของ event ที่มีธง | `evt_3f2a…` |
| `event` | ใช่ | `StopEventDto` |   |   |   |
| `flags` | ใช่ | `array<string>` |   | ธงปัจจุบัน |   |
| `status` | ใช่ | `string` | ค่า: `OPEN`, `RESOLVED` | RESOLVED = มีการตัดสินที่ธงตรงกับธงปัจจุบัน |   |
| `tripId` | ใช่ | `string` |   |   | `trp_3f2a…` |
| `tripNo` | ใช่ | `string` | null ได้ |   | `TRP-2611-0042` |
| `tripStatus` | ใช่ | `string` |   |   | `DISPATCHED` |
| `stopId` | ใช่ | `string` |   |   | `stp_3f2a…` |
| `stopSequence` | ใช่ | `number` |   |   | `2` |
| `stopType` | ใช่ | `string` | ค่า: `PICKUP`, `DELIVERY`, `RETURN` |   |   |
| `siteName` | ใช่ | `string` |   |   | `คลังสินค้าบางนา` |
| `vehiclePlate` | ใช่ | `string` | null ได้ |   | `70-2281` |
| `customerName` | ใช่ | `string` | null ได้ |   |   |
| `doNos` | ใช่ | `array<string>` |   |   | `["DO-2611-00022"]` |
| `stateBefore` | ใช่ | `string` | ค่า: `PENDING`, `EN_ROUTE`, `ARRIVED`, `COMPLETED`, `FAILED` · null ได้ | สถานะของจุดตามลำดับที่มีผล ก่อน event นี้ (เฉพาะธงขัดลำดับ) |   |
| `resolution` | ใช่ | `StopEventResolutionDto` | null ได้ | การตัดสินที่มีผล |   |
| `recordedByName` | ใช่ | `string` | null ได้ | ชื่อผู้บันทึก event (ผู้ใช้ภายใน) |   |
| `resolvedByName` | ใช่ | `string` | null ได้ | ชื่อผู้ตัดสิน |   |

### StopEventFlagPageDto {#schema-StopEventFlagPageDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<StopEventFlagDto>` |   |   |   |
| `nextCursor` | ใช่ | `string` | null ได้ |   |   |
| `hasMore` | ใช่ | `boolean` |   |   |   |

### StopEventFlagSummaryDto {#schema-StopEventFlagSummaryDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `open` | ใช่ | `number` |   | ยังไม่ตัดสิน (ใหม่) |   |
| `resolved` | ใช่ | `number` |   | ตัดสินแล้วทั้งหมด |   |
| `resolvedToday` | ใช่ | `number` |   | ตัดสินแล้ววันนี้ (เวลาไทย) |   |

### StopEventSequenceDto {#schema-StopEventSequenceDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<SequencedStopEventDto>` |   | เรียง occurredAt → ชนิด → receivedAt |   |
| `effective` | ใช่ | `StopEffectiveDto` |   |   |   |

### TripTimelineDto {#schema-TripTimelineDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<TripTimelineEventDto>` |   | ทุก event ของเที่ยว (รวมจุดที่ถอดแล้ว) เรียงตามลำดับจุด แล้วตามลำดับที่มีผลของจุด (occurredAt → ชนิด → receivedAt) |   |
