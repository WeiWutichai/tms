# Webhooks และ events

9 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`GET /v1/webhooks`](#get-webhooks) | `settings:read` |
| [`GET /v1/webhooks/summary`](#get-webhooks-summary) | `settings:read` |
| [`GET /v1/webhooks/event-types`](#get-webhooks-event-types) | `settings:read` |
| [`GET /v1/webhooks/{id}`](#get-webhooks-id) | `settings:read` |
| [`GET /v1/webhooks/{id}/history`](#get-webhooks-id-history) | `settings:read` |
| [`GET /v1/webhook-deliveries`](#get-webhook-deliveries) | `settings:read` |
| [`GET /v1/webhook-deliveries/{id}`](#get-webhook-deliveries-id) | `settings:read` |
| [`GET /v1/events`](#get-events) | `events:read` |
| [`GET /v1/events/{id}`](#get-events-id) | `events:read` |

## GET /v1/webhooks {#get-webhooks}

`GET /v1/webhooks`

scope: `settings:read` · operationId: `Webhooks_list`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `X-Tms-Mode` | header |   | `string` ค่า: `live`, `test` | เฉพาะผู้ใช้ที่ login (UI): `test` = จัดการข้อมูลของ Sandbox ของบริษัท (key `tk_test_`, webhook ของ sandbox) · ไม่ส่ง = live · API key ไม่ใช้ header นี้ (โหมดตาม key) |
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน |
| `updatedAfter` | query |   | `string` | คืนเฉพาะแถวที่ updatedAt > ค่านี้ (incremental pull) |
| `sort` | query |   | `string` ค่า: `updatedAt`, `-updatedAt` |   |
| `fields` | query |   | `string` | รายชื่อ field คั่นด้วย, เช่น id,legalName |
| `status` | query |   | `string` | สถานะคั่นด้วย, (active / failing / disabled / auto_disabled) |
| `url` | query |   | `string` | ค้น URL บางส่วน |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `WebhookPageDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settings:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/webhooks" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/webhooks');
```

## GET /v1/webhooks/summary {#get-webhooks-summary}

`GET /v1/webhooks/summary`

scope: `settings:read` · operationId: `Webhooks_summary`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `X-Tms-Mode` | header |   | `string` ค่า: `live`, `test` | เฉพาะผู้ใช้ที่ login (UI): `test` = จัดการข้อมูลของ Sandbox ของบริษัท (key `tk_test_`, webhook ของ sandbox) · ไม่ส่ง = live · API key ไม่ใช้ header นี้ (โหมดตาม key) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | จำนวนต่อสถานะ (แท็บ) + limit ของแพ็กเกจ | `WebhookSummaryDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settings:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/webhooks/summary" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/webhooks/summary');
```

## GET /v1/webhooks/event-types {#get-webhooks-event-types}

`GET /v1/webhooks/event-types`

scope: `settings:read` · operationId: `Webhooks_eventTypes`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `X-Tms-Mode` | header |   | `string` ค่า: `live`, `test` | เฉพาะผู้ใช้ที่ login (UI): `test` = จัดการข้อมูลของ Sandbox ของบริษัท (key `tk_test_`, webhook ของ sandbox) · ไม่ส่ง = live · API key ไม่ใช้ header นี้ (โหมดตาม key) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | ทะเบียน event สาธารณะ: คำอธิบาย, ระยะ (`active` = ยิงแล้ว / `pending` = รอโมดูล — สมัครรอได้), JSON schema ของ `data.object` และตัวอย่าง (ข้อมูลสมมติ) — schema เดียวกับ `components.schemas.WebhookEvent_*` ใน openapi.json | `WebhookEventTypeListDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settings:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/webhooks/event-types" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/webhooks/event-types');
```

## GET /v1/webhooks/{id} {#get-webhooks-id}

`GET /v1/webhooks/{id}`

scope: `settings:read` · operationId: `Webhooks_get`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `X-Tms-Mode` | header |   | `string` ค่า: `live`, `test` | เฉพาะผู้ใช้ที่ login (UI): `test` = จัดการข้อมูลของ Sandbox ของบริษัท (key `tk_test_`, webhook ของ sandbox) · ไม่ส่ง = live · API key ไม่ใช้ header นี้ (โหมดตาม key) |
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `WebhookEndpointDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settings:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/webhooks/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/webhooks/{id}', {
  params: { path: { id: "…" } },
});
```

## GET /v1/webhooks/{id}/history {#get-webhooks-id-history}

`GET /v1/webhooks/{id}/history`

scope: `settings:read` · operationId: `Webhooks_history`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `X-Tms-Mode` | header |   | `string` ค่า: `live`, `test` | เฉพาะผู้ใช้ที่ login (UI): `test` = จัดการข้อมูลของ Sandbox ของบริษัท (key `tk_test_`, webhook ของ sandbox) · ไม่ส่ง = live · API key ไม่ใช้ header นี้ (โหมดตาม key) |
| `id` | path | ใช่ | `string` |   |
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | ประวัติจาก audit log ใหม่สุดก่อน | `AuditPageDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settings:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/webhooks/<id>/history" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/webhooks/{id}/history', {
  params: { path: { id: "…" } },
});
```

## GET /v1/webhook-deliveries {#get-webhook-deliveries}

`GET /v1/webhook-deliveries`

scope: `settings:read` · operationId: `WebhookDeliveries_list`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `X-Tms-Mode` | header |   | `string` ค่า: `live`, `test` | เฉพาะผู้ใช้ที่ login (UI): `test` = จัดการข้อมูลของ Sandbox ของบริษัท (key `tk_test_`, webhook ของ sandbox) · ไม่ส่ง = live · API key ไม่ใช้ header นี้ (โหมดตาม key) |
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน |
| `sort` | query |   | `string` ค่า: `sentAt`, `-sentAt` |   |
| `eventId` | query |   | `string` | id ของ event (`id` ใน envelope / header X-TMS-Event-Id) |
| `endpointId` | query |   | `string` |   |
| `status` | query |   | `string` | คั่นด้วย, เช่น `failed,exhausted` |
| `eventType` | query |   | `string` |   |
| `test` | query |   | `boolean` | true = เฉพาะ event ทดสอบ/ยืนยันปลายทาง · false = เฉพาะ event จริง |
| `sentFrom` | query |   | `string (date-time)` | ส่งตั้งแต่เวลานี้ |
| `sentTo` | query |   | `string (date-time)` | ส่งก่อนเวลานี้ |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | การส่งทีละครั้ง (1 แถว/attempt) ใหม่สุดก่อน · กรอง `eventId`, `endpointId`, `status`, `eventType`, `test`, ช่วงเวลา · เก็บ 30 วัน | `WebhookDeliveryPageDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settings:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/webhook-deliveries" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/webhook-deliveries');
```

## GET /v1/webhook-deliveries/{id} {#get-webhook-deliveries-id}

`GET /v1/webhook-deliveries/{id}`

scope: `settings:read` · operationId: `WebhookDeliveries_get`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `X-Tms-Mode` | header |   | `string` ค่า: `live`, `test` | เฉพาะผู้ใช้ที่ login (UI): `test` = จัดการข้อมูลของ Sandbox ของบริษัท (key `tk_test_`, webhook ของ sandbox) · ไม่ส่ง = live · API key ไม่ใช้ header นี้ (โหมดตาม key) |
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | รายละเอียด + payload ที่ส่ง/response ที่ได้ · ค่า header เพิ่มเติมเป็น `***` · ลายเซ็นแสดงบางส่วน | `WebhookDeliveryDetailDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settings:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/webhook-deliveries/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/webhook-deliveries/{id}', {
  params: { path: { id: "…" } },
});
```

## GET /v1/events {#get-events}

`GET /v1/events`

scope: `events:read` · operationId: `Events_listEvents`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `X-Tms-Mode` | header |   | `string` ค่า: `live`, `test` | เฉพาะผู้ใช้ที่ login (UI): `test` = จัดการข้อมูลของ Sandbox ของบริษัท (key `tk_test_`, webhook ของ sandbox) · ไม่ส่ง = live · API key ไม่ใช้ header นี้ (โหมดตาม key) |
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน (ใช้กับ sort เดิม) |
| `sort` | query |   | `string` ค่า: `occurredAt`, `-occurredAt` |   |
| `type` | query |   | `string` | ชนิด event คั่นด้วย, (ชื่อใน `GET /v1/webhooks/event-types`) |
| `occurredFrom` | query |   | `string` | เกิดตั้งแต่ (ISO 8601) |
| `occurredTo` | query |   | `string` | เกิดก่อน (ISO 8601) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | event สาธารณะของบริษัท (envelope เดียวกับ webhook — ดึงเองแทน/เสริม webhook) ใหม่สุดก่อน · กรอง `type`, ช่วงเวลา · ไม่ขึ้นกับการสมัคร endpoint · scope `events:read` **และ** scope อ่านของ resource ของ event (order.*/delivery_order.* → `orders:read`, trip.*/stop.*/pod.* → `trips:read`, connector.* → `settings:read`, job.* → `jobs:read`) — ชนิดที่อ่านไม่ได้ไม่อยู่ในรายการ · `type` ที่ไม่อยู่ในทะเบียน → 422 · field ราคาถูกตัดตามสิทธิ์ · `mode` = `test` ใน sandbox · ⚠ `evt_` ของ envelope เป็นคนละชุดกับ id ของ event หน้างาน (`GET /v1/stops/{id}/events`) | `EventPageDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`events:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/events" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/events');
```

## GET /v1/events/{id} {#get-events-id}

`GET /v1/events/{id}`

scope: `events:read` · operationId: `Events_getEvent`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `X-Tms-Mode` | header |   | `string` ค่า: `live`, `test` | เฉพาะผู้ใช้ที่ login (UI): `test` = จัดการข้อมูลของ Sandbox ของบริษัท (key `tk_test_`, webhook ของ sandbox) · ไม่ส่ง = live · API key ไม่ใช้ header นี้ (โหมดตาม key) |
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | envelope ของ event (id เดียวกับ X-TMS-Event-Id) · อ่าน resource ของ event ไม่ได้ / ไม่ใช่ event สาธารณะ = 404 | `EventDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`events:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/events/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/events/{id}', {
  params: { path: { id: "…" } },
});
```

## Schema ของ response {#schemas}

### AuditPageDto {#schema-AuditPageDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<AuditEntryDto>` |   |   |   |
| `nextCursor` | ใช่ | `string` | null ได้ |   |   |
| `hasMore` | ใช่ | `boolean` |   |   |   |

### EventDto {#schema-EventDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   | id เดียวกับ envelope / header X-TMS-Event-Id | `evt_8f3a…` |
| `type` | ใช่ | `string` |   |   | `order.created` |
| `version` | ใช่ | `string` |   |   | `1` |
| `occurredAt` | ใช่ | `string (date-time)` |   |   |   |
| `tenantId` | ใช่ | `string` |   |   | `ten_…` |
| `mode` | ใช่ | `string` | ค่า: `live`, `test` |   |   |
| `data` | ใช่ | `EventDataDto` |   |   |   |
| `request` | ใช่ | `EventRequestDto` |   |   |   |

### EventPageDto {#schema-EventPageDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<EventDto>` |   |   |   |
| `nextCursor` | ใช่ | `string` | null ได้ |   |   |
| `hasMore` | ใช่ | `boolean` |   |   |   |

### WebhookDeliveryDetailDto {#schema-WebhookDeliveryDetailDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `whd_8f3a…` |
| `endpointId` | ใช่ | `string` |   |   | `whe_8f3a…` |
| `eventId` | ใช่ | `string` |   | id ใน envelope — เท่ากันทุกครั้งที่ส่ง event เดิม (ผู้รับกันซ้ำด้วยค่านี้) | `evt_8f3a…` |
| `eventType` | ใช่ | `string` |   |   | `order.created` |
| `attempt` | ใช่ | `number` |   | ครั้งที่ส่ง (= header X-TMS-Attempt) |   |
| `test` | ใช่ | `boolean` |   | event ทดสอบ / ยืนยันปลายทาง (ส่งซ้ำไม่ได้) |   |
| `status` | ใช่ | `string` | ค่า: `delivered`, `failed`, `exhausted` |   |   |
| `requestUrl` | ใช่ | `string` |   |   | `https://erp.example.co.th/tms/webhook` |
| `responseStatus` | ใช่ | `number` | null ได้ | HTTP status (null = ไม่ได้ response) |   |
| `durationMs` | ใช่ | `number` |   |   |   |
| `errorCode` | ใช่ | `string` | ค่า: `http_status`, `redirect`, `timeout`, `network`, `ssrf_blocked`, `invalid_url`, `invalid_request` · null ได้ |   |   |
| `sentAt` | ใช่ | `string (date-time)` |   |   |   |
| `nextRetryAt` | ใช่ | `string (date-time)` | null ได้ | เวลาลองใหม่อัตโนมัติครั้งถัดไป (status = failed) |   |
| `requestHeaders` | ใช่ | `object` |   | header ที่ส่ง — ค่าของ header เพิ่มเติมแสดงเป็น `***` · ลายเซ็นแสดงบางส่วน (ไม่มี secret) |   |
| `requestBody` | ใช่ | `string` | null ได้ | body ที่ส่ง (JSON envelope) — field ราคาที่ผู้ดูไม่มีสิทธิ์ `prices.sell:read`/`prices.buy:read` ถูกตัดออก · body ที่ไม่ใช่ JSON ต้องมีทั้งสองสิทธิ์ ไม่งั้น null |   |
| `responseBody` | ใช่ | `string` | null ได้ | body ที่ผู้รับตอบ (ตัดที่ 4 KB) |   |
| `errorMessage` | ใช่ | `string` | null ได้ | รายละเอียดข้อผิดพลาดการเชื่อมต่อ |   |

### WebhookDeliveryPageDto {#schema-WebhookDeliveryPageDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<WebhookDeliveryDto>` |   |   |   |
| `nextCursor` | ใช่ | `string` | null ได้ |   |   |
| `hasMore` | ใช่ | `boolean` |   |   |   |

### WebhookEndpointDto {#schema-WebhookEndpointDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `whe_8f3a…` |
| `url` | ใช่ | `string` |   |   | `https://erp.example.co.th/tms/webhook` |
| `description` | ใช่ | `string` | null ได้ |   |   |
| `events` | ใช่ | `array<string>` |   |   | `["order.created","trip.dispatched"]` |
| `extraHeaderNames` | ใช่ | `array<string>` |   | ชื่อ header เพิ่มเติม (ค่าไม่แสดง — อาจเป็น credential ของผู้รับ) | `["X-Client-Id"]` |
| `status` | ใช่ | `string` | ค่า: `active`, `failing`, `disabled`, `auto_disabled` |   |   |
| `consecutiveFailures` | ใช่ | `number` |   | event ที่ล้มเหลวขั้นสุดท้ายติดกัน (ครบ 50 → ปิดอัตโนมัติ) |   |
| `successRate7d` | ใช่ | `number` | null ได้ | อัตราส่งสำเร็จ 7 วัน (% ของครั้งที่ส่ง event จริง — ไม่นับ event ทดสอบ) · null = ยังไม่มีการส่ง | `99.6` |
| `lastDeliveryAt` | ใช่ | `string (date-time)` | null ได้ |   |   |
| `lastSuccessAt` | ใช่ | `string (date-time)` | null ได้ |   |   |
| `verifiedAt` | ใช่ | `string (date-time)` | null ได้ | ผู้รับตอบ challenge ของ `webhook.verification` ถูกต้อง (ไม่บังคับ — ไม่บล็อกการส่ง) |   |
| `secretRotatedAt` | ใช่ | `string (date-time)` | null ได้ |   |   |
| `previousSecretExpiresAt` | ใช่ | `string (date-time)` | null ได้ | หลังหมุน secret: ส่ง 2 ลายเซ็น (ใหม่ + เดิม) ถึงเวลานี้ |   |
| `disabledAt` | ใช่ | `string (date-time)` | null ได้ |   |   |
| `disabledReason` | ใช่ | `string` | null ได้ |   |   |
| `createdBy` | ใช่ | `string` | null ได้ | ผู้สร้าง (usr_…) |   |
| `createdByName` | ใช่ | `string` | null ได้ |   |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string (date-time)` |   |   |   |
| `updatedAt` | ใช่ | `string (date-time)` |   |   |   |

### WebhookEventTypeListDto {#schema-WebhookEventTypeListDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<WebhookEventTypeDto>` |   |   |   |

### WebhookPageDto {#schema-WebhookPageDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<WebhookEndpointDto>` |   |   |   |
| `nextCursor` | ใช่ | `string` | null ได้ |   |   |
| `hasMore` | ใช่ | `boolean` |   |   |   |

### WebhookSummaryDto {#schema-WebhookSummaryDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `all` | ใช่ | `number` |   |   |   |
| `active` | ใช่ | `number` |   |   |   |
| `failing` | ใช่ | `number` |   |   |   |
| `disabled` | ใช่ | `number` |   | ปิด (ผู้ใช้ปิด + ระบบปิดอัตโนมัติ) |   |
| `limit` | ใช่ | `number` | null ได้ | จำนวน endpoint ที่แพ็กเกจให้ (null = ไม่จำกัด) |   |
