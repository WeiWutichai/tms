# ใบส่งของ (delivery-orders)

19 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`GET /v1/delivery-orders/summary`](#get-delivery-orders-summary) | `orders:read` |
| [`GET /v1/delivery-orders`](#get-delivery-orders) | `orders:read` |
| [`POST /v1/delivery-orders`](#post-delivery-orders) | `orders:write` |
| [`GET /v1/delivery-orders/{id}`](#get-delivery-orders-id) | `orders:read` |
| [`POST /v1/delivery-orders/{id}/split`](#post-delivery-orders-id-split) | `orders:write` |
| [`POST /v1/delivery-orders/{id}/merge`](#post-delivery-orders-id-merge) | `orders:write` |
| [`POST /v1/delivery-orders/{id}/cancel`](#post-delivery-orders-id-cancel) | `orders:cancel` |
| [`POST /v1/delivery-orders/{id}/redeliver`](#post-delivery-orders-id-redeliver) | `orders:write` |
| [`POST /v1/delivery-orders/{id}/return`](#post-delivery-orders-id-return) | `orders:write` |
| [`POST /v1/delivery-orders/{id}/revert-delivery`](#post-delivery-orders-id-revert-delivery) | `trips:close` |
| [`GET /v1/delivery-orders/{id}/pod`](#get-delivery-orders-id-pod) | `trips:read` |
| [`PUT /v1/delivery-orders/{id}/pod`](#put-delivery-orders-id-pod) | `trips:dispatch` |
| [`POST /v1/delivery-orders/{id}/release`](#post-delivery-orders-id-release) | `invoices:draft` |
| [`POST /v1/delivery-orders/{id}/unrelease`](#post-delivery-orders-id-unrelease) | `invoices:draft` |
| [`POST /v1/delivery-orders/bulk-release`](#post-delivery-orders-bulk-release) | `invoices:draft` |
| [`GET /v1/delivery-orders/{id}/revenue-lines`](#get-delivery-orders-id-revenue-lines) | `orders:read` |
| [`GET /v1/delivery-orders/{id}/tracking-link`](#get-delivery-orders-id-tracking-link) | `orders:write` / `trips:dispatch` |
| [`POST /v1/delivery-orders/{id}/tracking-link`](#post-delivery-orders-id-tracking-link) | `orders:write` / `trips:dispatch` |
| [`POST /v1/delivery-orders/{id}/tracking-link/revoke`](#post-delivery-orders-id-tracking-link-revoke) | `orders:write` / `trips:dispatch` |

## ตัวนับ DO ของวันนี้ (เวลาไทย) {#get-delivery-orders-summary}

`GET /v1/delivery-orders/summary`

scope: `orders:read` · operationId: `DeliveryOrders_summary`

นับด้วยตัวกรองชุดเดียวกับ `GET /delivery-orders` ของวัน `date` (dateFrom = dateTo = date) — ตัวเลขเท่ากับจำนวนแถวของรายการเมื่อใช้ตัวกรองตามคำอธิบายของแต่ละช่อง · การ์ดหน้า `/do` (`draft` / `inTransit` / `unbilled`) นับทุกวันที่

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `DeliveryOrderSummaryDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`orders:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/delivery-orders/summary" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/delivery-orders/summary');
```

## GET /v1/delivery-orders {#get-delivery-orders}

`GET /v1/delivery-orders`

scope: `orders:read` · operationId: `DeliveryOrders_list`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน |
| `updatedAfter` | query |   | `string` | คืนเฉพาะแถวที่ updatedAt > ค่านี้ (incremental pull) |
| `sort` | query |   | `string` ค่า: `updatedAt`, `-updatedAt` |   |
| `fields` | query |   | `string` | รายชื่อ field คั่นด้วย, เช่น id,legalName |
| `orderId` | query |   | `string` | ใบสั่งขนส่ง (SO) |
| `customerId` | query |   | `string` |   |
| `status` | query |   | `string` | สถานะ คั่นด้วย, (DRAFT / PLANNED / DISPATCHED / PICKED_UP / DELIVERED / FAILED / RETURNED / POD_PENDING / UNBILLED / BILLED / CANCELLED) |
| `dateFrom` | query |   | `string` | วันที่ DO ตั้งแต่ (YYYY-MM-DD) |
| `dateTo` | query |   | `string` | วันที่ DO ถึง (YYYY-MM-DD) |
| `doNo` | query |   | `string` | ค้นเลข DO (มีคำนี้ ไม่สนตัวพิมพ์) — หน้ารายการ `/do` |
| `customerName` | query |   | `string` | ค้นชื่อลูกค้า (มีคำนี้) |
| `vehiclePlate` | query |   | `string` | ค้นทะเบียนรถของเที่ยว (snapshot — มีคำนี้) |
| `driverName` | query |   | `string` | ค้นชื่อคนขับ / รถร่วมของเที่ยว (snapshot — มีคำนี้) |
| `product` | query |   | `string` | ค้นสินค้า (คำอธิบายบรรทัดของ DO — มีคำนี้) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `DeliveryOrderPageDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`orders:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/delivery-orders" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/delivery-orders');
```

## POST /v1/delivery-orders {#post-delivery-orders}

`POST /v1/delivery-orders`

scope: `orders:write` · operationId: `DeliveryOrders_create`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `Idempotency-Key` | header |   | `string` |   |

**Request body** `CreateDeliveryOrderDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `orderId` | ใช่ | `string` |   |   | `ord_3f2a…` |
| `destStopSeq` |   | `number` |   | ลำดับจุดส่งของ SO — บังคับเมื่อ SO มีหลายจุดส่ง (1 DO ต่อ 1 จุดส่ง) | `2` |
| `originStopSeq` |   | `number` |   | ลำดับจุดรับ — ไม่ระบุ = จุดรับแรก | `1` |
| `lines` |   | `array<DeliveryOrderLineQtyDto>` |   | ไม่ระบุ = ปริมาณคงเหลือทั้งหมดของ SO (ห้ามเกินคงเหลือ) |   |
| `lines[].soLineNo` | ใช่ | `number` |   | ลำดับบรรทัดสินค้าของ SO | `1` |
| `lines[].qty` | ใช่ | `string` |   | ปริมาณ > 0 (สตริงทศนิยม ≤ 3 ตำแหน่ง) | `12.5` |
| `lines[].unit` |   | `string` |   | ถ้าระบุต้องตรงหน่วยของบรรทัด SO | `TON` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `201` |   | `DeliveryOrderDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`orders:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/delivery-orders" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"orderId":"ord_3f2a…","destStopSeq":2,"originStopSeq":1}'
```

```ts
const { data, error } = await tms.POST('/v1/delivery-orders', {
  body: {
    "orderId": "ord_3f2a…",
    "destStopSeq": 2,
    "originStopSeq": 1
  },
});
```

## GET /v1/delivery-orders/{id} {#get-delivery-orders-id}

`GET /v1/delivery-orders/{id}`

scope: `orders:read` · operationId: `DeliveryOrders_get`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `DeliveryOrderDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`orders:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/delivery-orders/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/delivery-orders/{id}', {
  params: { path: { id: "…" } },
});
```

## POST /v1/delivery-orders/{id}/split {#post-delivery-orders-id-split}

`POST /v1/delivery-orders/{id}/split`

scope: `orders:write` · operationId: `DeliveryOrders_split`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `SplitDeliveryOrderDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `parts` | ใช่ | `array<DeliveryOrderSplitPartDto>` |   | ≥ 2 ส่วน — ปริมาณรวมต่อบรรทัดต้องเท่าใบเดิมพอดี |   |
| `parts[].lines` | ใช่ | `array<DeliveryOrderLineQtyDto>` |   |   |   |
| `parts[].lines[].soLineNo` | ใช่ | `number` |   | ลำดับบรรทัดสินค้าของ SO | `1` |
| `parts[].lines[].qty` | ใช่ | `string` |   | ปริมาณ > 0 (สตริงทศนิยม ≤ 3 ตำแหน่ง) | `12.5` |
| `parts[].lines[].unit` |   | `string` |   | ถ้าระบุต้องตรงหน่วยของบรรทัด SO | `TON` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `DeliveryOrderSplitResultDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`orders:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/delivery-orders/<id>/split" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"parts":[{"lines":[{}]}]}'
```

```ts
const { data, error } = await tms.POST('/v1/delivery-orders/{id}/split', {
  params: { path: { id: "…" } },
  body: {
    "parts": [
      {
        "lines": [
          {}
        ]
      }
    ]
  },
});
```

## POST /v1/delivery-orders/{id}/merge {#post-delivery-orders-id-merge}

`POST /v1/delivery-orders/{id}/merge`

scope: `orders:write` · operationId: `DeliveryOrders_merge`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag ของใบนี้ — ไม่ตรง → 412 |

**Request body** `MergeDeliveryOrdersDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `deliveryOrderIds` | ใช่ | `array<string>` |   | DO ที่จะรวมเข้าใบนี้ (SO + จุดส่งเดียวกัน, DRAFT, ไม่อยู่ในเที่ยว) | `["do_3f2a…"]` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `DeliveryOrderDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`orders:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/delivery-orders/<id>/merge" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"deliveryOrderIds":["do_3f2a…"]}'
```

```ts
const { data, error } = await tms.POST('/v1/delivery-orders/{id}/merge', {
  params: { path: { id: "…" } },
  body: {
    "deliveryOrderIds": [
      "do_3f2a…"
    ]
  },
});
```

## POST /v1/delivery-orders/{id}/cancel {#post-delivery-orders-id-cancel}

`POST /v1/delivery-orders/{id}/cancel`

scope: `orders:cancel` · operationId: `DeliveryOrders_cancel`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `CancelDeliveryOrderDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `ลูกค้าขอยกเลิกการส่งรอบนี้` |
| `reasonCodeId` |   | `string` | null ได้ | เหตุผลมาตรฐานหมวด CANCEL | `rsn_3f2a…` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `DeliveryOrderDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`orders:cancel`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/delivery-orders/<id>/cancel" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"ลูกค้าขอยกเลิกการส่งรอบนี้"}'
```

```ts
const { data, error } = await tms.POST('/v1/delivery-orders/{id}/cancel', {
  params: { path: { id: "…" } },
  body: {
    "reason": "ลูกค้าขอยกเลิกการส่งรอบนี้"
  },
});
```

## POST /v1/delivery-orders/{id}/redeliver {#post-delivery-orders-id-redeliver}

`POST /v1/delivery-orders/{id}/redeliver`

scope: `orders:write` · operationId: `DeliveryOrders_redeliver`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag ของใบเดิม — ไม่ตรง → 412 |

**Request body** `RedeliverDeliveryOrderDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reasonCodeId` | ใช่ | `string` |   | เหตุผล: DO ส่งแล้ว (ปฏิเสธรับบางส่วน/ทั้งหมด) = หมวด REJECTED_BY_RECEIVER · DO ส่งไม่สำเร็จ = หมวด DELIVERY_FAILED | `rsn_3f2a…` |
| `note` |   | `string` | ยาว ≤ 500 · null ได้ | โน้ต — บังคับเมื่อเหตุผลติ๊ก "บังคับโน้ต"; ชื่อเหตุผล + โน้ต รวม ≥ 10 ตัวอักษร |   |
| `lines` |   | `array<ReturnLineInputDto>` |   | เฉพาะ DO ส่งแล้ว: บรรทัด + ปริมาณ (ไม่ส่ง = ทุกบรรทัดที่ยังปฏิเสธคงเหลือ ทั้งจำนวน) · DO ส่งไม่สำเร็จ = ทั้งใบเสมอ (ส่งมา → 422) |   |
| `lines[].lineNo` |   | `number` |   | ลำดับบรรทัดของ DO (`lines[].lineNo`) — ส่ง `lineNo` หรือ `doLineId` อย่างน้อยหนึ่งช่อง (ไม่ส่งเลย → 422 `line_ref_required`) | `1` |
| `lines[].doLineId` |   | `string` |   | public id ของบรรทัด DO (`lines[].doLineId`) — ไม่ใช่บรรทัดของ DO ใบนี้ → 422 `unknown_line` · ส่งคู่กับ `lineNo` ต้องตรงกัน ไม่งั้น 422 `line_ref_mismatch` | `dol_3f2a…` |
| `lines[].qty` | ใช่ | `string` |   | > 0 และไม่เกินที่ปฏิเสธรับคงเหลือ (`openRejectQty`) — ทศนิยม ≤ 3 ตำแหน่ง | `10` |
| `doDate` |   | `string` |   | วันส่งของ DO ใหม่ (เวลาไทย) — ไม่ส่ง = วันนี้ · ก่อนวันนี้ → 422 | `2026-11-19` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `RedeliverResultDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`orders:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/delivery-orders/<id>/redeliver" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reasonCodeId":"rsn_3f2a…","doDate":"2026-11-19"}'
```

```ts
const { data, error } = await tms.POST('/v1/delivery-orders/{id}/redeliver', {
  params: { path: { id: "…" } },
  body: {
    "reasonCodeId": "rsn_3f2a…",
    "doDate": "2026-11-19"
  },
});
```

## POST /v1/delivery-orders/{id}/return {#post-delivery-orders-id-return}

`POST /v1/delivery-orders/{id}/return`

scope: `orders:write` · operationId: `DeliveryOrders_return`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `ReturnDeliveryOrderDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reasonCodeId` | ใช่ | `string` |   | เหตุผล: DO ส่งแล้ว (ปฏิเสธรับบางส่วน/ทั้งหมด) = หมวด REJECTED_BY_RECEIVER · DO ส่งไม่สำเร็จ = หมวด DELIVERY_FAILED | `rsn_3f2a…` |
| `note` |   | `string` | ยาว ≤ 500 · null ได้ | โน้ต — บังคับเมื่อเหตุผลติ๊ก "บังคับโน้ต"; ชื่อเหตุผล + โน้ต รวม ≥ 10 ตัวอักษร |   |
| `lines` |   | `array<ReturnLineInputDto>` |   | เฉพาะ DO ส่งแล้ว: บรรทัด + ปริมาณ (ไม่ส่ง = ทุกบรรทัดที่ยังปฏิเสธคงเหลือ ทั้งจำนวน) · DO ส่งไม่สำเร็จ = ทั้งใบเสมอ (ส่งมา → 422) |   |
| `lines[].lineNo` |   | `number` |   | ลำดับบรรทัดของ DO (`lines[].lineNo`) — ส่ง `lineNo` หรือ `doLineId` อย่างน้อยหนึ่งช่อง (ไม่ส่งเลย → 422 `line_ref_required`) | `1` |
| `lines[].doLineId` |   | `string` |   | public id ของบรรทัด DO (`lines[].doLineId`) — ไม่ใช่บรรทัดของ DO ใบนี้ → 422 `unknown_line` · ส่งคู่กับ `lineNo` ต้องตรงกัน ไม่งั้น 422 `line_ref_mismatch` | `dol_3f2a…` |
| `lines[].qty` | ใช่ | `string` |   | > 0 และไม่เกินที่ปฏิเสธรับคงเหลือ (`openRejectQty`) — ทศนิยม ≤ 3 ตำแหน่ง | `10` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `DeliveryOrderDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`orders:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/delivery-orders/<id>/return" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reasonCodeId":"rsn_3f2a…"}'
```

```ts
const { data, error } = await tms.POST('/v1/delivery-orders/{id}/return', {
  params: { path: { id: "…" } },
  body: {
    "reasonCodeId": "rsn_3f2a…"
  },
});
```

## ย้อนผลส่งถึง (DELIVERED → ส่งไม่สำเร็จ) {#post-delivery-orders-id-revert-delivery}

`POST /v1/delivery-orders/{id}/revert-delivery`

scope: `trips:close` · operationId: `DeliveryOrderRevert_revertDelivery`

ผู้จัดรถ (`trips:close`) ย้อนได้ภายใน 24 ชม. นับจากเวลาที่ใบส่งของเป็นส่งถึง — เกินต้องมี `deliveries:revert` (owner/admin) (ไม่งั้น 403 `permission_denied` + `reason: revert_window_expired`, `deliveredAt`, `revertDeadline`) · ใบส่งของต้องส่งถึง (DELIVERED/POD_PENDING/UNBILLED) ยังไม่ส่งบัญชี ไม่อยู่ในใบแจ้งหนี้ และยังไม่มีส่งซ้ำ/คืนคลังของที่ปฏิเสธรับ → สถานะเป็น FAILED + เหตุผล + audit `delivery_order.delivery_reverted` แล้วจัดการต่อด้วย `/redeliver` หรือ `/return`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `RevertDeliveryDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 | เหตุผล (บังคับ ≥ 10 ตัวอักษร — ลง audit + ประวัติสถานะ) | `คนขับกดปิดงานผิดจุด ของยังไม่ถึงลูกค้า` |
| `reasonCodeId` |   | `string` | null ได้ | เหตุผลมาตรฐานหมวด DELIVERY_FAILED (ส่งไม่สำเร็จ) — ใช้ต่อกับส่งซ้ำ/คืนคลัง | `rsn_3f2a…` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `DeliveryOrderDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:close`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | `invalid_state_transition` — `errors[].code`: not_delivered · do_released (ส่งบัญชีแล้ว — ย้อนการส่งบัญชีก่อน) · do_in_invoice (อยู่ในร่าง/ใบที่ออกแล้ว) · do_credited · has_followups (ส่งซ้ำ/คืนคลังของที่ปฏิเสธรับแล้ว) · order_closed · trip_costed (เที่ยวปิดต้นทุนแล้ว) — [do_released](errors.md#do_released) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/delivery-orders/<id>/revert-delivery" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"คนขับกดปิดงานผิดจุด ของยังไม่ถึงลูกค้า"}'
```

```ts
const { data, error } = await tms.POST('/v1/delivery-orders/{id}/revert-delivery', {
  params: { path: { id: "…" } },
  body: {
    "reason": "คนขับกดปิดงานผิดจุด ของยังไม่ถึงลูกค้า"
  },
});
```

## หลักฐานส่งของ DO (ฉบับปัจจุบัน + ประวัติ + checklist + สิ่งที่ขาด) {#get-delivery-orders-id-pod}

`GET /v1/delivery-orders/{id}/pod`

scope: `trips:read` · operationId: `Pod_get`

ETag = เลขฉบับปัจจุบัน (ยังไม่มี = "0") ใช้เป็น If-Match ตอน PUT · `missing[]` เทียบกับ checklist ของลูกค้า **ตอนนี้** (`podStatus` ของ DO คำนวณตอนบันทึก/ตอนส่งถึง)

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `DeliveryOrderPodDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบส่งของ (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/delivery-orders/<id>/pod" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/delivery-orders/{id}/pod', {
  params: { path: { id: "…" } },
});
```

## บันทึก/แก้หลักฐานส่ง (ฉบับใหม่ทุกครั้ง) {#put-delivery-orders-id-pod}

`PUT /v1/delivery-orders/{id}/pod`

scope: `trips:dispatch` · operationId: `Pod_put`

ส่งทั้งฉบับ → ฉบับใหม่ (version + 1) · แก้ฉบับเดิมต้องมี `reason` ≥ 10 ตัวอักษร (audit `pod.amended`) · คำนวณ `pod_status` กับ checklist ของลูกค้า (DO ส่งไม่สำเร็จใช้ชุดไม่สำเร็จ): ครบ = COMPLETE, ไม่ครบ = PARTIAL (ไม่ปฏิเสธ) · DO DELIVERED → UNBILLED (ครบ) / POD_PENDING (ไม่ครบ), POD_PENDING → UNBILLED เมื่อครบ — DO ที่ UNBILLED แล้วแก้จนไม่ครบ → 422 `pod_incomplete` (ด่านวางบิล) · ไฟล์ที่ใช้ถูกผูกกับ DO นี้ (`stored_document.entity_type/entity_id`) ใช้กับ DO อื่นไม่ได้ · domain_event `pod.captured` · บันทึกได้เมื่อ DO ส่งแล้ว/ส่งไม่สำเร็จ ยังไม่วางบิล

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag จาก GET (เลขฉบับ — ยังไม่มี = "0") · ไม่ตรง → 412 |

**Request body** `SubmitPodDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `receiverName` |   | `string` | ยาว ≤ 100 · null ได้ | ชื่อผู้รับ | `สมศรี ใจงาม` |
| `receiverRelation` |   | `string` | ค่า: `SELF`, `SECURITY`, `STAFF`, `OTHER` · null ได้ | ความสัมพันธ์ของผู้รับ: SELF = ผู้รับเอง · SECURITY = รปภ. · STAFF = พนักงาน · OTHER = อื่น ๆ |   |
| `signatureDocumentId` |   | `string` | null ได้ | ลายเซ็นผู้รับ — เอกสาร kind `POD_SIGNATURE` (PNG/JPEG/WebP) ที่อัปโหลดเสร็จแล้ว | `doc_3f2a…` |
| `photoDocumentIds` |   | `array<string>` | ≤ 20 รายการ | รูปหลักฐานส่ง — เอกสาร kind `POD_PHOTO` (รูป) ไม่เกิน 20 ใบ ไม่ซ้ำ · นับกับ "รูปขั้นต่ำ" ของ checklist |   |
| `fileDocumentIds` |   | `array<string>` | ≤ 10 รายการ | ไฟล์อื่น (เช่น ใบส่งของที่เซ็นแล้ว ใบชั่ง) — เอกสาร kind `POD_FILE` (PDF/รูป) ไม่เกิน 10 ไฟล์ · ไม่นับเป็นรูปของ checklist |   |
| `weighedKg` |   | `string` | null ได้ | น้ำหนักชั่งปลายทาง (กก.) ทศนิยมไม่เกิน 3 ตำแหน่ง — สตริง (ห้าม float) | `14940` |
| `customerRef` |   | `string` | ยาว ≤ 50 · null ได้ | เลขอ้างอิงของลูกค้าตอนรับของ (เช่น เลขใบรับสินค้า) — เก็บในหลักฐานส่ง **ไม่แก้** `customerRef` ของ DO | `GR-2611-0042` |
| `note` |   | `string` | ยาว ≤ 500 · null ได้ |   |   |
| `checks` |   | `object` |   | ข้อยืนยัน (BOOLEAN) ตาม key ใน checklist — key ที่ไม่มีใน checklist → 422 | `{"goods_ok":true}` |
| `choices` |   | `object` |   | คำตอบคำถามเลือกตอบ (SINGLE_CHOICE) ตาม key — ต้องเป็นตัวเลือกในรายการ | `{"box_state":"ดี"}` |
| `barcodes` |   | `array<string>` | ≤ 50 รายการ | รหัสบาร์โค้ด/QR ที่สแกนได้ (BARCODE) ยาวไม่เกิน 200 — ชื่อตาม |   |
| `scanCodes` |   | `array<string>` | ≤ 50 รายการ | ชื่อเดิมของ `barcodes` — รับได้เพื่อความเข้ากันได้ · ส่งทั้งสองชื่อต้องเหมือนกัน |   |
| `pin` |   | `string` | null ได้ | รหัส PIN ที่ผู้รับกรอก (ตัวเลขครบจำนวนหลักตาม checklist) — เก็บแบบเข้ารหัส response แสดงแบบปิดบังเท่านั้น · **ไม่ส่ง = คงค่าของฉบับก่อน** (อ่านค่าจริงคืนไม่ได้) · null = ล้าง | `4821` |
| `rating` |   | `number` | ≥ 1 · ≤ 10 · null ได้ | คะแนนความพึงพอใจของผู้รับ (RATING) 1–คะแนนเต็มของ checklist |   |
| `lines` |   | `array<PodLineInputDto>` | ≤ 500 รายการ | ยอดส่งจริงต่อรายการ (เฉพาะ DO ที่ส่งแล้ว — ชุดสำเร็จ; DO ส่งไม่สำเร็จ/ตีกลับ → 422 `not_applicable`) · **ไม่ส่ง = คงค่าของฉบับก่อน** · บรรทัดที่ไม่อยู่ในรายการ = คงค่าเดิม (ยังไม่เคยบันทึก = ตามแผน) |   |
| `lines[].lineNo` |   | `number` |   | ลำดับบรรทัดของ DO (`lines[].lineNo` ของ GET /v1/delivery-orders/{id}) — ส่ง `lineNo` หรือ `doLineId` อย่างน้อยหนึ่งช่อง (ไม่ส่งเลย → 422 `line_ref_required`) | `1` |
| `lines[].doLineId` |   | `string` |   | public id ของบรรทัด DO (`lines[].doLineId`) — ไม่ใช่บรรทัดของ DO ใบนี้ → 422 `unknown_line` · ส่งคู่กับ `lineNo` ต้องตรงกัน ไม่งั้น 422 `line_ref_mismatch` | `dol_3f2a…` |
| `lines[].qtyActual` | ใช่ | `string` |   | จำนวนที่ส่งได้จริง (หน่วยเดียวกับบรรทัด) 0 ≤ ค่า ≤ แผน ทศนิยมไม่เกิน 3 ตำแหน่ง — สตริง (ห้าม float) · เกินแผน → 422 `exceeds_planned` | `90` |
| `lines[].rejectQty` |   | `string` | null ได้ | จำนวนที่ผู้รับปฏิเสธ — ไม่ส่งได้ (ระบบคิด = แผน − ส่งจริง) · ส่งมาต้องเท่ากัน ไม่งั้น 422 `reject_qty_mismatch` | `10` |
| `lines[].rejectReasonCodeId` |   | `string` | null ได้ | เหตุผลมาตรฐานหมวด `REJECTED_BY_RECEIVER` (ปฏิเสธรับ/ตีกลับ) — **บังคับเมื่อส่งจริงน้อยกว่าแผน** (ไม่มี → 422 `reason_required`) · ส่งครบแต่ส่งเหตุผลมา → 422 `reason_not_applicable` · เหตุผลที่บังคับรูป = หลักฐานต้องมีรูป ≥ 1 · บังคับโน้ต = ต้องมี `note` | `rsn_3f2a…` |
| `lines[].note` |   | `string` | ยาว ≤ 500 · null ได้ | โน้ตของรายการที่ปฏิเสธ |   |
| `reason` |   | `string` | ยาว ≤ 500 · ยาว ≥ 10 · null ได้ | เหตุผลการแก้ — **บังคับเมื่อมีหลักฐานอยู่แล้ว** (ฉบับที่ 2 ขึ้นไป, ≥ 10 ตัวอักษร) ลง audit |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `DeliveryOrderPodDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`trips:dispatch`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบส่งของ (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | DO ยังไม่ส่ง / วางบิลแล้ว / ยกเลิก (`doStatus`) — หรือชนกับการแก้ไขพร้อมกัน — [pod_not_allowed](errors.md#pod_not_allowed), [concurrent_update](errors.md#concurrent_update) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับเลขฉบับปัจจุบัน (`currentVersion`) — โหลดใหม่แล้วบันทึกอีกครั้ง — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — ไฟล์ไม่ใช่ของหลักฐานส่ง/ยังอัปโหลดไม่เสร็จ/ผูกกับเอกสารหรือ DO อื่นแล้ว (`document_in_use`), ค่าผิดรูปแบบ (PIN ไม่ครบหลัก ตัวเลือกไม่อยู่ในรายการ คะแนนเกิน), key ไม่อยู่ใน checklist, แก้ฉบับเดิมโดยไม่มีเหตุผล · **หลักฐานที่ยังไม่ครบไม่ถูกปฏิเสธ** (บันทึกเป็น PARTIAL) ยกเว้น DO ที่รอวางบิลแล้ว (UNBILLED) → `pod_incomplete` + `missing[]` — [validation_failed](errors.md#validation_failed), [pod_incomplete](errors.md#pod_incomplete) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PUT "$TMS_BASE_URL/v1/delivery-orders/<id>/pod" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"checks":{"goods_ok":true},"choices":{"box_state":"ดี"}}'
```

```ts
const { data, error } = await tms.PUT('/v1/delivery-orders/{id}/pod', {
  params: { path: { id: "…" } },
  body: {
    "checks": {
      "goods_ok": true
    },
    "choices": {
      "box_state": "ดี"
    }
  },
});
```

## ส่งบัญชี (RELEASED) — ใบส่งของพร้อมวางบิล {#post-delivery-orders-id-release}

`POST /v1/delivery-orders/{id}/release`

scope: `invoices:draft` · operationId: `DeliveryOrderRelease_releaseOne`

ตรวจเงื่อนไขชุดเดียวกับคิวพร้อมวางบิล + จุดส่งมีเวลาถึง/ออกครบ + (ลูกค้าเปิด "ไม่มี POD ไม่วางบิล") หลักฐานล่าสุดผ่าน checklist **ปัจจุบัน** ของลูกค้า → บันทึกเวลา/ผู้ส่งบัญชี + audit `delivery_order.released` · สถานะ DO ไม่เปลี่ยน · ส่งแล้ว = ตอบ DO เดิม (ไม่ทำซ้ำ)

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `ReleaseDeliveryOrderDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `note` |   | `string` | ยาว ≤ 500 | หมายเหตุ (ไม่บังคับ — ลง audit) |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `DeliveryOrderDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:draft`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | `not_ready_to_bill` — DO ยังไม่พร้อมวางบิล: `reasons[]` (NOT_DELIVERED · BILLING_HOLD · PRICING_UNAVAILABLE · NO_REVENUE · REVENUE_PROVISIONAL · REVENUE_LOCKED · SURCHARGE_PENDING · STOP_TIMES_MISSING · POD_INCOMPLETE · IN_INVOICE) + `missing[]` เมื่อหลักฐานไม่ครบ — [not_ready_to_bill](errors.md#not_ready_to_bill) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/delivery-orders/<id>/release" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{}'
```

```ts
const { data, error } = await tms.POST('/v1/delivery-orders/{id}/release', {
  params: { path: { id: "…" } },
  body: {},
});
```

## ย้อนการส่งบัญชี (RELEASED → DELIVERED) {#post-delivery-orders-id-unrelease}

`POST /v1/delivery-orders/{id}/unrelease`

scope: `invoices:draft` · operationId: `DeliveryOrderRelease_unrelease`

"RELEASED ย้อนได้โดย Invoicer": ล้างเวลา/ผู้ส่งบัญชี + audit `delivery_order.unreleased` (เหตุผลบังคับ) · หลังย้อนแก้จุดแวะ/ยอดส่งจริงได้อีก (ล็อกหลังส่งบัญชี — 409 `do_released`) · ใบส่งของในร่างใบแจ้งหนี้ → 409 `do_in_invoice` (ถอดออกจากร่างก่อน) · ออกใบแล้ว (INVOICED) ย้อนไม่ได้ — ใช้ใบลดหนี้ · ยังไม่ส่งบัญชี = ตอบใบเดิม (ไม่ทำซ้ำ)

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `UnreleaseDeliveryOrderDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 | เหตุผล (บังคับ ≥ 10 ตัวอักษร — ลง audit) | `ยอดส่งจริงต้องแก้ตามใบรับของลูกค้า` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `DeliveryOrderDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:draft`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | `invalid_state_transition` + `errors[].code = do_in_invoice` + `billingStatus` (IN_DRAFT ถอดออกจากร่างก่อน · INVOICED ย้อนไม่ได้) — [do_in_invoice](errors.md#do_in_invoice) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/delivery-orders/<id>/unrelease" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"ยอดส่งจริงต้องแก้ตามใบรับของลูกค้า"}'
```

```ts
const { data, error } = await tms.POST('/v1/delivery-orders/{id}/unrelease', {
  params: { path: { id: "…" } },
  body: {
    "reason": "ยอดส่งจริงต้องแก้ตามใบรับของลูกค้า"
  },
});
```

## ส่งบัญชีหลายใบส่งของ {#post-delivery-orders-bulk-release}

`POST /v1/delivery-orders/bulk-release`

scope: `invoices:draft` · operationId: `DeliveryOrderRelease_bulkRelease`

≤ 100 รายการ ทำทีละรายการแยกกัน (สำเร็จบางรายการได้) · เงื่อนไขเหมือน `POST /delivery-orders/{id}/release` · ตอบ 207 เสมอเมื่อคำขอถูกต้อง — ดู `results[].outcome` / `problem`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `Idempotency-Key` | header |   | `string` |   |

**Request body** `BulkReleaseDeliveryOrdersDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `items` | ใช่ | `array<BulkReleaseItemDto>` | ≤ 100 รายการ |   |   |
| `items[].deliveryOrderId` | ใช่ | `string` |   |   | `do_3f2a…` |
| `items[].version` |   | `number` |   | `version` ที่ผู้ใช้เห็น (แทน If-Match ต่อรายการ) — ไม่ตรง → รายการนั้น 412 | `3` |
| `note` |   | `string` | ยาว ≤ 500 | หมายเหตุ (ไม่บังคับ — ลง audit ทุกรายการ) |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `207` | ผลต่อรายการ | `BulkReleaseResultsDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:draft`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/delivery-orders/bulk-release" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"items":[{"deliveryOrderId":"do_3f2a…","version":3}]}'
```

```ts
const { data, error } = await tms.POST('/v1/delivery-orders/bulk-release', {
  body: {
    "items": [
      {
        "deliveryOrderId": "do_3f2a…",
        "version": 3
      }
    ]
  },
});
```

## บรรทัดรายได้ของใบส่งของ + รายได้รวมของใบ {#get-delivery-orders-id-revenue-lines}

`GET /v1/delivery-orders/{id}/revenue-lines`

scope: `orders:read` · operationId: `DeliveryOrderRevenueLines_list`

รายได้ต่อใบส่งของ: ราคาของใบสั่งที่แบ่งลงใบนี้ตามปริมาณ (snapshot × ยอดส่งจริง เมื่อลูกค้าวางบิลตามยอดส่งจริง — ยังไม่บันทึก = แผน `provisional`) + ค่าใช้จ่ายหน้างานที่ยืนยันแล้ว + บรรทัดที่คนเพิ่มผูกใบนี้ · `sellRevenueTotal` = ผลรวมบรรทัดที่ยังใช้ (ยอดเห็นเมื่อมี `prices.sell:read`) · ใบที่ยกเลิก = บรรทัด VOIDED ยอด 0.00 · ไม่คำนวณภาษี

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `DeliveryOrderRevenueDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`orders:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/delivery-orders/<id>/revenue-lines" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/delivery-orders/{id}/revenue-lines', {
  params: { path: { id: "…" } },
});
```

## GET /v1/delivery-orders/{id}/tracking-link {#get-delivery-orders-id-tracking-link}

`GET /v1/delivery-orders/{id}/tracking-link`

scope: `orders:write` หรือ `trips:dispatch` · operationId: `DeliveryOrderTracking_get`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | URL มี token — ต้องมีสิทธิ์ออกลิงก์ · ลิงก์หน้าติดตามของผู้รับ (`/t/{token}` — magic link `tracking`, อายุ token 90 วัน; งานจบเกิน `tracking.linkDays` วัน = ใช้ไม่ได้) · ห้าม cache (มี token) | `TrackingLinkStateDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`orders:write` / `trips:dispatch`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบเที่ยว (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/delivery-orders/<id>/tracking-link" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/delivery-orders/{id}/tracking-link', {
  params: { path: { id: "…" } },
});
```

## POST /v1/delivery-orders/{id}/tracking-link {#post-delivery-orders-id-tracking-link}

`POST /v1/delivery-orders/{id}/tracking-link`

scope: `orders:write` หรือ `trips:dispatch` · operationId: `DeliveryOrderTracking_issue`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `201` | ออกลิงก์ใหม่ — ลิงก์เดิมถูกเพิกถอน (1 ลิงก์ต่อ DO) · DO ยกเลิกแล้ว → 409 · URL มี token — ต้องมีสิทธิ์ออกลิงก์ · ลิงก์หน้าติดตามของผู้รับ (`/t/{token}` — magic link `tracking`, อายุ token 90 วัน; งานจบเกิน `tracking.linkDays` วัน = ใช้ไม่ได้) · ห้าม cache (มี token) | `TrackingLinkDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`orders:write` / `trips:dispatch`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบเที่ยว (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/delivery-orders/<id>/tracking-link" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)"
```

```ts
const { data, error } = await tms.POST('/v1/delivery-orders/{id}/tracking-link', {
  params: { path: { id: "…" } },
});
```

## POST /v1/delivery-orders/{id}/tracking-link/revoke {#post-delivery-orders-id-tracking-link-revoke}

`POST /v1/delivery-orders/{id}/tracking-link/revoke`

scope: `orders:write` หรือ `trips:dispatch` · operationId: `DeliveryOrderTracking_revoke`

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
| `200` | เพิกถอนลิงก์ที่ใช้ได้ (เหตุผล + audit) | `TrackingLinkStateDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`orders:write` / `trips:dispatch`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบเที่ยว (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/delivery-orders/<id>/tracking-link/revoke" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"เลิกใช้บริการตั้งแต่ ธ.ค. 2569"}'
```

```ts
const { data, error } = await tms.POST('/v1/delivery-orders/{id}/tracking-link/revoke', {
  params: { path: { id: "…" } },
  body: {
    "reason": "เลิกใช้บริการตั้งแต่ ธ.ค. 2569"
  },
});
```

## Schema ของ response {#schemas}

### BulkReleaseResultsDto {#schema-BulkReleaseResultsDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `results` | ใช่ | `array<BulkReleaseResultDto>` |   | ผลต่อรายการ เรียงตามคำขอ |   |
| `succeeded` | ใช่ | `number` |   |   | `3` |
| `unchanged` | ใช่ | `number` |   |   | `0` |
| `failed` | ใช่ | `number` |   |   | `1` |

### DeliveryOrderDto {#schema-DeliveryOrderDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `do_3f2a…` |
| `doNo` | ใช่ | `string` |   |   | `DO-6911-0001` |
| `status` | ใช่ | `string` | ค่า: `DRAFT`, `PLANNED`, `DISPATCHED`, `PICKED_UP`, `DELIVERED`, `FAILED`, `RETURNED`, `POD_PENDING`, `UNBILLED`, `BILLED`, `CANCELLED` |   |   |
| `orderId` | ใช่ | `string` |   |   | `ord_3f2a…` |
| `customerId` | ใช่ | `string` |   |   | `cus_3f2a…` |
| `doDate` | ใช่ | `string` |   |   | `2026-11-12` |
| `originSiteId` | ใช่ | `string` |   |   | `loc_3f2a…` |
| `destSiteId` | ใช่ | `string` |   |   | `loc_3f2a…` |
| `originStopSeq` | ใช่ | `number` |   | ลำดับจุดรับของ SO |   |
| `destStopSeq` | ใช่ | `number` |   | ลำดับจุดส่งของ SO |   |
| `tripId` | ใช่ | `string` | null ได้ |   |   |
| `customerName` | ใช่ | `string` |   | ชื่อลูกค้า |   |
| `originSiteName` | ใช่ | `string` |   | ชื่อจุดรับ |   |
| `destSiteName` | ใช่ | `string` |   | ชื่อจุดส่ง |   |
| `tripNo` | ใช่ | `string` | null ได้ |   | `TRP-6911-0001` |
| `vehiclePlate` | ใช่ | `string` | null ได้ | ทะเบียนรถของเที่ยว (snapshot) |   |
| `driverName` | ใช่ | `string` | null ได้ | คนขับของเที่ยว (snapshot) |   |
| `carrierName` | ใช่ | `string` | null ได้ | รถร่วมของเที่ยว (snapshot) |   |
| `weightKg` | ใช่ | `string` | null ได้ |   |   |
| `cbm` | ใช่ | `string` | null ได้ |   |   |
| `customerRef` | ใช่ | `string` | null ได้ | ลูกค้า |   |
| `splitFromId` | ใช่ | `string` | null ได้ | ใบแม่ที่ถูกแยก |   |
| `splitIndex` | ใช่ | `number` | null ได้ |   |   |
| `redeliveryOfId` | ใช่ | `string` | null ได้ | ส่งใหม่ของ DO ใบนี้ |   |
| `rescheduleCount` | ใช่ | `number` |   | ครั้งที่นัดส่งใหม่อัตโนมัติของสายงานนี้ (0 = ใบแรก) — เกินค่าตั้ง `dispatch.maxAutoReschedules` → ใบสั่งค้าง RESCHEDULES_EXHAUSTED | `0` |
| `redeliveryManual` | ใช่ | `boolean` |   | ส่งซ้ำโดยผู้ใช้ (ไม่ใช่นัดส่งใหม่อัตโนมัติ) — ผลส่งไม่สำเร็จถูกพลิกภายหลังระบบไม่คืนใบเดิมเอง |   |
| `rejectedFromId` | ใช่ | `string` | null ได้ | ใบส่งซ้ำของที่ลูกค้าปฏิเสธรับจาก DO นี้ (ใบเดิมคงส่งแล้ว) — ไม่นับปริมาณจัดสรรของ SO |   |
| `podStatus` | ใช่ | `string` |   |   | `NONE` |
| `releasedAt` | ใช่ | `string` | null ได้ | เวลาส่งบัญชี · null = ยังไม่ส่ง |   |
| `billingStatus` | ใช่ | `string` | ค่า: `UNBILLED`, `IN_DRAFT`, `INVOICED`, `CREDITED` | สถานะวางบิล: UNBILLED ยังไม่อยู่ในใบแจ้งหนี้ · IN_DRAFT อยู่ในร่าง · INVOICED ใบออกเลขแล้ว · CREDITED ใบถูกลดหนี้เต็มใบ (วางบิลใหม่ได้) — DO หนึ่งใบอยู่ในใบแจ้งหนี้ที่ active ได้ใบเดียว | `UNBILLED` |
| `invoicedAt` | ใช่ | `string` | null ได้ | เวลาใบแจ้งหนี้ของ DO ออกเลข · null = ยังไม่ออก/ดึงเข้าร่างใหม่หลังลดหนี้ |   |
| `paidAt` | ใช่ | `string` | null ได้ | เวลารับชำระครบ · null = ยังไม่ชำระครบ |   |
| `billingStage` | ใช่ | `string` | ค่า: `DELIVERED`, `RELEASED`, `IN_DRAFT`, `INVOICED`, `PARTIALLY_PAID`, `PAID`, `CREDITED` · null ได้ | ขั้น lifecycle วางบิล: DELIVERED ส่งถึง · RELEASED ส่งบัญชีแล้ว · IN_DRAFT อยู่ในร่าง · INVOICED ออกใบแล้ว · PAID ชำระครบ · CREDITED ลดหนี้เต็มใบ · null = ยังไม่ส่งถึง/ส่งไม่สำเร็จ/ยกเลิก | `RELEASED` |
| `lines` | ใช่ | `array<DeliveryOrderLineDto>` |   |   |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string` |   |   |   |
| `updatedAt` | ใช่ | `string` |   |   |   |

### DeliveryOrderPageDto {#schema-DeliveryOrderPageDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<DeliveryOrderDto>` |   |   |   |
| `nextCursor` | ใช่ | `string` | null ได้ |   |   |
| `hasMore` | ใช่ | `boolean` |   |   |   |

### DeliveryOrderPodDto {#schema-DeliveryOrderPodDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `deliveryOrderId` | ใช่ | `string` |   |   | `do_…` |
| `doNo` | ใช่ | `string` |   |   | `DO-2611-00052` |
| `doStatus` | ใช่ | `string` |   | สถานะ DO (ตัวใหญ่ — เหมือน GET /v1/delivery-orders/{id}) | `UNBILLED` |
| `podStatus` | ใช่ | `string` | ค่า: `NONE`, `PARTIAL`, `COMPLETE` |   |   |
| `editable` | ใช่ | `boolean` |   | บันทึก/แก้หลักฐานได้ในสถานะ DO ปัจจุบัน (ส่งแล้ว/ส่งไม่สำเร็จ ยังไม่วางบิล) |   |
| `plannedWeightKg` | ใช่ | `string` | null ได้ | น้ำหนักตามใบสั่ง | `15000` |
| `checklist` | ใช่ | `EffectivePodChecklistDto` |   | checklist ที่ใช้จริงตอนนี้ (ชุดตามสถานะ DO: ส่งไม่สำเร็จ = ชุดไม่สำเร็จ) |   |
| `missing` | ใช่ | `array<PodMissingDto>` |   | เทียบหลักฐานปัจจุบันกับ checklist ตอนนี้ (ว่าง = ครบ) |   |
| `current` | ใช่ | `PodRecordDto` | null ได้ | ฉบับปัจจุบัน — null = ยังไม่มี |   |
| `versions` | ใช่ | `array<PodVersionDto>` |   | ทุกฉบับ ใหม่ → เก่า |   |
| `lines` | ใช่ | `array<PodLineDto>` |   | บรรทัดของ DO (แผน vs ส่งจริง vs ปฏิเสธ + เหตุผล) ตามฉบับล่าสุด |   |

### DeliveryOrderRevenueDto {#schema-DeliveryOrderRevenueDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `deliveryOrderId` | ใช่ | `string` |   |   | `do_…` |
| `doNo` | ใช่ | `string` | null ได้ |   | `DO-2611-00001` |
| `sellRevenueTotal` |   | `string` |   | รายได้ของใบส่งของก่อน VAT = ผลรวมบรรทัดที่ยังใช้ (ACTIVE) — เห็นเมื่อมี `prices.sell:read` | `8750.00` |
| `provisional` | ใช่ | `boolean` |   | true = มีบรรทัดที่ยอดยังไม่ยืนยัน (ยังไม่บันทึกยอดส่งจริง) |   |
| `buyAllocatedCost` |   | `string` | null ได้ | ต้นทุนเที่ยวที่ปันลงใบนี้ · null = เที่ยวยังไม่ปิดต้นทุน · กำไรต่อ DO = `sellRevenueTotal` − `buyAllocatedCost` (ผู้เรียกคำนวณเอง — ต้องมีสิทธิ์ทั้งสองฝั่ง) · เห็นเมื่อมี `prices.buy:read` | `2400.25` |
| `data` | ใช่ | `array<RevenueLineDto>` |   | รวมบรรทัดที่ยกเลิก (`status` VOIDED) |   |

### DeliveryOrderSplitResultDto {#schema-DeliveryOrderSplitResultDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<DeliveryOrderDto>` |   | ใบลูกที่สร้างจากการแยก |   |

### DeliveryOrderSummaryDto {#schema-DeliveryOrderSummaryDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `date` | ใช่ | `string` |   | วันนี้ตามเวลาไทย (Asia/Bangkok) ที่ใช้นับ | `2026-11-18` |
| `today` | ใช่ | `number` |   | งานวันนี้ = `?dateFrom=date&dateTo=date&status=` ทุกสถานะยกเว้น CANCELLED |   |
| `delivered` | ใช่ | `number` |   | ส่งแล้ว = `status=DELIVERED,POD_PENDING,UNBILLED,BILLED` ของวัน `date` |   |
| `failed` | ใช่ | `number` |   | ส่งไม่สำเร็จ = `status=FAILED` ของวัน `date` |   |
| `draft` | ใช่ | `number` |   | หน้า `/do` การ์ด "ร่าง" = `status=DRAFT,PLANNED` (ทุกวันที่) |   |
| `inTransit` | ใช่ | `number` |   | การ์ด "ระหว่างส่ง" = `status=DISPATCHED,PICKED_UP` (ทุกวันที่) |   |
| `unbilled` | ใช่ | `number` |   | การ์ด "ยังไม่วางบิล" = `status=DELIVERED,POD_PENDING,UNBILLED` (ทุกวันที่ — ส่งถึงแล้วยังไม่วางบิล) |   |
| `sellUnbilledAmount` |   | `string` |   | มูลค่ารวมของ DO "ยังไม่วางบิล" = Σ บรรทัดรายได้ที่ใช้อยู่ (ก่อน VAT) — เห็นเมื่อมี `prices.sell:read` | `125400.00` |

### RedeliverResultDto {#schema-RedeliverResultDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `source` | ใช่ | `DeliveryOrderDto` |   | ใบเดิม — ส่งแล้ว: คงสถานะ (ยอดส่งซ้ำ/คงเหลือใหม่) · ส่งไม่สำเร็จ: CANCELLED (event redeliver) |   |
| `redelivery` | ใช่ | `DeliveryOrderDto` |   | DO ใหม่ (DRAFT รอจัดรถ) อ้าง `redeliveryOfId` |   |

### TrackingLinkDto {#schema-TrackingLinkDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `linkId` | ใช่ | `string` |   |   | `mlk_3f2a…` |
| `url` | ใช่ | `string` |   | URL หน้าติดตาม (มี token) | `https://app.example/t/ml1.…` |
| `expiresAt` | ใช่ | `string` |   |   |   |
| `createdAt` | ใช่ | `string` |   |   |   |
| `lastUsedAt` | ใช่ | `string` | null ได้ |   |   |

### TrackingLinkStateDto {#schema-TrackingLinkStateDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `link` | ใช่ | `TrackingLinkDto` | null ได้ | null = ไม่มีลิงก์ที่ใช้ได้ |   |
