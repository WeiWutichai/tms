# ส่งออกไฟล์ (exports)

3 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`POST /v1/exports`](#post-exports) | `export:run` |
| [`GET /v1/exports/{id}`](#get-exports-id) | `export:run` |
| [`GET /v1/accounting-exports/summary`](#get-accounting-exports-summary) | `export:run` |

## POST /v1/exports {#post-exports}

`POST /v1/exports`

scope: `export:run` · operationId: `Exports_create`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `Idempotency-Key` | header |   | `string` |   |
| `X-Step-Up` | header |   | `string` | stepUpToken จาก `POST /v1/auth/step-up` (ยืนยัน TOTP อายุ 5 นาที) — ผู้ใช้ต้องส่งเมื่อส่งออกทั้งบริษัท: ไม่มีตัวกรองที่จำกัดแถว (ไม่มี filter/`ids` หรือค่าว่าง/`all`) หรือ resource `accounting-*` ไม่งั้น 403 `step_up_required` · API key / OAuth client ไม่ต้อง |

**Request body** `CreateExportDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `resource` | ใช่ | `string` | ค่า: `orders`, `customers`, `customer-sites`, `carriers`, `vehicles`, `vehicle-documents`, `drivers`, `vehicle-types`, `routes`, `products`, `service-items`, `rate-cards`, `reason-codes`, `unbilled-delivery-orders`, `receivables-aging`, `revenue`, `accounting-sales`, `accounting-receipts`, `accounting-settlements` |   | `orders` |
| `format` |   | `string` | ค่า: `xlsx`, `csv`, `pdf` | .xlsx (แนะนำ — เลข 0 นำหน้าไม่หาย) หรือ.csv UTF-8 + BOM · `pdf` (ตาราง A4 ≤ 2,000 แถว) เฉพาะรายงานสรุป — resource `revenue` (อื่น ๆ = 422) |   |
| `filter` |   | `object` |   | ตัวกรองชุดเดียวกับ query ของ `GET /v1/{resource}` (ค่าเป็น string) — ตรวจกติกาเดียวกัน (field แปลก = 422) · `limit`/`cursor`/`sort`/`fields`/`updatedAfter` ไม่มีผล (ไฟล์มีทุกแถวที่ตรงตัวกรอง) | `{"held":"true","holdReason":"RATE_MISSING"}` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `202` | รับงานแล้ว — ต้องมี `export:run` + สิทธิ์อ่านของรายการนั้น (เช่น `orders:read`, `master:read`) · ไฟล์ไม่เกิน 100000 แถว · คอลัมน์ราคา/การเงินเฉพาะผู้มีสิทธิ์เห็น | `ExportAcceptedDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`export:run`) · ต้องยืนยัน 2FA ซ้ำ (`step_up_required`) เมื่อส่งออกทั้งบริษัท: ไม่มีตัวกรองที่จำกัดแถว (ไม่มี filter/`ids` หรือค่าว่าง/`all`) หรือ resource `accounting-*` — [permission_denied](errors.md#permission_denied), [step_up_required](errors.md#step_up_required) | `ProblemDto` |
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

## จำนวนเอกสาร/แถวของแต่ละชุดก่อนส่งออกให้นักบัญชี {#get-accounting-exports-summary}

`GET /v1/accounting-exports/summary`

scope: `export:run` · operationId: `AccountingExport_summary`

ชุดข้อมูล: **sales** ใบแจ้งหนี้ที่ออกแล้วและไม่ถูกยกเลิก (ISSUED / PARTIALLY_PAID / PAID / ADJUSTED — ชุดเดียวกับรายงานรายได้) ตามวันที่ออก · **receipts** การรับชำระที่ยังไม่กลับรายการ ตามวันที่รับ · **settlements** ใบสำคัญจ่ายรถร่วม PAID ตามวันที่จ่าย — แสดงเฉพาะชุดที่มีสิทธิ์อ่าน · ไฟล์: `POST /v1/exports` `{resource, format: csv|xlsx, filter: {dateFrom, dateTo, template?}}` → แถวเอกสาร 1 แถว + แถวรายการ (ยอดรวมอยู่เฉพาะแถวเอกสาร · CSV = UTF-8 BOM + CRLF เปิดใน Excel อ่านไทยได้)

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `dateFrom` | query | ใช่ | `string` | วันแรกของช่วง (วันที่เอกสาร เวลาไทย) — ช่วงยาวสุด 366 วัน |
| `dateTo` | query | ใช่ | `string` | วันสุดท้ายของช่วง (รวมวันนี้) |
| `template` | query |   | `string` | รูปแบบไฟล์ (`templates[].key` จาก summary) — ไม่ส่ง = รูปแบบทั่วไป (layout กลาง: แถวเอกสาร + แถวรายการ) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `AccountingExportSummaryDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`export:run`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/accounting-exports/summary" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/accounting-exports/summary');
```

## Schema ของ response {#schemas}

### AccountingExportSummaryDto {#schema-AccountingExportSummaryDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `dateFrom` | ใช่ | `string` |   |   | `2026-10-01` |
| `dateTo` | ใช่ | `string` |   |   | `2026-10-31` |
| `datasets` | ใช่ | `array<AccountingExportDatasetDto>` |   | เฉพาะชุดที่ผู้เรียกมีสิทธิ์อ่าน (`invoices:read` / `settlements:read`) |   |
| `templates` | ใช่ | `array<AccountingExportTemplateDto>` |   |   |   |

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
| `resource` | ใช่ | `string` | ค่า: `orders`, `customers`, `customer-sites`, `carriers`, `vehicles`, `vehicle-documents`, `drivers`, `vehicle-types`, `routes`, `products`, `service-items`, `rate-cards`, `reason-codes`, `unbilled-delivery-orders`, `receivables-aging`, `revenue`, `accounting-sales`, `accounting-receipts`, `accounting-settlements` |   |   |
| `format` | ใช่ | `string` | ค่า: `xlsx`, `csv`, `pdf` |   |   |
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
