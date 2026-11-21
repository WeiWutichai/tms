# ใบสั่งขนส่ง (orders)

24 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`POST /v1/orders:bulk`](#post-orders-bulk) | `orders:write` |
| [`GET /v1/orders/summary`](#get-orders-summary) | `orders:read` |
| [`GET /v1/orders`](#get-orders) | `orders:read` |
| [`POST /v1/orders`](#post-orders) | `orders:write` |
| [`PUT /v1/orders/external/{externalId}`](#put-orders-external-externalId) | `orders:write` |
| [`PATCH /v1/orders/external/{externalId}`](#patch-orders-external-externalId) | `orders:write` |
| [`GET /v1/orders/{id}`](#get-orders-id) | `orders:read` |
| [`PATCH /v1/orders/{id}`](#patch-orders-id) | `orders:write` |
| [`POST /v1/orders/{id}/cancel`](#post-orders-id-cancel) | `orders:cancel` |
| [`POST /v1/orders/{id}/source-changes/{changeId}/accept`](#post-orders-id-source-changes-changeId-accept) | `orders:write` |
| [`POST /v1/orders/{id}/source-changes/{changeId}/reject`](#post-orders-id-source-changes-changeId-reject) | `orders:write` |
| [`POST /v1/orders/{id}/lock`](#post-orders-id-lock) | `orders:write` |
| [`POST /v1/orders/{id}/unlock`](#post-orders-id-unlock) | `orders:write` |
| [`POST /v1/orders/{id}/stops/{sequence}/map-site`](#post-orders-id-stops-sequence-map-site) | `orders:write` |
| [`POST /v1/orders/{id}/reevaluate`](#post-orders-id-reevaluate) | `orders:write` |
| [`POST /v1/orders/{id}/manual-price`](#post-orders-id-manual-price) | `orders:write` |
| [`POST /v1/orders/{id}/resolve-source-error`](#post-orders-id-resolve-source-error) | `orders:write` |
| [`POST /v1/orders/{id}/map-customer`](#post-orders-id-map-customer) | `orders:write` |
| [`GET /v1/orders/{id}/documents`](#get-orders-id-documents) | `orders:read` |
| [`GET /v1/orders/{id}/tracking`](#get-orders-id-tracking) | `orders:read` |
| [`GET /v1/orders/{id}/events`](#get-orders-id-events) | `orders:read` |
| [`GET /v1/orders/{id}/revenue-lines`](#get-orders-id-revenue-lines) | `orders:read` |
| [`POST /v1/orders/{id}/revenue-lines`](#post-orders-id-revenue-lines) | `orders:write` |
| [`POST /v1/revenue-lines/{id}/void`](#post-revenue-lines-id-void) | `orders:write` |

## สร้าง/อัปเดตใบสั่งขนส่งหลายใบ (≤ 200) — 207 ผลต่อรายการ หรือ 202 job {#post-orders-bulk}

`POST /v1/orders:bulk`

scope: `orders:write` · operationId: `OrdersBulk_create`

แต่ละรายการ = `POST /v1/orders` หนึ่งครั้ง (ตรวจรูปแบบ, สิทธิ์ราคา, จับคู่, ราคา, ใบค้าง, event `order.created`) ใน transaction ของตัวเอง — รายการที่ไม่ผ่านไม่ย้อนรายการอื่น · ใบที่มี `externalId` ของใบเดิม = อัปเดตใบเดิม (ส่งซ้ำไม่เกิดใบซ้ำ) · ทั้งคำขอ 422 เฉพาะ `items` ไม่ใช่ array / ว่าง / เกิน 200 รายการ · body ไม่เกิน 1 MB · นับเป็นคำขอหนัก (rate limit ชั้น heavy) · ส่ง header `Prefer: respond-async` = ทำเป็น job → 202 `{jobId, statusUrl}` → `GET /v1/jobs/{id}` (`result` = รูปเดียวกับ 207; ทุกรายการผ่าน = `succeeded`, มีรายการไม่ผ่าน = `succeeded_with_errors`) + webhook `job.completed` · job เก็บ 7 วันหลังจบ

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `Prefer` | header |   | `string` | `respond-async` (RFC 7240) = ทำเป็น job → 202 + `Preference-Applied: respond-async` · ไม่ส่ง/ค่าอื่น = ทำทันที (207) · ผู้สั่งดู `statusUrl` ได้แม้ไม่มีสิทธิ์ `jobs:read` |
| `Idempotency-Key` | header |   | `string` | ส่งซ้ำ key เดิม + body เดิม = ผลเดิม (207 เดิม หรือ 202 jobId เดิม พร้อม `Preference-Applied` เดิม) + `Idempotent-Replayed: true` · **header `Prefer` ไม่นับเป็นส่วนของคำขอ** — key เดิมได้ผลของคำขอแรกเสมอ แม้ครั้งหลังส่ง/ไม่ส่ง `Prefer` ต่างไป · ระหว่างที่คำขอแรกยังทำอยู่ (จองไว้ 10 นาที) ส่งซ้ำ = 409 `idempotency_in_progress` · เก็บ 24 ชม. |

**Request body** `BulkOrdersDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `items` | ใช่ | `array<CreateOrderDto>` | ≤ 200 รายการ | ใบสั่งขนส่ง 1–200 ใบ (รูปเดียวกับ body ของ `POST /v1/orders`) — ตรวจ/สร้างแยกทีละใบ; ใบที่มี `externalId` ของใบเดิม = อัปเดตใบเดิม (idempotent ต่อใบ) |   |
| `items[].draft` |   | `boolean` |   | บันทึกเป็นร่าง · ใบที่พ้นร่างแล้วกลับเป็นร่างไม่ได้ |   |
| `items[].customer` |   | `OrderCustomerInputDto` |   |   |   |
| `items[].customer.id` |   | `string` | null ได้ | ลูกค้าใน master | `cus_3f2a…` |
| `items[].customer.externalId` |   | `string` | null ได้ | รหัสลูกค้าตามระบบต้นทาง — จับคู่กับ customer.externalId (ไม่พบ = ใบค้าง CUSTOMER_UNMAPPED) | `C-001` |
| `items[].customer.name` |   | `string` | null ได้ | ชื่อ/ข้อความลูกค้าตามต้นทาง |   |
| `items[].billingCompanyId` |   | `string` | null ได้ | นิติบุคคลที่ออกบิล (`cmp_…` จาก `GET /v1/companies`) — ไม่ส่ง = "ออกบิลในนาม" ของลูกค้า → ค่าตั้งต้นของบริษัท → นิติบุคคลเดียวที่ใช้งานอยู่; บริษัทมีหลายนิติบุคคลและไม่ได้ตั้งค่าใดเลย = 422 `routing_not_configured` (errors[].field = `billingCompanyId`) · ใบเดิมไม่ส่ง = คงของเดิม | `cmp_3f2a…` |
| `items[].customerRef` |   | `string` | ยาว ≤ 50 · null ได้ | เลข / อ้างอิงของลูกค้า |   |
| `items[].requestedDate` | ใช่ | `string` |   | วันรับของ YYYY-MM-DD (ใช้หา rate) | `2026-11-12` |
| `items[].vehicleTypeId` |   | `string` | null ได้ |   | `vty_3f2a…` |
| `items[].stops` | ใช่ | `array<OrderStopInputDto>` |   | 1–50 จุด เรียงตามลำดับวิ่ง |   |
| `items[].stops[].type` | ใช่ | `string` | ค่า: `PICKUP`, `DELIVERY`, `RETURN` |   |   |
| `items[].stops[].siteId` |   | `string` | null ได้ | สถานที่ใน master — ไม่ส่ง = ใช้ `siteText` (ใบค้าง LOCATION_UNMAPPED) | `loc_3f2a…` |
| `items[].stops[].siteText` |   | `string` | ยาว ≤ 500 · null ได้ | ข้อความสถานที่ตามต้นทาง (บังคับเมื่อไม่มี siteId) |   |
| `items[].stops[].windowStart` |   | `string` | null ได้ | ISO 8601 พร้อม timezone | `2026-11-12T07:00:00+07:00` |
| `items[].stops[].windowEnd` |   | `string` | null ได้ | ISO 8601 พร้อม timezone (≥ windowStart) |   |
| `items[].lines` |   | `array<OrderLineInputDto>` |   | ≤ 200 บรรทัด |   |
| `items[].lines[].description` | ใช่ | `string` | ยาว ≤ 500 |   |   |
| `items[].lines[].qty` | ใช่ | `string` |   | > 0 ทศนิยม ≤ 3 (สตริง) | `12.5` |
| `items[].lines[].unitId` |   | `string` | null ได้ | หน่วยใน master | `unt_3f2a…` |
| `items[].lines[].unit` |   | `string` | null ได้ | ข้อความหน่วย (บังคับเมื่อไม่มี unitId) |   |
| `items[].lines[].productId` |   | `string` | null ได้ |   | `prd_3f2a…` |
| `items[].lines[].itemCode` |   | `string` | null ได้ | รหัสสินค้าตามต้นทาง |   |
| `items[].lines[].weightKg` |   | `string` | null ได้ |   | `12500` |
| `items[].lines[].cbm` |   | `string` | null ได้ |   |   |
| `items[].lines[].isDangerous` |   | `boolean` |   |   |   |
| `items[].lines[].tempMin` |   | `string` | null ได้ |   | `2.0` |
| `items[].lines[].tempMax` |   | `string` | null ได้ |   | `8.0` |
| `items[].externalId` |   | `string` | ยาว ≤ 100 · null ได้ | externalRef ของระบบต้นทาง (ASCII ที่พิมพ์ได้ 1–100 ตัว ไม่มีช่องว่าง — ผิด = 422) — unique ต่อบริษัท; มีใบเดิมจากช่องทางเดียวกัน = อัปเดตใบเดิม (เหมือน PUT external) | `2026-0001` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `202` | `Prefer: respond-async` — รับงานแล้ว ติดตามที่ `statusUrl` | `BulkJobAcceptedDto` |
| `207` | ผลต่อรายการ เรียงตาม items[] | `BulkOrderResultsDto` |
| `400` | JSON เสีย / Idempotency-Key ผิดรูป — [bad_request](errors.md#bad_request) | `ProblemDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ `orders:write` / ส่งราคาโดยไม่มีสิทธิ์แก้ราคา — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `409` | `idempotency_in_progress` — คำขอเดียวกันกำลังทำอยู่ — [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `413` | body ใหญ่เกิน 1 MB — [payload_too_large](errors.md#payload_too_large) | `ProblemDto` |
| `422` | `items` ไม่ใช่ array / ว่าง / เกิน 200 · `idempotency_mismatch` — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/orders:bulk" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"items":[{"requestedDate":"2026-11-12","stops":[{}]}]}'
```

```ts
const { data, error } = await tms.POST('/v1/orders:bulk', {
  body: {
    "items": [
      {
        "requestedDate": "2026-11-12",
        "stops": [
          {}
        ]
      }
    ]
  },
});
```

## GET /v1/orders/summary {#get-orders-summary}

`GET /v1/orders/summary`

scope: `orders:read` · operationId: `Orders_summary`

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `OrderSummaryDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`orders:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/orders/summary" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/orders/summary');
```

## GET /v1/orders {#get-orders}

`GET /v1/orders`

scope: `orders:read` · operationId: `Orders_list`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน (ใช้กับ sort เดิม) |
| `updatedAfter` | query |   | `string` | คืนเฉพาะแถวที่ updatedAt > ค่านี้ (incremental pull) |
| `sort` | query |   | `string` ค่า: `updatedAt`, `-updatedAt` |   |
| `fields` | query |   | `string` | รายชื่อ field ของ Order คั่นด้วย, เช่น id,soNo,status (ไม่รู้จัก → 422) — id คืนเสมอ |
| `status` | query |   | `string` | สถานะ คั่นด้วย, (draft, received, on_hold, planned, in_transit, partially_delivered, delivered, closed, cancelled) |
| `holdReason` | query |   | `string` | รหัสเหตุค้าง คั่นด้วย, เช่น RATE_MISSING,CUSTOMER_UNMAPPED — ตรงกับเหตุใดก็ได้ (OR) ของ `holdCodes` (เหตุทั้งหมดของการรับงานครั้งล่าสุด รวมเหตุรอง) หรือ `holdReason.code` (เหตุหลักบนใบ) |
| `held` | query |   | `string` ค่า: `true`, `false` | หน้าใบค้าง: true = เฉพาะใบค้าง (ON_HOLD + ใบที่ต้นทางแก้หลังวางแผนรอตัดสิน ซึ่งสถานะยัง PLANNED) · false = ไม่รวมใบค้างทั้งสองแบบ — ใช้คู่กับ `holdReason` ได้ |
| `customerId` | query |   | `string` | ลูกค้า |
| `source` | query |   | `string` | ที่มา คั่นด้วย,: MANUAL / EXCEL / API / PORTAL / ERP (ทุก connector) / ERP:{connector} |
| `requestedFrom` | query |   | `string` | วันรับของตั้งแต่ (YYYY-MM-DD) |
| `requestedTo` | query |   | `string` | วันรับของถึง (รวมวันนั้น) |
| `externalId` | query |   | `string` | externalId ตรงตัว |
| `q` | query |   | `string` | ค้นหา — เลข SO, externalId, เลข, ชื่อ/รหัสลูกค้า (ไม่สนตัวพิมพ์) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `OrderPageDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`orders:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | รูปแบบผิด — `errors[]` รวมทุกช่อง (path แบบ `stops[0].siteId`) — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/orders" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/orders');
```

## POST /v1/orders {#post-orders}

`POST /v1/orders`

scope: `orders:write` · operationId: `Orders_create`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `Idempotency-Key` | header |   | `string` | ส่งซ้ำ key เดิม + body เดิม = ผลเดิม (สถานะ + ETag เดิม, header `Idempotent-Replayed: true`; body เท่ากันเชิง JSON — ลำดับ key อาจต่าง) เก็บ 24 ชม. |

**Request body** `CreateOrderDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `draft` |   | `boolean` |   | บันทึกเป็นร่าง · ใบที่พ้นร่างแล้วกลับเป็นร่างไม่ได้ |   |
| `customer` |   | `OrderCustomerInputDto` |   |   |   |
| `customer.id` |   | `string` | null ได้ | ลูกค้าใน master | `cus_3f2a…` |
| `customer.externalId` |   | `string` | null ได้ | รหัสลูกค้าตามระบบต้นทาง — จับคู่กับ customer.externalId (ไม่พบ = ใบค้าง CUSTOMER_UNMAPPED) | `C-001` |
| `customer.name` |   | `string` | null ได้ | ชื่อ/ข้อความลูกค้าตามต้นทาง |   |
| `billingCompanyId` |   | `string` | null ได้ | นิติบุคคลที่ออกบิล (`cmp_…` จาก `GET /v1/companies`) — ไม่ส่ง = "ออกบิลในนาม" ของลูกค้า → ค่าตั้งต้นของบริษัท → นิติบุคคลเดียวที่ใช้งานอยู่; บริษัทมีหลายนิติบุคคลและไม่ได้ตั้งค่าใดเลย = 422 `routing_not_configured` (errors[].field = `billingCompanyId`) · ใบเดิมไม่ส่ง = คงของเดิม | `cmp_3f2a…` |
| `customerRef` |   | `string` | ยาว ≤ 50 · null ได้ | เลข / อ้างอิงของลูกค้า |   |
| `requestedDate` | ใช่ | `string` |   | วันรับของ YYYY-MM-DD (ใช้หา rate) | `2026-11-12` |
| `vehicleTypeId` |   | `string` | null ได้ |   | `vty_3f2a…` |
| `stops` | ใช่ | `array<OrderStopInputDto>` |   | 1–50 จุด เรียงตามลำดับวิ่ง |   |
| `stops[].type` | ใช่ | `string` | ค่า: `PICKUP`, `DELIVERY`, `RETURN` |   |   |
| `stops[].siteId` |   | `string` | null ได้ | สถานที่ใน master — ไม่ส่ง = ใช้ `siteText` (ใบค้าง LOCATION_UNMAPPED) | `loc_3f2a…` |
| `stops[].siteText` |   | `string` | ยาว ≤ 500 · null ได้ | ข้อความสถานที่ตามต้นทาง (บังคับเมื่อไม่มี siteId) |   |
| `stops[].windowStart` |   | `string` | null ได้ | ISO 8601 พร้อม timezone | `2026-11-12T07:00:00+07:00` |
| `stops[].windowEnd` |   | `string` | null ได้ | ISO 8601 พร้อม timezone (≥ windowStart) |   |
| `lines` |   | `array<OrderLineInputDto>` |   | ≤ 200 บรรทัด |   |
| `lines[].description` | ใช่ | `string` | ยาว ≤ 500 |   |   |
| `lines[].qty` | ใช่ | `string` |   | > 0 ทศนิยม ≤ 3 (สตริง) | `12.5` |
| `lines[].unitId` |   | `string` | null ได้ | หน่วยใน master | `unt_3f2a…` |
| `lines[].unit` |   | `string` | null ได้ | ข้อความหน่วย (บังคับเมื่อไม่มี unitId) |   |
| `lines[].productId` |   | `string` | null ได้ |   | `prd_3f2a…` |
| `lines[].itemCode` |   | `string` | null ได้ | รหัสสินค้าตามต้นทาง |   |
| `lines[].weightKg` |   | `string` | null ได้ |   | `12500` |
| `lines[].cbm` |   | `string` | null ได้ |   |   |
| `lines[].isDangerous` |   | `boolean` |   |   |   |
| `lines[].tempMin` |   | `string` | null ได้ |   | `2.0` |
| `lines[].tempMax` |   | `string` | null ได้ |   | `8.0` |
| `externalId` |   | `string` | ยาว ≤ 100 · null ได้ | externalRef ของระบบต้นทาง (ASCII ที่พิมพ์ได้ 1–100 ตัว ไม่มีช่องว่าง — ผิด = 422) — unique ต่อบริษัท; มีใบเดิมจากช่องทางเดียวกัน = อัปเดตใบเดิม (เหมือน PUT external) | `2026-0001` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | มี externalId ของใบเดิม (ช่องทางเดียวกัน) → อัปเดตใบเดิม | `OrderDto` |
| `201` | สร้างใบใหม่ (ข้อมูลไม่ครบ/จับคู่ไม่ได้ = ยังรับเข้าเป็น ON_HOLD + holdReason) · มี externalId ของใบเดิม = 200 อัปเดตใบเดิม | `OrderDto` |
| `400` | JSON เสีย / Idempotency-Key ผิดรูป (ต้องเป็น ASCII 1–255 ตัว) — [bad_request](errors.md#bad_request) | `ProblemDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`orders:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `409` | 409 `order_locked_for_update` — แก้ช่องที่สถานะไม่อนุญาต (errors[] = ช่อง, `editableFields` = ช่องที่แก้ได้): ก่อนวางแผนแก้ได้ทุกช่อง · PLANNED แก้ได้เฉพาะช่วงเวลาของจุด + customerRef · ตั้งแต่ in_transit แก้ได้เฉพาะ customerRef · ปิดงาน/ยกเลิกแก้ไม่ได้ · 409 `external_id_conflict` — externalId นี้เป็นของใบจากช่องทางอื่น — [order_locked_for_update](errors.md#order_locked_for_update), [external_id_conflict](errors.md#external_id_conflict), [idempotency_in_progress](errors.md#idempotency_in_progress), [invalid_state_transition](errors.md#invalid_state_transition) | `ProblemDto` |
| `413` | body ใหญ่เกินกำหนด — [payload_too_large](errors.md#payload_too_large) | `ProblemDto` |
| `422` | รูปแบบผิด — `errors[]` รวมทุกช่อง (path แบบ `stops[0].siteId`) — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/orders" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"requestedDate":"2026-11-12","stops":[{"type":"PICKUP"}]}'
```

```ts
const { data, error } = await tms.POST('/v1/orders', {
  body: {
    "requestedDate": "2026-11-12",
    "stops": [
      {
        "type": "PICKUP"
      }
    ]
  },
});
```

## สร้าง/แทนทั้งใบด้วย externalId (idempotent) {#put-orders-external-externalId}

`PUT /v1/orders/external/{externalId}`

scope: `orders:write` · operationId: `Orders_upsertExternal`

**แทนทั้งใบ (full replace):** ช่องที่ไม่ส่ง = ว่าง/ค่าตั้งต้น — ใบที่วางแผน/ออกรถแล้ว การล้างช่องที่ล็อกนับเป็นการแก้ → 409 `order_locked_for_update` · ยกเว้น `billingCompanyId` ไม่ส่ง = คงของเดิม · แก้บางช่องใช้ PATCH · ส่งซ้ำค่าเดิม = ไม่เปลี่ยน version

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `externalId` | path | ใช่ | `string` | เลขของระบบต้นทาง (ASCII ที่พิมพ์ได้ 1–100 ตัว ไม่มีช่องว่าง) — unique ต่อ tenant ต่อ resource |
| `If-Match` | header |   | `string` | ETag — ใช้เมื่อใบมีอยู่แล้ว |

**Request body** `UpsertOrderDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `draft` |   | `boolean` |   | บันทึกเป็นร่าง · ใบที่พ้นร่างแล้วกลับเป็นร่างไม่ได้ |   |
| `customer` |   | `OrderCustomerInputDto` |   |   |   |
| `customer.id` |   | `string` | null ได้ | ลูกค้าใน master | `cus_3f2a…` |
| `customer.externalId` |   | `string` | null ได้ | รหัสลูกค้าตามระบบต้นทาง — จับคู่กับ customer.externalId (ไม่พบ = ใบค้าง CUSTOMER_UNMAPPED) | `C-001` |
| `customer.name` |   | `string` | null ได้ | ชื่อ/ข้อความลูกค้าตามต้นทาง |   |
| `billingCompanyId` |   | `string` | null ได้ | นิติบุคคลที่ออกบิล (`cmp_…` จาก `GET /v1/companies`) — ไม่ส่ง = "ออกบิลในนาม" ของลูกค้า → ค่าตั้งต้นของบริษัท → นิติบุคคลเดียวที่ใช้งานอยู่; บริษัทมีหลายนิติบุคคลและไม่ได้ตั้งค่าใดเลย = 422 `routing_not_configured` (errors[].field = `billingCompanyId`) · ใบเดิมไม่ส่ง = คงของเดิม | `cmp_3f2a…` |
| `customerRef` |   | `string` | ยาว ≤ 50 · null ได้ | เลข / อ้างอิงของลูกค้า |   |
| `requestedDate` | ใช่ | `string` |   | วันรับของ YYYY-MM-DD (ใช้หา rate) | `2026-11-12` |
| `vehicleTypeId` |   | `string` | null ได้ |   | `vty_3f2a…` |
| `stops` | ใช่ | `array<OrderStopInputDto>` |   | 1–50 จุด เรียงตามลำดับวิ่ง |   |
| `stops[].type` | ใช่ | `string` | ค่า: `PICKUP`, `DELIVERY`, `RETURN` |   |   |
| `stops[].siteId` |   | `string` | null ได้ | สถานที่ใน master — ไม่ส่ง = ใช้ `siteText` (ใบค้าง LOCATION_UNMAPPED) | `loc_3f2a…` |
| `stops[].siteText` |   | `string` | ยาว ≤ 500 · null ได้ | ข้อความสถานที่ตามต้นทาง (บังคับเมื่อไม่มี siteId) |   |
| `stops[].windowStart` |   | `string` | null ได้ | ISO 8601 พร้อม timezone | `2026-11-12T07:00:00+07:00` |
| `stops[].windowEnd` |   | `string` | null ได้ | ISO 8601 พร้อม timezone (≥ windowStart) |   |
| `lines` |   | `array<OrderLineInputDto>` |   | ≤ 200 บรรทัด |   |
| `lines[].description` | ใช่ | `string` | ยาว ≤ 500 |   |   |
| `lines[].qty` | ใช่ | `string` |   | > 0 ทศนิยม ≤ 3 (สตริง) | `12.5` |
| `lines[].unitId` |   | `string` | null ได้ | หน่วยใน master | `unt_3f2a…` |
| `lines[].unit` |   | `string` | null ได้ | ข้อความหน่วย (บังคับเมื่อไม่มี unitId) |   |
| `lines[].productId` |   | `string` | null ได้ |   | `prd_3f2a…` |
| `lines[].itemCode` |   | `string` | null ได้ | รหัสสินค้าตามต้นทาง |   |
| `lines[].weightKg` |   | `string` | null ได้ |   | `12500` |
| `lines[].cbm` |   | `string` | null ได้ |   |   |
| `lines[].isDangerous` |   | `boolean` |   |   |   |
| `lines[].tempMin` |   | `string` | null ได้ |   | `2.0` |
| `lines[].tempMax` |   | `string` | null ได้ |   | `8.0` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | มีอยู่แล้ว → อัปเดต (ส่งซ้ำได้ ไม่เกิดใบใหม่) | `OrderDto` |
| `201` | ยังไม่มี → สร้าง (ที่มา API) | `OrderDto` |
| `400` | JSON เสีย — [bad_request](errors.md#bad_request) | `ProblemDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`orders:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `409` | 409 `order_locked_for_update` — แก้ช่องที่สถานะไม่อนุญาต (errors[] = ช่อง, `editableFields` = ช่องที่แก้ได้): ก่อนวางแผนแก้ได้ทุกช่อง · PLANNED แก้ได้เฉพาะช่วงเวลาของจุด + customerRef · ตั้งแต่ in_transit แก้ได้เฉพาะ customerRef · ปิดงาน/ยกเลิกแก้ไม่ได้ · 409 `external_id_conflict` — externalId นี้เป็นของใบจากช่องทางอื่น — [order_locked_for_update](errors.md#order_locked_for_update), [external_id_conflict](errors.md#external_id_conflict), [invalid_state_transition](errors.md#invalid_state_transition) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version / ส่ง If-Match แต่ยังไม่มีใบ — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `413` | body ใหญ่เกินกำหนด — [payload_too_large](errors.md#payload_too_large) | `ProblemDto` |
| `422` | รูปแบบผิด — `errors[]` รวมทุกช่อง (path แบบ `stops[0].siteId`) — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PUT "$TMS_BASE_URL/v1/orders/external/<externalId>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"requestedDate":"2026-11-12","stops":[{"type":"PICKUP"}]}'
```

```ts
const { data, error } = await tms.PUT('/v1/orders/external/{externalId}', {
  params: { path: { externalId: "…" } },
  body: {
    "requestedDate": "2026-11-12",
    "stops": [
      {
        "type": "PICKUP"
      }
    ]
  },
});
```

## แก้บางช่องด้วย externalId {#patch-orders-external-externalId}

`PATCH /v1/orders/external/{externalId}`

scope: `orders:write` · operationId: `Orders_patchExternal`

แก้บางช่องของใบที่มีอยู่ (กติกาเดียวกับ `PATCH /orders/{id}`) · ยังไม่มีใบนี้ → 404 — สร้างใหม่ใช้ PUT · ช่องทางเดียวกับ PUT: ใบที่ไม่ได้มาจาก API (กรอกมือ/Excel/connector) → 409 `external_id_conflict` · **ต่างจาก PUT: ติดล็อกการแก้** — ผู้ใช้อื่นเปิดแก้อยู่ → 409 `order_locked_by_user`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `externalId` | path | ใช่ | `string` | เลขของระบบต้นทาง (ASCII ที่พิมพ์ได้ 1–100 ตัว ไม่มีช่องว่าง) — unique ต่อ tenant ต่อ resource |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `UpdateOrderDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `draft` |   | `boolean` |   | false = ส่งร่าง (ออกเลข SO) · true ใช้ได้เฉพาะใบที่ยังเป็นร่าง |   |
| `customer` |   | `OrderCustomerInputDto` |   |   |   |
| `customer.id` |   | `string` | null ได้ | ลูกค้าใน master | `cus_3f2a…` |
| `customer.externalId` |   | `string` | null ได้ | รหัสลูกค้าตามระบบต้นทาง — จับคู่กับ customer.externalId (ไม่พบ = ใบค้าง CUSTOMER_UNMAPPED) | `C-001` |
| `customer.name` |   | `string` | null ได้ | ชื่อ/ข้อความลูกค้าตามต้นทาง |   |
| `billingCompanyId` |   | `string` | null ได้ |   |   |
| `customerRef` |   | `string` | ยาว ≤ 50 · null ได้ |   |   |
| `requestedDate` |   | `string` |   |   | `2026-11-12` |
| `vehicleTypeId` |   | `string` | null ได้ |   |   |
| `stops` |   | `array<OrderStopInputDto>` |   |   |   |
| `stops[].type` | ใช่ | `string` | ค่า: `PICKUP`, `DELIVERY`, `RETURN` |   |   |
| `stops[].siteId` |   | `string` | null ได้ | สถานที่ใน master — ไม่ส่ง = ใช้ `siteText` (ใบค้าง LOCATION_UNMAPPED) | `loc_3f2a…` |
| `stops[].siteText` |   | `string` | ยาว ≤ 500 · null ได้ | ข้อความสถานที่ตามต้นทาง (บังคับเมื่อไม่มี siteId) |   |
| `stops[].windowStart` |   | `string` | null ได้ | ISO 8601 พร้อม timezone | `2026-11-12T07:00:00+07:00` |
| `stops[].windowEnd` |   | `string` | null ได้ | ISO 8601 พร้อม timezone (≥ windowStart) |   |
| `lines` |   | `array<OrderLineInputDto>` |   |   |   |
| `lines[].description` | ใช่ | `string` | ยาว ≤ 500 |   |   |
| `lines[].qty` | ใช่ | `string` |   | > 0 ทศนิยม ≤ 3 (สตริง) | `12.5` |
| `lines[].unitId` |   | `string` | null ได้ | หน่วยใน master | `unt_3f2a…` |
| `lines[].unit` |   | `string` | null ได้ | ข้อความหน่วย (บังคับเมื่อไม่มี unitId) |   |
| `lines[].productId` |   | `string` | null ได้ |   | `prd_3f2a…` |
| `lines[].itemCode` |   | `string` | null ได้ | รหัสสินค้าตามต้นทาง |   |
| `lines[].weightKg` |   | `string` | null ได้ |   | `12500` |
| `lines[].cbm` |   | `string` | null ได้ |   |   |
| `lines[].isDangerous` |   | `boolean` |   |   |   |
| `lines[].tempMin` |   | `string` | null ได้ |   | `2.0` |
| `lines[].tempMax` |   | `string` | null ได้ |   | `8.0` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `OrderDto` |
| `400` | JSON เสีย — [bad_request](errors.md#bad_request) | `ProblemDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`orders:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมใบของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | 409 `order_locked_for_update` — แก้ช่องที่สถานะไม่อนุญาต (errors[] = ช่อง, `editableFields` = ช่องที่แก้ได้): ก่อนวางแผนแก้ได้ทุกช่อง · PLANNED แก้ได้เฉพาะช่วงเวลาของจุด + customerRef · ตั้งแต่ in_transit แก้ได้เฉพาะ customerRef · ปิดงาน/ยกเลิกแก้ไม่ได้ · 409 `external_id_conflict` — externalId นี้เป็นของใบจากช่องทางอื่น · 409 `order_locked_by_user` — ผู้ใช้อื่นเปิดแก้อยู่ · 409 `external_id_conflict` — ใบจากช่องทางอื่น — [order_locked_for_update](errors.md#order_locked_for_update), [external_id_conflict](errors.md#external_id_conflict), [invalid_state_transition](errors.md#invalid_state_transition), [order_locked_by_user](errors.md#order_locked_by_user), [order_lock_released](errors.md#order_lock_released) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version / ส่ง If-Match แต่ยังไม่มีใบ — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `413` | body ใหญ่เกินกำหนด — [payload_too_large](errors.md#payload_too_large) | `ProblemDto` |
| `422` | รูปแบบผิด — `errors[]` รวมทุกช่อง (path แบบ `stops[0].siteId`) — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PATCH "$TMS_BASE_URL/v1/orders/external/<externalId>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"requestedDate":"2026-11-12"}'
```

```ts
const { data, error } = await tms.PATCH('/v1/orders/external/{externalId}', {
  params: { path: { externalId: "…" } },
  body: {
    "requestedDate": "2026-11-12"
  },
});
```

## GET /v1/orders/{id} {#get-orders-id}

`GET /v1/orders/{id}`

scope: `orders:read` · operationId: `Orders_get`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | `{id}` รับ `ext:{externalId}` ได้ · ETag = version ของใบ (ใช้กับ If-Match) — `editLock`/`editableFields` เปลี่ยนได้โดย version ไม่เปลี่ยน จึงไม่รองรับ conditional GET (`If-None-Match` ถูกละเลย ตอบ 200 เสมอ) + `Cache-Control: no-store` | `OrderDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`orders:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมใบของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/orders/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/orders/{id}', {
  params: { path: { id: "…" } },
});
```

## แก้บางช่อง {#patch-orders-id}

`PATCH /v1/orders/{id}`

scope: `orders:write` · operationId: `Orders_update`

ผู้ใช้อื่นเปิดแก้อยู่ → 409 `order_locked_by_user` · ผู้ถือล็อกแก้ได้และนับเป็นกิจกรรม (ต่ออายุ) · ล็อกของผู้เรียกถูกผู้อื่นปลด → 409 `order_lock_released` จนกว่าจะเปิดแก้ใหม่ (POST /lock) · ไม่มีล็อก = แก้ได้ตามปกติ · ทางเข้า POST/PUT external (API/connector/นำเข้า) ไม่ติดล็อก

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `UpdateOrderDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `draft` |   | `boolean` |   | false = ส่งร่าง (ออกเลข SO) · true ใช้ได้เฉพาะใบที่ยังเป็นร่าง |   |
| `customer` |   | `OrderCustomerInputDto` |   |   |   |
| `customer.id` |   | `string` | null ได้ | ลูกค้าใน master | `cus_3f2a…` |
| `customer.externalId` |   | `string` | null ได้ | รหัสลูกค้าตามระบบต้นทาง — จับคู่กับ customer.externalId (ไม่พบ = ใบค้าง CUSTOMER_UNMAPPED) | `C-001` |
| `customer.name` |   | `string` | null ได้ | ชื่อ/ข้อความลูกค้าตามต้นทาง |   |
| `billingCompanyId` |   | `string` | null ได้ |   |   |
| `customerRef` |   | `string` | ยาว ≤ 50 · null ได้ |   |   |
| `requestedDate` |   | `string` |   |   | `2026-11-12` |
| `vehicleTypeId` |   | `string` | null ได้ |   |   |
| `stops` |   | `array<OrderStopInputDto>` |   |   |   |
| `stops[].type` | ใช่ | `string` | ค่า: `PICKUP`, `DELIVERY`, `RETURN` |   |   |
| `stops[].siteId` |   | `string` | null ได้ | สถานที่ใน master — ไม่ส่ง = ใช้ `siteText` (ใบค้าง LOCATION_UNMAPPED) | `loc_3f2a…` |
| `stops[].siteText` |   | `string` | ยาว ≤ 500 · null ได้ | ข้อความสถานที่ตามต้นทาง (บังคับเมื่อไม่มี siteId) |   |
| `stops[].windowStart` |   | `string` | null ได้ | ISO 8601 พร้อม timezone | `2026-11-12T07:00:00+07:00` |
| `stops[].windowEnd` |   | `string` | null ได้ | ISO 8601 พร้อม timezone (≥ windowStart) |   |
| `lines` |   | `array<OrderLineInputDto>` |   |   |   |
| `lines[].description` | ใช่ | `string` | ยาว ≤ 500 |   |   |
| `lines[].qty` | ใช่ | `string` |   | > 0 ทศนิยม ≤ 3 (สตริง) | `12.5` |
| `lines[].unitId` |   | `string` | null ได้ | หน่วยใน master | `unt_3f2a…` |
| `lines[].unit` |   | `string` | null ได้ | ข้อความหน่วย (บังคับเมื่อไม่มี unitId) |   |
| `lines[].productId` |   | `string` | null ได้ |   | `prd_3f2a…` |
| `lines[].itemCode` |   | `string` | null ได้ | รหัสสินค้าตามต้นทาง |   |
| `lines[].weightKg` |   | `string` | null ได้ |   | `12500` |
| `lines[].cbm` |   | `string` | null ได้ |   |   |
| `lines[].isDangerous` |   | `boolean` |   |   |   |
| `lines[].tempMin` |   | `string` | null ได้ |   | `2.0` |
| `lines[].tempMax` |   | `string` | null ได้ |   | `8.0` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `OrderDto` |
| `400` | JSON เสีย — [bad_request](errors.md#bad_request) | `ProblemDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`orders:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมใบของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | 409 `order_locked_for_update` — แก้ช่องที่สถานะไม่อนุญาต (errors[] = ช่อง, `editableFields` = ช่องที่แก้ได้): ก่อนวางแผนแก้ได้ทุกช่อง · PLANNED แก้ได้เฉพาะช่วงเวลาของจุด + customerRef · ตั้งแต่ in_transit แก้ได้เฉพาะ customerRef · ปิดงาน/ยกเลิกแก้ไม่ได้ · 409 `external_id_conflict` — externalId นี้เป็นของใบจากช่องทางอื่น · 409 `order_locked_by_user` — ผู้ใช้อื่นเปิดแก้อยู่ — [order_locked_for_update](errors.md#order_locked_for_update), [invalid_state_transition](errors.md#invalid_state_transition), [order_locked_by_user](errors.md#order_locked_by_user), [order_lock_released](errors.md#order_lock_released) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version / ส่ง If-Match แต่ยังไม่มีใบ — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `413` | body ใหญ่เกินกำหนด — [payload_too_large](errors.md#payload_too_large) | `ProblemDto` |
| `422` | รูปแบบผิด — `errors[]` รวมทุกช่อง (path แบบ `stops[0].siteId`) — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PATCH "$TMS_BASE_URL/v1/orders/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"requestedDate":"2026-11-12"}'
```

```ts
const { data, error } = await tms.PATCH('/v1/orders/{id}', {
  params: { path: { id: "…" } },
  body: {
    "requestedDate": "2026-11-12"
  },
});
```

## POST /v1/orders/{id}/cancel {#post-orders-id-cancel}

`POST /v1/orders/{id}/cancel`

scope: `orders:cancel` · operationId: `Orders_cancel`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `CancelOrderDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `ลูกค้ายกเลิกคำสั่งทางอีเมล` |
| `reasonCodeId` |   | `string` | null ได้ | เหตุผลมาตรฐานหมวด CANCEL (ไม่บังคับ) | `rsn_3f2a…` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `OrderDto` |
| `400` | JSON เสีย — [bad_request](errors.md#bad_request) | `ProblemDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`orders:cancel`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมใบของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | `order_on_trip` — มีใบส่งของอยู่ในเที่ยว (ถอดออกจากเที่ยวก่อน) · `invalid_state_transition` — สถานะนี้ยกเลิกไม่ได้ (ออกรถ/ส่ง/ปิด/ยกเลิกแล้ว) · `order_locked_by_user` — ผู้ใช้อื่นเปิดแก้อยู่ · `order_lock_released` — ล็อกของผู้เรียกถูกปลด — [order_on_trip](errors.md#order_on_trip), [invalid_state_transition](errors.md#invalid_state_transition), [order_locked_by_user](errors.md#order_locked_by_user), [order_lock_released](errors.md#order_lock_released) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version / ส่ง If-Match แต่ยังไม่มีใบ — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | เหตุผลสั้นกว่า 10 ตัวอักษร / reason code ไม่ใช่หมวด CANCEL — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/orders/<id>/cancel" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"ลูกค้ายกเลิกคำสั่งทางอีเมล"}'
```

```ts
const { data, error } = await tms.POST('/v1/orders/{id}/cancel', {
  params: { path: { id: "…" } },
  body: {
    "reason": "ลูกค้ายกเลิกคำสั่งทางอีเมล"
  },
});
```

## POST /v1/orders/{id}/source-changes/{changeId}/accept {#post-orders-id-source-changes-changeId-accept}

`POST /v1/orders/{id}/source-changes/{changeId}/accept`

scope: `orders:write` · operationId: `Orders_acceptSourceChange`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `changeId` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag ของใบที่ผู้ใช้เห็น diff — ไม่ตรง → 412 |

**Request body** `SourceChangeDecisionDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `ลูกค้ายืนยันเปลี่ยนจุดส่งทางโทรศัพท์` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `OrderDto` |
| `400` | JSON เสีย — [bad_request](errors.md#bad_request) | `ProblemDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`orders:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมใบของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | `order_on_trip` — ช่องที่ต้นทางแก้ยังล็อกเพราะมีใบส่งของในเที่ยว (ถอดออกจากเที่ยวก่อนแล้วรับ) · `order_locked_for_update` — ใบออกรถ/ปิด/ยกเลิกแล้ว · `source_change_not_pending` — ชุดนี้ถูกตัดสิน/มีชุดใหม่มาแทนแล้ว · `order_locked_by_user` — ผู้ใช้อื่นเปิดแก้อยู่ · `order_lock_released` — ล็อกของผู้เรียกถูกปลด — [order_on_trip](errors.md#order_on_trip), [source_change_not_pending](errors.md#source_change_not_pending), [order_locked_by_user](errors.md#order_locked_by_user), [order_lock_released](errors.md#order_lock_released) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version / ส่ง If-Match แต่ยังไม่มีใบ — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | เหตุผลสั้นกว่า 10 ตัวอักษร / reason code ไม่ใช่หมวด CANCEL — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/orders/<id>/source-changes/<changeId>/accept" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"ลูกค้ายืนยันเปลี่ยนจุดส่งทางโทรศัพท์"}'
```

```ts
const { data, error } = await tms.POST('/v1/orders/{id}/source-changes/{changeId}/accept', {
  params: { path: { id: "…", changeId: "…" } },
  body: {
    "reason": "ลูกค้ายืนยันเปลี่ยนจุดส่งทางโทรศัพท์"
  },
});
```

## POST /v1/orders/{id}/source-changes/{changeId}/reject {#post-orders-id-source-changes-changeId-reject}

`POST /v1/orders/{id}/source-changes/{changeId}/reject`

scope: `orders:write` · operationId: `Orders_rejectSourceChange`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `changeId` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag ของใบที่ผู้ใช้เห็น diff — ไม่ตรง → 412 |

**Request body** `SourceChangeDecisionDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `ลูกค้ายืนยันเปลี่ยนจุดส่งทางโทรศัพท์` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `OrderDto` |
| `400` | JSON เสีย — [bad_request](errors.md#bad_request) | `ProblemDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`orders:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมใบของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | `order_on_trip` — ช่องที่ต้นทางแก้ยังล็อกเพราะมีใบส่งของในเที่ยว (ถอดออกจากเที่ยวก่อนแล้วรับ) · `order_locked_for_update` — ใบออกรถ/ปิด/ยกเลิกแล้ว · `source_change_not_pending` — ชุดนี้ถูกตัดสิน/มีชุดใหม่มาแทนแล้ว · `order_locked_by_user` — ผู้ใช้อื่นเปิดแก้อยู่ · `order_lock_released` — ล็อกของผู้เรียกถูกปลด — [order_on_trip](errors.md#order_on_trip), [source_change_not_pending](errors.md#source_change_not_pending), [order_locked_by_user](errors.md#order_locked_by_user), [order_lock_released](errors.md#order_lock_released) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version / ส่ง If-Match แต่ยังไม่มีใบ — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | เหตุผลสั้นกว่า 10 ตัวอักษร / reason code ไม่ใช่หมวด CANCEL — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/orders/<id>/source-changes/<changeId>/reject" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"ลูกค้ายืนยันเปลี่ยนจุดส่งทางโทรศัพท์"}'
```

```ts
const { data, error } = await tms.POST('/v1/orders/{id}/source-changes/{changeId}/reject', {
  params: { path: { id: "…", changeId: "…" } },
  body: {
    "reason": "ลูกค้ายืนยันเปลี่ยนจุดส่งทางโทรศัพท์"
  },
});
```

## ขอ/ต่ออายุล็อกการแก้ {#post-orders-id-lock}

`POST /v1/orders/{id}/lock`

scope: `orders:write` · operationId: `Orders_lock`

ได้ล็อก (หรือต่ออายุของตัวเอง) → 200 + ผู้ถือ/เวลาหมดอายุ (กิจกรรมล่าสุด + 10 นาที) · ผู้อื่นถืออยู่ → 409 `order_locked_by_user` · ล็อกของผู้อื่นที่หมดอายุแล้วถูกแทนที่ทันที · ใช้ได้เฉพาะผู้ใช้ในบริษัท (token อื่น → 403 `edit_lock_user_required`)

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |

**Request body** `OrderLockDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `heartbeat` |   | `boolean` |   | true = ต่ออายุระหว่างแก้ (หน้าจอส่งเมื่อผู้ใช้มีกิจกรรม) — ถ้าล็อกเดิมถูกผู้อื่นปลดแล้วได้ 409 `order_lock_released` (ไม่ได้ล็อกคืนเอง) · ไม่ส่ง/false = เปิดแก้ใหม่ |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `OrderEditLockDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`orders:write`) — [permission_denied](errors.md#permission_denied), [edit_lock_user_required](errors.md#edit_lock_user_required) | `ProblemDto` |
| `404` | ไม่พบ (รวมใบของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | 409 `order_locked_by_user` — ผู้ใช้อื่นเปิดแก้อยู่ (`editLock` = ผู้ถือ + เวลาหมดอายุ) · `order_lock_released` — ล็อกของผู้เรียกถูกผู้อื่นปลด (heartbeat/PATCH) จนกว่าจะเปิดแก้ใหม่ · `concurrent_update` — ล็อกเปลี่ยนมือระหว่างขอ ลองใหม่ได้ — [order_locked_by_user](errors.md#order_locked_by_user), [order_lock_released](errors.md#order_lock_released), [concurrent_update](errors.md#concurrent_update) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/orders/<id>/lock" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{}'
```

```ts
const { data, error } = await tms.POST('/v1/orders/{id}/lock', {
  params: { path: { id: "…" } },
  body: {},
});
```

## ปลดล็อกการแก้ {#post-orders-id-unlock}

`POST /v1/orders/{id}/unlock`

scope: `orders:write` · operationId: `Orders_unlock`

ของตัวเอง/ไม่มีล็อก/หมดอายุ → 204 · ล็อกของผู้อื่น: ต้องมีสิทธิ์ `orders:unlock` (ไม่มี → 403) และ `reason` ≥ 10 ตัวอักษร (422) — ลง audit พร้อมเหตุผล · ผู้ถือเดิมต่ออายุ/บันทึกไม่ได้ (409 `order_lock_released`) จนกว่าจะเปิดแก้ใหม่ — คนอื่นขอล็อกได้ทันที

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |

**Request body** `OrderUnlockDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` |   | `string` | ยาว ≤ 500 | บังคับ (≥ 10 ตัวอักษร) เมื่อปลดล็อกของผู้ใช้อื่น | `ผู้แก้ลาป่วย ต้องแก้วันรับของด่วน` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `204` |   |   |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`orders:write`; ปลดล็อกของผู้อื่นต้องมี `orders:unlock`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมใบของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `422` | ปลดล็อกของผู้อื่นโดยไม่มีเหตุผล / เหตุผลสั้นกว่า 10 ตัวอักษร — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/orders/<id>/unlock" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"ผู้แก้ลาป่วย ต้องแก้วันรับของด่วน"}'
```

```ts
const { data, error } = await tms.POST('/v1/orders/{id}/unlock', {
  params: { path: { id: "…" } },
  body: {
    "reason": "ผู้แก้ลาป่วย ต้องแก้วันรับของด่วน"
  },
});
```

## เลือกสถานที่ให้จุดที่ยังจับคู่ไม่ได้ + จำข้อความเป็น alias {#post-orders-id-stops-sequence-map-site}

`POST /v1/orders/{id}/stops/{sequence}/map-site`

scope: `orders:write` · operationId: `Orders_mapStopSite`

จุดลำดับ `{sequence}` (เริ่ม 1) ได้สถานที่ที่เลือก (`match.method = MANUAL`) แล้วระบบจำข้อความสถานที่ของจุดนี้เป็น alias ของสถานที่ → ใบถัดไปที่ข้อความเดิม (ไม่สนช่องว่าง/ตัวพิมพ์/คำนิติบุคคล) จับคู่เอง · ประเมินราคา + ใบค้างใหม่ทันที (LOCATION_UNMAPPED หาย / RATE_MISSING ถ้ายังไม่มี rate) · สถานที่ต้องเป็นของลูกค้าของใบหรือของบริษัท — ใบยังไม่มีลูกค้าเลือกได้เฉพาะสถานที่ของบริษัท (422 `customer_unmapped`) · หลังวางแผน → 409 `order_locked_for_update`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `sequence` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `MapStopSiteDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `siteId` | ใช่ | `string` |   | สถานที่ (ของลูกค้าของใบ หรือของบริษัท) ที่ใช้งานอยู่ | `loc_3f2a…` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `OrderMapResultDto` |
| `400` | JSON เสีย — [bad_request](errors.md#bad_request) | `ProblemDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`orders:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมใบของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | 409 `order_locked_for_update` — แก้ช่องที่สถานะไม่อนุญาต (errors[] = ช่อง, `editableFields` = ช่องที่แก้ได้): ก่อนวางแผนแก้ได้ทุกช่อง · PLANNED แก้ได้เฉพาะช่วงเวลาของจุด + customerRef · ตั้งแต่ in_transit แก้ได้เฉพาะ customerRef · ปิดงาน/ยกเลิกแก้ไม่ได้ · 409 `external_id_conflict` — externalId นี้เป็นของใบจากช่องทางอื่น — [order_locked_for_update](errors.md#order_locked_for_update), [invalid_state_transition](errors.md#invalid_state_transition) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version / ส่ง If-Match แต่ยังไม่มีใบ — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | รูปแบบผิด — `errors[]` รวมทุกช่อง (path แบบ `stops[0].siteId`) — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/orders/<id>/stops/<sequence>/map-site" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"siteId":"loc_3f2a…"}'
```

```ts
const { data, error } = await tms.POST('/v1/orders/{id}/stops/{sequence}/map-site', {
  params: { path: { id: "…", sequence: "…" } },
  body: {
    "siteId": "loc_3f2a…"
  },
});
```

## ตรวจใบค้างอีกครั้ง — คิดราคา + ประเมินเหตุค้างใหม่จากข้อมูลหลักปัจจุบัน {#post-orders-id-reevaluate}

`POST /v1/orders/{id}/reevaluate`

scope: `orders:write` · operationId: `Orders_reevaluate`

หน้าใบค้างเรียกหลังเคลียร์เหตุที่ข้อมูลหลัก (เพิ่ม/อนุมัติ rate card → RATE_MISSING, ปักพิกัดสถานที่ → GEOCODING_ERROR, เปิดใช้ลูกค้า/สถานที่) · จับคู่อัตโนมัติด้วย alias ที่เรียนรู้ล่าสุดด้วย · ไม่แก้ข้อมูลงาน · ผลเหมือนเดิม = ไม่เพิ่ม version · เหตุหมด → กลับ `received` · เหตุที่ flow อื่นตั้ง (CARRIER_REJECTED ฯลฯ) ไม่ถูกปล่อย · ใช้ได้ก่อนวางแผน (draft/received/on_hold) — ไม่งั้น 409 `invalid_state_transition` · ใบค้างด้วยเหตุตอนจัดรถ/ส่ง (CARRIER_REJECTED ฯลฯ — เคยวางแผนแล้ว ไม่คิดราคาใหม่) → 409 `invalid_state_transition` (`holdReason`) · ผู้ใช้อื่นเปิดแก้อยู่ → 409 `order_locked_by_user`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `OrderDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`orders:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมใบของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | `invalid_state_transition` — ใบวางแผน/ออกรถ/ปิด/ยกเลิกแล้ว (ประเมินใหม่ได้เฉพาะก่อนวางแผน) หรือไม่มีปัญหาจากต้นทางให้ยืนยัน · `order_locked_by_user` — ผู้ใช้อื่นเปิดแก้อยู่ · `order_lock_released` — ล็อกของผู้เรียกถูกปลด — [invalid_state_transition](errors.md#invalid_state_transition), [order_locked_for_update](errors.md#order_locked_for_update), [order_locked_by_user](errors.md#order_locked_by_user), [order_lock_released](errors.md#order_lock_released) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version / ส่ง If-Match แต่ยังไม่มีใบ — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/orders/<id>/reevaluate" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)"
```

```ts
const { data, error } = await tms.POST('/v1/orders/{id}/reevaluate', {
  params: { path: { id: "…" } },
});
```

## กำหนดราคาเอง — ค่าขนส่งเมื่อไม่พบ rate card {#post-orders-id-manual-price}

`POST /v1/orders/{id}/manual-price`

scope: `orders:write` · operationId: `Orders_manualPrice`

สร้างบรรทัด FREIGHT ที่มา `MANUAL` (รายการบริการระบบ FREIGHT — vat_type/wht_rate ตาม catalog) หรือแก้จำนวนเงินของบรรทัด MANUAL เดิม → ประเมินใบค้างใหม่ (มีค่าขนส่ง MANUAL = ไม่ค้าง RATE_MISSING · เหตุหมด → `received`) · บรรทัด MANUAL ไม่ถูกลบตอนคิดราคาใหม่ · ต้องมี `orders:write` + `prices.sell:write` (ไม่มี → 403) · เหตุผล ≥ 10 ตัวอักษร (audit `sales_order.manual_price_set`) · ใช้ได้ก่อนวางแผน (หลังวางแผน → 409 `order_locked_for_update`) · มีค่าขนส่งจาก rate card แล้ว หรือใบค้างด้วยเหตุตอนจัดรถ/ส่ง → 409 `invalid_state_transition`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `ManualPriceDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `sellAmount` | ใช่ | `string` |   | ค่าขนส่งที่กำหนดเอง (บาท ก่อน VAT, > 0, ทศนิยม ≤ 2) — ต้องมีสิทธิ์ `prices.sell:write` (ไม่มี → 403) | `4200.00` |
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 | เหตุผลที่กำหนดราคาเอง (≥ 10 ตัวอักษร — ลง audit) | `ลูกค้ารายใหม่ ยังไม่มีสัญญาราคา ตกลงราคาทางโทรศัพท์` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `OrderDto` |
| `400` | JSON เสีย — [bad_request](errors.md#bad_request) | `ProblemDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`orders:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมใบของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | `invalid_state_transition` — ใบวางแผน/ออกรถ/ปิด/ยกเลิกแล้ว (ประเมินใหม่ได้เฉพาะก่อนวางแผน) หรือไม่มีปัญหาจากต้นทางให้ยืนยัน · `order_locked_by_user` — ผู้ใช้อื่นเปิดแก้อยู่ · `order_lock_released` — ล็อกของผู้เรียกถูกปลด — [invalid_state_transition](errors.md#invalid_state_transition), [order_locked_for_update](errors.md#order_locked_for_update), [order_locked_by_user](errors.md#order_locked_by_user), [order_lock_released](errors.md#order_lock_released) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version / ส่ง If-Match แต่ยังไม่มีใบ — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | รูปแบบผิด — `errors[]` รวมทุกช่อง (path แบบ `stops[0].siteId`) — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/orders/<id>/manual-price" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"sellAmount":"4200.00","reason":"ลูกค้ารายใหม่ ยังไม่มีสัญญาราคา ตกลงราคาทางโทรศัพท์"}'
```

```ts
const { data, error } = await tms.POST('/v1/orders/{id}/manual-price', {
  params: { path: { id: "…" } },
  body: {
    "sellAmount": "4200.00",
    "reason": "ลูกค้ารายใหม่ ยังไม่มีสัญญาราคา ตกลงราคาทางโทรศัพท์"
  },
});
```

## ยืนยันข้อมูลใบที่ต้นทางแจ้งว่าไม่ครบ {#post-orders-id-resolve-source-error}

`POST /v1/orders/{id}/resolve-source-error`

scope: `orders:write` · operationId: `Orders_resolveSourceError`

SOURCE_ERROR "ดู raw_payload, แก้มือ หรือรอ connector แก้": คนแก้ข้อมูลใบ (PATCH) แล้วยืนยัน → ล้างรายการปัญหาจากต้นทาง แล้วประเมินใบค้างใหม่ (เหตุอื่นยังค้างได้) · บังคับเหตุผล ≥ 10 ตัวอักษร (ลง audit `sales_order.source_error_resolved`) · ต้นทางส่งใบนี้มาใหม่ด้วยข้อมูลที่เปลี่ยน = ใช้ผลตรวจของต้นทางชุดใหม่ · ไม่มีปัญหาค้าง → 409 `invalid_state_transition` · หลังวางแผน → 409 `order_locked_for_update`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `ResolveSourceErrorDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 | เหตุผลที่ยืนยันว่าข้อมูลใบใช้ได้แม้ต้นทางแจ้งว่าไม่ครบ (≥ 10 ตัวอักษร — ลง audit) | `ตรวจกับเอกสารต้นฉบับแล้ว แก้วันรับของและจำนวนในใบให้ถูกต้อง` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `OrderDto` |
| `400` | JSON เสีย — [bad_request](errors.md#bad_request) | `ProblemDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`orders:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมใบของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | `invalid_state_transition` — ใบวางแผน/ออกรถ/ปิด/ยกเลิกแล้ว (ประเมินใหม่ได้เฉพาะก่อนวางแผน) หรือไม่มีปัญหาจากต้นทางให้ยืนยัน · `order_locked_by_user` — ผู้ใช้อื่นเปิดแก้อยู่ · `order_lock_released` — ล็อกของผู้เรียกถูกปลด — [invalid_state_transition](errors.md#invalid_state_transition), [order_locked_for_update](errors.md#order_locked_for_update), [order_locked_by_user](errors.md#order_locked_by_user), [order_lock_released](errors.md#order_lock_released) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version / ส่ง If-Match แต่ยังไม่มีใบ — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | รูปแบบผิด — `errors[]` รวมทุกช่อง (path แบบ `stops[0].siteId`) — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/orders/<id>/resolve-source-error" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"ตรวจกับเอกสารต้นฉบับแล้ว แก้วันรับของและจำนวนในใบให้ถูกต้อง"}'
```

```ts
const { data, error } = await tms.POST('/v1/orders/{id}/resolve-source-error', {
  params: { path: { id: "…" } },
  body: {
    "reason": "ตรวจกับเอกสารต้นฉบับแล้ว แก้วันรับของและจำนวนในใบให้ถูกต้อง"
  },
});
```

## เลือกลูกค้าให้ใบที่ยังจับคู่ไม่ได้ + จำรหัส/ชื่อตามต้นทาง {#post-orders-id-map-customer}

`POST /v1/orders/{id}/map-customer`

scope: `orders:write` · operationId: `Orders_mapCustomer`

ใบได้ลูกค้าที่เลือก (`customer.match.method = MANUAL`) · ใบมีรหัสลูกค้าต้นทาง = จำรหัสนั้นของช่องทางนี้ (เช่น `ERP:krs`) · ไม่มีรหัส = จำชื่อตามต้นทาง → ใบถัดไปจับคู่เอง · เคยจำไว้กับลูกค้าอื่น = ย้ายมาลูกค้านี้ (audit) · จุดที่ยังว่างจับคู่ในขอบเขตลูกค้านี้ต่อ แล้วประเมินราคา + ใบค้างใหม่ · จุดที่เลือกสถานที่ของลูกค้าอื่นไว้ → 422 `site_other_customer` · รหัส/ชื่อนี้เคยจับคู่กับลูกค้าอื่น → 409 `alias_conflict` (ใบไม่เปลี่ยน) จนกว่าส่ง `confirmReassign: true` + `reason` · ชื่อทั่วไป (เงินสด, ลูกค้าทั่วไป, walk-in …) ไม่จำ (`aliasLearning = generic`) · alias รหัสที่คนจับคู่ชนะ externalId ของลูกค้า

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `MapCustomerDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `customerId` | ใช่ | `string` |   | ลูกค้าที่ใช้งานอยู่ | `cus_3f2a…` |
| `confirmReassign` |   | `boolean` |   | รหัส/ชื่อตามต้นทางนี้เคยจับคู่กับลูกค้ารายอื่น (409 `alias_conflict`) → ส่ง true + `reason` เพื่อย้ายมาลูกค้านี้ |   |
| `reason` |   | `string` | ยาว ≤ 500 · ยาว ≥ 10 | เหตุผลการย้าย (บังคับเมื่อ confirmReassign = true, ≥ 10 ตัวอักษร — ลง audit) |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `OrderMapResultDto` |
| `400` | JSON เสีย — [bad_request](errors.md#bad_request) | `ProblemDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`orders:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมใบของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | 409 `order_locked_for_update` — แก้ช่องที่สถานะไม่อนุญาต (errors[] = ช่อง, `editableFields` = ช่องที่แก้ได้): ก่อนวางแผนแก้ได้ทุกช่อง · PLANNED แก้ได้เฉพาะช่วงเวลาของจุด + customerRef · ตั้งแต่ in_transit แก้ได้เฉพาะ customerRef · ปิดงาน/ยกเลิกแก้ไม่ได้ · 409 `external_id_conflict` — externalId นี้เป็นของใบจากช่องทางอื่น — [order_locked_for_update](errors.md#order_locked_for_update), [invalid_state_transition](errors.md#invalid_state_transition), [alias_conflict](errors.md#alias_conflict) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version / ส่ง If-Match แต่ยังไม่มีใบ — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | รูปแบบผิด — `errors[]` รวมทุกช่อง (path แบบ `stops[0].siteId`) — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/orders/<id>/map-customer" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"customerId":"cus_3f2a…"}'
```

```ts
const { data, error } = await tms.POST('/v1/orders/{id}/map-customer', {
  params: { path: { id: "…" } },
  body: {
    "customerId": "cus_3f2a…"
  },
});
```

## ไฟล์ของ order (หลักฐานส่ง POD ของ DO ทุกใบ + ไฟล์ที่ผูกกับใบสั่ง) {#get-orders-id-documents}

`GET /v1/orders/{id}/documents`

scope: `orders:read` · operationId: `OrderResources_documents`

อ่านอย่างเดียว — อัปโหลดไฟล์ใหม่ใช้ `POST /v1/documents` (presigned) แล้วผูกผ่าน `PUT /v1/delivery-orders/{id}/pod` · ไม่มี `documents:read` = ได้ metadata แต่ไม่มี `downloadUrl`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `OrderDocumentListDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`orders:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบสั่งขนส่ง (รวมของบริษัทอื่น / `ext:` ที่ไม่มี) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/orders/<id>/documents" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/orders/{id}/documents', {
  params: { path: { id: "…" } },
});
```

## สถานะติดตามของ order — ขั้น ETA ตำแหน่งล่าสุด ต่อ DO {#get-orders-id-tracking}

`GET /v1/orders/{id}/tracking`

scope: `orders:read` · operationId: `OrderResources_trackingView`

ขั้น (stepper) และ ETA ตามกติกาของหน้าติดตามผู้รับ · ETA = ช่วงเวลาตามแผน (ยังไม่มี ETA สด — P1) · ตำแหน่ง = พิกัดของ event หน้างานล่าสุดของเที่ยว (ไม่มี GPS สด) · ทะเบียนปิด 2 หลัก · ห้าม cache

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `OrderTrackingDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`orders:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบสั่งขนส่ง (รวมของบริษัทอื่น / `ext:` ที่ไม่มี) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/orders/<id>/tracking" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/orders/{id}/tracking', {
  params: { path: { id: "…" } },
});
```

## ประวัติ order — สถานะใบสั่ง/DO + event หน้างาน เรียงตามเวลา {#get-orders-id-events}

`GET /v1/orders/{id}/events`

scope: `orders:read` · operationId: `OrderResources_events`

audit trail สำหรับระบบภายนอก (ไม่รวมบันทึก/ข้อความภายใน) · event หน้างานมีทั้ง `occurredAt` (อุปกรณ์) และ `receivedAt` (server)

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `OrderEventListDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`orders:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบสั่งขนส่ง (รวมของบริษัทอื่น / `ext:` ที่ไม่มี) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/orders/<id>/events" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/orders/{id}/events', {
  params: { path: { id: "…" } },
});
```

## บรรทัดรายได้ของใบสั่ง (ฐานของบรรทัดใบแจ้งหนี้) {#get-orders-id-revenue-lines}

`GET /v1/orders/{id}/revenue-lines`

scope: `orders:read` · operationId: `OrderRevenueLines_list`

ระบบสร้างจากราคาของใบสั่ง (`SO_CHARGE` — rate card snapshot / ราคาที่กำหนดเอง **แบ่งลงใบส่งของ** ตามปริมาณของใบ: ลูกค้าวางบิลตามยอดส่งจริง = ยอดส่งจริง (ยังไม่บันทึก = แผน `provisional`), ยังไม่มีใบส่งของ = ระดับใบสั่ง) และค่าใช้จ่ายหน้างานที่ยืนยันแล้ว (`DO_SURCHARGE`) · แก้ใบสั่ง → บรรทัดระบบคิดใหม่ บรรทัดที่คนเพิ่ม (`MANUAL`) คงไว้ · บรรทัดที่อยู่ในเอกสารที่ออกเลขแล้ว `locked` = ไม่เปลี่ยน · ไม่คำนวณภาษี (มีเฉพาะ vatType/whtRate ต่อบรรทัด) · รวมบรรทัดที่ยกเลิก (`status` VOIDED)

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `RevenueLineListDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`orders:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/orders/<id>/revenue-lines" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/orders/{id}/revenue-lines', {
  params: { path: { id: "…" } },
});
```

## เพิ่มบรรทัดรายได้เอง — คงไว้เมื่อระบบคิดราคาใหม่ {#post-orders-id-revenue-lines}

`POST /v1/orders/{id}/revenue-lines`

scope: `orders:write` · operationId: `OrderRevenueLines_add`

ธงภาษีคัดลอกจากรายการบริการฝั่งขาย ณ เวลาเพิ่ม · ยอด = จำนวน × ราคา (ปัดครึ่งขึ้นเป็นสตางค์) · ต้องมี `prices.sell:write` · เหตุผล ≥ 10 ตัวอักษร (audit `sales_order.revenue_line_added`) · ใบสั่งปิด/ยกเลิก หรือใบส่งของที่ระบุ (ไม่ระบุ = ระดับใบสั่ง) มีบรรทัดที่ออกใบแจ้งหนี้แล้ว → 409

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |

**Request body** `AddRevenueLineDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `serviceItemId` | ใช่ | `string` |   | รายการบริการฝั่งขาย (SELL/BOTH) ที่ใช้งานอยู่ | `svc_…` |
| `qty` |   | `string` |   | จำนวน (ทศนิยม ≤ 3 ตำแหน่ง, > 0) — ไม่ส่ง = 1 | `1` |
| `sellUnitPrice` | ใช่ | `string` |   | ราคาต่อหน่วยก่อน VAT (บาท) — ยอด = จำนวน × ราคา ปัดครึ่งขึ้นเป็นสตางค์ · ต้องมีสิทธิ์ `prices.sell:write` | `500.00` |
| `description` |   | `string` | ยาว ≤ 500 | ข้อความบนบรรทัด — ไม่ส่ง = ชื่อรายการบริการ |   |
| `deliveryOrderId` |   | `string` |   | ผูกกับใบส่งของของใบสั่งนี้ (ไม่ยกเลิก/ยังไม่วางบิล) — ไม่ส่ง = ระดับใบสั่ง | `do_…` |
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `ลูกค้าขอให้ช่วยยกของขึ้นชั้น 2` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `201` |   | `RevenueLineDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`prices.sell:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress), [order_locked_for_update](errors.md#order_locked_for_update) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/orders/<id>/revenue-lines" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"serviceItemId":"svc_…","qty":"1","sellUnitPrice":"500.00","deliveryOrderId":"do_…","reason":"ลูกค้าขอให้ช่วยยกของขึ้นชั้น 2"}'
```

```ts
const { data, error } = await tms.POST('/v1/orders/{id}/revenue-lines', {
  params: { path: { id: "…" } },
  body: {
    "serviceItemId": "svc_…",
    "qty": "1",
    "sellUnitPrice": "500.00",
    "deliveryOrderId": "do_…",
    "reason": "ลูกค้าขอให้ช่วยยกของขึ้นชั้น 2"
  },
});
```

## ยกเลิกบรรทัดรายได้ที่คนเพิ่มเอง — เหตุผล ≥ 10 ตัวอักษร {#post-revenue-lines-id-void}

`POST /v1/revenue-lines/{id}/void`

scope: `orders:write` · operationId: `RevenueLines_void`

บรรทัดระบบ (SO_CHARGE / DO_SURCHARGE) ยกเลิกไม่ได้ — แก้ที่ใบสั่ง/ค่าใช้จ่ายหน้างาน (409) · บรรทัดที่ล็อก (ออกเลขแล้ว) / ใบสั่งปิดหรือยกเลิก / ใบสั่งถูกล็อกการแก้โดยผู้อื่น → 409 · ต้องมี `prices.sell:write` · audit `sales_order.revenue_line_voided`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag (version) — ไม่ตรง → 412 |

**Request body** `RevenueLineReasonDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `เพิ่มผิดรายการ ลูกค้าไม่ได้ขอบริการนี้` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `RevenueLineDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`prices.sell:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress), [order_locked_for_update](errors.md#order_locked_for_update) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/revenue-lines/<id>/void" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"เพิ่มผิดรายการ ลูกค้าไม่ได้ขอบริการนี้"}'
```

```ts
const { data, error } = await tms.POST('/v1/revenue-lines/{id}/void', {
  params: { path: { id: "…" } },
  body: {
    "reason": "เพิ่มผิดรายการ ลูกค้าไม่ได้ขอบริการนี้"
  },
});
```

## Schema ของ response {#schemas}

### BulkJobAcceptedDto {#schema-BulkJobAcceptedDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `jobId` | ใช่ | `string` |   |   | `job_3f2a…` |
| `statusUrl` | ใช่ | `string` |   |   | `/v1/jobs/job_3f2a…` |

### BulkOrderResultsDto {#schema-BulkOrderResultsDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `results` | ใช่ | `array<BulkOrderResultDto>` |   | ผลต่อรายการ เรียงตาม `items[]` |   |
| `total` | ใช่ | `number` |   |   | `200` |
| `succeeded` | ใช่ | `number` |   | สร้าง/อัปเดตสำเร็จ | `198` |
| `failed` | ใช่ | `number` |   |   | `2` |

### OrderDocumentListDto {#schema-OrderDocumentListDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<OrderDocumentDto>` |   | ไฟล์ของ order และ DO ทุกใบ (รวมที่ยกเลิก) เรียงตามเวลาที่จอง · `downloadUrl` (หมดอายุ 5 นาที) ให้เฉพาะผู้มี `documents:read` และไฟล์ที่อัปโหลดเสร็จ |   |
| `truncated` | ใช่ | `boolean` |   | มีเกิน 500 ไฟล์ — คืนเฉพาะ 500 ไฟล์แรก (ไม่มี cursor: ไฟล์ของใบเดียวมีจำกัด) |   |

### OrderDto {#schema-OrderDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `ord_3f2a…` |
| `soNo` | ใช่ | `string` | null ได้ | ร่าง = null | `SO-6911-0001` |
| `status` | ใช่ | `string` | ค่า: `draft`, `received`, `on_hold`, `planned`, `in_transit`, `partially_delivered`, `delivered`, `closed`, `cancelled` |   |   |
| `source` | ใช่ | `string` |   | ที่มาตาม C: MANUAL / EXCEL / API / PORTAL / ERP:{connector} | `ERP:krs` |
| `sourceType` | ใช่ | `string` | ค่า: `MANUAL`, `IMPORT`, `API`, `PORTAL`, `CONNECTOR` | ชนิดที่มา (ใช้กับป้ายที่มา): MANUAL / IMPORT / API / PORTAL / CONNECTOR |   |
| `connector` | ใช่ | `string` | null ได้ | รหัส connector | `krs` |
| `externalId` | ใช่ | `string` | null ได้ | externalRef ของระบบต้นทาง |   |
| `customer` | ใช่ | `OrderCustomerDto` |   |   |   |
| `billingCompanyId` | ใช่ | `string` |   |   |   |
| `customerRef` | ใช่ | `string` | null ได้ |   |   |
| `requestedDate` | ใช่ | `string` |   |   | `2026-11-12` |
| `vehicleTypeId` | ใช่ | `string` | null ได้ |   |   |
| `holdReason` | ใช่ | `OrderHoldReasonDto` | null ได้ | เหตุค้าง (ON_HOLD) |   |
| `holdCodes` | ใช่ | `array<string>` |   | เหตุค้างทั้งหมดของการรับงานครั้งล่าสุด (ตัวแรก = holdReason) |   |
| `rescheduledDate` | ใช่ | `string` | null ได้ | วันที่นัดส่งใหม่ล่าสุดของ DO ส่งใหม่ที่ยังรอจัด (null = ไม่มี) — หน้าใบค้าง/รายการแสดงแทนกำหนดส่งเดิม | `2026-11-18` |
| `pricingStatus` | ใช่ | `string` | ค่า: `AVAILABLE`, `RATE_MISSING`, `CALCULATION_FAILURE` |   |   |
| `pricingReasons` | ใช่ | `array<OrderPricingReasonDto>` |   |   |   |
| `sellTotal` |   | `string` | null ได้ | ราคาขายรวมก่อน VAT (คาดการณ์) — เห็นเมื่อมี `prices.sell:read` | `4500.00` |
| `sellCharges` |   | `array<OrderChargeDto>` |   | บรรทัดราคาขาย — เห็นเมื่อมี `prices.sell:read` |   |
| `sellBilling` |   | `OrderBillingDto` |   | **ยอดประมาณ (preview, ไม่ผูกพัน)** ของการวางบิล (ตามใบสั่ง / ตามยอดส่งจริงตามที่ตั้งในลูกค้า) — ยังไม่ใช้ออกใบแจ้งหนี้ (กติกา OPEN) · มีเฉพาะ GET ทีละใบและผลของการเขียน · เห็นเมื่อมี `prices.sell:read` |   |
| `stops` | ใช่ | `array<OrderStopDto>` |   |   |   |
| `lines` | ใช่ | `array<OrderLineDto>` |   |   |   |
| `editableFields` |   | `array<string>` |   | ช่องที่แก้ได้ในสถานะปัจจุบัน — มีเฉพาะ GET ทีละใบและผลของ POST/PUT/PATCH (ไม่อยู่ในรายการ) · ว่าง = แก้ไม่ได้ (ปิดงาน/ยกเลิก) · ฟอร์มใช้ปิดช่องที่แก้ไม่ได้ก่อนส่ง (server ตรวจซ้ำ → 409 `order_locked_for_update`) |   |
| `sourceChangedAfterPlan` | ใช่ | `boolean` |   | ต้นทาง (connector) แก้ใบหลังวางแผน — ไม่ทับข้อมูล รอคนรับ/ไม่รับ (`sourceChange`) · สถานะใบไม่เปลี่ยน |   |
| `sourceCancelledAt` | ใช่ | `string (date-time)` | null ได้ | ต้นทาง (ERP connector) แจ้งว่ายกเลิกใบนี้ — ใบที่ยังไม่มี DO ถูกยกเลิกอัตโนมัติ (`status = cancelled`) · มี DO แล้ว = ไม่ยกเลิก แจ้งเตือนผู้วางแผนให้ตรวจและยกเลิกเอง · null = ต้นทางไม่ได้ยกเลิก |   |
| `sourceChange` | ใช่ | `OrderSourceChangeDto` | null ได้ | ชุดการเปลี่ยนแปลงจากต้นทางที่รอตัดสิน (รับ: POST …/source-changes/{changeId}/accept · ไม่รับ: …/reject) |   |
| `editLock` |   | `OrderEditLockDto` | null ได้ | ผู้ที่เปิดแก้ใบนี้อยู่ · null = ไม่มีใครแก้ · มีเฉพาะ GET ทีละใบและผลของ POST/PUT/PATCH (ไม่อยู่ในรายการ) |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string` |   |   |   |
| `updatedAt` | ใช่ | `string` |   |   |   |

### OrderEditLockDto {#schema-OrderEditLockDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `userId` | ใช่ | `string` |   | ผู้ถือล็อก | `usr_3f2a…` |
| `userName` | ใช่ | `string` |   | ชื่อผู้ถือล็อก (ป้าย "กำลังแก้ไขโดย …") | `สมชาย ใจดี` |
| `acquiredAt` | ใช่ | `string (date-time)` |   |   |   |
| `lastSeenAt` | ใช่ | `string (date-time)` |   | กิจกรรมล่าสุด |   |
| `expiresAt` | ใช่ | `string (date-time)` |   | หมดอายุ = กิจกรรมล่าสุด + 10 นาที — หลังเวลานี้คนอื่นขอล็อกได้ทันที |   |
| `mine` | ใช่ | `boolean` |   | ผู้เรียกเป็นผู้ถือล็อกเอง |   |

### OrderEventListDto {#schema-OrderEventListDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<OrderEventDto>` |   | ประวัติของ order เรียงตามเวลา: สถานะของใบสั่ง + DO ทุกใบ (doc_status_history) และ event หน้างานของจุดรับ/ส่งของ DO (รวมที่ขัดลำดับ — ผลที่มีผลดู `GET /v1/stops/{id}/events`) |   |
| `truncated` | ใช่ | `boolean` |   | มีเกิน 1000 รายการ — คืนเฉพาะ 1000 รายการแรกตามเวลา (ไม่มี cursor: ประวัติของใบเดียวมีจำกัด) |   |

### OrderMapResultDto {#schema-OrderMapResultDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `ord_3f2a…` |
| `soNo` | ใช่ | `string` | null ได้ | ร่าง = null | `SO-6911-0001` |
| `status` | ใช่ | `string` | ค่า: `draft`, `received`, `on_hold`, `planned`, `in_transit`, `partially_delivered`, `delivered`, `closed`, `cancelled` |   |   |
| `source` | ใช่ | `string` |   | ที่มาตาม C: MANUAL / EXCEL / API / PORTAL / ERP:{connector} | `ERP:krs` |
| `sourceType` | ใช่ | `string` | ค่า: `MANUAL`, `IMPORT`, `API`, `PORTAL`, `CONNECTOR` | ชนิดที่มา (ใช้กับป้ายที่มา): MANUAL / IMPORT / API / PORTAL / CONNECTOR |   |
| `connector` | ใช่ | `string` | null ได้ | รหัส connector | `krs` |
| `externalId` | ใช่ | `string` | null ได้ | externalRef ของระบบต้นทาง |   |
| `customer` | ใช่ | `OrderCustomerDto` |   |   |   |
| `billingCompanyId` | ใช่ | `string` |   |   |   |
| `customerRef` | ใช่ | `string` | null ได้ |   |   |
| `requestedDate` | ใช่ | `string` |   |   | `2026-11-12` |
| `vehicleTypeId` | ใช่ | `string` | null ได้ |   |   |
| `holdReason` | ใช่ | `OrderHoldReasonDto` | null ได้ | เหตุค้าง (ON_HOLD) |   |
| `holdCodes` | ใช่ | `array<string>` |   | เหตุค้างทั้งหมดของการรับงานครั้งล่าสุด (ตัวแรก = holdReason) |   |
| `rescheduledDate` | ใช่ | `string` | null ได้ | วันที่นัดส่งใหม่ล่าสุดของ DO ส่งใหม่ที่ยังรอจัด (null = ไม่มี) — หน้าใบค้าง/รายการแสดงแทนกำหนดส่งเดิม | `2026-11-18` |
| `pricingStatus` | ใช่ | `string` | ค่า: `AVAILABLE`, `RATE_MISSING`, `CALCULATION_FAILURE` |   |   |
| `pricingReasons` | ใช่ | `array<OrderPricingReasonDto>` |   |   |   |
| `sellTotal` |   | `string` | null ได้ | ราคาขายรวมก่อน VAT (คาดการณ์) — เห็นเมื่อมี `prices.sell:read` | `4500.00` |
| `sellCharges` |   | `array<OrderChargeDto>` |   | บรรทัดราคาขาย — เห็นเมื่อมี `prices.sell:read` |   |
| `sellBilling` |   | `OrderBillingDto` |   | **ยอดประมาณ (preview, ไม่ผูกพัน)** ของการวางบิล (ตามใบสั่ง / ตามยอดส่งจริงตามที่ตั้งในลูกค้า) — ยังไม่ใช้ออกใบแจ้งหนี้ (กติกา OPEN) · มีเฉพาะ GET ทีละใบและผลของการเขียน · เห็นเมื่อมี `prices.sell:read` |   |
| `stops` | ใช่ | `array<OrderStopDto>` |   |   |   |
| `lines` | ใช่ | `array<OrderLineDto>` |   |   |   |
| `editableFields` |   | `array<string>` |   | ช่องที่แก้ได้ในสถานะปัจจุบัน — มีเฉพาะ GET ทีละใบและผลของ POST/PUT/PATCH (ไม่อยู่ในรายการ) · ว่าง = แก้ไม่ได้ (ปิดงาน/ยกเลิก) · ฟอร์มใช้ปิดช่องที่แก้ไม่ได้ก่อนส่ง (server ตรวจซ้ำ → 409 `order_locked_for_update`) |   |
| `sourceChangedAfterPlan` | ใช่ | `boolean` |   | ต้นทาง (connector) แก้ใบหลังวางแผน — ไม่ทับข้อมูล รอคนรับ/ไม่รับ (`sourceChange`) · สถานะใบไม่เปลี่ยน |   |
| `sourceCancelledAt` | ใช่ | `string (date-time)` | null ได้ | ต้นทาง (ERP connector) แจ้งว่ายกเลิกใบนี้ — ใบที่ยังไม่มี DO ถูกยกเลิกอัตโนมัติ (`status = cancelled`) · มี DO แล้ว = ไม่ยกเลิก แจ้งเตือนผู้วางแผนให้ตรวจและยกเลิกเอง · null = ต้นทางไม่ได้ยกเลิก |   |
| `sourceChange` | ใช่ | `OrderSourceChangeDto` | null ได้ | ชุดการเปลี่ยนแปลงจากต้นทางที่รอตัดสิน (รับ: POST …/source-changes/{changeId}/accept · ไม่รับ: …/reject) |   |
| `editLock` |   | `OrderEditLockDto` | null ได้ | ผู้ที่เปิดแก้ใบนี้อยู่ · null = ไม่มีใครแก้ · มีเฉพาะ GET ทีละใบและผลของ POST/PUT/PATCH (ไม่อยู่ในรายการ) |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string` |   |   |   |
| `updatedAt` | ใช่ | `string` |   |   |   |
| `aliasLearning` | ใช่ | `string` | ค่า: `learned`, `exists`, `name`, `full`, `too_long`, `empty`, `generic`, `conflict`, `not_permitted` | ผลการเรียนรู้ alias (ใบนี้จับคู่แล้วทุกกรณี): learned = จำแล้ว (ใบถัดไปข้อความเดิมจับคู่เอง) · exists = จำไว้แล้ว · name = ข้อความตรงชื่อสถานที่อยู่แล้ว · full = alias ครบ 50 · too_long = ข้อความยาวเกิน · empty = ไม่มีข้อความ · generic = ข้อความทั่วไป/สั้นเกินไป (เช่น "คลัง", "เงินสด") ไม่จำ · conflict = ข้อความนี้เป็นชื่อ/alias ของสถานที่อื่น ในขอบเขตเดียวกัน ไม่จำ · not_permitted = สถานที่ของบริษัท (มีผลกับทุกลูกค้า) ต้องมีสิทธิ์ `master:write` จึงจำ |   |

### OrderPageDto {#schema-OrderPageDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<OrderDto>` |   |   |   |
| `nextCursor` | ใช่ | `string` | null ได้ |   |   |
| `hasMore` | ใช่ | `boolean` |   |   |   |

### OrderSummaryDto {#schema-OrderSummaryDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `total` | ใช่ | `number` |   | ทุกใบ (รวมร่าง) |   |
| `draft` | ใช่ | `number` |   | ร่าง (ยังไม่ออกเลข SO) |   |
| `onHold` | ใช่ | `number` |   | ค้าง (ON_HOLD) ทุกเหตุ |   |
| `locationUnmapped` | ใช่ | `number` |   | ค้างเพราะจับคู่สถานที่ไม่ได้ (LOCATION_UNMAPPED) — "รอกำหนดเส้นทาง" |   |
| `customerUnmapped` | ใช่ | `number` |   | ค้างเพราะจับคู่ลูกค้าไม่ได้ (CUSTOMER_UNMAPPED) |   |
| `overdue` | ใช่ | `number` |   | เกินกำหนด: ยังไม่ออกรถ (RECEIVED/ON_HOLD/PLANNED) และวันรับของก่อนวันนี้ (เวลาไทย) |   |
| `planned` | ใช่ | `number` |   | วางแผนแล้ว (PLANNED) ทั้งหมด |   |
| `plannedToday` | ใช่ | `number` |   | วางแผนแล้ว (PLANNED) ที่วันรับของ = วันนี้ (เวลาไทย) |   |
| `heldTotal` | ใช่ | `number` |   | หน้าใบค้าง: ใบค้างทั้งหมด = ON_HOLD + ใบที่ต้นทางแก้หลังวางแผนรอตัดสิน (สถานะ PLANNED — เงื่อนไขเดียวกับ `held=true`) |   |
| `holdReasons` | ใช่ | `array<OrderHoldCountDto>` |   | หน้าใบค้าง: จำนวนใบค้างต่อเหตุ ครบ 12 รหัสของ C (ไม่มี = 0) — นับเหตุหลักหรือเหตุรอง (เงื่อนไขเดียวกับตัวกรอง `held=true&holdReason=`) ใบหนึ่งจึงอาจนับในหลายเหตุ · SOURCE_CHANGED_AFTER_PLAN = ใบที่ต้นทางแก้หลังวางแผน (สถานะยัง PLANNED) |   |
| `today` | ใช่ | `string` |   | วันนี้ตามเวลาไทยที่ใช้นับ `waiting*` | `2026-11-18` |
| `waiting` | ใช่ | `number` |   | รอจัดรถ = ยังไม่อยู่ในเที่ยว (รับแล้ว + ค้าง) และวันรับของ ≤ วันนี้ + 1 — เงื่อนไขเดียวกับ `status=received,on_hold&requestedTo={today+1}` |   |
| `waitingOverdue` | ใช่ | `number` |   | รอจัดรถที่เลยกำหนดรับ = `status=received,on_hold&requestedTo={today−1}` |   |

### OrderTrackingDto {#schema-OrderTrackingDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `orderId` | ใช่ | `string` |   |   | `ord_3f2a…` |
| `soNo` | ใช่ | `string` | null ได้ |   | `SO-6911-0001` |
| `orderStatus` | ใช่ | `string` |   | สถานะใบสั่งขนส่ง | `IN_TRANSIT` |
| `deliveryOrders` | ใช่ | `array<OrderTrackingShipmentDto>` |   | ทุก DO ของ order (รวมที่ยกเลิก) ตามลำดับที่สร้าง — ขั้น/ETA/รายการใช้กติกาเดียวกับหน้าติดตามสาธารณะ แต่ไม่หมดอายุตาม `tracking.linkDays` และไม่มีรูป POD (ดู `GET /v1/orders/{id}/documents`) |   |

### RevenueLineDto {#schema-RevenueLineDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `rvl_…` |
| `lineNo` | ใช่ | `number` |   | ลำดับบรรทัดในใบสั่ง (ไม่ใช้ซ้ำ) |   |
| `sourceType` | ใช่ | `string` | ค่า: `SO_CHARGE`, `DO_SURCHARGE`, `MANUAL` | SO_CHARGE = ราคาของใบสั่ง (rate card / ราคาที่กำหนดเอง) แบ่งลงใบส่งของตามปริมาณ (`deliveryOrderId` — ว่าง = ใบสั่งยังไม่มีใบส่งของ) · DO_SURCHARGE = ค่าใช้จ่ายหน้างานที่ยืนยันแล้ว · MANUAL = คนเพิ่มเอง |   |
| `sourceId` | ใช่ | `string` | null ได้ | แหล่งของบรรทัด: `och_…` (บรรทัดราคาของใบสั่ง) · `dsc_…` (ค่าใช้จ่ายหน้างาน) · MANUAL = null | `dsc_…` |
| `isUserAdded` | ใช่ | `boolean` |   | true = คนเพิ่มเอง (คงไว้เมื่อระบบคิดบรรทัดใหม่) |   |
| `kind` | ใช่ | `string` | ค่า: `FREIGHT`, `EXTRA_STOP`, `ACCESSORIAL` |   |   |
| `deliveryOrderId` | ใช่ | `string` | null ได้ |   | `do_…` |
| `doNo` | ใช่ | `string` | null ได้ |   | `DO-2611-00001` |
| `serviceItemId` | ใช่ | `string` |   |   | `svc_…` |
| `serviceItemCode` | ใช่ | `string` |   | รหัสรายการ ณ เวลาคิด (snapshot) | `FREIGHT` |
| `description` | ใช่ | `string` |   |   | `ค่าขนส่ง` |
| `qty` | ใช่ | `string` |   | จำนวน (snapshot) | `25` |
| `sellUnitPrice` |   | `string` |   | ราคาขายต่อหน่วยก่อน VAT — เห็นเมื่อมี `prices.sell:read` | `350.00` |
| `sellAmount` |   | `string` |   | ยอดขายของบรรทัดก่อน VAT — เห็นเมื่อมี `prices.sell:read` | `8750.00` |
| `vatType` | ใช่ | `string` | ค่า: `VAT_7`, `EXEMPT_TRANSPORT`, `ZERO_RATED` | ชนิด VAT ของบรรทัด (snapshot — ไม่คำนวณภาษีที่นี่) |   |
| `whtRate` | ใช่ | `string` |   | หัก ณ ที่จ่าย % (snapshot) | `1.00` |
| `status` | ใช่ | `string` | ค่า: `ACTIVE`, `VOIDED` |   |   |
| `locked` | ใช่ | `boolean` |   | true = อยู่ในเอกสารที่ออกเลขแล้ว — แก้/ยกเลิก/คิดใหม่ไม่ได้ |   |
| `lockedAt` | ใช่ | `string (date-time)` | null ได้ |   |   |
| `provisional` | ใช่ | `boolean` |   | true = ยอดยังไม่ยืนยัน: ใบสั่งยังไม่มีใบส่งของ (บรรทัดระดับใบสั่ง) หรือใบส่งของยังไม่บันทึกยอดส่งจริง (ลูกค้าวางบิลตามยอดส่งจริง — ตอนนี้คิดตามแผน) — ระบบคิดใหม่เมื่อบันทึก |   |
| `voidedAt` | ใช่ | `string (date-time)` | null ได้ |   |   |
| `voidReason` | ใช่ | `string` | null ได้ |   |   |
| `createdBy` | ใช่ | `string` | null ได้ |   |   |
| `createdAt` | ใช่ | `string (date-time)` |   |   |   |
| `version` | ใช่ | `number` |   |   |   |

### RevenueLineListDto {#schema-RevenueLineListDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<RevenueLineDto>` |   |   |   |
