# แม่แบบใบสั่ง (order-templates)

5 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`GET /v1/order-templates`](#get-order-templates) | `orders:read` |
| [`POST /v1/order-templates`](#post-order-templates) | `orders:write` |
| [`GET /v1/order-templates/{id}`](#get-order-templates-id) | `orders:read` |
| [`PATCH /v1/order-templates/{id}`](#patch-order-templates-id) | `orders:write` |
| [`POST /v1/order-templates/{id}/delete`](#post-order-templates-id-delete) | `orders:write` |

## GET /v1/order-templates {#get-order-templates}

`GET /v1/order-templates`

scope: `orders:read` · operationId: `OrderTemplates_list`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน |
| `updatedAfter` | query |   | `string` | คืนเฉพาะแถวที่ updatedAt > ค่านี้ (incremental pull) |
| `sort` | query |   | `string` ค่า: `updatedAt`, `-updatedAt` |   |
| `fields` | query |   | `string` | รายชื่อ field คั่นด้วย, เช่น id,legalName |
| `q` | query |   | `string` | ค้นชื่อเทมเพลต (ไม่สนตัวพิมพ์) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `OrderTemplatePageDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`orders:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/order-templates" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/order-templates');
```

## บันทึกเทมเพลต {#post-order-templates}

`POST /v1/order-templates`

scope: `orders:write` · operationId: `OrderTemplates_create`

payload ตรวจด้วยกฎเดียวกับ POST /v1/orders (422 `payload.…`) · ชื่อซ้ำ (ไม่สนตัวพิมพ์) → 409 `duplicate`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `Idempotency-Key` | header |   | `string` |   |

**Request body** `CreateOrderTemplateDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `name` | ใช่ | `string` | ยาว ≤ 100 |   | `ส่งน้ำดื่ม บางปู → แหลมฉบัง ทุกจันทร์` |
| `payload` | ใช่ | `OrderTemplatePayloadDto` |   | ข้อมูลใบสั่งขนส่ง (รูปเดียวกับ body ของ POST /v1/orders) — `requestedDate` + ช่วงเวลาของจุด = วันอ้างอิง (ตอนสร้างใบ ผู้เรียกเลื่อนเป็นวันที่ต้องการโดยคงเวลาเดิม) |   |
| `payload.customer` |   | `OrderCustomerInputDto` |   |   |   |
| `payload.customer.id` |   | `string` | null ได้ | ลูกค้าใน master | `cus_3f2a…` |
| `payload.customer.externalId` |   | `string` | null ได้ | รหัสลูกค้าตามระบบต้นทาง — จับคู่กับ customer.externalId (ไม่พบ = ใบค้าง CUSTOMER_UNMAPPED) | `C-001` |
| `payload.customer.name` |   | `string` | null ได้ | ชื่อ/ข้อความลูกค้าตามต้นทาง |   |
| `payload.billingCompanyId` |   | `string` | null ได้ | นิติบุคคลที่ออกบิล (`cmp_…` จาก `GET /v1/companies`) — ไม่ส่ง = "ออกบิลในนาม" ของลูกค้า → ค่าตั้งต้นของบริษัท → นิติบุคคลเดียวที่ใช้งานอยู่; บริษัทมีหลายนิติบุคคลและไม่ได้ตั้งค่าใดเลย = 422 `routing_not_configured` (errors[].field = `billingCompanyId`) · ใบเดิมไม่ส่ง = คงของเดิม | `cmp_3f2a…` |
| `payload.customerRef` |   | `string` | ยาว ≤ 50 · null ได้ | เลข / อ้างอิงของลูกค้า |   |
| `payload.requestedDate` | ใช่ | `string` |   | วันรับของ YYYY-MM-DD (ใช้หา rate) | `2026-11-12` |
| `payload.vehicleTypeId` |   | `string` | null ได้ |   | `vty_3f2a…` |
| `payload.stops` | ใช่ | `array<OrderStopInputDto>` |   | 1–50 จุด เรียงตามลำดับวิ่ง |   |
| `payload.stops[].type` | ใช่ | `string` | ค่า: `PICKUP`, `DELIVERY`, `RETURN` |   |   |
| `payload.stops[].siteId` |   | `string` | null ได้ | สถานที่ใน master — ไม่ส่ง = ใช้ `siteText` (ใบค้าง LOCATION_UNMAPPED) | `loc_3f2a…` |
| `payload.stops[].siteText` |   | `string` | ยาว ≤ 500 · null ได้ | ข้อความสถานที่ตามต้นทาง (บังคับเมื่อไม่มี siteId) |   |
| `payload.stops[].windowStart` |   | `string` | null ได้ | ISO 8601 พร้อม timezone | `2026-11-12T07:00:00+07:00` |
| `payload.stops[].windowEnd` |   | `string` | null ได้ | ISO 8601 พร้อม timezone (≥ windowStart) |   |
| `payload.lines` |   | `array<OrderLineInputDto>` |   | ≤ 200 บรรทัด |   |
| `payload.lines[].description` | ใช่ | `string` | ยาว ≤ 500 |   |   |
| `payload.lines[].qty` | ใช่ | `string` |   | > 0 ทศนิยม ≤ 3 (สตริง) | `12.5` |
| `payload.lines[].unitId` |   | `string` | null ได้ | หน่วยใน master | `unt_3f2a…` |
| `payload.lines[].unit` |   | `string` | null ได้ | ข้อความหน่วย (บังคับเมื่อไม่มี unitId) |   |
| `payload.lines[].productId` |   | `string` | null ได้ |   | `prd_3f2a…` |
| `payload.lines[].itemCode` |   | `string` | null ได้ | รหัสสินค้าตามต้นทาง |   |
| `payload.lines[].weightKg` |   | `string` | null ได้ |   | `12500` |
| `payload.lines[].cbm` |   | `string` | null ได้ |   |   |
| `payload.lines[].isDangerous` |   | `boolean` |   |   |   |
| `payload.lines[].tempMin` |   | `string` | null ได้ |   | `2.0` |
| `payload.lines[].tempMax` |   | `string` | null ได้ |   | `8.0` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `201` |   | `OrderTemplateDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`orders:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/order-templates" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"name":"ส่งน้ำดื่ม บางปู → แหลมฉบัง ทุกจันทร์","payload":{"requestedDate":"2026-11-12","stops":[{"type":"PICKUP"}]}}'
```

```ts
const { data, error } = await tms.POST('/v1/order-templates', {
  body: {
    "name": "ส่งน้ำดื่ม บางปู → แหลมฉบัง ทุกจันทร์",
    "payload": {
      "requestedDate": "2026-11-12",
      "stops": [
        {
          "type": "PICKUP"
        }
      ]
    }
  },
});
```

## GET /v1/order-templates/{id} {#get-order-templates-id}

`GET /v1/order-templates/{id}`

scope: `orders:read` · operationId: `OrderTemplates_get`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `OrderTemplateDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`orders:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/order-templates/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/order-templates/{id}', {
  params: { path: { id: "…" } },
});
```

## PATCH /v1/order-templates/{id} {#patch-order-templates-id}

`PATCH /v1/order-templates/{id}`

scope: `orders:write` · operationId: `OrderTemplates_update`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `UpdateOrderTemplateDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `name` |   | `string` | ยาว ≤ 100 |   |   |
| `payload` |   | `OrderTemplatePayloadDto` |   | แทนทั้งก้อน |   |
| `payload.customer` |   | `OrderCustomerInputDto` |   |   |   |
| `payload.customer.id` |   | `string` | null ได้ | ลูกค้าใน master | `cus_3f2a…` |
| `payload.customer.externalId` |   | `string` | null ได้ | รหัสลูกค้าตามระบบต้นทาง — จับคู่กับ customer.externalId (ไม่พบ = ใบค้าง CUSTOMER_UNMAPPED) | `C-001` |
| `payload.customer.name` |   | `string` | null ได้ | ชื่อ/ข้อความลูกค้าตามต้นทาง |   |
| `payload.billingCompanyId` |   | `string` | null ได้ | นิติบุคคลที่ออกบิล (`cmp_…` จาก `GET /v1/companies`) — ไม่ส่ง = "ออกบิลในนาม" ของลูกค้า → ค่าตั้งต้นของบริษัท → นิติบุคคลเดียวที่ใช้งานอยู่; บริษัทมีหลายนิติบุคคลและไม่ได้ตั้งค่าใดเลย = 422 `routing_not_configured` (errors[].field = `billingCompanyId`) · ใบเดิมไม่ส่ง = คงของเดิม | `cmp_3f2a…` |
| `payload.customerRef` |   | `string` | ยาว ≤ 50 · null ได้ | เลข / อ้างอิงของลูกค้า |   |
| `payload.requestedDate` | ใช่ | `string` |   | วันรับของ YYYY-MM-DD (ใช้หา rate) | `2026-11-12` |
| `payload.vehicleTypeId` |   | `string` | null ได้ |   | `vty_3f2a…` |
| `payload.stops` | ใช่ | `array<OrderStopInputDto>` |   | 1–50 จุด เรียงตามลำดับวิ่ง |   |
| `payload.stops[].type` | ใช่ | `string` | ค่า: `PICKUP`, `DELIVERY`, `RETURN` |   |   |
| `payload.stops[].siteId` |   | `string` | null ได้ | สถานที่ใน master — ไม่ส่ง = ใช้ `siteText` (ใบค้าง LOCATION_UNMAPPED) | `loc_3f2a…` |
| `payload.stops[].siteText` |   | `string` | ยาว ≤ 500 · null ได้ | ข้อความสถานที่ตามต้นทาง (บังคับเมื่อไม่มี siteId) |   |
| `payload.stops[].windowStart` |   | `string` | null ได้ | ISO 8601 พร้อม timezone | `2026-11-12T07:00:00+07:00` |
| `payload.stops[].windowEnd` |   | `string` | null ได้ | ISO 8601 พร้อม timezone (≥ windowStart) |   |
| `payload.lines` |   | `array<OrderLineInputDto>` |   | ≤ 200 บรรทัด |   |
| `payload.lines[].description` | ใช่ | `string` | ยาว ≤ 500 |   |   |
| `payload.lines[].qty` | ใช่ | `string` |   | > 0 ทศนิยม ≤ 3 (สตริง) | `12.5` |
| `payload.lines[].unitId` |   | `string` | null ได้ | หน่วยใน master | `unt_3f2a…` |
| `payload.lines[].unit` |   | `string` | null ได้ | ข้อความหน่วย (บังคับเมื่อไม่มี unitId) |   |
| `payload.lines[].productId` |   | `string` | null ได้ |   | `prd_3f2a…` |
| `payload.lines[].itemCode` |   | `string` | null ได้ | รหัสสินค้าตามต้นทาง |   |
| `payload.lines[].weightKg` |   | `string` | null ได้ |   | `12500` |
| `payload.lines[].cbm` |   | `string` | null ได้ |   |   |
| `payload.lines[].isDangerous` |   | `boolean` |   |   |   |
| `payload.lines[].tempMin` |   | `string` | null ได้ |   | `2.0` |
| `payload.lines[].tempMax` |   | `string` | null ได้ |   | `8.0` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `OrderTemplateDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`orders:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PATCH "$TMS_BASE_URL/v1/order-templates/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

```ts
const { data, error } = await tms.PATCH('/v1/order-templates/{id}', {
  params: { path: { id: "…" } },
  body: {},
});
```

## POST /v1/order-templates/{id}/delete {#post-order-templates-id-delete}

`POST /v1/order-templates/{id}/delete`

scope: `orders:write` · operationId: `OrderTemplates_remove`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `MasterReasonDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `เลิกใช้บริการตั้งแต่ ธ.ค. 2569` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `204` |   |   |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`orders:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/order-templates/<id>/delete" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"เลิกใช้บริการตั้งแต่ ธ.ค. 2569"}'
```

```ts
const { data, error } = await tms.POST('/v1/order-templates/{id}/delete', {
  params: { path: { id: "…" } },
  body: {
    "reason": "เลิกใช้บริการตั้งแต่ ธ.ค. 2569"
  },
});
```

## Schema ของ response {#schemas}

### OrderTemplateDto {#schema-OrderTemplateDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `otp_3f2a…` |
| `name` | ใช่ | `string` |   |   |   |
| `payload` | ใช่ | `OrderTemplatePayloadDto` |   |   |   |
| `customer` | ใช่ | `OrderTemplateCustomerDto` | null ได้ | ลูกค้าตาม payload.customer.id (ไม่พบ/ถูกลบ = null) — ใช้แสดงในรายการ |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string` |   |   |   |
| `updatedAt` | ใช่ | `string` |   |   |   |

### OrderTemplatePageDto {#schema-OrderTemplatePageDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<OrderTemplateDto>` |   |   |   |
| `nextCursor` | ใช่ | `string` | null ได้ |   |   |
| `hasMore` | ใช่ | `boolean` |   |   |   |
