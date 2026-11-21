# payments

8 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`GET /v1/payments`](#get-payments) | `invoices:read` |
| [`POST /v1/payments`](#post-payments) | `payments:record` |
| [`GET /v1/payments/summary`](#get-payments-summary) | `invoices:read` |
| [`GET /v1/payments/aging`](#get-payments-aging) | `invoices:read` |
| [`GET /v1/payments/{id}`](#get-payments-id) | `invoices:read` |
| [`POST /v1/payments/{id}/reverse`](#post-payments-id-reverse) | `payments:reverse` |
| [`POST /v1/payments/{id}/bounce`](#post-payments-id-bounce) | `payments:reverse` |
| [`POST /v1/payments/{id}/clear`](#post-payments-id-clear) | `payments:record` |

## รายการรับชำระ {#get-payments}

`GET /v1/payments`

scope: `invoices:read` · operationId: `Payments_list`

กรองใบแจ้งหนี้ (`invoiceId`) / ลูกค้า (`customerId` รับ `ext:`) / สถานะ · cursor มาตรฐาน (updatedAt, id) · ยอด `sell*` เห็นเมื่อมี `prices.sell:read`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน |
| `updatedAfter` | query |   | `string` | คืนเฉพาะแถวที่ updatedAt > ค่านี้ (incremental pull) |
| `sort` | query |   | `string` ค่า: `updatedAt`, `-updatedAt` |   |
| `fields` | query |   | `string` | รายชื่อ field คั่นด้วย, เช่น id,legalName |
| `invoiceId` | query |   | `string` | การรับชำระที่ตัดใบแจ้งหนี้นี้ |
| `customerId` | query |   | `string` |   |
| `status` | query |   | `string` ค่า: `RECORDED`, `REVERSED` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `PaymentPageDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/payments" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/payments');
```

## บันทึกรับชำระ {#post-payments}

`POST /v1/payments`

scope: `payments:record` · operationId: `Payments_record`

ใบแจ้งหนี้ที่ออกแล้ว (ISSUED / PARTIALLY_PAID) ของลูกค้ารายเดียว หลายใบได้ (BIL-050) · **เงินรับ + WHT + ค่าธรรมเนียม + ส่วนต่าง = Σ `allocations.amount`** (BIL-051 — ไม่มีเงินรับเกิน/เครดิตลูกค้าในเฟสนี้) ไม่ตรง → 422 `payment_unbalanced` · ยอดตัดต่อใบ ≤ คงค้าง (ตรวจใต้ล็อกใบ — พร้อมกันก็ตัดเกินไม่ได้) → 409 `payment_exceeds_outstanding` · ใบไม่อยู่ในสถานะรับชำระ → 409 `invoice_not_payable` · วันที่รับ ≤ วันนี้ (เวลาไทย) · `CHEQUE` ต้องมี `chequeNo` `chequeBank` `chequeDate` (สถานะเช็คเริ่ม PENDING) · ส่วนต่าง > 0 ต้องมี `differenceReason` · WHT ที่ถูกหัก = บันทึกยอด (+ เลขที่ 50 ทวิ) — รับ/ตรวจ 50 ทวิ ที่ระบบบัญชี · สถานะใบ: ตัดครบ → PAID · บางส่วน → PARTIALLY_PAID · เลขภายใน PAY · audit + webhook `payment.recorded` (transaction เดียว) · แก้/ลบไม่ได้ — กลับรายการด้วย `POST /payments/{id}/reverse`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `Idempotency-Key` | header |   | `string` | ส่งซ้ำ key เดิม + body เดิม = ผลเดิม (ไม่บันทึกซ้ำ) เก็บ 24 ชม. |

**Request body** `CreatePaymentDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `receivedDate` | ใช่ | `string` |   | วันที่รับ (เวลาไทย) ≤ วันนี้ และไม่ก่อนวันที่ออกใบแจ้งหนี้ (422 `before_invoice_issue`) | `2026-11-21` |
| `method` | ใช่ | `string` | ค่า: `TRANSFER`, `CHEQUE`, `CASH`, `OFFSET` | โอนเงิน / เช็ค / เงินสด · `OFFSET` (หักกลบลบหนี้) ยังปิด → 422 `method_not_available` (รอเครดิตลูกค้า BIL-058) |   |
| `reference` |   | `string` | ยาว ≤ 100 | เลขอ้างอิงการโอน / หักกลบ (เช็คใช้ `chequeNo`) |   |
| `chequeNo` |   | `string` | ยาว ≤ 30 | เลขที่เช็ค — **บังคับเมื่อ `CHEQUE`** |   |
| `chequeBank` |   | `string` | ยาว ≤ 100 | ธนาคาร (สาขา) — **บังคับเมื่อ `CHEQUE`** |   |
| `chequeDate` |   | `string` |   | วันที่หน้าเช็ค — **บังคับเมื่อ `CHEQUE`** | `2026-11-30` |
| `amountReceived` | ใช่ | `string` |   | เงินเข้าจริง ≥ 0 | `24750.00` |
| `whtAmount` |   | `string` |   | WHT ที่ลูกค้าหักไว้ | `250.00` |
| `whtCertificateNo` |   | `string` | ยาว ≤ 40 | เลขที่หนังสือรับรอง 50 ทวิ ที่ลูกค้าแจ้ง |   |
| `feeAmount` |   | `string` |   | ค่าธรรมเนียมโอนที่ลูกค้าหัก | `0.00` |
| `differenceAmount` |   | `string` |   | ส่วนต่างที่ยอมตัดยอด (ลูกค้าจ่ายขาด) — > 0 ต้องมี `differenceReason` · เกินค่าตั้ง `payments.maxDifferenceAmount` (ค่าเริ่ม 10 บาท) ต้องมีสิทธิ์ `payments:reverse` ไม่มี = 403 `payment_difference_over_limit` (BIL-059) | `0.00` |
| `differenceReason` |   | `string` | ยาว ≤ 500 · ยาว ≥ 10 | เหตุผลของส่วนต่าง |   |
| `note` |   | `string` | ยาว ≤ 500 |   |   |
| `allocations` | ใช่ | `array<PaymentAllocationInputDto>` | ≤ 50 รายการ |   |   |
| `allocations[].invoiceId` | ใช่ | `string` |   | ใบแจ้งหนี้ที่ออกแล้วของลูกค้ารายเดียวกัน | `ivc_…` |
| `allocations[].amount` | ใช่ | `string` |   | ยอดตัดหนี้ของใบนี้ (รวม WHT ที่ถูกหัก) > 0 และ ≤ ยอดคงค้าง | `25000.00` |
| `allocations[].whtAmount` |   | `string` |   | WHT ที่ถูกหักของใบนี้ — ตัดใบเดียว: ไม่ส่ง = `whtAmount` ของการรับชำระ · หลายใบ: ส่งทุกใบ และรวม = `whtAmount` | `250.00` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `201` |   | `PaymentDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ `payments:record` / ส่วนต่างเกิน `payments.maxDifferenceAmount` โดยไม่มี `payments:reverse` (`payment_difference_over_limit`) — [permission_denied](errors.md#permission_denied), [payment_difference_over_limit](errors.md#payment_difference_over_limit) | `ProblemDto` |
| `409` | `invoice_not_payable` · `payment_exceeds_outstanding` (`outstanding`) — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress), [invoice_not_payable](errors.md#invoice_not_payable), [payment_exceeds_outstanding](errors.md#payment_exceeds_outstanding) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/payments" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"receivedDate":"2026-11-21","method":"TRANSFER","chequeDate":"2026-11-30","amountReceived":"24750.00","whtAmount":"250.00","feeAmount":"0.00","differenceAmount":"0.00","allocations":[{"invoiceId":"ivc_…","amount":"25000.00","whtAmount":"250.00"}]}'
```

```ts
const { data, error } = await tms.POST('/v1/payments', {
  body: {
    "receivedDate": "2026-11-21",
    "method": "TRANSFER",
    "chequeDate": "2026-11-30",
    "amountReceived": "24750.00",
    "whtAmount": "250.00",
    "feeAmount": "0.00",
    "differenceAmount": "0.00",
    "allocations": [
      {
        "invoiceId": "ivc_…",
        "amount": "25000.00",
        "whtAmount": "250.00"
      }
    ]
  },
});
```

## KPI หน้า "รับชำระ" — ยอดค้างรับ / เกินกำหนด / รับชำระเดือนนี้ / ครบกำหนดใน 7 วัน + จำนวนต่อแท็บ {#get-payments-summary}

`GET /v1/payments/summary`

scope: `invoices:read` · operationId: `Payments_summary`

วันครบกำหนดและเดือน ตามเวลาไทย (Asia/Bangkok) · เกินกำหนด = ใบที่มีธง `overdue`

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `PaymentSummaryDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/payments/summary" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/payments/summary');
```

## อายุลูกหนี้ — ยอดค้างตามช่วงอายุ รวมและต่อลูกค้า {#get-payments-aging}

`GET /v1/payments/aging`

scope: `invoices:read` · operationId: `Payments_agingReport`

ใบค้างรับ (ISSUED / PARTIALLY_PAID ที่ยังมียอดค้าง) · ยอดค้าง = ยอดรวม − ยอดตัดชำระ · ช่วงอายุจาก `daysPastDue = asOf − dueDate` (เวลาไทย): ยังไม่ครบกำหนด (≤ 0) · 1–30 · 31–60 · 61–90 · เกิน 90 วัน · **Σ ทุกช่วง = `sellOutstanding` ของ `GET /payments/summary`** · `data` = ต่อลูกค้า (เฉพาะที่มียอดค้าง) เรียงตามชื่อ cursor มาตรฐาน · กรองลูกค้า `customerId` (รับ `ext:`) · asOf = วันนี้ · ยอด `sell*` เห็นเมื่อมี `prices.sell:read` (จำนวนใบเห็นเสมอ) · รายการใบในช่วงอายุ: `GET /invoices?receivable=open&aging=…`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `limit` | query |   | `number` | ลูกค้าต่อหน้า |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน (เรียงตามชื่อลูกค้า) |
| `customerId` | query |   | `string` | ลูกค้ารายเดียว — id หรือ `ext:{externalId}` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `AgingReportDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/payments/aging" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/payments/aging');
```

## การรับชำระ + การตัดชำระต่อใบแจ้งหนี้ {#get-payments-id}

`GET /v1/payments/{id}`

scope: `invoices:read` · operationId: `Payments_get`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `PaymentDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบการรับชำระ (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/payments/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/payments/{id}', {
  params: { path: { id: "…" } },
});
```

## กลับรายการรับชำระ {#post-payments-id-reverse}

`POST /v1/payments/{id}/reverse`

scope: `payments:reverse` · operationId: `Payments_reverse`

RECORDED → REVERSED · ยอดค้างของใบกลับมา (PAID/PARTIALLY_PAID → ตามยอดที่เหลือ) · เหตุผล ≥ 10 ตัวอักษร + audit · webhook `payment.reversed` · บันทึกผิด = กลับรายการแล้วบันทึกใหม่ (ไม่มีแก้/ลบ)

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header | ใช่ | `string` | ETag (version) ของการรับชำระ — **บังคับ** · ไม่ส่ง → 422 `if_match_required` · ไม่ตรง → 412 |

**Request body** `PaymentReasonDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `บันทึกยอดผิด ลูกค้าโอน 24,500.00` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `PaymentDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`payments:reverse`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบการรับชำระ (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | `invalid_state_transition` — กลับรายการแล้ว / ไม่ใช่เช็ค / เช็คไม่อยู่ในสถานะที่ทำได้ — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/payments/<id>/reverse" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"บันทึกยอดผิด ลูกค้าโอน 24,500.00"}'
```

```ts
const { data, error } = await tms.POST('/v1/payments/{id}/reverse', {
  params: { path: { id: "…" } },
  body: {
    "reason": "บันทึกยอดผิด ลูกค้าโอน 24,500.00"
  },
});
```

## เช็คคืน — กลับรายการรับชำระด้วยเช็ค (BIL-060) {#post-payments-id-bounce}

`POST /v1/payments/{id}/bounce`

scope: `payments:reverse` · operationId: `Payments_bounce`

เช็คที่รอเคลียร์/ผ่านแล้ว → `chequeStatus` BOUNCED + REVERSED · ยอดค้างของใบกลับมา · เหตุผล + audit `payment.cheque_bounced` · webhook `payment.reversed` (`chequeStatus: BOUNCED`)

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header | ใช่ | `string` | ETag (version) ของการรับชำระ — **บังคับ** · ไม่ส่ง → 422 `if_match_required` · ไม่ตรง → 412 |

**Request body** `PaymentReasonDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `บันทึกยอดผิด ลูกค้าโอน 24,500.00` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `PaymentDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`payments:reverse`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบการรับชำระ (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | `invalid_state_transition` — กลับรายการแล้ว / ไม่ใช่เช็ค / เช็คไม่อยู่ในสถานะที่ทำได้ — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/payments/<id>/bounce" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"บันทึกยอดผิด ลูกค้าโอน 24,500.00"}'
```

```ts
const { data, error } = await tms.POST('/v1/payments/{id}/bounce', {
  params: { path: { id: "…" } },
  body: {
    "reason": "บันทึกยอดผิด ลูกค้าโอน 24,500.00"
  },
});
```

## เช็คผ่าน (เคลียร์แล้ว) — PENDING → CLEARED {#post-payments-id-clear}

`POST /v1/payments/{id}/clear`

scope: `payments:record` · operationId: `Payments_clear`

ไม่เปลี่ยนยอดตัดหนี้ (ตัดยอดตั้งแต่บันทึกรับเช็ค) · audit `payment.cheque_cleared`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header | ใช่ | `string` | ETag (version) ของการรับชำระ — **บังคับ** · ไม่ส่ง → 422 `if_match_required` · ไม่ตรง → 412 |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `PaymentDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`payments:record`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบการรับชำระ (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | `invalid_state_transition` — กลับรายการแล้ว / ไม่ใช่เช็ค / เช็คไม่อยู่ในสถานะที่ทำได้ — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/payments/<id>/clear" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)"
```

```ts
const { data, error } = await tms.POST('/v1/payments/{id}/clear', {
  params: { path: { id: "…" } },
});
```

## Schema ของ response {#schemas}

### AgingReportDto {#schema-AgingReportDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `asOf` | ใช่ | `string` |   | วันที่คำนวณ (วันนี้ เวลาไทย Asia/Bangkok) | `2026-11-09` |
| `basis` | ใช่ | `string` | ค่า: `DUE_DATE` | นับอายุจากวันครบกำหนด — ไม่มีวันครบกำหนด = ยังไม่ครบกำหนด |   |
| `count` | ใช่ | `number` |   | ใบค้างรับทั้งหมด (ตามตัวกรองลูกค้า — ไม่ขึ้นกับหน้า) |   |
| `sellOutstanding` |   | `string` |   | ยอดค้างรวม = Σ ทุกช่วง = `sellOutstanding` ของ `GET /payments/summary` (ใบ ISSUED + PARTIALLY_PAID) — `prices.sell:read` |   |
| `buckets` | ใช่ | `array<AgingBucketDto>` |   | รวมทุกลูกค้า (ไม่ขึ้นกับหน้า) |   |
| `data` | ใช่ | `array<AgingCustomerDto>` |   | ต่อลูกค้า (เฉพาะที่มียอดค้าง) เรียงตามชื่อ |   |
| `nextCursor` | ใช่ | `string` | null ได้ |   |   |
| `hasMore` | ใช่ | `boolean` |   |   |   |

### PaymentDto {#schema-PaymentDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `pay_…` |
| `paymentNo` | ใช่ | `string` |   | เลขภายใน | `PAY-2611-0001` |
| `customer` | ใช่ | `PaymentCustomerDto` |   |   |   |
| `receivedDate` | ใช่ | `string` |   |   | `2026-11-21` |
| `method` | ใช่ | `string` | ค่า: `TRANSFER`, `CHEQUE`, `CASH`, `OFFSET` |   |   |
| `reference` | ใช่ | `string` | null ได้ |   |   |
| `chequeNo` | ใช่ | `string` | null ได้ |   |   |
| `chequeBank` | ใช่ | `string` | null ได้ |   |   |
| `chequeDate` | ใช่ | `string` | null ได้ |   |   |
| `chequeStatus` | ใช่ | `string` | ค่า: `PENDING`, `CLEARED`, `BOUNCED` · null ได้ | สถานะเช็ค (รอเคลียร์ / ผ่าน / เช็คคืน) — ไม่ใช่เช็ค = null |   |
| `sellAmountReceived` |   | `string` |   | เงินเข้าจริง — `prices.sell:read` |   |
| `sellWhtAmount` |   | `string` |   | WHT ที่ลูกค้าหัก — `prices.sell:read` |   |
| `sellFeeAmount` |   | `string` |   | ค่าธรรมเนียมที่ลูกค้าหัก — `prices.sell:read` |   |
| `sellDifferenceAmount` |   | `string` |   | ส่วนต่างที่ยอมตัดยอด — `prices.sell:read` |   |
| `sellAppliedTotal` |   | `string` |   | ยอดตัดหนี้รวม (= Σ allocations) — `prices.sell:read` |   |
| `differenceReason` | ใช่ | `string` | null ได้ |   |   |
| `whtCertificateNo` | ใช่ | `string` | null ได้ | เลขที่ 50 ทวิ ที่ลูกค้าแจ้ง |   |
| `note` | ใช่ | `string` | null ได้ |   |   |
| `source` | ใช่ | `string` | ค่า: `MANUAL`, `CONNECTOR` |   |   |
| `status` | ใช่ | `string` | ค่า: `RECORDED`, `REVERSED` | RECORDED · REVERSED (กลับรายการแล้ว — ไม่นับเป็นยอดรับ) |   |
| `allocations` | ใช่ | `array<PaymentAllocationDto>` |   |   |   |
| `reversedAt` | ใช่ | `string` | null ได้ |   |   |
| `reversedBy` | ใช่ | `string` | null ได้ |   |   |
| `reverseReason` | ใช่ | `string` | null ได้ |   |   |
| `createdBy` | ใช่ | `string` | null ได้ |   |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string` |   |   |   |
| `updatedAt` | ใช่ | `string` |   |   |   |

### PaymentPageDto {#schema-PaymentPageDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<PaymentDto>` |   |   |   |
| `nextCursor` | ใช่ | `string` | null ได้ |   |   |
| `hasMore` | ใช่ | `boolean` |   |   |   |

### PaymentSummaryDto {#schema-PaymentSummaryDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `sellOutstanding` |   | `string` |   | ยอดค้างรับรวม (ใบที่ออกแล้ว) — `prices.sell:read` |   |
| `sellOverdueOutstanding` |   | `string` |   | ยอดค้างของใบที่เลยวันครบกำหนด (เวลาไทย) — `prices.sell:read` |   |
| `sellReceivedThisMonth` |   | `string` |   | เงินเข้าจริง (`amountReceived`) ของการรับชำระเดือนนี้ — ไม่รวม WHT/ค่าธรรมเนียม/ส่วนต่าง และที่กลับรายการ (เวลาไทย) — `prices.sell:read` |   |
| `dueSoon` | ใช่ | `number` |   | ใบที่ค้างรับและครบกำหนดภายใน 7 วัน |   |
| `total` | ใช่ | `number` |   | ใบที่ออกแล้วทั้งหมด (ไม่รวมร่าง/ยกเลิก) |   |
| `open` | ใช่ | `number` |   | ค้างรับ (ISSUED + PARTIALLY_PAID) |   |
| `overdue` | ใช่ | `number` |   | เกินกำหนด — ธง `overdue` ของใบ |   |
| `partiallyPaid` | ใช่ | `number` |   | ชำระบางส่วนที่ไม่เกินกำหนด |   |
| `paid` | ใช่ | `number` |   |   |   |
