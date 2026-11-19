# ส่งออกไฟล์ (exports)

2 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`POST /v1/exports`](#post-exports) | `export:run` |
| [`GET /v1/exports/{id}`](#get-exports-id) | `export:run` |

## POST /v1/exports {#post-exports}

`POST /v1/exports`

scope: `export:run` · operationId: `Exports_create`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `Idempotency-Key` | header |   | `string` |   |

**Request body** `CreateExportDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `resource` | ใช่ | `string` | ค่า: `orders`, `customers`, `customer-sites`, `carriers`, `vehicles`, `vehicle-documents`, `drivers`, `vehicle-types`, `routes`, `products`, `service-items`, `rate-cards`, `reason-codes` |   | `orders` |
| `format` |   | `string` | ค่า: `xlsx`, `csv` | .xlsx (แนะนำ — เลข 0 นำหน้าไม่หาย) หรือ.csv UTF-8 + BOM |   |
| `filter` |   | `object` |   | ตัวกรองชุดเดียวกับ query ของ `GET /v1/{resource}` (ค่าเป็น string) — ตรวจกติกาเดียวกัน (field แปลก = 422) · `limit`/`cursor`/`sort`/`fields`/`updatedAfter` ไม่มีผล (ไฟล์มีทุกแถวที่ตรงตัวกรอง) | `{"held":"true","holdReason":"RATE_MISSING"}` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `202` | รับงานแล้ว — ต้องมี `export:run` + สิทธิ์อ่านของรายการนั้น (เช่น `orders:read`, `master:read`) · ไฟล์ไม่เกิน 100000 แถว · คอลัมน์ราคา/การเงินเฉพาะผู้มีสิทธิ์เห็น | `ExportAcceptedDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`export:run`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/exports" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"resource":"orders","filter":{"held":"true","holdReason":"RATE_MISSING"}}'
```

```ts
const { data, error } = await tms.POST('/v1/exports', {
  body: {
    "resource": "orders",
    "filter": {
      "held": "true",
      "holdReason": "RATE_MISSING"
    }
  },
});
```

## GET /v1/exports/{id} {#get-exports-id}

`GET /v1/exports/{id}`

scope: `export:run` · operationId: `Exports_get`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | งานส่งออกของผู้เรียกเท่านั้น (ของคนอื่น = 404) | `ExportDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`export:run`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/exports/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/exports/{id}', {
  params: { path: { id: "…" } },
});
```

## Schema ของ response {#schemas}

### ExportAcceptedDto {#schema-ExportAcceptedDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `job_…` |
| `jobId` | ใช่ | `string` |   |   | `job_…` |
| `statusUrl` | ใช่ | `string` |   |   | `/v1/exports/job_…` |
| `status` | ใช่ | `string` | ค่า: `pending` |   |   |

### ExportDto {#schema-ExportDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `job_…` |
| `resource` | ใช่ | `string` | ค่า: `orders`, `customers`, `customer-sites`, `carriers`, `vehicles`, `vehicle-documents`, `drivers`, `vehicle-types`, `routes`, `products`, `service-items`, `rate-cards`, `reason-codes` |   |   |
| `format` | ใช่ | `string` | ค่า: `xlsx`, `csv` |   |   |
| `filter` | ใช่ | `object` |   |   |   |
| `status` | ใช่ | `string` | ค่า: `pending`, `running`, `succeeded`, `failed`, `expired` | expired = ไฟล์เกิน 7 วันแล้ว (ส่งออกใหม่) |   |
| `progress` | ใช่ | `number` | ≥ 0 · ≤ 100 |   |   |
| `rows` | ใช่ | `number` | null ได้ |   |   |
| `fileName` | ใช่ | `string` | null ได้ |   |   |
| `bytes` | ใช่ | `number` | null ได้ |   |   |
| `error` | ใช่ | `ExportErrorDto` | null ได้ |   |   |
| `createdAt` | ใช่ | `string (date-time)` |   |   |   |
| `finishedAt` | ใช่ | `string (date-time)` | null ได้ |   |   |
| `expiresAt` | ใช่ | `string (date-time)` | null ได้ | ไฟล์ดาวน์โหลดได้ถึงเวลานี้ (7 วันหลังเสร็จ) |   |
| `downloadUrl` |   | `string` |   | สถานะ succeeded: ลิงก์ดาวน์โหลด (หมดอายุ 5 นาที — เรียกใหม่ได้) |   |
| `urlExpiresAt` |   | `string (date-time)` |   |   |   |
