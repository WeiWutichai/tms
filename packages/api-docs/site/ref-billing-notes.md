# billing-notes

15 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`GET /v1/billing-notes/summary`](#get-billing-notes-summary) | `invoices:read` |
| [`GET /v1/billing-notes/candidates`](#get-billing-notes-candidates) | `invoices:read` |
| [`GET /v1/billing-notes`](#get-billing-notes) | `invoices:read` |
| [`POST /v1/billing-notes`](#post-billing-notes) | `invoices:draft` |
| [`GET /v1/billing-notes/{id}`](#get-billing-notes-id) | `invoices:read` |
| [`PATCH /v1/billing-notes/{id}`](#patch-billing-notes-id) | `invoices:draft` |
| [`POST /v1/billing-notes/{id}/finalize`](#post-billing-notes-id-finalize) | `invoices:finalize` |
| [`POST /v1/billing-notes/{id}/acknowledge`](#post-billing-notes-id-acknowledge) | `invoices:finalize` |
| [`POST /v1/billing-notes/{id}/collect`](#post-billing-notes-id-collect) | `invoices:finalize` |
| [`POST /v1/billing-notes/{id}/cancel`](#post-billing-notes-id-cancel) | `invoices:draft` |
| [`GET /v1/billing-notes/{id}/proforma`](#get-billing-notes-id-proforma) | `invoices:read` |
| [`GET /v1/billing-notes/{id}/pdf`](#get-billing-notes-id-pdf) | `invoices:read` |
| [`GET /v1/billing-notes/{id}/pdf-bundle`](#get-billing-notes-id-pdf-bundle) | `invoices:read` |
| [`POST /v1/billing-notes/{id}/send`](#post-billing-notes-id-send) | `invoices:finalize` |
| [`GET /v1/billing-notes/{id}/emails`](#get-billing-notes-id-emails) | `invoices:read` |

## จำนวนใบวางบิลตามสถานะ (แท็บ) {#get-billing-notes-summary}

`GET /v1/billing-notes/summary`

scope: `invoices:read` · operationId: `BillingNotes_summary`

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `BillingNoteSummaryCountsDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/billing-notes/summary" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/billing-notes/summary');
```

## ใบแจ้งหนี้ของลูกค้าที่ใส่ในใบวางบิลได้ {#get-billing-notes-candidates}

`GET /v1/billing-notes/candidates`

scope: `invoices:read` · operationId: `BillingNotes_candidates`

ออกแล้วและยังค้างชำระ (ISSUED) และไม่อยู่ในใบวางบิลอื่นที่ active (ร่าง/ออกแล้ว) · เรียงวันที่ออก · ≤ 500 ใบ · ยอด `sell*` เห็นเมื่อมี `prices.sell:read`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `customerId` | query | ใช่ | `string` | ลูกค้า — id หรือ `ext:{externalId}` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `BillingNoteCandidatesDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/billing-notes/candidates" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/billing-notes/candidates');
```

## รายการใบวางบิล {#get-billing-notes}

`GET /v1/billing-notes`

scope: `invoices:read` · operationId: `BillingNotes_list`

กรองลูกค้า (`customerId` รับ `ext:`) / สถานะ · cursor มาตรฐาน (updatedAt, id) · ร่างไม่มีเลข · ยอด `sell*` เห็นเมื่อมี `prices.sell:read`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน |
| `updatedAfter` | query |   | `string` | คืนเฉพาะแถวที่ updatedAt > ค่านี้ (incremental pull) |
| `sort` | query |   | `string` ค่า: `updatedAt`, `-updatedAt` |   |
| `fields` | query |   | `string` | รายชื่อ field คั่นด้วย, เช่น id,legalName |
| `customerId` | query |   | `string` | ลูกค้า — id หรือ `ext:{externalId}` |
| `status` | query |   | `string` ค่า: `DRAFT`, `ISSUED`, `COLLECTED`, `CANCELLED` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `BillingNotePageDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/billing-notes" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/billing-notes');
```

## สร้างร่างใบวางบิลจากใบแจ้งหนี้หลายใบของลูกค้าเดียว (ไม่มีเลข) {#post-billing-notes}

`POST /v1/billing-notes`

scope: `invoices:draft` · operationId: `BillingNotes_create`

ใบแจ้งหนี้ต้องเป็นของลูกค้ารายนี้ **ออกแล้วและยังค้างชำระ** (ISSUED — ไม่งั้น 409 `invoice_not_billable`) ผู้ออก/สาขาผู้ออกเดียวกัน (422 `issuer_mismatch`) · **ใบแจ้งหนี้หนึ่งใบอยู่ในใบวางบิลที่ active ได้ใบเดียว** (409 `invoice_already_billed` — กันระดับ DB) · ยอดวางบิล = Σ ยอดค้าง · WHT ที่คาดว่าจะถูกหักเป็นประมาณการ · ไม่กระทบ VAT/WHT · audit `billing_note.draft_created`

**Request body** `CreateBillingNoteDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `customerId` | ใช่ | `string` |   | ลูกค้า — id หรือ `ext:{externalId}` | `cus_…` |
| `invoiceIds` | ใช่ | `array<string>` |   | ใบแจ้งหนี้ (≤ 200) ของลูกค้ารายนี้ที่**ออกแล้วและยังค้างชำระ** (ISSUED) · ผู้ออก/สาขาผู้ออกเดียวกัน · ไม่อยู่ในใบวางบิลอื่นที่ active | `["ivc_…"]` |
| `collectionDate` |   | `string` |   | วันนัดรับเช็ค/โอน (บังคับก่อนออกเอกสาร · ≥ วันวางบิล) | `2026-12-05` |
| `note` |   | `string` |   | หมายเหตุบนเอกสาร (≤ 2,000) |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `201` |   | `BillingNoteDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:draft`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `409` | `invoice_already_billed` — ใบแจ้งหนี้อยู่ในใบวางบิลอื่นที่ active (ร่าง/ออกแล้ว) `invoices[]` · `invoice_not_billable` — ใบแจ้งหนี้ยังไม่ออก/ไม่ค้างชำระ `invoices[]` · `invalid_state_transition` — ใบวางบิลไม่ใช่ร่าง — [invoice_already_billed](errors.md#invoice_already_billed), [invoice_not_billable](errors.md#invoice_not_billable) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/billing-notes" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"customerId":"cus_…","invoiceIds":["ivc_…"],"collectionDate":"2026-12-05"}'
```

```ts
const { data, error } = await tms.POST('/v1/billing-notes', {
  body: {
    "customerId": "cus_…",
    "invoiceIds": [
      "ivc_…"
    ],
    "collectionDate": "2026-12-05"
  },
});
```

## ใบวางบิล + ใบแจ้งหนี้ในใบ + ผู้รับวางบิล {#get-billing-notes-id}

`GET /v1/billing-notes/{id}`

scope: `invoices:read` · operationId: `BillingNotes_get`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `BillingNoteDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบวางบิล (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/billing-notes/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/billing-notes/{id}', {
  params: { path: { id: "…" } },
});
```

## แก้ร่าง — ชุดใบแจ้งหนี้ วันนัดรับเช็ค/โอน หมายเหตุ {#patch-billing-notes-id}

`PATCH /v1/billing-notes/{id}`

scope: `invoices:draft` · operationId: `BillingNotes_update`

เฉพาะ DRAFT (อื่น ๆ → 409) · `invoiceIds` = ชุดใหม่ทั้งหมด (ใบที่ไม่อยู่ในชุดถูกถอด — ยังเห็นในประวัติ `active=false`) · audit `billing_note.draft_updated`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag (version) จาก GET — ไม่ตรง → 412 |

**Request body** `UpdateBillingNoteDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `invoiceIds` |   | `array<string>` |   | ชุดใบแจ้งหนี้ใหม่ทั้งหมด (≥ 1) | `["ivc_…"]` |
| `collectionDate` |   | `string` | null ได้ | วันนัดรับเช็ค/โอน · null = ล้าง | `2026-12-05` |
| `note` |   | `string` | null ได้ | หมายเหตุ · null/"" = ล้าง |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `BillingNoteDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:draft`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบวางบิล (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | `invoice_already_billed` — ใบแจ้งหนี้อยู่ในใบวางบิลอื่นที่ active (ร่าง/ออกแล้ว) `invoices[]` · `invoice_not_billable` — ใบแจ้งหนี้ยังไม่ออก/ไม่ค้างชำระ `invoices[]` · `invalid_state_transition` — ใบวางบิลไม่ใช่ร่าง — [invoice_already_billed](errors.md#invoice_already_billed), [invoice_not_billable](errors.md#invoice_not_billable) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PATCH "$TMS_BASE_URL/v1/billing-notes/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"invoiceIds":["ivc_…"]}'
```

```ts
const { data, error } = await tms.PATCH('/v1/billing-notes/{id}', {
  params: { path: { id: "…" } },
  body: {
    "invoiceIds": [
      "ivc_…"
    ]
  },
});
```

## ออกเอกสาร — ออกเลขใบวางบิล (ชุด BN) + ล็อก {#post-billing-notes-id-finalize}

`POST /v1/billing-notes/{id}/finalize`

scope: `invoices:finalize` · operationId: `BillingNotes_finalize`

DRAFT → ISSUED · ตรวจใบแจ้งหนี้ซ้ำ (ยังออกแล้วค้างชำระ — 409 `invoice_not_billable`) · ต้องมีวันนัดรับเช็ค/โอน ≥ วันวางบิล (422 `collectionDate`) · วันวางบิล = วันนี้ (เวลาไทย) · ออกเลขชุด BN (เรียงไม่ข้าม) · snapshot ลูกค้า/ผู้ออก/ยอดต่อใบ · audit `billing_note.issued` · แล้ว render PDF ต้นฉบับเก็บแบบเขียนครั้งเดียว · หลังนี้แก้ไม่ได้ (ยกเลิกแล้วสร้างใหม่)

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header | ใช่ | `string` | ETag (version) — **บังคับ** · ไม่ส่ง → 422 `if_match_required` · ไม่ตรง → 412 |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `BillingNoteDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:finalize`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบวางบิล (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | `invoice_already_billed` — ใบแจ้งหนี้อยู่ในใบวางบิลอื่นที่ active (ร่าง/ออกแล้ว) `invoices[]` · `invoice_not_billable` — ใบแจ้งหนี้ยังไม่ออก/ไม่ค้างชำระ `invoices[]` · `invalid_state_transition` — ใบวางบิลไม่ใช่ร่าง — [invoice_already_billed](errors.md#invoice_already_billed), [invoice_not_billable](errors.md#invoice_not_billable) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/billing-notes/<id>/finalize" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)"
```

```ts
const { data, error } = await tms.POST('/v1/billing-notes/{id}/finalize', {
  params: { path: { id: "…" } },
});
```

## บันทึกผู้รับวางบิล (ชื่อฝั่งลูกค้า + วันที่รับ) {#post-billing-notes-id-acknowledge}

`POST /v1/billing-notes/{id}/acknowledge`

scope: `invoices:finalize` · operationId: `BillingNotes_acknowledge`

ใบที่ออกแล้ว (ISSUED/COLLECTED) · วันที่รับ ≥ วันวางบิล และไม่เกินวันนี้ · บันทึกซ้ำ = แก้ (audit ค่าเดิม/ใหม่ `billing_note.acknowledged`) · ไม่เปลี่ยนสถานะ

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag (version) จาก GET — ไม่ตรง → 412 |

**Request body** `AcknowledgeBillingNoteDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `receivedBy` | ใช่ | `string` |   | ชื่อผู้รับวางบิลฝั่งลูกค้า | `คุณสมศรี (ฝ่ายบัญชี)` |
| `receivedOn` | ใช่ | `string` |   | วันที่ลูกค้ารับวางบิล (≥ วันวางบิล, ≤ วันนี้) | `2026-11-21` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `BillingNoteDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:finalize`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบวางบิล (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/billing-notes/<id>/acknowledge" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"receivedBy":"คุณสมศรี (ฝ่ายบัญชี)","receivedOn":"2026-11-21"}'
```

```ts
const { data, error } = await tms.POST('/v1/billing-notes/{id}/acknowledge', {
  params: { path: { id: "…" } },
  body: {
    "receivedBy": "คุณสมศรี (ฝ่ายบัญชี)",
    "receivedOn": "2026-11-21"
  },
});
```

## รับเช็ค/โอนแล้ว — ISSUED → COLLECTED {#post-billing-notes-id-collect}

`POST /v1/billing-notes/{id}/collect`

scope: `invoices:finalize` · operationId: `BillingNotes_collect`

สถานะสิ้นสุด · ใบแจ้งหนี้ในใบ**ยังนับว่าวางบิลแล้ว** · ไม่เปลี่ยนสถานะ/ยอดของใบแจ้งหนี้ · audit `billing_note.collected`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag (version) จาก GET — ไม่ตรง → 412 |

**Request body** `CollectBillingNoteDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `note` |   | `string` |   | หมายเหตุการรับเช็ค/โอน (≤ 500) เช่น เลขเช็ค |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `BillingNoteDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:finalize`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบวางบิล (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/billing-notes/<id>/collect" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{}'
```

```ts
const { data, error } = await tms.POST('/v1/billing-notes/{id}/collect', {
  params: { path: { id: "…" } },
  body: {},
});
```

## ยกเลิกใบวางบิล — เหตุผล ≥ 10 ตัวอักษร {#post-billing-notes-id-cancel}

`POST /v1/billing-notes/{id}/cancel`

scope: `invoices:draft` · operationId: `BillingNotes_cancel`

DRAFT → CANCELLED (`invoices:draft`) · ISSUED → CANCELLED (ต้องมี `invoices:finalize` ด้วย — 403) · เลขคงอยู่ ไม่ถูกใช้ซ้ำ · ไม่กระทบใบแจ้งหนี้ (BIL-039 — วางบิลใหม่ได้) · COLLECTED ยกเลิกไม่ได้ (409) · audit `billing_note.cancelled` + เหตุผล

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `If-Match` | header |   | `string` | ETag (version) จาก GET — ไม่ตรง → 412 |
| `X-Step-Up` | header |   | `string` | stepUpToken จาก `POST /v1/auth/step-up` (ยืนยัน TOTP อายุ 5 นาที) — ผู้ใช้ต้องส่งเมื่อยกเลิกใบวางบิลที่ออกแล้ว ไม่งั้น 403 `step_up_required` · API key / OAuth client ไม่ต้อง |

**Request body** `BillingNoteReasonDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` |   | เหตุผล 10–500 ตัวอักษร | `ลูกค้าขอแยกวางบิลตามสาขา` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `BillingNoteDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:draft` / `invoices:finalize`) · ต้องยืนยัน 2FA ซ้ำ (`step_up_required`) เมื่อยกเลิกใบวางบิลที่ออกแล้ว — [permission_denied](errors.md#permission_denied), [step_up_required](errors.md#step_up_required) | `ProblemDto` |
| `404` | ไม่พบใบวางบิล (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `412` | If-Match ไม่ตรง version — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/billing-notes/<id>/cancel" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"ลูกค้าขอแยกวางบิลตามสาขา"}'
```

```ts
const { data, error } = await tms.POST('/v1/billing-notes/{id}/cancel', {
  params: { path: { id: "…" } },
  body: {
    "reason": "ลูกค้าขอแยกวางบิลตามสาขา"
  },
});
```

## PDF ตัวอย่างของร่างใบวางบิล — ไม่มีเลข มีลายน้ำ "ร่าง" {#get-billing-notes-id-proforma}

`GET /v1/billing-notes/{id}/proforma`

scope: `invoices:read` · operationId: `BillingNotes_proforma`

เฉพาะ DRAFT (อื่น ๆ → 409 ใช้ `/pdf`) · แม่แบบเดียวกับใบแจ้งหนี้ (TMS Print #bill) · render ใหม่ทุกครั้ง ไม่เก็บไฟล์ · ต้องมี `prices.sell:read`

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
| `404` | ไม่พบใบวางบิล (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/billing-notes/<id>/proforma" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/billing-notes/{id}/proforma', {
  params: { path: { id: "…" } },
});
```

## PDF ใบวางบิลที่ออกแล้ว — ต้นฉบับ / สำเนา (ไฟล์ที่เก็บ ณ วันออก) {#get-billing-notes-id-pdf}

`GET /v1/billing-notes/{id}/pdf`

scope: `invoices:read` · operationId: `BillingNotes_pdf`

ใบที่ออกเลขแล้ว (ISSUED/COLLECTED/ยกเลิกหลังออก) — ร่าง → 409 ใช้ `/proforma` · `copy=COPY` render จาก snapshot ครั้งแรกแล้วเก็บ · header `X-Content-SHA256` · ต้องมี `prices.sell:read`

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
| `404` | ไม่พบใบวางบิล (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress), [invoice_pdf_template_changed](errors.md#invoice_pdf_template_changed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/billing-notes/<id>/pdf" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/billing-notes/{id}/pdf', {
  params: { path: { id: "…" } },
});
```

## ไฟล์รวมชุด "ใบวางบิล + ใบแจ้งหนี้" (PDF เดียว) — ดาวน์โหลดไปส่งเอง {#get-billing-notes-id-pdf-bundle}

`GET /v1/billing-notes/{id}/pdf-bundle`

scope: `invoices:read` · operationId: `BillingNotes_pdfBundle`

ใบวางบิลที่ออกแล้ว (ISSUED / COLLECTED — อื่น ๆ 409) · หน้าแรก = ใบวางบิล**ต้นฉบับ** ตามด้วยใบแจ้งหนี้**ต้นฉบับ**ตามลำดับในใบวางบิล · คัดลอกหน้าจาก PDF ที่เก็บ ณ วันออก (ไม่ render ใหม่ — ยังไม่มีไฟล์ = สร้างตามกติกาเดิมของแต่ละใบ; แม่แบบเปลี่ยนแล้ว → 409 `invoice_pdf_template_changed`) · header `X-Content-SHA256`, `X-Bundle-Contents` (เลขเอกสารตามลำดับ คั่นด้วย `,`) · ต้องมี `prices.sell:read`

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
| `404` | ไม่พบใบวางบิล (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress), [invoice_pdf_template_changed](errors.md#invoice_pdf_template_changed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/billing-notes/<id>/pdf-bundle" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/billing-notes/{id}/pdf-bundle', {
  params: { path: { id: "…" } },
});
```

## ส่งชุดใบวางบิล + ใบแจ้งหนี้ทางอีเมลถึงลูกค้า (ไฟล์รวม 1 ไฟล์) {#post-billing-notes-id-send}

`POST /v1/billing-notes/{id}/send`

scope: `invoices:finalize` · operationId: `BillingNotes_send`

สิทธิ์ `invoices:finalize` + `prices.sell:read` · ใบวางบิล ISSUED / COLLECTED (อื่น ๆ 409) · แนบไฟล์เดียวกับ `GET /billing-notes/{id}/pdf-bundle` · ผู้รับ = `to` หรือผู้ติดต่อของลูกค้าที่มีอีเมล (ไม่มี → 422 `document_email_no_recipient`) · อีเมล 1 ฉบับต่อผู้รับผ่าน outbox (ส่งโดย worker; สถานะการส่งดูที่ `GET /billing-notes/{id}/emails` — แยกจากสถานะเอกสาร) · ผู้รับเดิมยังรอส่งอยู่ (ภายใน 10 นาที) → 409 `document_email_pending` · ไฟล์เกิน 10 MB → 422 `email_attachment_too_large` (ดาวน์โหลดแล้วส่งเอง) · ใบแจ้งหนี้ในชุดที่ยังไม่มีธง "ส่งลูกค้าแล้ว" → ตั้งช่องทาง EMAIL · audit `billing_note.emailed` · บริษัททดสอบ (sandbox) ไม่ส่งออกจริง (`sandbox_suppressed`) · ส่ง `Idempotency-Key` ได้ (กดซ้ำ = ผลเดิม)

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `Idempotency-Key` | header |   | `string` | ส่งซ้ำ key เดิม + body เดิม = ผลเดิม (ไม่ส่งอีเมลซ้ำ) เก็บ 24 ชม. |

**Request body** `SendBillingNoteDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `to` |   | `array<string>` |   | อีเมลผู้รับ 1–5 คน (ไม่ซ้ำ) · ไม่ระบุ = อีเมลผู้ติดต่อของลูกค้า (ผู้ติดต่อหลักที่มีอีเมล · ไม่มีผู้ติดต่อหลักที่มีอีเมล = ผู้ติดต่อทุกคนที่มีอีเมล สูงสุด 5) · ไม่มีเลย → 422 `document_email_no_recipient` | `["ap@example.co.th"]` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `DocumentEmailResultDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:finalize`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบวางบิล (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | สถานะไม่ให้ทำรายการนี้ / ชนกับการแก้ไขพร้อมกัน — [invalid_state_transition](errors.md#invalid_state_transition), [concurrent_update](errors.md#concurrent_update), [idempotency_in_progress](errors.md#idempotency_in_progress), [invoice_pdf_template_changed](errors.md#invoice_pdf_template_changed), [document_email_pending](errors.md#document_email_pending) | `ProblemDto` |
| `422` | `validation_failed` — `to` ผิดรูปแบบ/ซ้ำ/เกิน 5 · `document_email_no_recipient` — ไม่ระบุ `to` และลูกค้าไม่มีอีเมลผู้ติดต่อ · `email_attachment_too_large` — ไฟล์แนบเกินขนาด (`sizeBytes`, `maxBytes`) → ดาวน์โหลดแล้วส่งเอง — [validation_failed](errors.md#validation_failed), [document_email_no_recipient](errors.md#document_email_no_recipient), [email_attachment_too_large](errors.md#email_attachment_too_large) | `ProblemDto` |
| `429` | `rate_limited` — อีเมลเอกสารของบริษัทเกิน 200 ผู้รับต่อชั่วโมง (`limit`, `sentLastHour`) — ลองใหม่ภายหลังหรือดาวน์โหลดแล้วส่งเอง — [rate_limited](errors.md#rate_limited) | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/billing-notes/<id>/send" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"to":["ap@example.co.th"]}'
```

```ts
const { data, error } = await tms.POST('/v1/billing-notes/{id}/send', {
  params: { path: { id: "…" } },
  body: {
    "to": [
      "ap@example.co.th"
    ]
  },
});
```

## ประวัติการส่งใบวางบิลทางอีเมล + สถานะการส่งต่อผู้รับ {#get-billing-notes-id-emails}

`GET /v1/billing-notes/{id}/emails`

scope: `invoices:read` · operationId: `BillingNotes_emails`

ใหม่สุดก่อน (สูงสุด 100) · สถานะ QUEUED / SENT / FAILED แยกจากสถานะเอกสาร

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `DocumentEmailListDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบใบวางบิล (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/billing-notes/<id>/emails" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/billing-notes/{id}/emails', {
  params: { path: { id: "…" } },
});
```

## Schema ของ response {#schemas}

### BillingNoteCandidatesDto {#schema-BillingNoteCandidatesDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<BillingNoteCandidateDto>` |   |   |   |

### BillingNoteDto {#schema-BillingNoteDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `bn_…` |
| `billingNoteNo` | ใช่ | `string` | null ได้ | เลขใบวางบิล (ชุด BN) — **ร่างไม่มีเลข** |   |
| `status` | ใช่ | `string` | ค่า: `DRAFT`, `ISSUED`, `COLLECTED`, `CANCELLED` |   |   |
| `customer` | ใช่ | `InvoiceCustomerDto` |   |   |   |
| `invoiceCount` | ใช่ | `number` |   | จำนวนใบแจ้งหนี้ในใบ |   |
| `billingDate` | ใช่ | `string` | null ได้ | วันวางบิล (วันที่ออก) — ร่าง = null |   |
| `collectionDate` | ใช่ | `string` | null ได้ | วันนัดรับเช็ค/โอน |   |
| `sellTotal` |   | `string` |   | ยอดวางบิล (Σ ยอดค้างของใบแจ้งหนี้) — `prices.sell:read` |   |
| `sellNetExpected` |   | `string` |   | ยอดวางบิล − WHT ที่คาดว่าจะถูกหัก (ประมาณการ) — `prices.sell:read` |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string` |   |   |   |
| `updatedAt` | ใช่ | `string` |   |   |   |
| `issuingCompanyId` | ใช่ | `string` |   |   | `cmp_…` |
| `issuingBranchId` | ใช่ | `string` |   |   | `brn_…` |
| `sellWhtExpected` |   | `string` |   | Σ WHT ที่คาดว่าจะถูกหัก — `prices.sell:read` |   |
| `note` | ใช่ | `string` | null ได้ |   |   |
| `invoices` | ใช่ | `array<BillingNoteInvoiceDto>` |   | ใบแจ้งหนี้ในใบ (รวมที่ถอดออกจากร่างแล้ว `active=false`) |   |
| `acknowledgement` | ใช่ | `BillingNoteAcknowledgementDto` | null ได้ | ผู้รับวางบิล — ยังไม่บันทึก = null |   |
| `collectedAt` | ใช่ | `string` | null ได้ |   |   |
| `collectedBy` | ใช่ | `string` | null ได้ |   |   |
| `collectNote` | ใช่ | `string` | null ได้ |   |   |
| `cancelledAt` | ใช่ | `string` | null ได้ |   |   |
| `cancelReason` | ใช่ | `string` | null ได้ |   |   |
| `createdBy` | ใช่ | `string` | null ได้ |   |   |
| `issuedAt` | ใช่ | `string` | null ได้ |   |   |
| `issuedBy` | ใช่ | `string` | null ได้ |   |   |
| `pdf` | ใช่ | `InvoicePdfDto` | null ได้ | PDF ต้นฉบับที่เก็บ ณ วันออก — null = ร่าง หรือยังไม่ได้ render (`GET /v1/billing-notes/{id}/pdf` สร้างให้) |   |

### BillingNotePageDto {#schema-BillingNotePageDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<BillingNoteSummaryDto>` |   |   |   |
| `nextCursor` | ใช่ | `string` | null ได้ |   |   |
| `hasMore` | ใช่ | `boolean` |   |   |   |

### BillingNoteSummaryCountsDto {#schema-BillingNoteSummaryCountsDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `total` | ใช่ | `number` |   |   |   |
| `draft` | ใช่ | `number` |   |   |   |
| `issued` | ใช่ | `number` |   |   |   |
| `collected` | ใช่ | `number` |   |   |   |
| `cancelled` | ใช่ | `number` |   |   |   |

### DocumentEmailListDto {#schema-DocumentEmailListDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<DocumentEmailDto>` |   | ใหม่สุดก่อน (สูงสุด 100 รายการ) |   |

### DocumentEmailResultDto {#schema-DocumentEmailResultDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `attachment` | ใช่ | `DocumentEmailAttachmentDto` |   |   |   |
| `emails` | ใช่ | `array<DocumentEmailDto>` |   | 1 แถวต่อผู้รับ (สถานะเริ่ม QUEUED) |   |
