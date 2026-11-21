# จ่ายรถร่วม (settlements)

16 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`GET /v1/settlements/queue`](#get-settlements-queue) | `settlements:read` |
| [`GET /v1/settlements`](#get-settlements) | `settlements:read` |
| [`POST /v1/settlements`](#post-settlements) | `settlements:create` |
| [`GET /v1/settlements/{id}`](#get-settlements-id) | `settlements:read` |
| [`PATCH /v1/settlements/{id}`](#patch-settlements-id) | `settlements:create` |
| [`GET /v1/settlements/{id}/pdf`](#get-settlements-id-pdf) | `settlements:read` |
| [`GET /v1/settlements/{id}/comparison`](#get-settlements-id-comparison) | `settlements:read` |
| [`POST /v1/settlements/{id}/lines`](#post-settlements-id-lines) | `settlements:create` |
| [`POST /v1/settlements/{id}/lines/{lineId}/remove`](#post-settlements-id-lines-lineId-remove) | `settlements:create` |
| [`POST /v1/settlements/{id}/cancel`](#post-settlements-id-cancel) | `settlements:create` |
| [`POST /v1/settlements/{id}/send-to-carrier`](#post-settlements-id-send-to-carrier) | `settlements:create` |
| [`POST /v1/settlements/{id}/review-link`](#post-settlements-id-review-link) | `settlements:create` |
| [`POST /v1/settlements/{id}/recall`](#post-settlements-id-recall) | `settlements:create` |
| [`POST /v1/settlements/{id}/lines/{lineId}/dispute`](#post-settlements-id-lines-lineId-dispute) | `settlements:create` |
| [`POST /v1/settlements/{id}/lines/{lineId}/resolve`](#post-settlements-id-lines-lineId-resolve) | `settlements:create` |
| [`POST /v1/settlements/{id}/mark-paid`](#post-settlements-id-mark-paid) | `settlements:pay` |

## คิวจ่ายรถร่วม (เที่ยวที่ปิดต้นทุนแล้วและยังไม่อยู่ในใบสำคัญจ่าย) {#get-settlements-queue}

`GET /v1/settlements/queue`

scope: `settlements:read` · operationId: `Settlements_list`

เที่ยว **COSTED** ของรถร่วมที่ยังมีบรรทัดต้นทุนรอจ่าย (ค่าจ้าง CARRIER_FEE + ค่าใช้จ่ายหน้างานฝั่งซื้อที่ยืนยันแล้ว ของรถร่วมรายปัจจุบัน ที่ยังไม่อยู่ในใบสำคัญจ่าย) · รถร่วมที่ตั้ง "ไม่มี POD ไม่จ่าย" (`requirePodToPay`) → เที่ยวที่หลักฐานส่งยังไม่ครบไม่ขึ้นคิว · กรองรถร่วม (`carrierId` รับ `ext:`) / ช่วงวันที่เที่ยวจบ (เวลาไทย) / หลักฐานครบ · `carriers` = ยอดรวมต่อรถร่วมของทุกแถวที่ตรงตัวกรอง · ยอดเงิน (`buy*`) เห็นเมื่อมี `prices.buy:read` · ปิดต้นทุนเที่ยว (COMPLETED → COSTED) ปิดใช้ได้ด้วย kill switch (`POST /trips/{id}/cost` → 409 `trip_costing_unavailable`) — ระหว่างนั้นคิวว่าง

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน |
| `updatedAfter` | query |   | `string` | คืนเฉพาะแถวที่ updatedAt > ค่านี้ (incremental pull) |
| `sort` | query |   | `string` ค่า: `updatedAt`, `-updatedAt` |   |
| `fields` | query |   | `string` | รายชื่อ field คั่นด้วย, เช่น id,legalName |
| `carrierId` | query |   | `string` | รถร่วม — id หรือ `ext:{externalId}` (ไม่พบ = รายการว่าง) |
| `dateFrom` | query |   | `string` | วันที่เที่ยวจบตั้งแต่ (YYYY-MM-DD ตามเวลาไทย — `completedAt`) |
| `dateTo` | query |   | `string` | วันที่เที่ยวจบถึง (YYYY-MM-DD ตามเวลาไทย — รวมทั้งวัน) |
| `podComplete` | query |   | `string` ค่า: `true`, `false` | กรองตามหลักฐานส่ง (POD) ของเที่ยว: true = ครบ · false = ยังไม่ครบ (มีได้เฉพาะรถร่วมที่ปิด "ไม่มี POD ไม่จ่าย") |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `SettlementQueuePageDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settlements:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/settlements/queue" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/settlements/queue');
```

## รายการใบสำคัญจ่ายรถร่วม {#get-settlements}

`GET /v1/settlements`

scope: `settlements:read` · operationId: `Settlements_listSettlements`

กรองรถร่วม (`carrierId` รับ `ext:` — ไม่พบ = รายการว่าง) / สถานะ · cursor มาตรฐาน (updatedAt, id) · ยอด `buy*` เห็นเมื่อมี `prices.buy:read`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน |
| `updatedAfter` | query |   | `string` | คืนเฉพาะแถวที่ updatedAt > ค่านี้ (incremental pull) |
| `sort` | query |   | `string` ค่า: `updatedAt`, `-updatedAt` |   |
| `fields` | query |   | `string` | รายชื่อ field คั่นด้วย, เช่น id,legalName |
| `carrierId` | query |   | `string` | รถร่วม — id หรือ `ext:{externalId}` |
| `status` | query |   | `string` ค่า: `DRAFT`, `SENT_TO_CARRIER`, `DISPUTED`, `APPROVED`, `PAID`, `CANCELLED` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `SettlementPageDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settlements:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/settlements" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/settlements');
```

## ติ๊กเที่ยว → สร้างร่างใบสำคัญจ่าย (DRAFT — ยังไม่มีเลขเอกสาร) {#post-settlements}

`POST /v1/settlements`

scope: `settlements:create` · operationId: `Settlements_create`

รถร่วม 1 ราย หลายเที่ยว: `tripIds` (ทุกบรรทัดที่รอจ่ายของเที่ยว) และ/หรือ `tripCostIds` (รายบรรทัด) — ต้องอยู่ในคิวจ่าย (`GET /settlements/queue`) ของรถร่วมรายนี้ มิฉะนั้น 409 `trip_cost_not_payable` · บรรทัดที่อยู่ในใบอื่นที่ยังใช้แล้ว → **409 `trip_cost_already_settled`** (กันจ่ายซ้ำ — unique ระดับ DB) · บรรทัดหัก (`deductions`) กรอกมือ ยอดติดลบ + เอกสารอ้างอิง · ยอดสุทธิ `buyNetPayable` = ยอดรวม − รายการหัก (ก่อนหัก ณ ที่จ่าย) · หัก ณ ที่จ่าย**ประมาณการ** `buyWhtAmount` = ยอดก่อนหัก × อัตราของบรรทัด (`whtRate` ที่คัดลอกจากต้นทุน — ไม่มีธงใช้ค่าตั้งต้นของรถร่วม) ปัดครั้งเดียวต่อกลุ่มอัตรา + ขั้นต่ำ `tax.whtMinimumAmount` · `buyNetAfterWht` = ยอดจ่ายหลังหัก · `whtEstimate` แยกอัตรา + แบบ ภ.ง.ด.3/53 (ร่าง — ยังไม่ผ่านนักบัญชี) · งวดไม่ส่ง = ช่วงวันที่เที่ยวจบ (เวลาไทย) · audit `settlement.created`

**Request body** `CreateSettlementDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `tripIds` |   | `array<string>` |   | ติ๊กเที่ยว → ทุกบรรทัดต้นทุนที่รอจ่ายของเที่ยว (กฎเดียวกับคิวจ่าย `GET /settlements/queue`) | `["trp_…"]` |
| `tripCostIds` |   | `array<string>` |   | บรรทัดต้นทุน (`trip_cost`) รายบรรทัด — ต้องเป็นบรรทัดที่รอจ่ายในคิว | `["tco_…"]` |
| `deductions` |   | `array<SettlementDeductionInput>` |   |   |   |
| `deductions[].deductionType` | ใช่ | `string` | ค่า: `CASH_ADVANCE`, `FUEL_PROVIDED`, `FINE`, `DAMAGE` | ชนิดรายการหัก |   |
| `deductions[].description` | ใช่ | `string` | ยาว ≤ 500 |   | `เงินเบิกล่วงหน้าค่าน้ำมัน 12 พ.ย.` |
| `deductions[].amount` | ใช่ | `string` |   | ยอดหัก **ติดลบ** (บาท ทศนิยม ≤ 2) — ไม่ใช่ราคาซื้อ (ไม่ต้องมี `prices.buy:write`) · ผู้มี `settlements:create` กรอกได้ | `2000.00` |
| `deductions[].reference` | ใช่ | `string` | ยาว ≤ 200 | เอกสารอ้างอิง (เลขใบเบิก / ใบสั่งปรับ / ใบเสร็จน้ำมัน / รายงานความเสียหาย) — บังคับ | `ADV-2611-0007` |
| `deductions[].tripId` |   | `string` |   | ผูกกับเที่ยว (ไม่บังคับ) | `trp_…` |
| `periodFrom` |   | `string` |   | งวดตั้งแต่ (YYYY-MM-DD) | `2026-11-01` |
| `periodTo` |   | `string` |   | งวดถึง (YYYY-MM-DD) | `2026-11-15` |
| `carrierInvoiceNo` |   | `string` | ยาว ≤ 60 · null ได้ | เลขใบแจ้งหนี้ที่รถร่วมวางมา (ใช้กระทบยอด) |   |
| `carrierInvoiceDate` |   | `string` | null ได้ |   | `2026-11-16` |
| `carrierReceiptNo` |   | `string` | ยาว ≤ 60 · null ได้ | เลขใบเสร็จของรถร่วม |   |
| `note` |   | `string` | ยาว ≤ 1000 · null ได้ |   |   |
| `carrierId` | ใช่ | `string` |   | รถร่วม — id หรือ `ext:{externalId}` | `car_…` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `201` |   | `SettlementDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settlements:create`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress), [trip_cost_already_settled](errors.md#trip_cost_already_settled), [trip_cost_not_payable](errors.md#trip_cost_not_payable) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/settlements" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"tripIds":["trp_…"],"tripCostIds":["tco_…"],"periodFrom":"2026-11-01","periodTo":"2026-11-15","carrierId":"car_…"}'
```

```ts
const { data, error } = await tms.POST('/v1/settlements', {
  body: {
    "tripIds": [
      "trp_…"
    ],
    "tripCostIds": [
      "tco_…"
    ],
    "periodFrom": "2026-11-01",
    "periodTo": "2026-11-15",
    "carrierId": "car_…"
  },
});
```

## ใบสำคัญจ่ายรถร่วม + บรรทัด (รวมบรรทัดที่นำออกแล้ว) {#get-settlements-id}

`GET /v1/settlements/{id}`

scope: `settlements:read` · operationId: `Settlements_get`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `SettlementDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settlements:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบสำคัญจ่าย (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/settlements/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/settlements/{id}', {
  params: { path: { id: "…" } },
});
```

## แก้หัวใบร่าง — งวด เลขใบแจ้งหนี้/วันที่/เลขใบเสร็จของรถร่วม หมายเหตุ {#patch-settlements-id}

`PATCH /v1/settlements/{id}`

scope: `settlements:create` · operationId: `Settlements_update`

เฉพาะ DRAFT (อื่น ๆ → 409) · audit `settlement.updated` (เฉพาะช่องที่เปลี่ยน)

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag (version) — ไม่ตรง → 412 |

**Request body** `UpdateSettlementDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `periodFrom` |   | `string` |   |   | `2026-11-01` |
| `periodTo` |   | `string` |   |   | `2026-11-15` |
| `carrierInvoiceNo` |   | `string` | ยาว ≤ 60 · null ได้ |   |   |
| `carrierInvoiceDate` |   | `string` | null ได้ |   | `2026-11-16` |
| `carrierReceiptNo` |   | `string` | ยาว ≤ 60 · null ได้ |   |   |
| `note` |   | `string` | ยาว ≤ 1000 · null ได้ |   |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `SettlementDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settlements:create`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบสำคัญจ่าย (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PATCH "$TMS_BASE_URL/v1/settlements/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"periodFrom":"2026-11-01","periodTo":"2026-11-15"}'
```

```ts
const { data, error } = await tms.PATCH('/v1/settlements/{id}', {
  params: { path: { id: "…" } },
  body: {
    "periodFrom": "2026-11-01",
    "periodTo": "2026-11-15"
  },
});
```

## PDF ใบสำคัญจ่ายรถร่วม — รายการเที่ยว ยอด หัก ณ ที่จ่าย (ประมาณการ) สุทธิ {#get-settlements-id-pdf}

`GET /v1/settlements/{id}/pdf`

scope: `settlements:read` · operationId: `Settlements_voucherPdf`

แม่แบบตามต้นแบบ TMS Print #pv (แม่แบบการเงินร่วมกับใบแจ้งหนี้) · ทุกตัวเลขมาจาก `GET /v1/settlements/{id}` ชุดเดียวกัน: ยอดซื้อรวม = `buyGrossAmount` · หัก ณ ที่จ่ายแยกอัตรา = `whtEstimate.byRate` (รวม = `buyWhtAmount`; ใบที่อนุมัติแล้ว = ยอดที่ตรึง) · บรรทัดหักรวมต่อชนิด · จ่ายสุทธิ = `buyNetAfterWht` · ยอดหัก ณ ที่จ่ายติด * · ยังไม่อนุมัติ = ลายน้ำ "ร่าง" ไม่มีเลข · จ่ายแล้ว = วันที่จ่าย + วิธีจ่าย + เลขอ้างอิง · render ตามคำขอ (ไม่ใช่เอกสารภาษี — ไม่เก็บไฟล์) · ใบที่ยกเลิก → 409 · ต้องมี `prices.buy:read` ไม่งั้น 403

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | application/pdf | `string (binary)` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settlements:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบสำคัญจ่าย (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/settlements/<id>/pdf" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/settlements/{id}/pdf', {
  params: { path: { id: "…" } },
});
```

## หน้าเทียบ planned vs executed vs claimed + POD {#get-settlements-id-comparison}

`GET /v1/settlements/{id}/comparison`

scope: `settlements:read` · operationId: `Settlements_compare`

"Dispute — หน้าเอกสารคู่ยอด" · ต่อบรรทัดที่ยังใช้: ยอดตามแผน (ราคาที่ตกลงตอนจ้างรถร่วม) / ยอดในใบ / ยอดที่รถร่วมเรียก + ส่วนต่าง + สถานะรายการ (OPEN/DISPUTED/APPROVED) + คำตอบของรถร่วม + การตัดสินของบริษัท · ต่อเที่ยว: POD ล่าสุดต่อ DO (ผ่านเกณฑ์จ่ายไหม, ปริมาณตามแผน/ส่งจริง/ปฏิเสธ, เอกสาร) · ยอด `buy*` เห็นเมื่อมี `prices.buy:read`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `SettlementComparisonDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settlements:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบสำคัญจ่าย (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/settlements/<id>/comparison" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/settlements/{id}/comparison', {
  params: { path: { id: "…" } },
});
```

## เพิ่มเที่ยว/บรรทัดต้นทุน/บรรทัดหักเข้าใบร่าง {#post-settlements-id-lines}

`POST /v1/settlements/{id}/lines`

scope: `settlements:create` · operationId: `Settlements_addLines`

กฎเดียวกับตอนสร้าง (409 `trip_cost_already_settled` / `trip_cost_not_payable`) · เฉพาะ DRAFT · audit `settlement.lines_added`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag (version) — ไม่ตรง → 412 |

**Request body** `SettlementItemsInput`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `tripIds` |   | `array<string>` |   | ติ๊กเที่ยว → ทุกบรรทัดต้นทุนที่รอจ่ายของเที่ยว (กฎเดียวกับคิวจ่าย `GET /settlements/queue`) | `["trp_…"]` |
| `tripCostIds` |   | `array<string>` |   | บรรทัดต้นทุน (`trip_cost`) รายบรรทัด — ต้องเป็นบรรทัดที่รอจ่ายในคิว | `["tco_…"]` |
| `deductions` |   | `array<SettlementDeductionInput>` |   |   |   |
| `deductions[].deductionType` | ใช่ | `string` | ค่า: `CASH_ADVANCE`, `FUEL_PROVIDED`, `FINE`, `DAMAGE` | ชนิดรายการหัก |   |
| `deductions[].description` | ใช่ | `string` | ยาว ≤ 500 |   | `เงินเบิกล่วงหน้าค่าน้ำมัน 12 พ.ย.` |
| `deductions[].amount` | ใช่ | `string` |   | ยอดหัก **ติดลบ** (บาท ทศนิยม ≤ 2) — ไม่ใช่ราคาซื้อ (ไม่ต้องมี `prices.buy:write`) · ผู้มี `settlements:create` กรอกได้ | `2000.00` |
| `deductions[].reference` | ใช่ | `string` | ยาว ≤ 200 | เอกสารอ้างอิง (เลขใบเบิก / ใบสั่งปรับ / ใบเสร็จน้ำมัน / รายงานความเสียหาย) — บังคับ | `ADV-2611-0007` |
| `deductions[].tripId` |   | `string` |   | ผูกกับเที่ยว (ไม่บังคับ) | `trp_…` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `SettlementDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settlements:create`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบสำคัญจ่าย (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress), [trip_cost_already_settled](errors.md#trip_cost_already_settled), [trip_cost_not_payable](errors.md#trip_cost_not_payable) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/settlements/<id>/lines" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"tripIds":["trp_…"],"tripCostIds":["tco_…"]}'
```

```ts
const { data, error } = await tms.POST('/v1/settlements/{id}/lines', {
  params: { path: { id: "…" } },
  body: {
    "tripIds": [
      "trp_…"
    ],
    "tripCostIds": [
      "tco_…"
    ]
  },
});
```

## นำบรรทัดออกจากใบร่าง — เหตุผล ≥ 10 ตัวอักษร {#post-settlements-id-lines-lineId-remove}

`POST /v1/settlements/{id}/lines/{lineId}/remove`

scope: `settlements:create` · operationId: `Settlements_removeLine`

บรรทัดคงอยู่ (`active` false + เหตุผล — ไม่มีการลบ) · บรรทัดต้นทุนกลับเข้าคิวจ่าย · เฉพาะ DRAFT · audit `settlement.line_removed`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `lineId` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag (version) — ไม่ตรง → 412 |

**Request body** `SettlementReasonDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `รถร่วมขอแยกวางบิลเที่ยวนี้งวดหน้า` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `SettlementDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settlements:create`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบสำคัญจ่าย (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/settlements/<id>/lines/<lineId>/remove" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"รถร่วมขอแยกวางบิลเที่ยวนี้งวดหน้า"}'
```

```ts
const { data, error } = await tms.POST('/v1/settlements/{id}/lines/{lineId}/remove', {
  params: { path: { id: "…", lineId: "…" } },
  body: {
    "reason": "รถร่วมขอแยกวางบิลเที่ยวนี้งวดหน้า"
  },
});
```

## ยกเลิกใบร่าง — เหตุผล ≥ 10 ตัวอักษร {#post-settlements-id-cancel}

`POST /v1/settlements/{id}/cancel`

scope: `settlements:create` · operationId: `Settlements_cancel`

DRAFT → CANCELLED · ทุกบรรทัดถูกนำออก บรรทัดต้นทุนกลับเข้าคิวจ่าย · ยอดของใบคงไว้ ณ เวลายกเลิก · audit `settlement.cancelled`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag (version) — ไม่ตรง → 412 |

**Request body** `SettlementReasonDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `รถร่วมขอแยกวางบิลเที่ยวนี้งวดหน้า` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `SettlementDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settlements:create`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบสำคัญจ่าย (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/settlements/<id>/cancel" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"รถร่วมขอแยกวางบิลเที่ยวนี้งวดหน้า"}'
```

```ts
const { data, error } = await tms.POST('/v1/settlements/{id}/cancel', {
  params: { path: { id: "…" } },
  body: {
    "reason": "รถร่วมขอแยกวางบิลเที่ยวนี้งวดหน้า"
  },
});
```

## ส่งให้รถร่วมตรวจผ่านลิงก์ (DRAFT → SENT_TO_CARRIER) {#post-settlements-id-send-to-carrier}

`POST /v1/settlements/{id}/send-to-carrier`

scope: `settlements:create` · operationId: `Settlements_send`

"รถร่วมตรวจผ่านลิงก์" · ต้องมีบรรทัดค่าขนส่ง (409 `settlement_empty`) และยอดสุทธิไม่ติดลบ (409 `settlement_net_negative`) · ออกลิงก์อายุ 7 วัน (`link.url` แสดงครั้งเดียว — ส่งทาง LINE/SMS ด้วย POST /v1/messages/send-link หรือคัดลอกไปส่งเอง) · รอบตรวจ +1 · ใบที่ส่งแล้วแก้/เพิ่ม/นำบรรทัดออก/ยกเลิกไม่ได้ (409) จนกว่าจะเรียกกลับ · **ผู้ส่งนับเป็นผู้เตรียมใบ — อนุมัติใบนี้ไม่ได้** · audit `settlement.sent`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header | ใช่ | `string` | ETag (version) — **บังคับ** · ไม่ส่ง → 422 `if_match_required` · ไม่ตรง → 412 |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `SettlementSentDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settlements:create`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบสำคัญจ่าย (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress), [settlement_empty](errors.md#settlement_empty), [settlement_net_negative](errors.md#settlement_net_negative) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/settlements/<id>/send-to-carrier" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)"
```

```ts
const { data, error } = await tms.POST('/v1/settlements/{id}/send-to-carrier', {
  params: { path: { id: "…" } },
});
```

## ออกลิงก์ให้รถร่วมตรวจใหม่ (ลิงก์เดิมหมดอายุ/หาย) {#post-settlements-id-review-link}

`POST /v1/settlements/{id}/review-link`

scope: `settlements:create` · operationId: `Settlements_reissueLink`

เฉพาะใบ SENT_TO_CARRIER / DISPUTED · เพิกถอนลิงก์เดิม · คำตอบของรถร่วมในรอบนี้คงอยู่ · audit `settlement.review_link_reissued`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `201` |   | `SettlementReviewLinkDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settlements:create`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบสำคัญจ่าย (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/settlements/<id>/review-link" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)"
```

```ts
const { data, error } = await tms.POST('/v1/settlements/{id}/review-link', {
  params: { path: { id: "…" } },
});
```

## เรียกใบกลับมาแก้ (SENT_TO_CARRIER / DISPUTED → DRAFT) — เหตุผล ≥ 10 ตัวอักษร {#post-settlements-id-recall}

`POST /v1/settlements/{id}/recall`

scope: `settlements:create` · operationId: `Settlements_recall`

เช่น รถร่วมโต้แย้งรายการ แล้วต้องแก้/นำบรรทัดออก · เพิกถอนลิงก์ตรวจ · คำตอบของรถร่วมเก็บเป็นประวัติ (ส่งใหม่ = รอบใหม่) · รายการที่โต้แย้งค้างยังบล็อกอนุมัติร่างตรง (นำออก / ยืนยันยอดเดิม / ส่งรอบใหม่) · audit `settlement.recalled`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header | ใช่ | `string` | ETag (version) — **บังคับ** · ไม่ส่ง → 422 `if_match_required` · ไม่ตรง → 412 |

**Request body** `SettlementReasonDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `รถร่วมขอแยกวางบิลเที่ยวนี้งวดหน้า` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `SettlementDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settlements:create`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบสำคัญจ่าย (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/settlements/<id>/recall" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"รถร่วมขอแยกวางบิลเที่ยวนี้งวดหน้า"}'
```

```ts
const { data, error } = await tms.POST('/v1/settlements/{id}/recall', {
  params: { path: { id: "…" } },
  body: {
    "reason": "รถร่วมขอแยกวางบิลเที่ยวนี้งวดหน้า"
  },
});
```

## บัญชีติด dispute รายการ — เหตุผล ≥ 10 ตัวอักษร {#post-settlements-id-lines-lineId-dispute}

`POST /v1/settlements/{id}/lines/{lineId}/dispute`

scope: `settlements:create` · operationId: `Settlements_disputeLine`

"SENT_TO_CARRIER → DISPUTED: รถร่วม/บัญชีติด dispute รายการ" · เฉพาะใบ SENT_TO_CARRIER / DISPUTED (อื่น ๆ → 409) · บรรทัดที่โต้แย้งค้างอยู่แล้ว / นำออกแล้ว → 409 · หัวใบ → DISPUTED (อนุมัติไม่ได้จนเคลียร์) · ไม่แสดงให้รถร่วมเห็น · audit `settlement.line_flagged`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `lineId` | path | ใช่ | `string` |   |
| `If-Match` | header | ใช่ | `string` | ETag (version) — **บังคับ** · ไม่ส่ง → 422 `if_match_required` · ไม่ตรง → 412 |

**Request body** `SettlementReasonDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `รถร่วมขอแยกวางบิลเที่ยวนี้งวดหน้า` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `SettlementDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settlements:create`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบสำคัญจ่าย (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/settlements/<id>/lines/<lineId>/dispute" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"รถร่วมขอแยกวางบิลเที่ยวนี้งวดหน้า"}'
```

```ts
const { data, error } = await tms.POST('/v1/settlements/{id}/lines/{lineId}/dispute', {
  params: { path: { id: "…", lineId: "…" } },
  body: {
    "reason": "รถร่วมขอแยกวางบิลเที่ยวนี้งวดหน้า"
  },
});
```

## เคลียร์ dispute — ยืนยันยอดเดิมพร้อมเหตุผล ≥ 10 ตัวอักษร {#post-settlements-id-lines-lineId-resolve}

`POST /v1/settlements/{id}/lines/{lineId}/resolve`

scope: `settlements:create` · operationId: `Settlements_resolveLine`

BIL-136 · เฉพาะบรรทัดที่โต้แย้งค้าง ของใบ DISPUTED / ร่างที่เรียกกลับ / SENT_TO_CARRIER ที่มีโต้แย้งค้าง (อื่น ๆ → 409) · ปิดทุก dispute ก่อนหน้าของบรรทัดในรอบนี้ (รถร่วม + บัญชี) → สถานะรายการ APPROVED · ถ้าปิดข้อโต้แย้งของรถร่วม: **รถร่วมตอบบรรทัดนี้ในรอบนี้ไม่ได้อีก** (409 `settlement_line_resolved`) และเห็นเหตุผลนี้บนลิงก์ตรวจ · ปิดแค่ธงภายในของบัญชี: รถร่วมยังตอบได้และไม่เห็นเหตุผล · เคลียร์ครบ → DISPUTED กลับเป็น SENT_TO_CARRIER (อนุมัติได้) · **ผู้เคลียร์นับเป็นผู้เตรียมใบ — อนุมัติใบนี้ไม่ได้** (separation of duties) · แก้ยอด = เรียกกลับแล้วนำบรรทัดออก/เพิ่มใหม่ · audit `settlement.line_resolved`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `lineId` | path | ใช่ | `string` |   |
| `If-Match` | header | ใช่ | `string` | ETag (version) — **บังคับ** · ไม่ส่ง → 422 `if_match_required` · ไม่ตรง → 412 |

**Request body** `SettlementReasonDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `รถร่วมขอแยกวางบิลเที่ยวนี้งวดหน้า` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `SettlementDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settlements:create`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบสำคัญจ่าย (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/settlements/<id>/lines/<lineId>/resolve" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"รถร่วมขอแยกวางบิลเที่ยวนี้งวดหน้า"}'
```

```ts
const { data, error } = await tms.POST('/v1/settlements/{id}/lines/{lineId}/resolve', {
  params: { path: { id: "…", lineId: "…" } },
  body: {
    "reason": "รถร่วมขอแยกวางบิลเที่ยวนี้งวดหน้า"
  },
});
```

## บันทึกจ่ายใบสำคัญจ่ายรถร่วม (APPROVED → PAID) — วันที่จ่าย วิธี เลขอ้างอิง ธนาคาร {#post-settlements-id-mark-paid}

`POST /v1/settlements/{id}/mark-paid`

scope: `settlements:pay` · operationId: `Settlements_markPaid`

"จ่าย" + APPROVED → PAID · **เฉพาะใบ APPROVED** (ร่าง/รอตรวจ/โต้แย้ง/ยกเลิก/จ่ายแล้ว → 409 `invalid_state_transition`) · จ่ายเต็มยอดครั้งเดียว — ยอดที่จ่าย = `buyNetAfterWht` (ยอดสุทธิ − หัก ณ ที่จ่ายประมาณการที่ตรึงตอนอนุมัติ — ไม่เปลี่ยน) · `paidDate` (= วันที่หักภาษี) ตั้งแต่วันอนุมัติถึงวันนี้ (เวลาไทย) — ก่อนวันอนุมัติ → 422 `before_approval` · `reference` บังคับเมื่อ TRANSFER / CHEQUE · ใบที่ไม่ใช่ APPROVED (รวมจ่ายแล้ว/คำขอซ้ำพร้อมกัน) → 409 ก่อนตรวจ If-Match · **ผู้อนุมัติใบนี้บันทึกจ่ายเองไม่ได้ → 403 `settlement_self_payment`** · เที่ยวที่บรรทัดต้นทุนจ่ายครบแล้ว COSTED → **SETTLED** (ไม่กลับเข้าคิวจ่าย) · ใบ PAID แก้ไม่ได้ · audit `settlement.paid` + webhook `settlement.paid` · ไฟล์โอนธนาคาร (bulk payment) = P1

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header | ใช่ | `string` | ETag (version) — **บังคับ** · ไม่ส่ง → 422 `if_match_required` · ไม่ตรง → 412 |

**Request body** `SettlementPayDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `paidDate` | ใช่ | `string` |   | วันที่จ่ายจริง (วันโอน / วันที่เช็ค / วันจ่ายเงินสด — YYYY-MM-DD วันที่ไทย) = วันที่หักภาษี — ตั้งแต่วันอนุมัติถึงวันนี้ | `2026-11-20` |
| `method` | ใช่ | `string` | ค่า: `TRANSFER`, `CHEQUE`, `CASH` | TRANSFER = โอนเงิน · CHEQUE = เช็ค · CASH = เงินสด |   |
| `reference` |   | `string` | ยาว ≤ 60 · null ได้ | เลขอ้างอิงการโอน / เลขที่เช็ค — **บังคับเมื่อ TRANSFER / CHEQUE** | `KBANK-2611-0091` |
| `bank` |   | `string` | ยาว ≤ 60 · null ได้ | ธนาคาร (ของบัญชีที่โอนออก / ธนาคารของเช็ค) — ไม่บังคับ | `กสิกรไทย` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `SettlementDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ `settlements:pay` / ผู้อนุมัติใบนี้บันทึกจ่ายเอง — [permission_denied](errors.md#permission_denied), [settlement_self_payment](errors.md#settlement_self_payment) | `ProblemDto` |
| `404` | ไม่พบใบสำคัญจ่าย (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/settlements/<id>/mark-paid" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"paidDate":"2026-11-20","method":"TRANSFER"}'
```

```ts
const { data, error } = await tms.POST('/v1/settlements/{id}/mark-paid', {
  params: { path: { id: "…" } },
  body: {
    "paidDate": "2026-11-20",
    "method": "TRANSFER"
  },
});
```

## Schema ของ response {#schemas}

### SettlementComparisonDto {#schema-SettlementComparisonDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `stl_…` |
| `status` | ใช่ | `string` | ค่า: `DRAFT`, `SENT_TO_CARRIER`, `DISPUTED`, `APPROVED`, `PAID`, `CANCELLED` |   |   |
| `round` | ใช่ | `number` |   | รอบตรวจปัจจุบัน (0 = ยังไม่เคยส่ง) |   |
| `carrierInvoiceNo` | ใช่ | `string` | null ได้ | เลขใบแจ้งหนี้ของรถร่วม |   |
| `dispute` | ใช่ | `SettlementDisputeSummaryDto` |   |   |   |
| `lines` | ใช่ | `array<ComparisonLineDto>` |   | บรรทัดที่ยังใช้ เรียงตามลำดับในใบ |   |
| `trips` | ใช่ | `array<ComparisonTripDto>` |   | เที่ยวของบรรทัด + POD ต่อ DO |   |

### SettlementDto {#schema-SettlementDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `stl_…` |
| `settlementNo` | ใช่ | `string` | null ได้ | เลขเอกสาร (ชุด STL) — ร่างยังไม่มีเลข · ออกตอนอนุมัติ |   |
| `status` | ใช่ | `string` | ค่า: `DRAFT`, `SENT_TO_CARRIER`, `DISPUTED`, `APPROVED`, `PAID`, `CANCELLED` |   |   |
| `carrier` | ใช่ | `SettlementCarrierDto` |   |   |   |
| `payingCompanyId` | ใช่ | `string` | null ได้ | นิติบุคคลที่จ่าย ("จ้างในนาม" ของรถร่วม — null = ค่าเริ่มต้นองค์กร) |   |
| `periodFrom` | ใช่ | `string` |   |   | `2026-11-01` |
| `periodTo` | ใช่ | `string` |   |   | `2026-11-15` |
| `carrierInvoiceNo` | ใช่ | `string` | null ได้ |   |   |
| `carrierInvoiceDate` | ใช่ | `string` | null ได้ |   |   |
| `carrierReceiptNo` | ใช่ | `string` | null ได้ |   |   |
| `note` | ใช่ | `string` | null ได้ |   |   |
| `tripCount` | ใช่ | `number` |   | จำนวนเที่ยวในใบ (บรรทัดที่ยังใช้) |   |
| `buyGrossAmount` |   | `string` |   | ยอดรวม = Σ บรรทัดเที่ยวที่ยังใช้ (ก่อน VAT ก่อนหัก ณ ที่จ่าย) — เห็นเมื่อมี `prices.buy:read` | `13500.00` |
| `buyDeductionAmount` |   | `string` |   | รวมรายการหัก (ค่าบวก = Σ \|บรรทัดหัก\|) — เห็นเมื่อมี `prices.buy:read` | `2500.00` |
| `buyNetPayable` |   | `string` |   | ยอดสุทธิ = ยอดรวม − รายการหัก (**ก่อนหัก ณ ที่จ่าย** — ใช้เทียบวงเงิน step-up ตอนอนุมัติ) — เห็นเมื่อมี `prices.buy:read` | `11000.00` |
| `buyWhtAmount` |   | `string` |   | หัก ณ ที่จ่าย **ประมาณการ** = Σ ต่ออัตรา round_half_up(ฐานก่อนหักของกลุ่ม × อัตรา) — ร่าง ยังไม่ผ่านนักบัญชี · เห็นเมื่อมี `prices.buy:read` | `150.00` |
| `buyNetAfterWht` |   | `string` |   | ยอดจ่ายรถร่วมหลังหัก ณ ที่จ่าย = ยอดรวม − หัก ณ ที่จ่าย − รายการหัก (ประมาณการ) — เห็นเมื่อมี `prices.buy:read` | `10850.00` |
| `whtEstimate` | ใช่ | `SettlementWhtEstimateDto` |   |   |   |
| `lines` | ใช่ | `array<SettlementLineDto>` |   | ทุกบรรทัด รวมบรรทัดที่นำออกแล้ว (`active` false) |   |
| `approvedAt` | ใช่ | `string` | null ได้ | เวลาอนุมัติ — ออกเลข `settlementNo` พร้อมกัน |   |
| `approvedBy` | ใช่ | `string` | null ได้ | ผู้อนุมัติ (ไม่ใช่ผู้สร้าง — separation of duties) |   |
| `paidDate` | ใช่ | `string` | null ได้ | วันที่จ่ายจริง (YYYY-MM-DD) — null จนบันทึกจ่าย | `2026-11-20` |
| `paidAt` | ใช่ | `string` | null ได้ | เวลาที่บันทึกจ่าย |   |
| `paidBy` | ใช่ | `string` | null ได้ | ผู้บันทึกจ่าย |   |
| `paymentMethod` | ใช่ | `string` | ค่า: `TRANSFER`, `CHEQUE`, `CASH` · null ได้ | วิธีจ่าย TRANSFER / CHEQUE / CASH |   |
| `paymentReference` | ใช่ | `string` | null ได้ | เลขอ้างอิงการโอน / เลขที่เช็ค |   |
| `paymentBank` | ใช่ | `string` | null ได้ | ธนาคาร |   |
| `sentAt` | ใช่ | `string` | null ได้ | ส่งให้รถร่วมตรวจล่าสุด — ผู้ส่งนับเป็นผู้เตรียมใบ (อนุมัติใบนี้ไม่ได้) |   |
| `sentBy` | ใช่ | `string` | null ได้ |   |   |
| `carrierReview` | ใช่ | `SettlementCarrierReviewDto` |   |   |   |
| `dispute` | ใช่ | `SettlementDisputeSummaryDto` |   |   |   |
| `cancelledAt` | ใช่ | `string` | null ได้ |   |   |
| `cancelledBy` | ใช่ | `string` | null ได้ |   |   |
| `cancelReason` | ใช่ | `string` | null ได้ |   |   |
| `createdBy` | ใช่ | `string` | null ได้ |   |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string` |   |   |   |
| `updatedAt` | ใช่ | `string` |   |   |   |

### SettlementPageDto {#schema-SettlementPageDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<SettlementSummaryDto>` |   |   |   |
| `nextCursor` | ใช่ | `string` | null ได้ |   |   |
| `hasMore` | ใช่ | `boolean` |   |   |   |

### SettlementQueuePageDto {#schema-SettlementQueuePageDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<SettlementQueueTripDto>` |   |   |   |
| `nextCursor` | ใช่ | `string` | null ได้ |   |   |
| `hasMore` | ใช่ | `boolean` |   |   |   |
| `carriers` | ใช่ | `array<SettlementQueueCarrierDto>` |   | สรุปต่อรถร่วมของทุกเที่ยวที่ตรงตัวกรอง (ไม่ขึ้นกับ cursor/limit) — เรียงตามรหัสรถร่วม |   |

### SettlementReviewLinkDto {#schema-SettlementReviewLinkDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `mlk_…` |
| `url` | ใช่ | `string` |   | ลิงก์หน้าตรวจของรถร่วม (`/link/settlement/{token}`) — ส่งทาง LINE/SMS ด้วย POST /v1/messages/send-link หรือคัดลอกไปส่งเอง · แสดงครั้งเดียว (ไม่เก็บ token) |   |
| `expiresAt` | ใช่ | `string (date-time)` |   |   |   |

### SettlementSentDto {#schema-SettlementSentDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `settlement` | ใช่ | `SettlementDto` |   |   |   |
| `link` | ใช่ | `SettlementReviewLinkDto` |   |   |   |
