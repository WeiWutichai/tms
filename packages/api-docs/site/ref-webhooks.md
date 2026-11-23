# Webhooks และ events

18 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`GET /v1/webhooks`](#get-webhooks) | `settings:read` / `webhooks:manage` |
| [`POST /v1/webhooks`](#post-webhooks) | `settings:write` / `webhooks:manage` |
| [`GET /v1/webhooks/summary`](#get-webhooks-summary) | `settings:read` / `webhooks:manage` |
| [`GET /v1/webhooks/event-types`](#get-webhooks-event-types) | `settings:read` / `webhooks:manage` |
| [`GET /v1/webhooks/{id}`](#get-webhooks-id) | `settings:read` / `webhooks:manage` |
| [`PATCH /v1/webhooks/{id}`](#patch-webhooks-id) | `settings:write` / `webhooks:manage` |
| [`DELETE /v1/webhooks/{id}`](#delete-webhooks-id) | `settings:write` / `webhooks:manage` |
| [`GET /v1/webhooks/{id}/history`](#get-webhooks-id-history) | `settings:read` / `webhooks:manage` |
| [`POST /v1/webhooks/{id}/rotate-secret`](#post-webhooks-id-rotate-secret) | `settings:write` / `webhooks:manage` |
| [`POST /v1/webhooks/{id}/disable`](#post-webhooks-id-disable) | `settings:write` / `webhooks:manage` |
| [`POST /v1/webhooks/{id}/enable`](#post-webhooks-id-enable) | `settings:write` / `webhooks:manage` |
| [`POST /v1/webhooks/{id}/test`](#post-webhooks-id-test) | `settings:write` / `webhooks:manage` |
| [`GET /v1/webhook-deliveries`](#get-webhook-deliveries) | `settings:read` / `webhooks:manage` |
| [`GET /v1/webhook-deliveries/{id}`](#get-webhook-deliveries-id) | `settings:read` / `webhooks:manage` |
| [`POST /v1/webhook-deliveries/{id}/retry`](#post-webhook-deliveries-id-retry) | `settings:write` / `webhooks:manage` |
| [`GET /v1/events`](#get-events) | `events:read` |
| [`GET /v1/events/{id}`](#get-events-id) | `events:read` |
| [`POST /v1/events/{id}/redeliver`](#post-events-id-redeliver) | `settings:write` / `webhooks:manage` |

## GET /v1/webhooks {#get-webhooks}

`GET /v1/webhooks`

scope: `settings:read` หรือ `webhooks:manage` · operationId: `Webhooks_list`

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
| `403` | ไม่มีสิทธิ์ (`settings:read` / `webhooks:manage` — มีตัวใดตัวหนึ่งก็พอ) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
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

## POST /v1/webhooks {#post-webhooks}

`POST /v1/webhooks`

scope: `settings:write` หรือ `webhooks:manage` · operationId: `Webhooks_create`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `X-Tms-Mode` | header |   | `string` ค่า: `live`, `test` | เฉพาะผู้ใช้ที่ login (UI): `test` = จัดการข้อมูลของ Sandbox ของบริษัท (key `tk_test_`, webhook ของ sandbox) · ไม่ส่ง = live · API key ไม่ใช้ header นี้ (โหมดตาม key) |
| `X-Step-Up` | header |   | `string` | stepUpToken จาก `POST /v1/auth/step-up` (ยืนยัน TOTP อายุ 5 นาที) — ผู้ใช้ต้องส่งทุกครั้ง ไม่งั้น 403 `step_up_required` · API key / OAuth client ไม่ต้อง |

**Request body** `CreateWebhookDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `url` | ใช่ | `string` | ยาว ≤ 2048 | https:// เท่านั้น (dev/test ยอม http) · ห้าม IP ภายใน/localhost/metadata (กัน SSRF — ตรวจซ้ำทุกครั้งที่ส่ง) | `https://erp.example.co.th/tms/webhook` |
| `events` | ใช่ | `array<string>` |   | event ที่สมัคร (ชื่อเต็ม — ไม่รับ `*`) |   |
| `description` |   | `string` | ยาว ≤ 200 · null ได้ |   |   |
| `extraHeaders` |   | `array<WebhookHeaderDto>` |   | header เพิ่มเติม ≤ 5 รายการ (ห้ามทับ X-TMS-* / Content-Type) — เก็บเข้ารหัส |   |
| `extraHeaders[].name` | ใช่ | `string` | รูปแบบ `^[A-Za-z0-9-]{1,64}$` |   | `X-Client-Id` |
| `extraHeaders[].value` | ใช่ | `string` | ยาว ≤ 500 |   | `srithai-erp` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `201` | `secret` แสดงครั้งเดียว · ส่ง `webhook.verification` (challenge) หลังบันทึก 1 ครั้ง — ผลไม่บล็อก · ไม่รับ Idempotency-Key · เกิน limit ของแพ็กเกจ → 409 `webhook_limit_reached` | `WebhookEndpointSecretDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settings:write` / `webhooks:manage` — มีตัวใดตัวหนึ่งก็พอ) · ต้องยืนยัน 2FA ซ้ำ (`step_up_required`) — [permission_denied](errors.md#permission_denied), [step_up_required](errors.md#step_up_required) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/webhooks" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://erp.example.co.th/tms/webhook","events":["order.created"]}'
```

```ts
const { data, error } = await tms.POST('/v1/webhooks', {
  body: {
    "url": "https://erp.example.co.th/tms/webhook",
    "events": [
      "order.created"
    ]
  },
});
```

## GET /v1/webhooks/summary {#get-webhooks-summary}

`GET /v1/webhooks/summary`

scope: `settings:read` หรือ `webhooks:manage` · operationId: `Webhooks_summary`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `X-Tms-Mode` | header |   | `string` ค่า: `live`, `test` | เฉพาะผู้ใช้ที่ login (UI): `test` = จัดการข้อมูลของ Sandbox ของบริษัท (key `tk_test_`, webhook ของ sandbox) · ไม่ส่ง = live · API key ไม่ใช้ header นี้ (โหมดตาม key) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | จำนวนต่อสถานะ (แท็บ) + limit ของแพ็กเกจ | `WebhookSummaryDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settings:read` / `webhooks:manage` — มีตัวใดตัวหนึ่งก็พอ) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
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

scope: `settings:read` หรือ `webhooks:manage` · operationId: `Webhooks_eventTypes`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `X-Tms-Mode` | header |   | `string` ค่า: `live`, `test` | เฉพาะผู้ใช้ที่ login (UI): `test` = จัดการข้อมูลของ Sandbox ของบริษัท (key `tk_test_`, webhook ของ sandbox) · ไม่ส่ง = live · API key ไม่ใช้ header นี้ (โหมดตาม key) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | ทะเบียน event สาธารณะ: คำอธิบาย, ระยะ (`active` = ยิงแล้ว / `pending` = รอโมดูล — สมัครรอได้), JSON schema ของ `data.object` และตัวอย่าง (ข้อมูลสมมติ) — schema เดียวกับ `components.schemas.WebhookEvent_*` ใน openapi.json | `WebhookEventTypeListDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settings:read` / `webhooks:manage` — มีตัวใดตัวหนึ่งก็พอ) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
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

scope: `settings:read` หรือ `webhooks:manage` · operationId: `Webhooks_get`

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
| `403` | ไม่มีสิทธิ์ (`settings:read` / `webhooks:manage` — มีตัวใดตัวหนึ่งก็พอ) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
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

## PATCH /v1/webhooks/{id} {#patch-webhooks-id}

`PATCH /v1/webhooks/{id}`

scope: `settings:write` หรือ `webhooks:manage` · operationId: `Webhooks_update`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `X-Tms-Mode` | header |   | `string` ค่า: `live`, `test` | เฉพาะผู้ใช้ที่ login (UI): `test` = จัดการข้อมูลของ Sandbox ของบริษัท (key `tk_test_`, webhook ของ sandbox) · ไม่ส่ง = live · API key ไม่ใช้ header นี้ (โหมดตาม key) |
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |
| `X-Step-Up` | header |   | `string` | stepUpToken จาก `POST /v1/auth/step-up` (ยืนยัน TOTP อายุ 5 นาที) — ผู้ใช้ต้องส่งเมื่อเปลี่ยน `url` หรือ `extraHeaders` ไม่งั้น 403 `step_up_required` · API key / OAuth client ไม่ต้อง |

**Request body** `UpdateWebhookDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `url` |   | `string` | ยาว ≤ 2048 |   |   |
| `events` |   | `array<string>` |   |   |   |
| `description` |   | `string` | ยาว ≤ 200 · null ได้ |   |   |
| `extraHeaders` |   | `array<WebhookHeaderDto>` |   | แทนที่ header เพิ่มเติมทั้งชุด ([] = ล้าง) |   |
| `extraHeaders[].name` | ใช่ | `string` | รูปแบบ `^[A-Za-z0-9-]{1,64}$` |   | `X-Client-Id` |
| `extraHeaders[].value` | ใช่ | `string` | ยาว ≤ 500 |   | `srithai-erp` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | แก้ URL / event / คำอธิบาย / header เพิ่มเติม | `WebhookEndpointDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settings:write` / `webhooks:manage` — มีตัวใดตัวหนึ่งก็พอ) · ต้องยืนยัน 2FA ซ้ำ (`step_up_required`) เมื่อเปลี่ยน `url` หรือ `extraHeaders` — [permission_denied](errors.md#permission_denied), [step_up_required](errors.md#step_up_required) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PATCH "$TMS_BASE_URL/v1/webhooks/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

```ts
const { data, error } = await tms.PATCH('/v1/webhooks/{id}', {
  params: { path: { id: "…" } },
  body: {},
});
```

## DELETE /v1/webhooks/{id} {#delete-webhooks-id}

`DELETE /v1/webhooks/{id}`

scope: `settings:write` หรือ `webhooks:manage` · operationId: `Webhooks_remove`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `X-Tms-Mode` | header |   | `string` ค่า: `live`, `test` | เฉพาะผู้ใช้ที่ login (UI): `test` = จัดการข้อมูลของ Sandbox ของบริษัท (key `tk_test_`, webhook ของ sandbox) · ไม่ส่ง = live · API key ไม่ใช้ header นี้ (โหมดตาม key) |
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `WebhookReasonDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `เลิกใช้บริการตั้งแต่ ธ.ค. 2569` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `204` | ลบ (เหตุผล ≥ 10 ตัว · เก็บประวัติการส่งตาม retention) — หยุดส่งทันที |   |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settings:write` / `webhooks:manage` — มีตัวใดตัวหนึ่งก็พอ) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X DELETE "$TMS_BASE_URL/v1/webhooks/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"reason":"เลิกใช้บริการตั้งแต่ ธ.ค. 2569"}'
```

```ts
const { data, error } = await tms.DELETE('/v1/webhooks/{id}', {
  params: { path: { id: "…" } },
  body: {
    "reason": "เลิกใช้บริการตั้งแต่ ธ.ค. 2569"
  },
});
```

## GET /v1/webhooks/{id}/history {#get-webhooks-id-history}

`GET /v1/webhooks/{id}/history`

scope: `settings:read` หรือ `webhooks:manage` · operationId: `Webhooks_history`

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
| `403` | ไม่มีสิทธิ์ (`settings:read` / `webhooks:manage` — มีตัวใดตัวหนึ่งก็พอ) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
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

## POST /v1/webhooks/{id}/rotate-secret {#post-webhooks-id-rotate-secret}

`POST /v1/webhooks/{id}/rotate-secret`

scope: `settings:write` หรือ `webhooks:manage` · operationId: `Webhooks_rotate`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `X-Tms-Mode` | header |   | `string` ค่า: `live`, `test` | เฉพาะผู้ใช้ที่ login (UI): `test` = จัดการข้อมูลของ Sandbox ของบริษัท (key `tk_test_`, webhook ของ sandbox) · ไม่ส่ง = live · API key ไม่ใช้ header นี้ (โหมดตาม key) |
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |
| `X-Step-Up` | header |   | `string` | stepUpToken จาก `POST /v1/auth/step-up` (ยืนยัน TOTP อายุ 5 นาที) — ผู้ใช้ต้องส่งทุกครั้ง ไม่งั้น 403 `step_up_required` · API key ใช้ route นี้ไม่ได้ |

**Request body** `WebhookActionDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` |   | `string` | ยาว ≤ 500 |   |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `201` | secret ใหม่ (แสดงครั้งเดียว) · 24 ชม. ส่ง `v1` ของ secret ใหม่และเดิมคู่กัน · ไม่รับ Idempotency-Key · **ผู้ใช้ที่ step-up เท่านั้น** — API key ได้ 403 `step_up_required` แม้มี `webhooks:manage` | `WebhookEndpointSecretDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settings:write` / `webhooks:manage` — มีตัวใดตัวหนึ่งก็พอ) · ต้องยืนยัน 2FA ซ้ำ (`step_up_required`) — [permission_denied](errors.md#permission_denied), [step_up_required](errors.md#step_up_required) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/webhooks/<id>/rotate-secret" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{}'
```

```ts
const { data, error } = await tms.POST('/v1/webhooks/{id}/rotate-secret', {
  params: { path: { id: "…" } },
  body: {},
});
```

## POST /v1/webhooks/{id}/disable {#post-webhooks-id-disable}

`POST /v1/webhooks/{id}/disable`

scope: `settings:write` หรือ `webhooks:manage` · operationId: `Webhooks_disable`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `X-Tms-Mode` | header |   | `string` ค่า: `live`, `test` | เฉพาะผู้ใช้ที่ login (UI): `test` = จัดการข้อมูลของ Sandbox ของบริษัท (key `tk_test_`, webhook ของ sandbox) · ไม่ส่ง = live · API key ไม่ใช้ header นี้ (โหมดตาม key) |
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `WebhookReasonDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `เลิกใช้บริการตั้งแต่ ธ.ค. 2569` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | ปิดใช้งาน — event ใหม่ไม่เข้าคิว · ที่ค้างอยู่ถูกข้าม | `WebhookEndpointDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settings:write` / `webhooks:manage` — มีตัวใดตัวหนึ่งก็พอ) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/webhooks/<id>/disable" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"เลิกใช้บริการตั้งแต่ ธ.ค. 2569"}'
```

```ts
const { data, error } = await tms.POST('/v1/webhooks/{id}/disable', {
  params: { path: { id: "…" } },
  body: {
    "reason": "เลิกใช้บริการตั้งแต่ ธ.ค. 2569"
  },
});
```

## POST /v1/webhooks/{id}/enable {#post-webhooks-id-enable}

`POST /v1/webhooks/{id}/enable`

scope: `settings:write` หรือ `webhooks:manage` · operationId: `Webhooks_enable`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `X-Tms-Mode` | header |   | `string` ค่า: `live`, `test` | เฉพาะผู้ใช้ที่ login (UI): `test` = จัดการข้อมูลของ Sandbox ของบริษัท (key `tk_test_`, webhook ของ sandbox) · ไม่ส่ง = live · API key ไม่ใช้ header นี้ (โหมดตาม key) |
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `WebhookActionDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` |   | `string` | ยาว ≤ 500 |   |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | เปิดใช้อีกครั้ง (รวมที่ระบบปิดอัตโนมัติ) — ตัวนับล้มเหลวเริ่มใหม่ | `WebhookEndpointDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settings:write` / `webhooks:manage` — มีตัวใดตัวหนึ่งก็พอ) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/webhooks/<id>/enable" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{}'
```

```ts
const { data, error } = await tms.POST('/v1/webhooks/{id}/enable', {
  params: { path: { id: "…" } },
  body: {},
});
```

## POST /v1/webhooks/{id}/test {#post-webhooks-id-test}

`POST /v1/webhooks/{id}/test`

scope: `settings:write` หรือ `webhooks:manage` · operationId: `Webhooks_test`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `X-Tms-Mode` | header |   | `string` ค่า: `live`, `test` | เฉพาะผู้ใช้ที่ login (UI): `test` = จัดการข้อมูลของ Sandbox ของบริษัท (key `tk_test_`, webhook ของ sandbox) · ไม่ส่ง = live · API key ไม่ใช้ header นี้ (โหมดตาม key) |
| `id` | path | ใช่ | `string` |   |

**Request body** `WebhookTestDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `eventType` |   | `string` | ค่า: `order.created`, `order.updated`, `order.held`, `order.released`, `order.cancelled`, `trip.assigned`, `trip.dispatched`, `trip.started`, `trip.completed`, `trip.cancelled`, `stop.arrived`, `stop.departed`, `stop.completed`, `stop.failed`, `delivery_order.status_changed`, `pod.captured`, `invoice.finalized`, `invoice.adjusted`, `invoice.paid`, `invoice.voided`, `credit_note.finalized`, `debit_note.finalized`, `payment.recorded`, `payment.reversed`, `receipt.issued`, `settlement.approved`, `settlement.paid`, `wht_certificate.issued`, `connector.health_changed`, `reconcile.mismatch_found`, `job.completed` | event ตัวอย่างใน payload ของ `webhook.test` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | ส่ง `webhook.test` ทันที (รอผลไม่เกิน 10 วิ) — ไม่นับอัตราสำเร็จ · endpoint ปิดอยู่ → 409 | `WebhookTestResultDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settings:write` / `webhooks:manage` — มีตัวใดตัวหนึ่งก็พอ) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/webhooks/<id>/test" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{}'
```

```ts
const { data, error } = await tms.POST('/v1/webhooks/{id}/test', {
  params: { path: { id: "…" } },
  body: {},
});
```

## GET /v1/webhook-deliveries {#get-webhook-deliveries}

`GET /v1/webhook-deliveries`

scope: `settings:read` หรือ `webhooks:manage` · operationId: `WebhookDeliveries_list`

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
| `403` | ไม่มีสิทธิ์ (`settings:read` / `webhooks:manage` — มีตัวใดตัวหนึ่งก็พอ) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
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

scope: `settings:read` หรือ `webhooks:manage` · operationId: `WebhookDeliveries_get`

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
| `403` | ไม่มีสิทธิ์ (`settings:read` / `webhooks:manage` — มีตัวใดตัวหนึ่งก็พอ) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
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

## POST /v1/webhook-deliveries/{id}/retry {#post-webhook-deliveries-id-retry}

`POST /v1/webhook-deliveries/{id}/retry`

scope: `settings:write` หรือ `webhooks:manage` · operationId: `WebhookDeliveries_retry`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `X-Tms-Mode` | header |   | `string` ค่า: `live`, `test` | เฉพาะผู้ใช้ที่ login (UI): `test` = จัดการข้อมูลของ Sandbox ของบริษัท (key `tk_test_`, webhook ของ sandbox) · ไม่ส่ง = live · API key ไม่ใช้ header นี้ (โหมดตาม key) |
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | ส่ง event ของรายการนี้ไป endpoint เดิมอีกครั้งผ่าน outbox (id เดิม, X-TMS-Attempt +1) รอผล ≤ 10 วิ · event ทดสอบ → 422 `webhook_not_retryable` · endpoint ปิด → 409 · เกิน 30 วัน → 422 `webhook_event_expired` · ถี่เกิน → 429 | `WebhookResendResultDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settings:write` / `webhooks:manage` — มีตัวใดตัวหนึ่งก็พอ) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/webhook-deliveries/<id>/retry" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)"
```

```ts
const { data, error } = await tms.POST('/v1/webhook-deliveries/{id}/retry', {
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

## POST /v1/events/{id}/redeliver {#post-events-id-redeliver}

`POST /v1/events/{id}/redeliver`

scope: `settings:write` หรือ `webhooks:manage` · operationId: `Events_redeliver`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `X-Tms-Mode` | header |   | `string` ค่า: `live`, `test` | เฉพาะผู้ใช้ที่ login (UI): `test` = จัดการข้อมูลของ Sandbox ของบริษัท (key `tk_test_`, webhook ของ sandbox) · ไม่ส่ง = live · API key ไม่ใช้ header นี้ (โหมดตาม key) |
| `id` | path | ใช่ | `string` |   |
| `endpointId` | query |   | `string` | ส่งเฉพาะ endpoint นี้ · ไม่ระบุ = ทุก endpoint ที่เปิดอยู่และสมัคร event ชนิดนี้ |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | ส่ง event ซ้ำไป `endpointId` หรือทุก endpoint ที่เปิดอยู่และสมัคร event นี้ · ผ่าน outbox รอผล ≤ 10 วิ ต่อ endpoint · ภายใน 30 วัน · ไม่ได้สมัคร → 422 `webhook_event_not_subscribed` | `WebhookRedeliverResultDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settings:write` / `webhooks:manage` — มีตัวใดตัวหนึ่งก็พอ) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/events/<id>/redeliver" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)"
```

```ts
const { data, error } = await tms.POST('/v1/events/{id}/redeliver', {
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

### WebhookEndpointSecretDto {#schema-WebhookEndpointSecretDto}



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
| `secret` | ใช่ | `string` |   | signing secret (HMAC-SHA256 ของ `t.rawBody`) — แสดงครั้งเดียว | `whsec_Zx81…` |

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

### WebhookRedeliverResultDto {#schema-WebhookRedeliverResultDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<WebhookResendResultDto>` |   |   |   |

### WebhookResendResultDto {#schema-WebhookResendResultDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `endpointId` | ใช่ | `string` |   |   | `whe_8f3a…` |
| `eventId` | ใช่ | `string` |   |   | `evt_8f3a…` |
| `attempt` | ใช่ | `number` |   | ครั้งที่ส่ง (X-TMS-Attempt) — ต่อจากครั้งล่าสุดของ event นี้ที่ endpoint นี้ |   |
| `state` | ใช่ | `string` | ค่า: `delivered`, `failed`, `queued`, `skipped` | delivered = ผู้รับตอบ 2xx · failed = ไม่สำเร็จ (ไม่ลองใหม่อัตโนมัติ) · queued = เข้าคิวแล้ว worker จะส่ง · skipped = endpoint ถูกปิดระหว่างส่ง |   |
| `deliveryId` | ใช่ | `string` | null ได้ |   | `whd_8f3a…` |
| `status` | ใช่ | `number` | null ได้ |   |   |
| `durationMs` | ใช่ | `number` | null ได้ |   |   |
| `errorCode` | ใช่ | `string` | ค่า: `http_status`, `redirect`, `timeout`, `network`, `ssrf_blocked`, `invalid_url`, `invalid_request` · null ได้ |   |   |

### WebhookSummaryDto {#schema-WebhookSummaryDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `all` | ใช่ | `number` |   |   |   |
| `active` | ใช่ | `number` |   |   |   |
| `failing` | ใช่ | `number` |   |   |   |
| `disabled` | ใช่ | `number` |   | ปิด (ผู้ใช้ปิด + ระบบปิดอัตโนมัติ) |   |
| `limit` | ใช่ | `number` | null ได้ | จำนวน endpoint ที่แพ็กเกจให้ (null = ไม่จำกัด) |   |

### WebhookTestResultDto {#schema-WebhookTestResultDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `delivered` | ใช่ | `boolean` |   | ปลายทางตอบ 2xx |   |
| `status` | ใช่ | `number` | null ได้ | HTTP status (null = ไม่ได้ response) |   |
| `durationMs` | ใช่ | `number` |   |   |   |
| `errorCode` | ใช่ | `string` | ค่า: `http_status`, `redirect`, `timeout`, `network`, `ssrf_blocked`, `invalid_url` · null ได้ |   |   |
| `eventId` | ใช่ | `string` |   | id ของ envelope ที่ส่ง | `evt_…` |
