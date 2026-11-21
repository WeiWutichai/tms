# Sandbox

1 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`POST /v1/test/events/trigger`](#post-test-events-trigger) | `settings:read` |

## POST /v1/test/events/trigger {#post-test-events-trigger}

`POST /v1/test/events/trigger`

scope: `settings:read` · operationId: `TestEvents_trigger`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `X-Tms-Mode` | header |   | `string` ค่า: `live`, `test` | เฉพาะผู้ใช้ที่ login (UI): `test` = จัดการข้อมูลของ Sandbox ของบริษัท (key `tk_test_`, webhook ของ sandbox) · ไม่ส่ง = live · API key ไม่ใช้ header นี้ (โหมดตาม key) |

**Request body** `TriggerTestEventDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `type` | ใช่ | `string` | ค่า: `order.created`, `order.updated`, `order.held`, `order.released`, `order.cancelled`, `trip.assigned`, `trip.dispatched`, `trip.started`, `trip.completed`, `trip.cancelled`, `stop.arrived`, `stop.departed`, `stop.completed`, `stop.failed`, `delivery_order.status_changed`, `pod.captured`, `invoice.finalized`, `payment.recorded`, `payment.reversed`, `settlement.approved`, `settlement.paid`, `connector.health_changed`, `job.completed` | event สาธารณะที่ยิงได้ในเฟสนี้ (`phase: active` ใน `GET /v1/webhooks/event-types`) — `data.object` = ตัวอย่างตาม schema ของ event (ข้อมูลสมมติ) | `order.created` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | ยิงแล้วและส่งไป endpoint ของ sandbox ที่สมัคร event นี้ทันที (รอผลต่อ endpoint ≤ 10 วิ — ล้มตามรอบ retry ปกติ; ดูทุกครั้งที่ `GET /v1/webhook-deliveries?eventId=`) · นอก sandbox → 403 `sandbox_only` · event ที่ไม่อยู่ในทะเบียน/ยังไม่เปิด (pending) → 422 | `TriggerTestEventResultDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settings:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/test/events/trigger" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"type":"order.created"}'
```

```ts
const { data, error } = await tms.POST('/v1/test/events/trigger', {
  body: {
    "type": "order.created"
  },
});
```

## Schema ของ response {#schemas}

### TriggerTestEventResultDto {#schema-TriggerTestEventResultDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `eventId` | ใช่ | `string` |   | id ของ event (= `id` ใน envelope / `X-TMS-Event-Id`) | `evt_…` |
| `type` | ใช่ | `string` |   |   | `order.created` |
| `mode` | ใช่ | `string` | ค่า: `test` |   |   |
| `queued` | ใช่ | `number` |   | จำนวน webhook endpoint ของ sandbox ที่เปิดอยู่และสมัคร event นี้ (คำสั่งส่งใน outbox) · 0 = ไม่มีผู้รับ |   |
| `deliveries` | ใช่ | `array<TriggerDeliveryDto>` |   | ผลการส่งครั้งแรกต่อ endpoint |   |
| `object` | ใช่ | `object` |   | `data.object` ที่ส่ง |   |
