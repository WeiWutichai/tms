# ส่งข้อความ (messaging)

5 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`POST /v1/messages/send-link`](#post-messages-send-link) | `master:write` / `trips:assign` |
| [`GET /v1/messages`](#get-messages) | `master:read` / `trips:read` |
| [`GET /v1/messages/channels`](#get-messages-channels) | `master:read` / `trips:read` |
| [`GET /v1/messages/{id}`](#get-messages-id) | `master:read` / `trips:read` |
| [`GET /v1/settings/messaging`](#get-settings-messaging) | `settings:read` |

## POST /v1/messages/send-link {#post-messages-send-link}

`POST /v1/messages/send-link`

scope: `master:write` หรือ `trips:assign` · operationId: `Messages_send`

**Request body** `SendLinkDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `channel` | ใช่ | `string` | ค่า: `line`, `sms` | ช่องทาง |   |
| `url` | ใช่ | `string` |   | URL ลิงก์ที่ระบบออกให้ (เช่น `url` จาก POST /v1/carriers/{id}/upload-links) — ต้องเป็นลิงก์ที่ยังใช้ได้ของบริษัทนี้ ระบบเลือก template + สิทธิ์ตามชนิดลิงก์ (carrier_docs → `master:write`; trip_offer ยังส่งไม่ได้จนถึง ST3-T23) · ผู้รับ = ช่องทางที่บันทึกไว้ของผู้รับเหมาเจ้าของลิงก์ (เบอร์มือถือ / LINE userId) — ระบุผู้รับเองไม่ได้ |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `202` | เข้าคิวส่งแล้ว (status `queued`) — worker ส่งจริงพร้อม retry; ติดตามผลที่ GET /v1/messages/{id} · ส่งไม่ได้/ล้ม ผู้ใช้ยังคัดลอก url ไปส่งเองได้เสมอ | `MessageDeliveryDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write` / `trips:assign` — มีตัวใดตัวหนึ่งก็พอ) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `409` | `channel_unavailable` — ช่องทางปิดหรือยังไม่ตั้งค่า |   |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | เกินเพดานต่อบริษัท/ชั่วโมง หรือต่อผู้รับ/ชั่วโมง | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/messages/send-link" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"channel":"line","url":"string"}'
```

```ts
const { data, error } = await tms.POST('/v1/messages/send-link', {
  body: {
    "channel": "line",
    "url": "string"
  },
});
```

## GET /v1/messages {#get-messages}

`GET /v1/messages`

scope: `master:read` หรือ `trips:read` · operationId: `Messages_list`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน |
| `carrierId` | query |   | `string` | เฉพาะที่ส่งถึงผู้รับเหมารายนี้ |
| `linkId` | query |   | `string` | เฉพาะลิงก์นี้ |
| `channel` | query |   | `string` ค่า: `line`, `sms` |   |
| `status` | query |   | `string` ค่า: `queued`, `sending`, `sent`, `failed` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | บันทึกการส่ง ใหม่ → เก่า (เฉพาะชนิดลิงก์ที่มีสิทธิ์ดู) — ผู้รับแสดงแบบปิดบังเสมอ ไม่มีเนื้อความ | `MessageDeliveryPageDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read` / `trips:read` — มีตัวใดตัวหนึ่งก็พอ) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/messages" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/messages');
```

## GET /v1/messages/channels {#get-messages-channels}

`GET /v1/messages/channels`

scope: `master:read` หรือ `trips:read` · operationId: `Messages_channels`

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | ช่องทางที่ส่งได้ตอนนี้ — UI ซ่อนปุ่มส่งของช่องที่ใช้ไม่ได้ (เหลือคัดลอกลิงก์) | `ChannelStatusListDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read` / `trips:read` — มีตัวใดตัวหนึ่งก็พอ) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/messages/channels" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/messages/channels');
```

## GET /v1/messages/{id} {#get-messages-id}

`GET /v1/messages/{id}`

scope: `master:read` หรือ `trips:read` · operationId: `Messages_get`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `MessageDeliveryDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read` / `trips:read` — มีตัวใดตัวหนึ่งก็พอ) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/messages/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/messages/{id}', {
  params: { path: { id: "…" } },
});
```

## GET /v1/settings/messaging {#get-settings-messaging}

`GET /v1/settings/messaging`

scope: `settings:read` · operationId: `MessagingSettings_get`

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `MessagingSettingsDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settings:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/settings/messaging" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/settings/messaging');
```

## Schema ของ response {#schemas}

### ChannelStatusListDto {#schema-ChannelStatusListDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<ChannelStatusDto>` |   |   |   |

### MessageDeliveryDto {#schema-MessageDeliveryDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `msg_…` |
| `channel` | ใช่ | `string` | ค่า: `line`, `sms` |   |   |
| `template` | ใช่ | `string` |   |   | `carrier_docs_link` |
| `status` | ใช่ | `string` | ค่า: `queued`, `sending`, `sent`, `failed` |   |   |
| `recipient` | ใช่ | `string` |   | ผู้รับแบบปิดบัง (ไม่คืนค่าเต็มเสมอ) | `081•••5678` |
| `carrierId` | ใช่ | `string` | null ได้ |   | `car_…` |
| `linkId` | ใช่ | `string` | null ได้ |   | `mlk_…` |
| `entityType` | ใช่ | `string` | null ได้ |   |   |
| `entityId` | ใช่ | `string` | null ได้ | id แบบ opaque ของ entity |   |
| `attempts` | ใช่ | `number` |   |   |   |
| `provider` | ใช่ | `string` | null ได้ |   | `mock` |
| `providerMessageId` | ใช่ | `string` | null ได้ |   |   |
| `errorCode` | ใช่ | `string` | null ได้ | สาเหตุที่ส่งไม่สำเร็จ: provider_unavailable · provider_auth_failed · provider_rejected · not_configured · channel_disabled · lease_expired |   |
| `createdAt` | ใช่ | `string (date-time)` |   |   |   |
| `sentAt` | ใช่ | `string (date-time)` | null ได้ |   |   |
| `failedAt` | ใช่ | `string (date-time)` | null ได้ |   |   |
| `nextAttemptAt` | ใช่ | `string (date-time)` | null ได้ | รอบส่งถัดไป (ยังไม่จบ) |   |

### MessageDeliveryPageDto {#schema-MessageDeliveryPageDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<MessageDeliveryDto>` |   |   |   |
| `nextCursor` | ใช่ | `string` | null ได้ |   |   |
| `hasMore` | ใช่ | `boolean` |   |   |   |

### MessagingSettingsDto {#schema-MessagingSettingsDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `lineEnabled` | ใช่ | `boolean` |   | เปิดส่งทาง LINE OA |   |
| `lineConfigured` | ใช่ | `boolean` |   | ตั้ง channel access token แล้ว |   |
| `lineTokenHint` | ใช่ | `string` | null ได้ | 4 ตัวท้ายของ token | `•••• a1B2` |
| `smsEnabled` | ใช่ | `boolean` |   | เปิดส่ง SMS (บัญชีผู้ให้บริการระดับระบบ) |   |
| `lineProvider` | ใช่ | `string` | null ได้ | ผู้ให้บริการ LINE ที่ระบบใช้อยู่ | `line` |
| `smsProvider` | ใช่ | `string` | null ได้ | ผู้ให้บริการ SMS ที่ระบบใช้อยู่ | `http` |
| `version` | ใช่ | `number` |   |   |   |
| `updatedAt` | ใช่ | `string (date-time)` | null ได้ |   |   |
