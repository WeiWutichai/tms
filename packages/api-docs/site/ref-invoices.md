# invoices

19 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`GET /v1/invoices/queue`](#get-invoices-queue) | `invoices:read` |
| [`GET /v1/invoices/summary`](#get-invoices-summary) | `invoices:read` |
| [`POST /v1/invoices/preview`](#post-invoices-preview) | `invoices:draft` |
| [`GET /v1/invoices`](#get-invoices) | `invoices:read` |
| [`POST /v1/invoices`](#post-invoices) | `invoices:draft` |
| [`GET /v1/invoices/{id}`](#get-invoices-id) | `invoices:read` |
| [`PATCH /v1/invoices/{id}`](#patch-invoices-id) | `invoices:draft` |
| [`GET /v1/invoices/{id}/proforma`](#get-invoices-id-proforma) | `invoices:read` |
| [`POST /v1/invoices/{id}/finalize`](#post-invoices-id-finalize) | `invoices:finalize` |
| [`GET /v1/invoices/{id}/pdf`](#get-invoices-id-pdf) | `invoices:read` |
| [`POST /v1/invoices/{id}/delivery-orders`](#post-invoices-id-delivery-orders) | `invoices:draft` |
| [`POST /v1/invoices/{id}/delivery-orders/remove`](#post-invoices-id-delivery-orders-remove) | `invoices:draft` |
| [`POST /v1/invoices/{id}/delivery-orders/move`](#post-invoices-id-delivery-orders-move) | `invoices:draft` |
| [`POST /v1/invoices/{id}/lines`](#post-invoices-id-lines) | `invoices:draft` |
| [`POST /v1/invoices/{id}/lines/merge`](#post-invoices-id-lines-merge) | `invoices:draft` |
| [`POST /v1/invoices/{id}/lines/split`](#post-invoices-id-lines-split) | `invoices:draft` |
| [`PATCH /v1/invoices/{id}/lines/{lineId}`](#patch-invoices-id-lines-lineId) | `invoices:draft` |
| [`POST /v1/invoices/{id}/lines/{lineId}/remove`](#post-invoices-id-lines-lineId-remove) | `invoices:draft` |
| [`POST /v1/invoices/{id}/cancel`](#post-invoices-id-cancel) | `invoices:draft` |

## คิวพร้อมวางบิล (DO ที่ส่งแล้ว หลักฐานครบ และราคาพร้อม) {#get-invoices-queue}

`GET /v1/invoices/queue`

scope: `invoices:read` · operationId: `Invoices_list`

DO ที่ส่งถึงแล้ว (DELIVERED/POD_PENDING/UNBILLED) ที่ใบสั่งมีราคา (`pricingStatus = AVAILABLE` หรือกำหนดราคาเองแล้ว — `POST /orders/{id}/manual-price`) และมีบรรทัดรายได้ที่ยืนยันแล้ว (ไม่มีบรรทัดยอดชั่วคราว/ล็อก ไม่มีค่าใช้จ่ายหน้างานฝั่งขายรอยืนยัน) และไม่ถูกระงับวางบิล · ลูกค้าที่เปิด "ไม่มี POD ไม่วางบิล" (`requirePodToBill`, ค่าเริ่มต้นเปิด) → DO ที่หลักฐานส่งยังไม่ครบตาม checklist ไม่ขึ้นคิว · กรองลูกค้า (`customerId` รับ `ext:`) / ช่วงวันที่ส่ง (`doDate`) / หลักฐานครบ / ส่งบัญชีแล้ว · `customers` = ยอดรวมต่อลูกค้าของทุกแถวที่ตรงตัวกรอง · ยอดเงิน (`sell*`) เห็นเมื่อมี `prices.sell:read`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน |
| `updatedAfter` | query |   | `string` | คืนเฉพาะแถวที่ updatedAt > ค่านี้ (incremental pull) |
| `sort` | query |   | `string` ค่า: `updatedAt`, `-updatedAt` |   |
| `fields` | query |   | `string` | รายชื่อ field คั่นด้วย, เช่น id,legalName |
| `customerId` | query |   | `string` | ลูกค้า — id หรือ `ext:{externalId}` (ไม่พบ = รายการว่าง) |
| `dateFrom` | query |   | `string` | วันที่ส่งตั้งแต่ (YYYY-MM-DD — วันที่ของใบส่งของ `doDate`) |
| `dateTo` | query |   | `string` | วันที่ส่งถึง (YYYY-MM-DD — รวมทั้งวัน) |
| `podComplete` | query |   | `string` ค่า: `true`, `false` | กรองตามหลักฐานส่ง (POD): true = ครบ · false = ยังไม่ครบ (มีได้เฉพาะลูกค้าที่ปิด "ไม่มี POD ไม่วางบิล") |
| `released` | query |   | `string` ค่า: `true`, `false` | กรองตามขั้นส่งบัญชี: true = ส่งบัญชีแล้ว (RELEASED) · false = ยังไม่ส่ง |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `BillingQueuePageDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/invoices/queue" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/invoices/queue');
```

## จำนวนใบแจ้งหนี้ตามสถานะ (แท็บ/KPI) {#get-invoices-summary}

`GET /v1/invoices/summary`

scope: `invoices:read` · operationId: `Invoices_summary`

นับทั้ง tenant · เกินกำหนดเป็น 0 จนกว่าจะมีวันครบกำหนด/รับชำระ

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `InvoiceSummaryCountsDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/invoices/summary" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/invoices/summary');
```

## PDF ตัวอย่างจาก DO ที่เลือก — ไม่บันทึกอะไร {#post-invoices-preview}

`POST /v1/invoices/preview`

scope: `invoices:draft` · operationId: `Invoices_preview`

body เดียวกับ `POST /invoices` · ตรวจกติกาชุดเดียวกัน (ลูกค้าเดียว, เงื่อนไขส่งบัญชี + คิวพร้อมวางบิล, กันวางบิลซ้ำ) แต่ **ไม่สร้างร่าง ไม่ส่งบัญชี ไม่ลง audit** (ทำใน transaction แล้วย้อนทั้งหมด) · ไม่มีเลข มีลายน้ำ "ร่าง" ไม่มีคำว่า "ใบกำกับภาษี" · ต้องมี `prices.sell:read`

**Request body** `CreateInvoiceDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `customerId` | ใช่ | `string` |   | ลูกค้า — id หรือ `ext:{externalId}` | `cus_…` |
| `deliveryOrderIds` | ใช่ | `array<string>` |   | ใบส่งของ (≤ 200) ของลูกค้ารายนี้ที่ **ส่งบัญชีแล้ว** และยังผ่านเงื่อนไขคิวพร้อมวางบิลตอนดึง (ตรวจซ้ำทุกครั้ง) | `["do_…"]` |
| `periodFrom` |   | `string` |   | งวดตั้งแต่ — ไม่ส่ง = วันที่ DO แรก | `2026-11-01` |
| `periodTo` |   | `string` |   | งวดถึง — ไม่ส่ง = วันที่ DO สุดท้าย | `2026-11-15` |
| `lineMode` |   | `string` | ค่า: `SINGLE`, `GROUP`, `MERGE` | ไม่ส่ง = SINGLE |   |
| `releaseDeliveryOrders` |   | `boolean` |   | true = ส่งบัญชี DO ที่ยังไม่ส่งในคำขอเดียวกัน (atomic — ส่งไม่ผ่าน = 409 และไม่มีอะไรเปลี่ยน) · ไม่ส่ง/false = DO ต้องส่งบัญชีแล้ว |   |
| `customerPoNo` |   | `string` | ยาว ≤ 60 · null ได้ | เลข ลูกค้า |   |
| `note` |   | `string` | ยาว ≤ 1000 · null ได้ |   |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | application/pdf |   |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:draft`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `409` | `not_ready_to_bill` — DO ยังไม่พร้อม (ตรวจซ้ำตอนดึง): `reasons[]` + `deliveryOrders[]` (ต่อ DO: `reasons`, `missing`) — รวม `NOT_RELEASED` (ยังไม่ส่งบัญชี) · `do_already_drafted` — DO อยู่ในใบแจ้งหนี้อื่นที่ยัง active · `invalid_state_transition` — ใบไม่ใช่ร่าง — [not_ready_to_bill](errors.md#not_ready_to_bill), [do_already_drafted](errors.md#do_already_drafted) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/invoices/preview" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"customerId":"cus_…","deliveryOrderIds":["do_…"],"periodFrom":"2026-11-01","periodTo":"2026-11-15"}'
```

```ts
const { data, error } = await tms.POST('/v1/invoices/preview', {
  body: {
    "customerId": "cus_…",
    "deliveryOrderIds": [
      "do_…"
    ],
    "periodFrom": "2026-11-01",
    "periodTo": "2026-11-15"
  },
});
```

## รายการใบแจ้งหนี้ {#get-invoices}

`GET /v1/invoices`

scope: `invoices:read` · operationId: `Invoices_listInvoices`

กรองลูกค้า (`customerId` รับ `ext:` — ไม่พบ = ว่าง) / สถานะ · cursor มาตรฐาน (updatedAt, id) · ร่างไม่มีเลข (`invoiceNo` = null) · ยอด `sell*` เห็นเมื่อมี `prices.sell:read`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน |
| `updatedAfter` | query |   | `string` | คืนเฉพาะแถวที่ updatedAt > ค่านี้ (incremental pull) |
| `sort` | query |   | `string` ค่า: `updatedAt`, `-updatedAt` |   |
| `fields` | query |   | `string` | รายชื่อ field คั่นด้วย, เช่น id,legalName |
| `customerId` | query |   | `string` | ลูกค้า — id หรือ `ext:{externalId}` |
| `status` | query |   | `string` ค่า: `DRAFT`, `ISSUED`, `PARTIALLY_PAID`, `PAID`, `ADJUSTED`, `VOIDED`, `CANCELLED` |   |
| `receivable` | query |   | `string` ค่า: `all`, `open`, `overdue` | หน้า "รับชำระ": `all` = ใบที่ออกแล้ว (ไม่รวมร่าง/ยกเลิก) · `open` = ค้างรับ (ISSUED + PARTIALLY_PAID) · `overdue` = ค้างรับและเลยวันครบกำหนด (เวลาไทย) — ใช้ร่วมกับ `status` ได้ |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `InvoicePageDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/invoices" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/invoices');
```

## สร้างร่างใบแจ้งหนี้จาก DO หลายใบของลูกค้าเดียว (ไม่มีเลข) {#post-invoices}

`POST /v1/invoices`

scope: `invoices:draft` · operationId: `Invoices_create`

บัญชีเบา: **ใบแจ้งหนี้ ไม่ใช่ใบกำกับภาษี** · ทุก DO ต้องเป็นของลูกค้ารายนี้ **ส่งบัญชีแล้ว** (`POST /delivery-orders/{id}/release`) และ **ตรวจความพร้อมซ้ำตอนดึง** (เงื่อนไขเดียวกับคิว `GET /invoices/queue` + เวลาจุดส่ง + หลักฐานตาม checklist ปัจจุบัน — ไม่เชื่อเวลาส่งบัญชีอย่างเดียว) ไม่ผ่าน → 409 `not_ready_to_bill` · DO อยู่ในใบอื่นที่ active → 409 `do_already_drafted` (กันวางบิลซ้ำ — ระดับ DB) · 1 บรรทัด = 1 บรรทัดรายได้ของ DO (ค่าขนส่ง/บริการประกอบ/ค่าใช้จ่ายหน้างาน — `vatType`/`whtRate` ต่อบรรทัด) · DO → `billingStatus` IN_DRAFT (ราคาที่ order ล็อก) · ยอด VAT/WHT **ประมาณการ** (computeDocumentTax) · ผู้ออก = บริษัทวางบิลตั้งต้นของลูกค้า + สาขาผู้ออกตั้งต้น · เครดิตจากลูกค้า · งวดไม่ส่ง = ช่วงวันที่ DO · **ไม่เข้า outbox/webhook** (ส่งระบบบัญชีหลังออกเลข) · audit `invoice.draft_created`

**Request body** `CreateInvoiceDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `customerId` | ใช่ | `string` |   | ลูกค้า — id หรือ `ext:{externalId}` | `cus_…` |
| `deliveryOrderIds` | ใช่ | `array<string>` |   | ใบส่งของ (≤ 200) ของลูกค้ารายนี้ที่ **ส่งบัญชีแล้ว** และยังผ่านเงื่อนไขคิวพร้อมวางบิลตอนดึง (ตรวจซ้ำทุกครั้ง) | `["do_…"]` |
| `periodFrom` |   | `string` |   | งวดตั้งแต่ — ไม่ส่ง = วันที่ DO แรก | `2026-11-01` |
| `periodTo` |   | `string` |   | งวดถึง — ไม่ส่ง = วันที่ DO สุดท้าย | `2026-11-15` |
| `lineMode` |   | `string` | ค่า: `SINGLE`, `GROUP`, `MERGE` | ไม่ส่ง = SINGLE |   |
| `releaseDeliveryOrders` |   | `boolean` |   | true = ส่งบัญชี DO ที่ยังไม่ส่งในคำขอเดียวกัน (atomic — ส่งไม่ผ่าน = 409 และไม่มีอะไรเปลี่ยน) · ไม่ส่ง/false = DO ต้องส่งบัญชีแล้ว |   |
| `customerPoNo` |   | `string` | ยาว ≤ 60 · null ได้ | เลข ลูกค้า |   |
| `note` |   | `string` | ยาว ≤ 1000 · null ได้ |   |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `201` |   | `InvoiceDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:draft`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `409` | `not_ready_to_bill` — DO ยังไม่พร้อม (ตรวจซ้ำตอนดึง): `reasons[]` + `deliveryOrders[]` (ต่อ DO: `reasons`, `missing`) — รวม `NOT_RELEASED` (ยังไม่ส่งบัญชี) · `do_already_drafted` — DO อยู่ในใบแจ้งหนี้อื่นที่ยัง active · `invalid_state_transition` — ใบไม่ใช่ร่าง — [not_ready_to_bill](errors.md#not_ready_to_bill), [do_already_drafted](errors.md#do_already_drafted) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/invoices" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"customerId":"cus_…","deliveryOrderIds":["do_…"],"periodFrom":"2026-11-01","periodTo":"2026-11-15"}'
```

```ts
const { data, error } = await tms.POST('/v1/invoices', {
  body: {
    "customerId": "cus_…",
    "deliveryOrderIds": [
      "do_…"
    ],
    "periodFrom": "2026-11-01",
    "periodTo": "2026-11-15"
  },
});
```

## ใบแจ้งหนี้ + บรรทัด + บรรทัดบนเอกสาร (Group / Merge / Single) {#get-invoices-id}

`GET /v1/invoices/{id}`

scope: `invoices:read` · operationId: `Invoices_get`

`lines` = บรรทัดจริง (รวมที่ถอดออกแล้ว `active=false`) · `printLines` = รูปบนเอกสารตาม `lineMode` + กลุ่มที่รวมเอง · ยอดภาษีเป็นประมาณการ (`taxEstimated`) · `sell*` เห็นเมื่อมี `prices.sell:read`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `InvoiceDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบแจ้งหนี้ (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/invoices/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/invoices/{id}', {
  params: { path: { id: "…" } },
});
```

## แก้หัวร่าง — รูปบรรทัด (Group / Merge / Single) งวด เครดิต เลข หมายเหตุ {#patch-invoices-id}

`PATCH /v1/invoices/{id}`

scope: `invoices:draft` · operationId: `Invoices_update`

เฉพาะ DRAFT (อื่น ๆ → 409) · audit `invoice.draft_updated` (เฉพาะช่องที่เปลี่ยน)

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag (version) จาก GET — ไม่ตรง → 412 |

**Request body** `UpdateInvoiceDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `lineMode` |   | `string` | ค่า: `SINGLE`, `GROUP`, `MERGE` | รูปบรรทัดบนเอกสาร (Group / Merge / Single) |   |
| `periodFrom` |   | `string` |   |   | `2026-11-01` |
| `periodTo` |   | `string` |   |   | `2026-11-15` |
| `creditTermDays` |   | `number` | ≥ 0 · ≤ 365 | เครดิต (วัน) — ค่าเริ่มจากลูกค้า แก้ได้ในร่าง |   |
| `customerPoNo` |   | `string` | ยาว ≤ 60 · null ได้ |   |   |
| `note` |   | `string` | ยาว ≤ 1000 · null ได้ |   |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `InvoiceDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:draft`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบแจ้งหนี้ (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PATCH "$TMS_BASE_URL/v1/invoices/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"periodFrom":"2026-11-01","periodTo":"2026-11-15"}'
```

```ts
const { data, error } = await tms.PATCH('/v1/invoices/{id}', {
  params: { path: { id: "…" } },
  body: {
    "periodFrom": "2026-11-01",
    "periodTo": "2026-11-15"
  },
});
```

## PDF ตัวอย่าง (pro forma) ของร่าง — ไม่มีเลข มีลายน้ำ "ร่าง" {#get-invoices-id-proforma}

`GET /v1/invoices/{id}/proforma`

scope: `invoices:read` · operationId: `Invoices_proforma`

เฉพาะใบ DRAFT · แม่แบบใบแจ้งหนี้เต็ม · render ใหม่ทุกครั้งตามร่างล่าสุด (ไม่เก็บไฟล์) · ไม่มีคำว่า "ใบกำกับภาษี" · ยอด VAT/WHT ประมาณการ · ต้องมี `prices.sell:read` (มีราคา) ไม่งั้น 403

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | application/pdf |   |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบแจ้งหนี้ (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/invoices/<id>/proforma" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/invoices/{id}/proforma', {
  params: { path: { id: "…" } },
});
```

## ออกเอกสาร (finalize) — ออกเลขใบแจ้งหนี้ + ล็อก {#post-invoices-id-finalize}

`POST /v1/invoices/{id}/finalize`

scope: `invoices:finalize` · operationId: `Invoices_finalize`

DRAFT → ISSUED · ตรวจ → ไม่ผ่าน 409 `invoice_not_finalizable` + `reasons[]`: `no_lines` · `total_not_positive` · `customer_tax_id_missing` · `customer_branch_missing` · `line_vat_type_missing` · `revenue_line_provisional` (+ `lines[]` — ยอดยังไม่ยืนยัน บันทึกยอดส่งจริงก่อน) · `issuer_not_vat_registered` (ผู้ออกไม่จด VAT แต่มีบรรทัด VAT 7%) · **แบ่งหน้าที่:** ผู้สร้าง/ผู้แก้ร่างล่าสุด (API key = ผู้ออก key) ออกใบนั้นเองไม่ได้ → 403 `invoice_self_finalize` (เว้น tenant ตั้ง `billing.allowSelfFinalize`) · ออกเลขชุด INV ต่อสาขาผู้ออก (เรียงไม่ข้าม พร้อมกันได้) · วันที่ออก = วันนี้ (เวลาไทย) · ครบกำหนด = วันที่ออก + เครดิต · เก็บ snapshot ลูกค้า/ผู้ออก · DO → INVOICED (+ UNBILLED → BILLED) · ล็อกบรรทัดรายได้ · audit + webhook `invoice.finalized` (transaction เดียว) · แล้ว render PDF ต้นฉบับเก็บแบบเขียนครั้งเดียว (`pdf`) · **ไม่มีเลขใบกำกับภาษี** · หลังนี้แก้/ยกเลิกร่าง/PATCH ไม่ได้ (409) · sandbox → 409 `sandbox_finalize_disabled`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header | ใช่ | `string` | ETag (version) — **บังคับ** · ไม่ส่ง → 422 `if_match_required` · ไม่ตรง → 412 |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `InvoiceDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ `invoices:finalize` / ผู้เตรียมร่างออกเอง (`invoice_self_finalize`) — [permission_denied](errors.md#permission_denied), [invoice_self_finalize](errors.md#invoice_self_finalize) | `ProblemDto` |
| `404` | ไม่พบใบแจ้งหนี้ (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | `invoice_not_finalizable` (`reasons[]`) · `invalid_state_transition` (ไม่ใช่ร่าง) · `sandbox_finalize_disabled` — [invoice_not_finalizable](errors.md#invoice_not_finalizable) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/invoices/<id>/finalize" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)"
```

```ts
const { data, error } = await tms.POST('/v1/invoices/{id}/finalize', {
  params: { path: { id: "…" } },
});
```

## PDF ใบแจ้งหนี้ที่ออกแล้ว — ต้นฉบับ / สำเนา (ไฟล์ที่เก็บ ณ วันออก) {#get-invoices-id-pdf}

`GET /v1/invoices/{id}/pdf`

scope: `invoices:read` · operationId: `Invoices_issuedPdf`

ใบที่ออกเลขแล้วเท่านั้น (ร่าง → 409 ใช้ `/proforma`) · `copy=ORIGINAL` (ค่าเริ่ม) = ไฟล์ต้นฉบับที่เก็บตอนออก · `copy=COPY` = สำเนา render จาก snapshot ณ วันออกครั้งแรกที่ขอแล้วเก็บ — ไม่ render ตามข้อมูลลูกค้าปัจจุบัน · ยังไม่มีไฟล์ (render ตอนออกล้ม) → สร้างให้แล้วเก็บ · header `X-Content-SHA256` · ไม่มีคำว่า "ใบกำกับภาษี" · ต้องมี `prices.sell:read` ไม่งั้น 403

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `copy` | query |   | `string` ค่า: `ORIGINAL`, `COPY` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | application/pdf |   |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบแจ้งหนี้ (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/invoices/<id>/pdf" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/invoices/{id}/pdf', {
  params: { path: { id: "…" } },
});
```

## เพิ่ม DO เข้าร่าง {#post-invoices-id-delivery-orders}

`POST /v1/invoices/{id}/delivery-orders`

scope: `invoices:draft` · operationId: `Invoices_addDos`

กฎเดียวกับตอนสร้าง (ส่งบัญชีแล้ว + ตรวจความพร้อมซ้ำ · กันวางบิลซ้ำ) · ลูกค้าอื่น → 422 `customer_mismatch` · audit `invoice.delivery_orders_added`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag (version) จาก GET — ไม่ตรง → 412 |

**Request body** `InvoiceDeliveryOrdersDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `deliveryOrderIds` | ใช่ | `array<string>` |   | ใบส่งของ (≤ 200) | `["do_…"]` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `InvoiceDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:draft`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบแจ้งหนี้ (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | `not_ready_to_bill` — DO ยังไม่พร้อม (ตรวจซ้ำตอนดึง): `reasons[]` + `deliveryOrders[]` (ต่อ DO: `reasons`, `missing`) — รวม `NOT_RELEASED` (ยังไม่ส่งบัญชี) · `do_already_drafted` — DO อยู่ในใบแจ้งหนี้อื่นที่ยัง active · `invalid_state_transition` — ใบไม่ใช่ร่าง — [not_ready_to_bill](errors.md#not_ready_to_bill), [do_already_drafted](errors.md#do_already_drafted) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/invoices/<id>/delivery-orders" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"deliveryOrderIds":["do_…"]}'
```

```ts
const { data, error } = await tms.POST('/v1/invoices/{id}/delivery-orders', {
  params: { path: { id: "…" } },
  body: {
    "deliveryOrderIds": [
      "do_…"
    ]
  },
});
```

## ถอด DO ออกจากร่าง — เหตุผล ≥ 10 ตัวอักษร {#post-invoices-id-delivery-orders-remove}

`POST /v1/invoices/{id}/delivery-orders/remove`

scope: `invoices:draft` · operationId: `Invoices_removeDos`

บรรทัดของ DO คงอยู่ (`active` false + เหตุผล — ไม่มีการลบ) · DO กลับ UNBILLED (ขึ้นคิวพร้อมวางบิลอีก ราคาที่ order ปลดล็อก) · DO ไม่อยู่ในร่างนี้ → 422 `not_on_invoice` · audit `invoice.delivery_orders_removed`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag (version) จาก GET — ไม่ตรง → 412 |

**Request body** `RemoveInvoiceDeliveryOrdersDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `deliveryOrderIds` | ใช่ | `array<string>` |   | ใบส่งของ (≤ 200) | `["do_…"]` |
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `ลูกค้าขอวางบิล DO นี้งวดหน้า` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `InvoiceDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:draft`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบแจ้งหนี้ (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/invoices/<id>/delivery-orders/remove" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"deliveryOrderIds":["do_…"],"reason":"ลูกค้าขอวางบิล DO นี้งวดหน้า"}'
```

```ts
const { data, error } = await tms.POST('/v1/invoices/{id}/delivery-orders/remove', {
  params: { path: { id: "…" } },
  body: {
    "deliveryOrderIds": [
      "do_…"
    ],
    "reason": "ลูกค้าขอวางบิล DO นี้งวดหน้า"
  },
});
```

## ย้าย DO ไปร่างอื่น (ลูกค้า + สาขาผู้ออกเดียวกัน) {#post-invoices-id-delivery-orders-move}

`POST /v1/invoices/{id}/delivery-orders/move`

scope: `invoices:draft` · operationId: `Invoices_moveDos`

ถอดจากร่างนี้แล้วดึงเข้าร่างปลายทางใน transaction เดียว (ตรวจความพร้อมซ้ำ — ไม่ผ่าน = ไม่ย้ายเลย) · ปลายทางไม่ใช่ร่าง → 409 · ลูกค้า/สาขาต่างกัน → 422 `customer_mismatch` · If-Match = version ของร่างต้นทาง · ETag ตอบกลับ = ต้นทาง · audit ทั้งสองใบ

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag (version) จาก GET — ไม่ตรง → 412 |

**Request body** `MoveInvoiceDeliveryOrdersDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `deliveryOrderIds` | ใช่ | `array<string>` |   | ใบส่งของ (≤ 200) | `["do_…"]` |
| `targetInvoiceId` | ใช่ | `string` |   | ร่างปลายทาง (ลูกค้า + สาขาผู้ออกเดียวกัน) | `ivc_…` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `InvoiceMoveResultDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:draft`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบแจ้งหนี้ (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | `not_ready_to_bill` — DO ยังไม่พร้อม (ตรวจซ้ำตอนดึง): `reasons[]` + `deliveryOrders[]` (ต่อ DO: `reasons`, `missing`) — รวม `NOT_RELEASED` (ยังไม่ส่งบัญชี) · `do_already_drafted` — DO อยู่ในใบแจ้งหนี้อื่นที่ยัง active · `invalid_state_transition` — ใบไม่ใช่ร่าง — [not_ready_to_bill](errors.md#not_ready_to_bill), [do_already_drafted](errors.md#do_already_drafted) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/invoices/<id>/delivery-orders/move" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"deliveryOrderIds":["do_…"],"targetInvoiceId":"ivc_…"}'
```

```ts
const { data, error } = await tms.POST('/v1/invoices/{id}/delivery-orders/move', {
  params: { path: { id: "…" } },
  body: {
    "deliveryOrderIds": [
      "do_…"
    ],
    "targetInvoiceId": "ivc_…"
  },
});
```

## เพิ่มบรรทัดเอง (ไม่ผูก DO) — เหตุผล ≥ 10 ตัวอักษร {#post-invoices-id-lines}

`POST /v1/invoices/{id}/lines`

scope: `invoices:draft` · operationId: `Invoices_addLine`

ประเภท VAT / อัตราหัก ณ ที่จ่าย / หน่วย ตามรายการบริการ (snapshot) · ยอด = จำนวน × ราคา ปัดครึ่งขึ้น 2 ตำแหน่ง · ราคาต้องมี `prices.sell:write` · audit `invoice.line_added`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag (version) จาก GET — ไม่ตรง → 412 |

**Request body** `AddInvoiceLineDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `serviceItemId` | ใช่ | `string` |   | รายการบริการ (catalog) — ประเภท VAT/อัตราหักตามรายการ | `svc_…` |
| `description` |   | `string` | ยาว ≤ 500 | ไม่ส่ง = ชื่อรายการบริการ |   |
| `quantity` | ใช่ | `string` |   | จำนวน > 0 (ทศนิยม ≤ 4) | `1` |
| `sellUnitPrice` | ใช่ | `string` |   | ราคาต่อหน่วย (บาท ก่อน VAT) — ต้องมี `prices.sell:write` | `500.00` |
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `ค่ายกขนเพิ่มตามที่ลูกค้าตกลงทางอีเมล` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `InvoiceDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:draft`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบแจ้งหนี้ (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/invoices/<id>/lines" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"serviceItemId":"svc_…","quantity":"1","sellUnitPrice":"500.00","reason":"ค่ายกขนเพิ่มตามที่ลูกค้าตกลงทางอีเมล"}'
```

```ts
const { data, error } = await tms.POST('/v1/invoices/{id}/lines', {
  params: { path: { id: "…" } },
  body: {
    "serviceItemId": "svc_…",
    "quantity": "1",
    "sellUnitPrice": "500.00",
    "reason": "ค่ายกขนเพิ่มตามที่ลูกค้าตกลงทางอีเมล"
  },
});
```

## รวมบรรทัด (Merge) บนเอกสาร {#post-invoices-id-lines-merge}

`POST /v1/invoices/{id}/lines/merge`

scope: `invoices:draft` · operationId: `Invoices_merge`

≥ 2 บรรทัดที่ยังใช้ ประเภท VAT + อัตราหักเดียวกัน (ปน → 422 `mixed_tax_treatment`) · รวมเป็นบรรทัดเดียวบนเอกสาร — ยอดเงิน/ภาษีไม่เปลี่ยน · audit `invoice.lines_merged`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag (version) จาก GET — ไม่ตรง → 412 |

**Request body** `InvoiceLineIdsDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `lineIds` | ใช่ | `array<string>` |   |   | `["ivl_…","ivl_…"]` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `InvoiceDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:draft`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบแจ้งหนี้ (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/invoices/<id>/lines/merge" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"lineIds":["ivl_…","ivl_…"]}'
```

```ts
const { data, error } = await tms.POST('/v1/invoices/{id}/lines/merge', {
  params: { path: { id: "…" } },
  body: {
    "lineIds": [
      "ivl_…",
      "ivl_…"
    ]
  },
});
```

## แยกบรรทัดที่รวมไว้ — กลับไปตามรูปบรรทัดของใบ {#post-invoices-id-lines-split}

`POST /v1/invoices/{id}/lines/split`

scope: `invoices:draft` · operationId: `Invoices_split`

audit `invoice.lines_split`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag (version) จาก GET — ไม่ตรง → 412 |

**Request body** `InvoiceLineIdsDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `lineIds` | ใช่ | `array<string>` |   |   | `["ivl_…","ivl_…"]` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `InvoiceDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:draft`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบแจ้งหนี้ (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/invoices/<id>/lines/split" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"lineIds":["ivl_…","ivl_…"]}'
```

```ts
const { data, error } = await tms.POST('/v1/invoices/{id}/lines/split', {
  params: { path: { id: "…" } },
  body: {
    "lineIds": [
      "ivl_…",
      "ivl_…"
    ]
  },
});
```

## แก้บรรทัดในร่าง — คำอธิบาย / ส่วนลด {#patch-invoices-id-lines-lineId}

`PATCH /v1/invoices/{id}/lines/{lineId}`

scope: `invoices:draft` · operationId: `Invoices_updateLine`

ส่วนลด = แก้ราคาที่ร่าง (ราคาที่ order ล็อก) — ≥ 0 และ ≤ ยอดก่อนส่วนลด · ต้องมี `prices.sell:write` + `reason` · ยอดบรรทัด = ยอดก่อนส่วนลด − ส่วนลด · audit `invoice.line_updated`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `lineId` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag (version) จาก GET — ไม่ตรง → 412 |

**Request body** `UpdateInvoiceLineDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `description` |   | `string` | ยาว ≤ 500 |   |   |
| `sellDiscount` |   | `string` |   | ส่วนลดของบรรทัด (บาท ≥ 0, ≤ ยอดก่อนส่วนลด) — ต้องมี `prices.sell:write` + `reason` | `100.00` |
| `reason` |   | `string` | ยาว ≤ 500 · ยาว ≥ 10 | บังคับเมื่อเปลี่ยนส่วนลด |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `InvoiceDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:draft`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบแจ้งหนี้ (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PATCH "$TMS_BASE_URL/v1/invoices/<id>/lines/<lineId>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"sellDiscount":"100.00"}'
```

```ts
const { data, error } = await tms.PATCH('/v1/invoices/{id}/lines/{lineId}', {
  params: { path: { id: "…", lineId: "…" } },
  body: {
    "sellDiscount": "100.00"
  },
});
```

## ถอดบรรทัดที่เพิ่มเอง — เหตุผล ≥ 10 ตัวอักษร {#post-invoices-id-lines-lineId-remove}

`POST /v1/invoices/{id}/lines/{lineId}/remove`

scope: `invoices:draft` · operationId: `Invoices_removeLine`

บรรทัดคงอยู่ (`active` false + เหตุผล) · บรรทัดของ DO ถอดทั้ง DO ด้วย `POST /invoices/{id}/delivery-orders/remove` (422 `delivery_order_line`) · audit `invoice.line_removed`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `lineId` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag (version) จาก GET — ไม่ตรง → 412 |

**Request body** `InvoiceReasonDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `ลูกค้าขอแยกวางบิลงวดหน้า` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `InvoiceDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:draft`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบแจ้งหนี้ (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/invoices/<id>/lines/<lineId>/remove" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"ลูกค้าขอแยกวางบิลงวดหน้า"}'
```

```ts
const { data, error } = await tms.POST('/v1/invoices/{id}/lines/{lineId}/remove', {
  params: { path: { id: "…", lineId: "…" } },
  body: {
    "reason": "ลูกค้าขอแยกวางบิลงวดหน้า"
  },
});
```

## ยกเลิกร่าง — เหตุผล ≥ 10 ตัวอักษร {#post-invoices-id-cancel}

`POST /v1/invoices/{id}/cancel`

scope: `invoices:draft` · operationId: `Invoices_cancel`

DRAFT → CANCELLED · บรรทัดหยุดนับ · DO กลับ UNBILLED (ขึ้นคิวอีก) · ใบที่ออกแล้วยกเลิกที่นี่ไม่ได้ · audit `invoice.draft_cancelled`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag (version) จาก GET — ไม่ตรง → 412 |

**Request body** `InvoiceReasonDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `ลูกค้าขอแยกวางบิลงวดหน้า` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `InvoiceDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:draft`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบแจ้งหนี้ (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/invoices/<id>/cancel" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"ลูกค้าขอแยกวางบิลงวดหน้า"}'
```

```ts
const { data, error } = await tms.POST('/v1/invoices/{id}/cancel', {
  params: { path: { id: "…" } },
  body: {
    "reason": "ลูกค้าขอแยกวางบิลงวดหน้า"
  },
});
```

## Schema ของ response {#schemas}

### BillingQueuePageDto {#schema-BillingQueuePageDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<BillingQueueRowDto>` |   |   |   |
| `nextCursor` | ใช่ | `string` | null ได้ |   |   |
| `hasMore` | ใช่ | `boolean` |   |   |   |
| `customers` | ใช่ | `array<BillingQueueCustomerDto>` |   | สรุปต่อลูกค้าของทุกแถวที่ตรงตัวกรอง (ไม่ขึ้นกับ cursor/limit) — เรียงตามรหัสลูกค้า |   |

### InvoiceDto {#schema-InvoiceDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `ivc_…` |
| `invoiceNo` | ใช่ | `string` | null ได้ | เลขใบแจ้งหนี้ — **ร่างไม่มีเลข** (ออกตอนออกเอกสาร) |   |
| `status` | ใช่ | `string` | ค่า: `DRAFT`, `ISSUED`, `PARTIALLY_PAID`, `PAID`, `ADJUSTED`, `VOIDED`, `CANCELLED` |   |   |
| `customer` | ใช่ | `InvoiceCustomerDto` |   |   |   |
| `periodFrom` | ใช่ | `string` | null ได้ |   |   |
| `periodTo` | ใช่ | `string` | null ได้ |   |   |
| `deliveryOrderCount` | ใช่ | `number` |   |   |   |
| `lineMode` | ใช่ | `string` | ค่า: `SINGLE`, `GROUP`, `MERGE` |   |   |
| `sellTotal` |   | `string` |   | ยอดรวม (รวม VAT ประมาณการ) — `prices.sell:read` |   |
| `sellNetExpected` |   | `string` |   | ยอดรวม − WHT ที่คาดว่าจะถูกหัก (ประมาณการ) — `prices.sell:read` |   |
| `issueDate` | ใช่ | `string` | null ได้ | วันที่ออก (เวลาไทย) — ร่าง = null | `2026-11-20` |
| `dueDate` | ใช่ | `string` | null ได้ | ครบกำหนดชำระ = วันที่ออก + เครดิต — ร่าง = null | `2026-12-20` |
| `sellPaidAmount` |   | `string` |   | ยอดรับชำระแล้ว — `prices.sell:read` |   |
| `sellOutstanding` |   | `string` |   | คงค้าง = ยอดรวม − รับชำระแล้ว (ร่าง/ยกเลิก = 0.00) — `prices.sell:read` |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string` |   |   |   |
| `updatedAt` | ใช่ | `string` |   |   |   |
| `issuingCompanyId` | ใช่ | `string` |   |   | `cmp_…` |
| `issuingBranchId` | ใช่ | `string` |   |   | `brn_…` |
| `creditTermDays` | ใช่ | `number` |   |   |   |
| `customerPoNo` | ใช่ | `string` | null ได้ |   |   |
| `note` | ใช่ | `string` | null ได้ |   |   |
| `sellSubtotalExempt` |   | `string` |   | ฐานยกเว้น VAT — `prices.sell:read` |   |
| `sellSubtotalVatable` |   | `string` |   | ฐาน VAT 7% — `prices.sell:read` |   |
| `sellSubtotalZeroRated` |   | `string` |   | ฐาน VAT 0% — `prices.sell:read` |   |
| `sellVatAmount` |   | `string` |   | VAT 7% — `prices.sell:read` |   |
| `sellWhtExpected` |   | `string` |   | WHT ที่คาดว่าจะถูกหัก — `prices.sell:read` |   |
| `sellDiscountTotal` |   | `string` |   | ส่วนลดรวม — `prices.sell:read` |   |
| `taxEstimated` | ใช่ | `boolean` |   | ยอด VAT/WHT เป็นประมาณการ — true เสมอ |   |
| `deliveryOrders` | ใช่ | `array<InvoiceDeliveryOrderDto>` |   |   |   |
| `lines` | ใช่ | `array<InvoiceLineDto>` |   | บรรทัดจริง (รวมที่ถอดออกแล้ว `active=false`) |   |
| `printLines` | ใช่ | `array<InvoicePrintLineDto>` |   | บรรทัดบนเอกสารตาม `lineMode` + กลุ่มที่รวมเอง |   |
| `cancelReason` | ใช่ | `string` | null ได้ |   |   |
| `createdBy` | ใช่ | `string` | null ได้ |   |   |
| `issuedAt` | ใช่ | `string` | null ได้ | เวลาออกเอกสาร (ออกเลข) — ร่าง = null |   |
| `issuedBy` | ใช่ | `string` | null ได้ | ผู้ออกเอกสาร |   |
| `pdf` | ใช่ | `InvoicePdfDto` | null ได้ | PDF ต้นฉบับที่เก็บ ณ วันออก — null = ร่าง หรือยังไม่ได้ render (render หลังออกเลข; `GET /v1/invoices/{id}/pdf` สร้างให้ถ้ายังไม่มี) |   |
| `billingNoteId` | ใช่ | `string` | null ได้ | ใบวางบิลที่ใบนี้อยู่ · null = ไม่อยู่ในใบวางบิล | `bn_…` |

### InvoiceMoveResultDto {#schema-InvoiceMoveResultDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `source` | ใช่ | `InvoiceDto` |   | ร่างต้นทาง (หลังย้าย) |   |
| `target` | ใช่ | `InvoiceDto` |   | ร่างปลายทาง (หลังย้าย) |   |

### InvoicePageDto {#schema-InvoicePageDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<InvoiceSummaryDto>` |   |   |   |
| `nextCursor` | ใช่ | `string` | null ได้ |   |   |
| `hasMore` | ใช่ | `boolean` |   |   |   |

### InvoiceSummaryCountsDto {#schema-InvoiceSummaryCountsDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `total` | ใช่ | `number` |   |   |   |
| `draft` | ใช่ | `number` |   |   |   |
| `issued` | ใช่ | `number` |   | ISSUED + ADJUSTED |   |
| `partiallyPaid` | ใช่ | `number` |   |   |   |
| `paid` | ใช่ | `number` |   |   |   |
| `overdue` | ใช่ | `number` |   | เกินกำหนด — คำนวณเมื่อมีการรับชำระ ตอนนี้ 0 เสมอ |   |
| `cancelled` | ใช่ | `number` |   | CANCELLED + VOIDED |   |
