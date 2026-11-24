# invoices

28 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`GET /v1/invoices/queue`](#get-invoices-queue) | `invoices:read` |
| [`GET /v1/invoices/summary`](#get-invoices-summary) | `invoices:read` |
| [`POST /v1/invoices/preview`](#post-invoices-preview) | `invoices:draft` |
| [`GET /v1/invoices`](#get-invoices) | `invoices:read` |
| [`POST /v1/invoices`](#post-invoices) | `invoices:draft` |
| [`PUT /v1/invoices/external/{externalId}`](#put-invoices-external-externalId) | `invoices:draft` |
| [`PATCH /v1/invoices/external/{externalId}`](#patch-invoices-external-externalId) | `invoices:draft` |
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
| [`POST /v1/invoices/{id}/void`](#post-invoices-id-void) | `invoices:void` |
| [`POST /v1/invoices/{id}/mark-sent`](#post-invoices-id-mark-sent) | `invoices:finalize` |
| [`POST /v1/invoices/{id}/erp-posted`](#post-invoices-id-erp-posted) | `integrations:retry` |
| [`POST /v1/invoices/{id}/unmark-sent`](#post-invoices-id-unmark-sent) | `invoices:void` |
| [`POST /v1/invoices/{id}/send`](#post-invoices-id-send) | `invoices:finalize` |
| [`GET /v1/invoices/{id}/emails`](#get-invoices-id-emails) | `invoices:read` |
| [`POST /v1/invoice-runs`](#post-invoice-runs) | `invoices:draft` |

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

## จำนวนและยอดใบแจ้งหนี้ตามสถานะ (แท็บ/KPI + Dashboard บิล) {#get-invoices-summary}

`GET /v1/invoices/summary`

scope: `invoices:read` · operationId: `Invoices_summary`

นับทั้ง tenant · แท็บแยกกันไม่ซ้อน: เกินกำหนด มาก่อน "ออกแล้ว"/"ชำระบางส่วน" Dashboard บิล: ยอดต่อแท็บ (`sellDraftTotal` = ยอดรวมร่าง · `sell*Outstanding` = ยอดรวม − ยอดตัดชำระ — ตรงกับ Σ ของ `GET /invoices` ตัวกรองเดียวกัน) + ใบที่ออกเดือนนี้ (ถึงวันนี้) vs เดือนก่อน (ทั้งเดือน) ตาม `issueDate` เวลาไทย ไม่รวมร่าง/ยกเลิก · ค้างวางบิล = `GET /invoices/queue` `totals` · รับชำระเดือนนี้/ก่อน = `GET /payments/summary` · ยอด `sell*` เห็นเมื่อมี `prices.sell:read` (จำนวนเห็นเสมอ): ใบแจ้งหนี้ไม่ใช่ใบกำกับภาษี ยอด VAT/WHT เป็นประมาณการ

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
| `deliveryOrderIds` | ใช่ | `array<string>` |   | ใบส่งของ ของลูกค้ารายนี้ที่ **ส่งบัญชีแล้ว** และยังผ่านเงื่อนไขคิวพร้อมวางบิลตอนดึง (ตรวจซ้ำทุกครั้ง) | `["do_…"]` |
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
| `receivable` | query |   | `string` ค่า: `all`, `open`, `overdue`, `due` | หน้า "รับชำระ": `all` = ใบที่ออกแล้ว (ไม่รวมร่าง/ยกเลิก) · `open` = ค้างรับ (ISSUED + PARTIALLY_PAID) · `overdue` = ใบที่มีธงเกินกำหนด · `due` = ครบกำหนดแล้ว: ค้างรับที่ยังมียอดค้างและ `dueDate` ≤ วันนี้ (เวลาไทย) **รวมใบเกินกำหนด** (การ์ด "ครบกำหนด" ของ Dashboard บิล) — ใช้ร่วมกับ `status` ได้ |
| `overdue` | query |   | `string` ค่า: `true`, `false` | ธงเกินกำหนด — `false` = ไม่รวมใบเกินกำหนด (แท็บ "ออกแล้ว"/"ชำระบางส่วน" ของต้นแบบ: เกินกำหนดแสดงก่อน) · `true` = เฉพาะเกินกำหนด |
| `aging` | query |   | `string` ค่า: `NOT_DUE`, `DAYS_1_30`, `DAYS_31_60`, `DAYS_61_90`, `DAYS_OVER_90` | ช่วงอายุลูกหนี้ (การ์ด "อายุลูกหนี้" ของหน้ารับชำระ) — เฉพาะใบค้างรับที่ยังมียอดค้าง และ `daysPastDue = วันนี้ − dueDate` (เวลาไทย) อยู่ในช่วง · ชุดเดียวกับ `GET /payments/aging` |

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
| `deliveryOrderIds` | ใช่ | `array<string>` |   | ใบส่งของ ของลูกค้ารายนี้ที่ **ส่งบัญชีแล้ว** และยังผ่านเงื่อนไขคิวพร้อมวางบิลตอนดึง (ตรวจซ้ำทุกครั้ง) | `["do_…"]` |
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

## สร้าง/แก้ร่างใบแจ้งหนี้ด้วยเลขของระบบต้นทาง (upsert — D68-45) {#put-invoices-external-externalId}

`PUT /v1/invoices/external/{externalId}`

scope: `invoices:draft` · operationId: `Invoices_upsertExternal`

ยังไม่มีใบที่ externalId นี้ → สร้างร่าง (กติกาเดียวกับ `POST /invoices`) 201 · มีแล้ว → 200: ลูกค้า + ชุด DO ต้องตรงกับใบ (เพิ่ม/ถอด DO ใช้ `/invoices/{id}/delivery-orders…`) ไม่ตรง → 409 `conflict` · ช่องหัวใบ เหมือนเดิม → ใบเดิม version เดิม (ส่งซ้ำได้) · ต่าง: ร่าง → แก้ (เหมือน PATCH) · **ใบที่ออกแล้ว/ยกเลิกแก้ไม่ได้ → 409 `invalid_state_transition`** · externalId ตั้งได้ตอนสร้างเท่านั้น · ยกเลิกแล้วออกใหม่ (`/void` + reissue) ใบใหม่**ไม่รับ externalId เดิม** (ใบเดิมคง externalId ไว้) — ระบบต้นทางต้องใช้ externalId ใหม่ · path `{id}` ทุก route รับ `ext:{externalId}`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `externalId` | path | ใช่ | `string` | เลขของระบบต้นทาง (ASCII ที่พิมพ์ได้ 1–100 ตัว ไม่มีช่องว่าง) — unique ต่อ tenant ต่อ resource |
| `If-Match` | header |   | `string` | ETag — ใช้เมื่อใบมีอยู่แล้ว (ไม่ตรง → 412) |

**Request body** `CreateInvoiceDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `customerId` | ใช่ | `string` |   | ลูกค้า — id หรือ `ext:{externalId}` | `cus_…` |
| `deliveryOrderIds` | ใช่ | `array<string>` |   | ใบส่งของ ของลูกค้ารายนี้ที่ **ส่งบัญชีแล้ว** และยังผ่านเงื่อนไขคิวพร้อมวางบิลตอนดึง (ตรวจซ้ำทุกครั้ง) | `["do_…"]` |
| `periodFrom` |   | `string` |   | งวดตั้งแต่ — ไม่ส่ง = วันที่ DO แรก | `2026-11-01` |
| `periodTo` |   | `string` |   | งวดถึง — ไม่ส่ง = วันที่ DO สุดท้าย | `2026-11-15` |
| `lineMode` |   | `string` | ค่า: `SINGLE`, `GROUP`, `MERGE` | ไม่ส่ง = SINGLE |   |
| `releaseDeliveryOrders` |   | `boolean` |   | true = ส่งบัญชี DO ที่ยังไม่ส่งในคำขอเดียวกัน (atomic — ส่งไม่ผ่าน = 409 และไม่มีอะไรเปลี่ยน) · ไม่ส่ง/false = DO ต้องส่งบัญชีแล้ว |   |
| `customerPoNo` |   | `string` | ยาว ≤ 60 · null ได้ | เลข ลูกค้า |   |
| `note` |   | `string` | ยาว ≤ 1000 · null ได้ |   |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | มีอยู่แล้ว → ใบเดิม (แก้หัวร่างถ้าต่าง) | `InvoiceDto` |
| `201` | ยังไม่มี → สร้างร่าง | `InvoiceDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:draft`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `409` | `not_ready_to_bill` — DO ยังไม่พร้อม (ตรวจซ้ำตอนดึง): `reasons[]` + `deliveryOrders[]` (ต่อ DO: `reasons`, `missing`) — รวม `NOT_RELEASED` (ยังไม่ส่งบัญชี) · `do_already_drafted` — DO อยู่ในใบแจ้งหนี้อื่นที่ยัง active · `invalid_state_transition` — ใบไม่ใช่ร่าง · `conflict` — ใบที่มีอยู่มีลูกค้า/ชุด DO ต่างจากที่ส่ง — [not_ready_to_bill](errors.md#not_ready_to_bill), [do_already_drafted](errors.md#do_already_drafted), [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress), [conflict](errors.md#conflict) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PUT "$TMS_BASE_URL/v1/invoices/external/<externalId>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"customerId":"cus_…","deliveryOrderIds":["do_…"],"periodFrom":"2026-11-01","periodTo":"2026-11-15"}'
```

```ts
const { data, error } = await tms.PUT('/v1/invoices/external/{externalId}', {
  params: { path: { externalId: "…" } },
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

## แก้หัวร่างด้วยเลขของระบบต้นทาง (= `PATCH /invoices/ext:{externalId}`) {#patch-invoices-external-externalId}

`PATCH /v1/invoices/external/{externalId}`

scope: `invoices:draft` · operationId: `Invoices_patchExternal`

กติกาเดียวกับ `PATCH /invoices/{id}` — เฉพาะ DRAFT (ออกแล้ว → 409) · ยังไม่มีใบนี้ → 404 (สร้างใช้ PUT)

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `externalId` | path | ใช่ | `string` | เลขของระบบต้นทาง (ASCII ที่พิมพ์ได้ 1–100 ตัว ไม่มีช่องว่าง) — unique ต่อ tenant ต่อ resource |
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
curl -sS -X PATCH "$TMS_BASE_URL/v1/invoices/external/<externalId>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"periodFrom":"2026-11-01","periodTo":"2026-11-15"}'
```

```ts
const { data, error } = await tms.PATCH('/v1/invoices/external/{externalId}', {
  params: { path: { externalId: "…" } },
  body: {
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
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |

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
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
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
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |

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

DRAFT → ISSUED · ตรวจ → ไม่ผ่าน 409 `invoice_not_finalizable` + `reasons[]`: `no_lines` · `total_not_positive` · `customer_tax_id_missing` · `customer_branch_missing` · `line_vat_type_missing` · `revenue_line_provisional` (+ `lines[]` — ยอดยังไม่ยืนยัน บันทึกยอดส่งจริงก่อน) · `issuer_not_vat_registered` (ผู้ออกไม่จด VAT แต่มีบรรทัด VAT 7%) · **แบ่งหน้าที่:** ผู้สร้าง/ผู้แก้ร่างล่าสุด (API key = ผู้ออก key) ออกใบนั้นเองไม่ได้ → 403 `invoice_self_finalize` (เว้น tenant ตั้ง `billing.allowSelfFinalize`) · ออกเลขชุด INV ต่อสาขาผู้ออก (เรียงไม่ข้าม พร้อมกันได้) · วันที่ออก = วันนี้ (เวลาไทย) · ครบกำหนด = วันที่ออก + เครดิต · เก็บ snapshot ลูกค้า/ผู้ออก · DO → INVOICED (+ UNBILLED → BILLED) · ล็อกบรรทัดรายได้ · audit + webhook `invoice.finalized` (transaction เดียว) · แล้ว render PDF ต้นฉบับเก็บแบบเขียนครั้งเดียว (`pdf`) · **ไม่มีเลขใบกำกับภาษี** · หลังนี้แก้/ยกเลิกร่าง/PATCH ไม่ได้ (409) · **sandbox:** ออกได้ — เลขจากชุดเลขของ sandbox ขึ้นต้น `TEST-` · PDF มีลายน้ำ "ตัวอย่าง — ใช้ไม่ได้จริง" · ไม่ส่งไป connector/ERP

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `If-Match` | header | ใช่ | `string` | ETag (version) — **บังคับ** · ไม่ส่ง → 422 `if_match_required` · ไม่ตรง → 412 |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `InvoiceDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ `invoices:finalize` / ผู้เตรียมร่างออกเอง (`invoice_self_finalize`) — [permission_denied](errors.md#permission_denied), [invoice_self_finalize](errors.md#invoice_self_finalize) | `ProblemDto` |
| `404` | ไม่พบใบแจ้งหนี้ (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | `invoice_not_finalizable` (`reasons[]`) · `invalid_state_transition` (ไม่ใช่ร่าง) — [invoice_not_finalizable](errors.md#invoice_not_finalizable) | `ProblemDto` |
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

ใบที่ออกเลขแล้วเท่านั้น (ร่าง → 409 ใช้ `/proforma`) · `copy=ORIGINAL` (ค่าเริ่ม) = ไฟล์ต้นฉบับที่เก็บตอนออก · `copy=COPY` = สำเนา render จาก snapshot ณ วันออกครั้งแรกที่ขอแล้วเก็บ — ไม่ render ตามข้อมูลลูกค้าปัจจุบัน · ยังไม่มีไฟล์ (render ตอนออกล้ม) → สร้างให้แล้วเก็บ · header `X-Content-SHA256` · ไม่มีคำว่า "ใบกำกับภาษี" · ต้องมี `prices.sell:read` ไม่งั้น 403 · **ใบที่ยกเลิกแล้ว** = ไฟล์ลายน้ำ "ยกเลิก" ที่ render ด้วยแม่แบบวันออกแล้วเก็บตอนยกเลิก · แม่แบบเปลี่ยนแล้วและยังไม่มีไฟล์ลายน้ำ → ส่งไฟล์ต้นฉบับที่เก็บแทน + header `X-Invoice-Pdf-Note: cancelled-watermark-unavailable` · ไฟล์ต้นฉบับ/สำเนาคงเดิม

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
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

กฎเดียวกับตอนสร้าง (ส่งบัญชีแล้ว + ตรวจความพร้อมซ้ำ · กันวางบิลซ้ำ) · ลูกค้าอื่น → 422 `customer_mismatch` · DO บนร่างรวมกับที่เพิ่มเกิน 1000 ใบ → 422 `too_many` · audit `invoice.delivery_orders_added`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `If-Match` | header |   | `string` | ETag (version) จาก GET — ไม่ตรง → 412 |

**Request body** `InvoiceDeliveryOrdersDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `deliveryOrderIds` | ใช่ | `array<string>` |   | ใบส่งของ (≤ 1000) · ร่างหนึ่งใบถือใบส่งของรวมได้ไม่เกิน 1000 ใบ (เพิ่มแล้วเกิน = 422 `too_many`) | `["do_…"]` |

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
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `If-Match` | header |   | `string` | ETag (version) จาก GET — ไม่ตรง → 412 |

**Request body** `RemoveInvoiceDeliveryOrdersDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `deliveryOrderIds` | ใช่ | `array<string>` |   | ใบส่งของ (≤ 1000) · ร่างหนึ่งใบถือใบส่งของรวมได้ไม่เกิน 1000 ใบ (เพิ่มแล้วเกิน = 422 `too_many`) | `["do_…"]` |
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

ถอดจากร่างนี้แล้วดึงเข้าร่างปลายทางใน transaction เดียว (ตรวจความพร้อมซ้ำ — ไม่ผ่าน = ไม่ย้ายเลย) · ปลายทางไม่ใช่ร่าง → 409 · ลูกค้า/สาขาต่างกัน → 422 `customer_mismatch` · DO บนร่างปลายทางรวมกับที่ย้ายเกิน 1000 ใบ → 422 `too_many` (ไม่ย้ายเลย) · If-Match = version ของร่างต้นทาง · ETag ตอบกลับ = ต้นทาง · audit ทั้งสองใบ

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `If-Match` | header |   | `string` | ETag (version) จาก GET — ไม่ตรง → 412 |

**Request body** `MoveInvoiceDeliveryOrdersDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `deliveryOrderIds` | ใช่ | `array<string>` |   | ใบส่งของ (≤ 1000) · ร่างหนึ่งใบถือใบส่งของรวมได้ไม่เกิน 1000 ใบ (เพิ่มแล้วเกิน = 422 `too_many`) | `["do_…"]` |
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
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
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
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
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
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
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
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
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
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
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

DRAFT → CANCELLED · บรรทัดหยุดนับ · DO กลับ UNBILLED (ขึ้นคิวอีก) · ใบที่ออกแล้วยกเลิกที่นี่ไม่ได้ (409 — ใช้ `POST /v1/invoices/{id}/void`) · audit `invoice.draft_cancelled`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
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

## ยกเลิกใบแจ้งหนี้ที่ออกแล้ว (void) — คงเลข · ยังไม่รับชำระ · เหตุผล ≥ 10 ตัวอักษร {#post-invoices-id-void}

`POST /v1/invoices/{id}/void`

scope: `invoices:void` · operationId: `Invoices_void`

สิทธิ์ `invoices:void` · **If-Match บังคับ** (ไม่ส่ง → 422 `if_match_required`) · ISSUED → **CANCELLED คงเลข** (เลขไม่ถูกออกซ้ำ · record ไม่ถูกลบ) · รับชำระแล้ว (บางส่วน/ครบ) → 409 `invoice_has_payments` (`payments[]` — กลับรายการก่อน) · อยู่ในใบวางบิลที่ออกแล้ว/เก็บเงินแล้ว → 409 `invoice_on_billing_note` (`billingNoteNo` — ยกเลิกใบวางบิลก่อน) · **ส่งลูกค้าแล้ว** → 409 `invoice_sent_to_customer` · ร่าง → 409 (ใช้ `/cancel`) · ผล: DO INVOICED/BILLED → UNBILLED (วางบิลใหม่ได้) · ปลดล็อกบรรทัดรายได้ · ถอดออกจากใบวางบิลที่ยังเป็นร่าง · audit `invoice.cancelled` + webhook `invoice.voided` · `reissue: true` = สร้างร่างฉบับใหม่แทน (DO ชุดเดิม + บรรทัดที่เพิ่มเอง) อ้างเลขเดิม (`replacedByInvoice` / `replacesInvoice`) — ออกเลขใหม่ตามปกติ · PDF ของใบที่ยกเลิกมีลายน้ำ "ยกเลิก"

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `If-Match` | header | ใช่ | `string` | ETag (version) — **บังคับ** · ไม่ส่ง → 422 `if_match_required` · ไม่ตรง → 412 |
| `X-Step-Up` | header |   | `string` | stepUpToken จาก `POST /v1/auth/step-up` (ยืนยัน TOTP อายุ 5 นาที) — ผู้ใช้ต้องส่งทุกครั้ง ไม่งั้น 403 `step_up_required` · API key / OAuth client ไม่ต้อง |

**Request body** `VoidInvoiceDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `ลูกค้าขอแยกวางบิลงวดหน้า` |
| `reissue` |   | `boolean` |   | สร้าง**ร่างฉบับใหม่แทน**ใน transaction เดียวกัน (DO ชุดเดิม + บรรทัดที่เพิ่มเอง · อ้างเลขเดิม `replacesInvoice`) — ร่างใหม่ต้องออกเอกสารตามปกติ (ได้เลขถัดไป ไม่ใช้เลขเดิม) |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `InvoiceDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:void`) · ต้องยืนยัน 2FA ซ้ำ (`step_up_required`) — [permission_denied](errors.md#permission_denied), [step_up_required](errors.md#step_up_required) | `ProblemDto` |
| `404` | ไม่พบใบแจ้งหนี้ (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | `invalid_state_transition` (ร่าง/ยกเลิกแล้ว/สถานะอื่น) · `invoice_has_payments` · `invoice_on_billing_note` · `invoice_sent_to_customer` · `not_ready_to_bill` (ออกฉบับใหม่แทน — DO ไม่พร้อม) — [invoice_on_billing_note](errors.md#invoice_on_billing_note), [invoice_has_payments](errors.md#invoice_has_payments) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/invoices/<id>/void" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"ลูกค้าขอแยกวางบิลงวดหน้า"}'
```

```ts
const { data, error } = await tms.POST('/v1/invoices/{id}/void', {
  params: { path: { id: "…" } },
  body: {
    "reason": "ลูกค้าขอแยกวางบิลงวดหน้า"
  },
});
```

## ทำเครื่องหมาย "ส่งลูกค้าแล้ว" {#post-invoices-id-mark-sent}

`POST /v1/invoices/{id}/mark-sent`

scope: `invoices:finalize` · operationId: `Invoices_markSent`

สิทธิ์ `invoices:finalize` · ใบที่ออกเลขแล้วและไม่ถูกยกเลิก (ISSUED / PARTIALLY_PAID / PAID / ADJUSTED — อื่น ๆ 409 `invalid_state_transition`) · ส่งแล้วอยู่แล้ว = คืนค่าเดิม (ไม่เปลี่ยน) · audit `invoice.sent_to_customer` · ส่งแล้ว**ยกเลิกใบไม่ได้** (`/void` → 409 `invoice_sent_to_customer`) · ออกใบวางบิลตั้งธงนี้ให้อัตโนมัติ (ช่องทาง BILLING_NOTE) · ส่งอีเมล (`POST /invoices/{id}/send`, ชุดใบวางบิล) ตั้งช่องทาง EMAIL

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `If-Match` | header |   | `string` | ETag (version) จาก GET — ไม่ตรง → 412 |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `InvoiceDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:finalize`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบแจ้งหนี้ (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/invoices/<id>/mark-sent" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)"
```

```ts
const { data, error } = await tms.POST('/v1/invoices/{id}/mark-sent', {
  params: { path: { id: "…" } },
});
```

## ปุ่ม "ลงบัญชีแล้ว" — ใบนี้ลงบัญชีในระบบบัญชีที่เชื่อมแล้ว (แทนที่ต้องมีผู้อนุมัติ) {#post-invoices-id-erp-posted}

`POST /v1/invoices/{id}/erp-posted`

scope: `integrations:retry` · operationId: `Invoices_markErpPosted`

สิทธิ์ `integrations:retry` (บัญชี/ผู้วางบิล/ผู้อนุมัติ) · ตั้ง `sync.postedAt` ของเอกสารนี้ในระบบบัญชีที่เชื่อม → หลังจากนี้การแทนที่เอกสารในระบบบัญชี (ส่งซ้ำ / ยกเลิกแล้วออกใหม่) ขึ้นคิว "ต้องอนุมัติ" (`replace_requires_approval`) จนผู้อนุมัติคนอื่นอนุมัติ · กดซ้ำ = คงเวลาเดิม · ใบที่ยังไม่อยู่ในระบบบัญชี → 409 `invalid_state_transition` · audit `invoice.erp_posted_marked` · **ยกเลิกแล้วออกใหม่: กดที่ใบเดิมก่อนออกใบใหม่แทน** (ธงอยู่กับเอกสารในระบบบัญชี — แทนที่สำเร็จแล้วย้ายตามไปใบใหม่; ใบเดิมที่ยกเลิกแล้วกดได้จนกว่าจะแทนที่)

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `InvoiceDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`integrations:retry`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบแจ้งหนี้ (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/invoices/<id>/erp-posted" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)"
```

```ts
const { data, error } = await tms.POST('/v1/invoices/{id}/erp-posted', {
  params: { path: { id: "…" } },
});
```

## ล้างธง "ส่งลูกค้าแล้ว" (ทำเครื่องหมายผิด) — เหตุผล ≥ 10 ตัวอักษร {#post-invoices-id-unmark-sent}

`POST /v1/invoices/{id}/unmark-sent`

scope: `invoices:void` · operationId: `Invoices_unmarkSent`

สิทธิ์ `invoices:void` (owner/admin/manager — สิทธิ์เดียวกับยกเลิกใบที่ออกแล้ว) · ยังไม่ส่ง = คืนค่าเดิม · audit `invoice.sent_to_customer_cleared` พร้อมเหตุผล · ยกเลิกใบวางบิลที่ออกแล้วล้างธงช่องทาง BILLING_NOTE ให้อัตโนมัติ

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `If-Match` | header |   | `string` | ETag (version) จาก GET — ไม่ตรง → 412 |

**Request body** `UnmarkInvoiceSentDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `ลูกค้าขอแยกวางบิลงวดหน้า` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `InvoiceDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:void`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบแจ้งหนี้ (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/invoices/<id>/unmark-sent" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"ลูกค้าขอแยกวางบิลงวดหน้า"}'
```

```ts
const { data, error } = await tms.POST('/v1/invoices/{id}/unmark-sent', {
  params: { path: { id: "…" } },
  body: {
    "reason": "ลูกค้าขอแยกวางบิลงวดหน้า"
  },
});
```

## ส่งใบแจ้งหนี้ / ใบแจ้งเตือนชำระ ทางอีเมลถึงลูกค้า (แนบ PDF ต้นฉบับ) {#post-invoices-id-send}

`POST /v1/invoices/{id}/send`

scope: `invoices:finalize` · operationId: `Invoices_send`

สิทธิ์ `invoices:finalize` + `prices.sell:read` · `purpose=DOCUMENT` (ค่าเริ่ม): ใบที่ออกเลขแล้วและไม่ถูกยกเลิก (ISSUED / PARTIALLY_PAID / PAID / ADJUSTED) · `purpose=PAYMENT_REMINDER` (ต้นแบบหน้า "รับชำระ" เมนู "ส่งใบแจ้งเตือนชำระ"): เฉพาะใบที่ยังมียอดค้าง (ISSUED / PARTIALLY_PAID) — อื่น ๆ 409 `reason: not_outstanding` · แนบไฟล์ต้นฉบับที่เก็บ ณ วันออก (`GET /invoices/{id}/pdf`) · ผู้รับ = `to` หรือผู้ติดต่อของลูกค้าที่มีอีเมล · อีเมล 1 ฉบับต่อผู้รับผ่าน outbox (สถานะการส่งที่ `GET /invoices/{id}/emails`) · ผู้รับเดิมยังรอส่ง (ภายใน 10 นาที) → 409 `document_email_pending` · ยังไม่มีธง "ส่งลูกค้าแล้ว" → ตั้งช่องทาง EMAIL · audit `invoice.emailed` · sandbox ไม่ส่งออกจริง

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `Idempotency-Key` | header |   | `string` | ส่งซ้ำ key เดิม + body เดิม = ผลเดิม (ไม่ส่งอีเมลซ้ำ) เก็บ 24 ชม. |

**Request body** `SendInvoiceDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `to` |   | `array<string>` |   | อีเมลผู้รับ 1–5 คน (ไม่ซ้ำ) · ไม่ระบุ = อีเมลผู้ติดต่อของลูกค้า (ผู้ติดต่อหลักที่มีอีเมล · ไม่มีผู้ติดต่อหลักที่มีอีเมล = ผู้ติดต่อทุกคนที่มีอีเมล สูงสุด 5) · ไม่มีเลย → 422 `document_email_no_recipient` | `["ap@example.co.th"]` |
| `purpose` |   | `string` | ค่า: `DOCUMENT`, `PAYMENT_REMINDER` | DOCUMENT = ส่งใบแจ้งหนี้ · PAYMENT_REMINDER = ใบแจ้งเตือนชำระ (ต้นแบบหน้า "รับชำระ") — เฉพาะใบที่ยังมียอดค้าง (ISSUED / PARTIALLY_PAID) · ทั้งสองแบบแนบ PDF ต้นฉบับของใบ |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `DocumentEmailResultDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:finalize`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบแจ้งหนี้ (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress), [invoice_pdf_template_changed](errors.md#invoice_pdf_template_changed), [document_email_pending](errors.md#document_email_pending) | `ProblemDto` |
| `422` | `validation_failed` — `to` ผิดรูปแบบ/ซ้ำ/เกิน 5 · `document_email_no_recipient` — ไม่ระบุ `to` และลูกค้าไม่มีอีเมลผู้ติดต่อ · `email_attachment_too_large` — ไฟล์แนบเกินขนาด (`sizeBytes`, `maxBytes`) → ดาวน์โหลดแล้วส่งเอง — [validation_failed](errors.md#validation_failed), [document_email_no_recipient](errors.md#document_email_no_recipient), [email_attachment_too_large](errors.md#email_attachment_too_large) | `ProblemDto` |
| `429` | `rate_limited` — อีเมลเอกสารของบริษัทเกิน 200 ผู้รับต่อชั่วโมง (`limit`, `sentLastHour`) — ลองใหม่ภายหลังหรือดาวน์โหลดแล้วส่งเอง — [rate_limited](errors.md#rate_limited) | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/invoices/<id>/send" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"to":["ap@example.co.th"]}'
```

```ts
const { data, error } = await tms.POST('/v1/invoices/{id}/send', {
  params: { path: { id: "…" } },
  body: {
    "to": [
      "ap@example.co.th"
    ]
  },
});
```

## ประวัติการส่งใบแจ้งหนี้ทางอีเมล + สถานะการส่งต่อผู้รับ {#get-invoices-id-emails}

`GET /v1/invoices/{id}/emails`

scope: `invoices:read` · operationId: `Invoices_emails`

การส่งรายใบ (`POST /invoices/{id}/send`) เท่านั้น — ส่งเป็นชุดใบวางบิลดูที่ `GET /billing-notes/{id}/emails` · ใหม่สุดก่อน (สูงสุด 100)

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `DocumentEmailListDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบแจ้งหนี้ (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/invoices/<id>/emails" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/invoices/{id}/emails', {
  params: { path: { id: "…" } },
});
```

## สั่งรอบวางบิล (async) — สร้างร่างใบแจ้งหนี้ทุกลูกค้าตาม billing_cycle (+ ร่างใบวางบิล) {#post-invoice-runs}

`POST /v1/invoice-runs`

scope: `invoices:draft` · operationId: `InvoiceRuns_create`

บัญชีเบา: ร่าง **ไม่มีเลข ไม่ใช่เอกสารภาษี** · ลูกค้าที่ `billingCycle` = รอบที่สั่ง (ไม่รวม `MANUAL` และลูกค้าที่ปิดใช้ `INACTIVE`) ที่มี DO พร้อมวางบิล (กฎเดียวกับ `GET /invoices/queue` + เวลาจุดส่งครบ) วันที่ DO อยู่ในงวด → ร่างผ่านทางเดียวกับ `POST /invoices` (ตรวจซ้ำตอนดึง · กันวางบิลซ้ำระดับ DB · audit `invoice.draft_created`) · `MONTHLY`/`WEEKLY` = **ใบแจ้งหนี้ใบเดียวต่อลูกค้าต่อรอบ** งวด = ที่สั่ง (เพดาน 1000 DO ต่อใบ — เกินจึงแบ่งหลายร่าง + `splitByCap`) · `PER_DO` = 1 ร่างต่อ DO · `billingNotes` (ค่าเริ่มต้น true) = ร่างใบวางบิลจากใบแจ้งหนี้ที่ออกแล้วยังค้าง และยังไม่อยู่ในใบวางบิลที่ active **เฉพาะใบของงวดนี้** (วันสิ้นงวดของใบ `periodTo` อยู่ในงวดของรอบ — ใบที่งวดคร่อมขอบรอบเข้ารอบที่งวดจบ; ใบที่ออกเลขหลังรอบของงวดนั้นไม่ถูกเลือกโดยรอบถัดไป — ทำใบวางบิลมือหรือสั่งรอบของงวดนั้นซ้ำ; ใบที่ไม่มีงวดใช้วันที่ออก) (1 ร่างต่อผู้ออก/สาขาผู้ออก) · **สั่งซ้ำไม่สร้างซ้ำ:** DO/ใบแจ้งหนี้ที่ถูกดึงแล้วไม่ถูกเลือกอีก · **ร่างละ transaction** (รวมการส่งบัญชีของ DO ในกลุ่ม) — กลุ่มที่ล้มย้อนทั้งกลุ่ม กลุ่ม/ลูกค้าอื่นไม่ล้มตาม · DO ที่ไม่ผ่านตอนดึง (ระบุตัวได้) ถูกข้าม (`skippedDeliveryOrders`) · ร่างลงชื่อผู้สั่งเป็นผู้สร้าง (กฎแบ่งหน้าที่ของ finalize ใช้เหมือนสร้างมือ) · 202 `{jobId, statusUrl}` → `GET /v1/jobs/{id}`: `progress` ต่อร่าง · `result` = `InvoiceRunResult` (ผลต่อลูกค้า SUCCEEDED/PARTIAL/FAILED/NOTHING_TO_BILL + ลิงก์ร่าง ≤ 50 ต่อลูกค้า — ไม่มียอดเงิน) · ไม่มีลูกค้า PARTIAL/FAILED = `succeeded`, มี = `succeeded_with_errors` · จบ = webhook `job.completed` · **ไฟล์สรุปรอบ.xlsx** (`result.summary.url` = `GET /v1/exports/{jobId}` เฉพาะผู้สั่งที่มี `export:run`; ยอดเงินในไฟล์เฉพาะผู้สั่งที่มี `prices.sell:read`; ใช้ได้ 7 วัน; แจ้งเตือนผู้สั่งพร้อมลิงก์) · ไม่มีรอบอัตโนมัติตามเวลา (สั่งเองเท่านั้น) · ผู้สั่งดู `statusUrl` ได้แม้ไม่มี `jobs:read` · job เก็บ 7 วัน · นับเป็นคำขอหนัก (rate limit ชั้น heavy)

**Request body** `CreateInvoiceRunDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `billingCycle` | ใช่ | `string` | ค่า: `PER_DO`, `WEEKLY`, `MONTHLY` | รอบวางบิลของลูกค้าที่เข้ารอบนี้ (`customer.billingCycle`) · `MANUAL` และลูกค้าที่ปิดใช้ (`INACTIVE`) ไม่เข้ารอบ · `MONTHLY`/`WEEKLY` = **ใบแจ้งหนี้ใบเดียวต่อลูกค้าต่อรอบ** (เกิน 1000 DO จึงแบ่งเป็นหลายร่าง + `splitByCap`) · `PER_DO` = 1 ร่างต่อ DO |   |
| `periodFrom` | ใช่ | `string` |   | งวดตั้งแต่ (วันที่ DO — `doDate`) | `2026-10-01` |
| `periodTo` | ใช่ | `string` |   | งวดถึง (วันที่ DO — `doDate`) ≥ periodFrom | `2026-10-31` |
| `releaseDeliveryOrders` |   | `boolean` |   | true = ส่งบัญชี DO ที่ยังไม่ส่งพร้อมสร้างร่าง (เหมือน `POST /invoices` `releaseDeliveryOrders`) · ไม่ส่ง/false = ดึงเฉพาะ DO ที่ส่งบัญชีแล้ว |   |
| `billingNotes` |   | `boolean` |   | สร้างร่างใบวางบิลอัตโนมัติ จากใบแจ้งหนี้ที่ออกแล้วยังค้างและยังไม่อยู่ในใบวางบิลที่ active ของลูกค้าในรอบนี้ **เฉพาะใบของงวดนี้**: วันสิ้นงวดของใบ (`periodTo`) อยู่ในงวดของรอบ (ใบที่งวดคร่อมขอบรอบเข้ารอบที่งวดของใบจบ) · ใบที่ออกเลขหลังรอบของงวดนั้นสั่งไปแล้ว **ไม่ถูกเลือกโดยรอบถัดไป** (periodTo อยู่นอกงวด) — ทำใบวางบิลมือ (`GET /billing-notes/candidates`) หรือสั่งรอบของงวดนั้นซ้ำ · ใบที่ไม่มีงวดใช้วันที่ออก (`issueDate`) อยู่ในงวดของรอบ (1 ร่างต่อผู้ออก/สาขาผู้ออก) · ไม่ส่ง = true |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `202` | รับงานแล้ว ติดตามที่ `statusUrl` | `InvoiceRunAcceptedDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:draft`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/invoice-runs" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"billingCycle":"PER_DO","periodFrom":"2026-10-01","periodTo":"2026-10-31"}'
```

```ts
const { data, error } = await tms.POST('/v1/invoice-runs', {
  body: {
    "billingCycle": "PER_DO",
    "periodFrom": "2026-10-01",
    "periodTo": "2026-10-31"
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
| `totals` | ใช่ | `BillingQueueTotalsDto` |   | ยอดรวมของทุกแถวที่ตรงตัวกรอง (ไม่ขึ้นกับ cursor/limit) = Σ `customers[]` |   |

### DocumentEmailListDto {#schema-DocumentEmailListDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<DocumentEmailDto>` |   | ใหม่สุดก่อน (สูงสุด 100 รายการ) |   |

### DocumentEmailResultDto {#schema-DocumentEmailResultDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `attachment` | ใช่ | `DocumentEmailAttachmentDto` |   |   |   |
| `emails` | ใช่ | `array<DocumentEmailDto>` |   | 1 แถวต่อผู้รับ (สถานะเริ่ม QUEUED) |   |

### InvoiceDto {#schema-InvoiceDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `ivc_…` |
| `invoiceNo` | ใช่ | `string` | null ได้ | เลขใบแจ้งหนี้ — **ร่างไม่มีเลข** (ออกตอนออกเอกสาร) |   |
| `externalId` | ใช่ | `string` | null ได้ | เลขของระบบต้นทาง (ERP) — ตั้งได้ตอนสร้างผ่าน `PUT /invoices/external/{externalId}` เท่านั้น (D68-45) |   |
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
| `overdue` | ใช่ | `boolean` |   | เกินกำหนด — ค้างรับ (ISSUED/PARTIALLY_PAID) และเลยวันครบกำหนด (เวลาไทย) · **ธงแยกจาก `status`** (ใบชำระบางส่วนที่เลยกำหนด = `PARTIALLY_PAID` + `overdue: true`) · ตั้งโดย job รายวัน 00:05 และตอนรับชำระ/กลับรายการ · ชำระครบแล้วหลุดเอง |   |
| `overdueAt` | ใช่ | `string` | null ได้ | เวลาที่ระบบตั้งธงเกินกำหนด — ไม่เกิน = null | `2026-11-21T17:05:00.000Z` |
| `sentToCustomerAt` | ใช่ | `string` | null ได้ | ส่งลูกค้าแล้วเมื่อ — ส่งแล้วยกเลิกใบไม่ได้ (409 `invoice_sent_to_customer`) |   |
| `sentToCustomerChannel` | ใช่ | `string` | ค่า: `MANUAL`, `BILLING_NOTE`, `EMAIL` · null ได้ | ช่องทางที่ทำให้ "ส่งลูกค้าแล้ว": MANUAL = ทำเครื่องหมายเอง · BILLING_NOTE = ออกใบวางบิล · EMAIL = ส่งอีเมล |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string` |   |   |   |
| `updatedAt` | ใช่ | `string` |   |   |   |
| `sync` |   | `ErpDocumentSyncDto` | null ได้ | ผลการส่งใบนี้เข้าระบบบัญชีที่เชื่อมต่อ (เลขเอกสารสองฝั่ง — `externalDocNo` = เลขที่ระบบบัญชีออก) · แยกจาก `status` ของเอกสาร · มีเฉพาะ `GET /{id}` · null = ยังไม่มีผลการส่ง (ไม่ได้เชื่อมระบบบัญชี / ยังรอคิว / ส่งไม่สำเร็จ — ดูคิวของ connector) |   |
| `erpWarnings` |   | `array<ErpDocumentWarningDto>` |   | คำเตือนก่อนส่งใบนี้เข้าระบบบัญชีที่เชื่อมต่อ (ร่าง/ออกแล้ว — ไม่บล็อกการออกเอกสาร) · ไม่เชื่อมระบบบัญชี / ไม่เปิดส่งใบแจ้งหนี้ / ยกเลิกแล้ว / วันที่ก่อนวันเริ่มซิงก์ = `[]` · ส่งสำเร็จแล้ว = ข้อความแบบอดีต · มีเฉพาะ `GET /{id}` |   |
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
| `cancelledAt` | ใช่ | `string` | null ได้ | เวลายกเลิก · null = ไม่ถูกยกเลิก |   |
| `replacesInvoice` | ใช่ | `InvoiceReplacesDto` | null ได้ | ใบนี้ออกแทนใบที่ยกเลิก · PDF พิมพ์หมายเหตุอ้างเลข/วันที่เดิม |   |
| `replacedByInvoice` | ใช่ | `InvoiceReplacedByDto` | null ได้ | ใบที่ออกแทนใบนี้ (ใบที่ยกเลิกแล้วออกใหม่ — ล่าสุดที่ยังไม่ยกเลิก) |   |
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

### InvoiceRunAcceptedDto {#schema-InvoiceRunAcceptedDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `jobId` | ใช่ | `string` |   |   | `job_3f2a…` |
| `statusUrl` | ใช่ | `string` |   |   | `/v1/jobs/job_3f2a…` |

### InvoiceSummaryCountsDto {#schema-InvoiceSummaryCountsDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `total` | ใช่ | `number` |   |   |   |
| `draft` | ใช่ | `number` |   |   |   |
| `issued` | ใช่ | `number` |   | ISSUED ที่ไม่เกินกำหนด: ไม่รวม ADJUSTED (นิยามลูกหนี้เดียวกับ `GET /payments/summary` — ADJUSTED นับใน `total` เท่านั้น) |   |
| `partiallyPaid` | ใช่ | `number` |   | PARTIALLY_PAID ที่ไม่เกินกำหนด |   |
| `paid` | ใช่ | `number` |   |   |   |
| `overdue` | ใช่ | `number` |   | เกินกำหนด — ใบที่มีธง `overdue` |   |
| `cancelled` | ใช่ | `number` |   | CANCELLED + VOIDED |   |
| `today` | ใช่ | `string` |   | วันนี้ตามเวลาไทยของ server (ใช้ตัดเกินกำหนด/เดือน) | `2026-11-22` |
| `sellDraftTotal` |   | `string` |   | Σ ยอดรวมของร่าง (ประมาณการ — ยังไม่ออกเลข) — `prices.sell:read` | `12500.00` |
| `sellIssuedOutstanding` |   | `string` |   | Σ ยอดค้าง (ยอดรวม − ยอดตัดชำระ) ของใบในแท็บ "ออกแล้ว" (ISSUED ที่ไม่เกินกำหนด) — `prices.sell:read` | `48000.00` |
| `sellPartiallyPaidOutstanding` |   | `string` |   | Σ ยอดค้างของใบชำระบางส่วนที่ไม่เกินกำหนด — `prices.sell:read` | `3200.00` |
| `sellOverdueOutstanding` |   | `string` |   | Σ ยอดค้างของใบเกินกำหนด (ชุดเดียวกับ `overdue` และ `GET /payments/summary` `sellOverdueOutstanding`) — `prices.sell:read` | `12500.00` |
| `due` | ใช่ | `number` |   | D68-94 ครบกำหนด — ใบค้างรับที่ยังมียอดค้างและ `dueDate` ≤ วันนี้ (เวลาไทย) **รวมใบเกินกำหนด** (= `overdue` + ใบที่ครบกำหนดวันนี้) · ชุดเดียวกับ `GET /invoices?receivable=due` · ซ้อนกับ `issued`/`partiallyPaid` เฉพาะใบที่ครบวันนี้ (ไม่นับใน `total` ซ้ำ) |   |
| `sellDueOutstanding` |   | `string` |   | D68-94 Σ ยอดค้างของใบครบกำหนด (ชุดเดียวกับ `due`) — `prices.sell:read` | `12821.07` |
| `issuedThisMonth` | ใช่ | `InvoiceMonthTotalDto` |   | ใบที่ออกเลขเดือนนี้ (วันที่ 1 ถึงวันนี้ ตาม `issueDate` เวลาไทย) ไม่รวมร่าง/ยกเลิก |   |
| `issuedLastMonth` | ใช่ | `InvoiceMonthTotalDto` |   | ใบที่ออกเลขเดือนก่อน (ทั้งเดือน) ไม่รวมร่าง/ยกเลิก |   |
