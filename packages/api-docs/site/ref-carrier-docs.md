# เอกสารรถร่วม (carrier-docs)

6 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`GET /v1/carriers/{id}/upload-links`](#get-carriers-id-upload-links) | `master:read` |
| [`POST /v1/carriers/{id}/upload-links`](#post-carriers-id-upload-links) | `master:write` |
| [`POST /v1/carrier-upload-links/{id}/revoke`](#post-carrier-upload-links-id-revoke) | `master:write` |
| [`GET /v1/carrier-doc-submissions`](#get-carrier-doc-submissions) | `master:read` |
| [`POST /v1/carrier-doc-submissions/{id}/approve`](#post-carrier-doc-submissions-id-approve) | `master:write` |
| [`POST /v1/carrier-doc-submissions/{id}/reject`](#post-carrier-doc-submissions-id-reject) | `master:write` |

## GET /v1/carriers/{id}/upload-links {#get-carriers-id-upload-links}

`GET /v1/carriers/{id}/upload-links`

scope: `master:read` · operationId: `CarrierDocs_links`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | ลิงก์ที่เคยออก (ไม่มี token) ใหม่สุดก่อน | `UploadLinkListDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/carriers/<id>/upload-links" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/carriers/{id}/upload-links', {
  params: { path: { id: "…" } },
});
```

## POST /v1/carriers/{id}/upload-links {#post-carriers-id-upload-links}

`POST /v1/carriers/{id}/upload-links`

scope: `master:write` · operationId: `CarrierDocs_issue`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |

**Request body** `CreateUploadLinkDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `ttlDays` |   | `number` | ≥ 1 · ≤ 30 | อายุลิงก์ (วัน) — ไม่ส่ง = 7 วัน |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `201` | ออกลิงก์อัปโหลดเอกสารให้ผู้รับเหมา — ส่งทาง LINE/SMS ด้วย POST /v1/messages/send-link (ST3-T21) หรือคัดลอก url ไปส่งเอง | `IssuedUploadLinkDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/carriers/<id>/upload-links" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{}'
```

```ts
const { data, error } = await tms.POST('/v1/carriers/{id}/upload-links', {
  params: { path: { id: "…" } },
  body: {},
});
```

## POST /v1/carrier-upload-links/{id}/revoke {#post-carrier-upload-links-id-revoke}

`POST /v1/carrier-upload-links/{id}/revoke`

scope: `master:write` · operationId: `CarrierDocs_revoke`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Request body** `MasterReasonDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `เลิกใช้บริการตั้งแต่ ธ.ค. 2569` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | เพิกถอน (เหตุผล ≥ 10 + audit) — คืนไม่ได้ | `UploadLinkDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/carrier-upload-links/<id>/revoke" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"เลิกใช้บริการตั้งแต่ ธ.ค. 2569"}'
```

```ts
const { data, error } = await tms.POST('/v1/carrier-upload-links/{id}/revoke', {
  params: { path: { id: "…" } },
  body: {
    "reason": "เลิกใช้บริการตั้งแต่ ธ.ค. 2569"
  },
});
```

## GET /v1/carrier-doc-submissions {#get-carrier-doc-submissions}

`GET /v1/carrier-doc-submissions`

scope: `master:read` · operationId: `CarrierDocs_list`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `carrierId` | query |   | `string` |   |
| `status` | query |   | `string` ค่า: `pending_review`, `approved`, `rejected` |   |
| `limit` | query |   | `number` | ไม่ส่ง = 100 |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | เอกสารที่รถร่วมส่งผ่านลิงก์ — รอตรวจขึ้นก่อน แล้วใหม่สุดก่อน | `CarrierDocSubmissionListDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/carrier-doc-submissions" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/carrier-doc-submissions');
```

## POST /v1/carrier-doc-submissions/{id}/approve {#post-carrier-doc-submissions-id-approve}

`POST /v1/carrier-doc-submissions/{id}/approve`

scope: `master:write` · operationId: `CarrierDocs_approve`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Request body** `MasterReasonDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `เลิกใช้บริการตั้งแต่ ธ.ค. 2569` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | อนุมัติ (เหตุผล ≥ 10 + audit) → เอกสารรถฉบับใหม่/ต่ออายุ หรืออัปเดตใบขับขี่ · ตรวจแล้ว → 409 · รถ/คนขับไม่อยู่กับผู้รับเหมาแล้ว → 409 `target_changed` | `CarrierDocSubmissionDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/carrier-doc-submissions/<id>/approve" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"เลิกใช้บริการตั้งแต่ ธ.ค. 2569"}'
```

```ts
const { data, error } = await tms.POST('/v1/carrier-doc-submissions/{id}/approve', {
  params: { path: { id: "…" } },
  body: {
    "reason": "เลิกใช้บริการตั้งแต่ ธ.ค. 2569"
  },
});
```

## POST /v1/carrier-doc-submissions/{id}/reject {#post-carrier-doc-submissions-id-reject}

`POST /v1/carrier-doc-submissions/{id}/reject`

scope: `master:write` · operationId: `CarrierDocs_reject`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Request body** `MasterReasonDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `เลิกใช้บริการตั้งแต่ ธ.ค. 2569` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | ไม่อนุมัติ (เหตุผล ≥ 10 บังคับ + audit) | `CarrierDocSubmissionDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/carrier-doc-submissions/<id>/reject" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"เลิกใช้บริการตั้งแต่ ธ.ค. 2569"}'
```

```ts
const { data, error } = await tms.POST('/v1/carrier-doc-submissions/{id}/reject', {
  params: { path: { id: "…" } },
  body: {
    "reason": "เลิกใช้บริการตั้งแต่ ธ.ค. 2569"
  },
});
```

## Schema ของ response {#schemas}

### CarrierDocSubmissionDto {#schema-CarrierDocSubmissionDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `cds_…` |
| `status` | ใช่ | `string` | ค่า: `pending_review`, `approved`, `rejected` |   |   |
| `carrier` | ใช่ | `SubjectCarrierDto` |   |   |   |
| `vehicle` | ใช่ | `SubjectVehicleDto` | null ได้ |   |   |
| `driver` | ใช่ | `SubjectDriverDto` | null ได้ |   |   |
| `docType` | ใช่ | `string` | ค่า: `INSURANCE`, `COMPULSORY_ACT`, `ANNUAL_TAX`, `INSPECTION`, `TRANSPORT_LICENSE`, `GPS_DLT_CERT`, `OTHER`, `DRIVER_LICENCE` |   |   |
| `title` | ใช่ | `string` | null ได้ |   |   |
| `targetDocumentId` | ใช่ | `string` | null ได้ | เอกสารรถฉบับที่จะต่ออายุ (OTHER) |   |
| `docNo` | ใช่ | `string` | null ได้ |   |   |
| `issuer` | ใช่ | `string` | null ได้ |   |   |
| `startsOn` | ใช่ | `string (date)` | null ได้ |   |   |
| `expiresOn` | ใช่ | `string (date)` |   |   |   |
| `files` | ใช่ | `array<SubmissionFileDto>` |   |   |   |
| `note` | ใช่ | `string` | null ได้ |   |   |
| `submittedAt` | ใช่ | `string (date-time)` |   |   |   |
| `reviewedAt` | ใช่ | `string (date-time)` | null ได้ |   |   |
| `reviewReason` | ใช่ | `string` | null ได้ | เหตุผลที่อนุมัติ/ไม่อนุมัติ |   |
| `resultDocumentId` | ใช่ | `string` | null ได้ | เอกสารรถที่เกิดจากการอนุมัติ (vdoc_…) |   |

### CarrierDocSubmissionListDto {#schema-CarrierDocSubmissionListDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<CarrierDocSubmissionDto>` |   |   |   |

### IssuedUploadLinkDto {#schema-IssuedUploadLinkDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `mlk_…` |
| `status` | ใช่ | `string` | ค่า: `active`, `expired`, `revoked` |   |   |
| `expiresAt` | ใช่ | `string (date-time)` |   |   |   |
| `createdAt` | ใช่ | `string (date-time)` |   |   |   |
| `lastUsedAt` | ใช่ | `string (date-time)` | null ได้ |   |   |
| `revokedAt` | ใช่ | `string (date-time)` | null ได้ |   |   |
| `revokedReason` | ใช่ | `string` | null ได้ |   |   |
| `url` | ใช่ | `string` |   | URL หน้าอัปโหลดสำหรับรถร่วม (เปิดบนมือถือได้โดยไม่ login) — แสดงครั้งเดียวตอนสร้าง · ส่งต่อด้วย POST /v1/messages/send-link หรือคัดลอกไปส่งเอง |   |
| `token` | ใช่ | `string` |   | token ของลิงก์ (อยู่ใน url แล้ว) |   |

### UploadLinkDto {#schema-UploadLinkDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `mlk_…` |
| `status` | ใช่ | `string` | ค่า: `active`, `expired`, `revoked` |   |   |
| `expiresAt` | ใช่ | `string (date-time)` |   |   |   |
| `createdAt` | ใช่ | `string (date-time)` |   |   |   |
| `lastUsedAt` | ใช่ | `string (date-time)` | null ได้ |   |   |
| `revokedAt` | ใช่ | `string (date-time)` | null ได้ |   |   |
| `revokedReason` | ใช่ | `string` | null ได้ |   |   |

### UploadLinkListDto {#schema-UploadLinkListDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<UploadLinkDto>` |   |   |   |
