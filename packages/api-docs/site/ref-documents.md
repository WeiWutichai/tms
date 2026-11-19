# ไฟล์และเอกสาร (documents)

4 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`POST /v1/documents`](#post-documents) | `documents:write` |
| [`GET /v1/documents/{id}`](#get-documents-id) | `documents:read` |
| [`GET /v1/documents/{id}/content`](#get-documents-id-content) |   |
| [`PUT /v1/documents/{id}/content`](#put-documents-id-content) |   |

## POST /v1/documents {#post-documents}

`POST /v1/documents`

scope: `documents:write` · operationId: `Documents_create`

**Request body** `CreateDocumentDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `kind` | ใช่ | `string` | ค่า: `POD_PHOTO`, `POD_SIGNATURE`, `POD_FILE`, `SIGNATURE`, `LOGO`, `PDF`, `VEHICLE_DOC`, `RECEIPT`, `WHT_CERT`, `CONTRACT`, `IMPORT`, `OTHER` |   |   |
| `mime` | ใช่ | `string` | ค่า: `application/pdf`, `image/png`, `image/jpeg`, `image/webp`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `text/csv` | ชนิดที่จะอัปโหลด — server ตรวจกับเนื้อไฟล์จริง |   |
| `bytes` | ใช่ | `number` |   | ขนาดไฟล์ (byte) ไม่เกิน 10485760 | `182044` |
| `filename` |   | `string` |   |   | `pod-SO-2611-0001.jpg` |
| `clientDocumentId` |   | `string` |   | id ฝั่ง client (อุปกรณ์) — ส่งซ้ำได้ ไม่สร้างแถวใหม่ |   |
| `entityType` |   | `string` |   |   | `trip_stop` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `201` |   | `DocumentDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`documents:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `409` | `clientDocumentId` นี้ถูกใช้แล้ว (คนอื่น/ชนิดอื่น/ขนาดอื่น) — [duplicate](errors.md#duplicate) | `ProblemDto` |
| `422` | ชนิด/ขนาดไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/documents" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"kind":"POD_PHOTO","mime":"application/pdf","bytes":182044,"filename":"pod-SO-2611-0001.jpg","entityType":"trip_stop"}'
```

```ts
const { data, error } = await tms.POST('/v1/documents', {
  body: {
    "kind": "POD_PHOTO",
    "mime": "application/pdf",
    "bytes": 182044,
    "filename": "pod-SO-2611-0001.jpg",
    "entityType": "trip_stop"
  },
});
```

## GET /v1/documents/{id} {#get-documents-id}

`GET /v1/documents/{id}`

scope: `documents:read` · operationId: `Documents_get`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `DocumentDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`documents:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/documents/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/documents/{id}', {
  params: { path: { id: "…" } },
});
```

## GET /v1/documents/{id}/content {#get-documents-id-content}

`GET /v1/documents/{id}/content`

scope: — · operationId: `Documents_download`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | เนื้อไฟล์ (Content-Type ตามไฟล์, attachment, no-store) |   |
| `404` | ลายเซ็นของ URL ผิด/หมดอายุ หรือไม่พบไฟล์ (ผิดเกิน 30 ครั้ง/นาที/IP → 429) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/documents/<id>/content" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/documents/{id}/content', {
  params: { path: { id: "…" } },
});
```

## PUT /v1/documents/{id}/content {#put-documents-id-content}

`PUT /v1/documents/{id}/content`

scope: — · operationId: `Documents_upload`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `DocumentDto` |
| `404` | ลายเซ็นของ URL ผิด/หมดอายุ หรือไม่พบไฟล์ (ผิดเกิน 30 ครั้ง/นาที/IP → 429) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | อัปโหลดแล้ว (ไฟล์เขียนครั้งเดียว) — [invalid_state_transition](errors.md#invalid_state_transition) | `ProblemDto` |
| `422` | ไฟล์ว่าง / ใหญ่กว่าที่จองไว้ / เนื้อไฟล์ไม่ตรงชนิดที่ประกาศ — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PUT "$TMS_BASE_URL/v1/documents/<id>/content" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.PUT('/v1/documents/{id}/content', {
  params: { path: { id: "…" } },
});
```

## Schema ของ response {#schemas}

### DocumentDto {#schema-DocumentDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `doc_…` |
| `status` | ใช่ | `string` | ค่า: `pending`, `ready`, `purged` | purged = ไฟล์ถูกลบตามระยะเก็บ — ดาวน์โหลดไม่ได้ (404) |   |
| `kind` | ใช่ | `string` |   |   |   |
| `mime` | ใช่ | `string` |   |   |   |
| `bytes` | ใช่ | `number` |   |   |   |
| `filename` | ใช่ | `string` | null ได้ |   |   |
| `sha256` | ใช่ | `string` | null ได้ |   |   |
| `createdAt` | ใช่ | `string (date-time)` |   |   |   |
| `uploadUrl` |   | `string` |   | สถานะ pending: PUT เนื้อไฟล์ไปที่นี่ (หมดอายุ 15 นาที) |   |
| `downloadUrl` |   | `string` |   | สถานะ ready: ลิงก์ดาวน์โหลด (หมดอายุ 5 นาที) |   |
| `urlExpiresAt` |   | `string (date-time)` |   |   |   |
