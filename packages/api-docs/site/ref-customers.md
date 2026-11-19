# ลูกค้า (customers)

17 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`GET /v1/customers`](#get-customers) | `master:read` |
| [`POST /v1/customers`](#post-customers) | `master:write` |
| [`GET /v1/customers/summary`](#get-customers-summary) | `master:read` |
| [`GET /v1/customers/next-code`](#get-customers-next-code) | `master:write` |
| [`GET /v1/customers/export`](#get-customers-export) | `export:run` |
| [`PUT /v1/customers/external/{externalId}`](#put-customers-external-externalId) | `master:write` |
| [`PATCH /v1/customers/external/{externalId}`](#patch-customers-external-externalId) | `master:write` |
| [`GET /v1/customers/{id}`](#get-customers-id) | `master:read` |
| [`PATCH /v1/customers/{id}`](#patch-customers-id) | `master:write` |
| [`GET /v1/customers/{id}/history`](#get-customers-id-history) | `master:read` |
| [`GET /v1/customers/{id}/pod-checklist`](#get-customers-id-pod-checklist) | `master:read` |
| [`POST /v1/customers/{id}/deactivate`](#post-customers-id-deactivate) | `master:write` |
| [`POST /v1/customers/{id}/activate`](#post-customers-id-activate) | `master:write` |
| [`POST /v1/customers/{id}/delete`](#post-customers-id-delete) | `master:write` |
| [`GET /v1/customers/{id}/tracking-link`](#get-customers-id-tracking-link) | `master:write` |
| [`POST /v1/customers/{id}/tracking-link`](#post-customers-id-tracking-link) | `master:write` |
| [`POST /v1/customers/{id}/tracking-link/revoke`](#post-customers-id-tracking-link-revoke) | `master:write` |

## GET /v1/customers {#get-customers}

`GET /v1/customers`

scope: `master:read` · operationId: `Customers_list`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน (ใช้กับ sort เดิมเท่านั้น) |
| `updatedAfter` | query |   | `string` | คืนเฉพาะแถวที่ updatedAt > ค่านี้ (incremental pull — ใช้คู่ includeDeleted=true เพื่อรับรายการที่ถูกลบ) |
| `sort` | query |   | `string` ค่า: `code`, `updatedAt`, `-updatedAt` | code = เรียงตามรหัส (ค่าเริ่มต้นของหน้าจอ) · updatedAt/-updatedAt สำหรับ sync |
| `fields` | query |   | `string` | รายชื่อ field คั่นด้วย, เช่น id,legalName |
| `q` | query |   | `string` | ค้นหา — รหัส ชื่อ เลขผู้เสียภาษี หรือ externalId (ไม่สนตัวพิมพ์) |
| `status` | query |   | `string` | คั่นด้วย, เช่น active,inactive |
| `externalId` | query |   | `string` | externalId ตรงตัว (ใช้ตรวจว่ามีในระบบแล้วหรือยัง) |
| `includeDeleted` | query |   | `string` | true = รวมรายการที่ถูกลบ (tombstone มี `deletedAt`) — ให้ระบบที่ดึงแบบ incremental รู้ว่ารายการถูกลบ |
| `billingCycle` | query |   | `string` ค่า: `PER_DO`, `WEEKLY`, `MONTHLY`, `MANUAL` |   |
| `code` | query |   | `string` | รหัสขึ้นต้นด้วย/มีคำนี้ |
| `name` | query |   | `string` | ชื่อมีคำนี้ |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `CustomerPageDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/customers" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/customers');
```

## POST /v1/customers {#post-customers}

`POST /v1/customers`

scope: `master:write` · operationId: `Customers_create`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `Idempotency-Key` | header |   | `string` |   |

**Request body** `CreateCustomerDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `taxId` |   | `string` | null ได้ | เลขผู้เสียภาษี 13 หลัก (ตรวจ check digit — ผิด → 422) | `0105536012451` |
| `branchCode` |   | `string` |   | รหัสสาขา 5 หลัก (00000 = สำนักงานใหญ่) | `00000` |
| `billingAddress` |   | `CustomerAddressDto` | null ได้ |   |   |
| `billingAddress.line1` | ใช่ | `string` |   |   | `22 หมู่ 3 ต.บางพลีใหญ่ อ.บางพลี จ.สมุทรปราการ 10540` |
| `billingAddress.line2` |   | `string` |   |   |   |
| `billingAddress.subdistrict` |   | `string` |   |   |   |
| `billingAddress.district` |   | `string` |   |   |   |
| `billingAddress.province` |   | `string` |   |   |   |
| `billingAddress.postcode` |   | `string` |   |   | `10540` |
| `contacts` |   | `array<CustomerContactDto>` |   |   |   |
| `contacts[].name` | ใช่ | `string` |   |   | `คุณธีรพงษ์` |
| `contacts[].phone` |   | `string` |   |   | `02-317-4133` |
| `contacts[].email` |   | `string` |   |   | `ap@example.co.th` |
| `contacts[].isPrimary` |   | `boolean` |   | ผู้ติดต่อหลัก (ค่าเริ่มต้น false) |   |
| `creditTermDays` |   | `number` | ≥ 0 · ≤ 365 | เครดิต (วัน) — ค่าเริ่มต้น 30 |   |
| `billingCycle` |   | `string` | ค่า: `PER_DO`, `WEEKLY`, `MONTHLY`, `MANUAL` | ค่าเริ่มต้น MONTHLY |   |
| `taxInvoiceMode` |   | `string` | ค่า: `ON_PAYMENT`, `ON_ISSUE` | ออกใบกำกับภาษีเมื่อรับชำระ (tax point = รับเงิน — ค่าเริ่มต้น) / พร้อมใบแจ้งหนี้ |   |
| `defaultVatType` |   | `string` | ค่า: `EXEMPT_TRANSPORT`, `VAT_7` · null ได้ | VAT ค่าเริ่มต้นของบรรทัดใหม่ — ค่าจริงอยู่ที่บรรทัด |   |
| `whtExpectedRate` |   | `string` | ค่า: `1.00`, `0.00` · null ได้ | อัตราหัก ณ ที่จ่ายที่ลูกค้าคาดว่าจะหักเรา: 1.00 = หัก 1% (ค่าขนส่ง), 0.00 = ไม่หัก, null = ยังไม่ระบุ |   |
| `creditLimit` |   | `string` | null ได้ |   | `500000.00` |
| `vatRegistered` |   | `boolean` |   | ลูกค้าจดทะเบียน VAT (ค่าเริ่มต้น true) |   |
| `etaxCapable` |   | `boolean` |   | ลูกค้ารับใบกำกับภาษีอิเล็กทรอนิกส์ (e-Tax) ได้ (ค่าเริ่มต้น false) |   |
| `billByActualQty` |   | `boolean` |   | วางบิลตามยอดส่งจริง — true = ค่าขนส่งที่คิดตามน้ำหนัก/ปริมาตร/หน่วยนับ ใช้ปริมาณที่ส่งได้จริงจากหลักฐานส่ง (ค่าเริ่มต้น false = ตามใบสั่ง) |   |
| `freeTimeMin` |   | `number` | ≥ 0 · ≤ 1440 · null ได้ | free time ค่ารอ (นาที) — null = ใช้ค่าตั้งองค์กร `billing.freeTimeMinutes` |   |
| `podRequirements` |   | `PodRequirementsDto` |   | POD checklist ของลูกค้านี้ — `{}` = ใช้ค่าเริ่มต้นขององค์กร (`pod.checklist`); ส่งชุด `success` = กำหนดเองทั้งชุด |   |
| `podRequirements.success` |   | `PodChecklistDto` |   | ชุดเมื่อส่งสำเร็จ — ของลูกค้า: ไม่ส่ง = ใช้ค่าเริ่มต้นขององค์กร |   |
| `podRequirements.success.fields` | ใช่ | `array<PodFieldDto>` |   | PHOTO/SIGNATURE/NOTE/BARCODE/PIN/RATING มีได้อย่างละ 1 (ไม่ส่ง = DISABLED) · BOOLEAN และ SINGLE_CHOICE ได้อย่างละสูงสุด 10 ข้อ — response: ชนิดเดี่ยวครบ 6 ตัวตามลำดับ PHOTO, SIGNATURE, NOTE, BARCODE, PIN, RATING ก่อนเสมอ แล้วตามด้วย BOOLEAN/SINGLE_CHOICE ตามลำดับที่ส่งมา (ไม่จัดกลุ่มตามชนิด) |   |
| `podRequirements.failure` |   | `PodChecklistDto` |   | ชุดเมื่อส่งไม่สำเร็จ (outcome FAILED / UNDELIVERED_RETAIN) — ของลูกค้า: ไม่ส่ง = ใช้ค่าเริ่มต้นขององค์กร · ค่าองค์กร: ไม่ส่ง = ค่าระบบ (รูป ≥ 1 + หมายเหตุ บังคับ) |   |
| `podRequirements.failure.fields` | ใช่ | `array<PodFieldDto>` |   | PHOTO/SIGNATURE/NOTE/BARCODE/PIN/RATING มีได้อย่างละ 1 (ไม่ส่ง = DISABLED) · BOOLEAN และ SINGLE_CHOICE ได้อย่างละสูงสุด 10 ข้อ — response: ชนิดเดี่ยวครบ 6 ตัวตามลำดับ PHOTO, SIGNATURE, NOTE, BARCODE, PIN, RATING ก่อนเสมอ แล้วตามด้วย BOOLEAN/SINGLE_CHOICE ตามลำดับที่ส่งมา (ไม่จัดกลุ่มตามชนิด) |   |
| `billingCompanyId` |   | `string` | null ได้ | ออกบิลในนาม (Invoice As) — null = ใช้ค่าเริ่มต้นขององค์กร | `cmp_…` |
| `salesOwnerUserId` |   | `string` | null ได้ | พนักงานขาย | `usr_…` |
| `legalName` | ใช่ | `string` |   |   | `บจก. สยามพลาสติก` |
| `code` |   | `string` |   | รหัสลูกค้า — ไม่ส่ง = ระบบออกเลขถัดไป | `CUS-0001` |
| `externalId` |   | `string` |   | รหัสในระบบต้นทาง (ERP/ระบบของลูกค้า) — เรียกด้วย ext:{externalId} ได้ |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `201` |   | `CustomerDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/customers" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"branchCode":"00000","legalName":"บจก. สยามพลาสติก","code":"CUS-0001"}'
```

```ts
const { data, error } = await tms.POST('/v1/customers', {
  body: {
    "branchCode": "00000",
    "legalName": "บจก. สยามพลาสติก",
    "code": "CUS-0001"
  },
});
```

## GET /v1/customers/summary {#get-customers-summary}

`GET /v1/customers/summary`

scope: `master:read` · operationId: `Customers_summary`

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `CustomerSummaryDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/customers/summary" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/customers/summary');
```

## GET /v1/customers/next-code {#get-customers-next-code}

`GET /v1/customers/next-code`

scope: `master:write` · operationId: `Customers_nextCode`

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | รหัสที่ระบบจะออกให้ลูกค้าใหม่ | `NextCodeDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/customers/next-code" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/customers/next-code');
```

## GET /v1/customers/export {#get-customers-export}

`GET /v1/customers/export`

scope: `export:run` · operationId: `Customers_export`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน (ใช้กับ sort เดิมเท่านั้น) |
| `updatedAfter` | query |   | `string` | คืนเฉพาะแถวที่ updatedAt > ค่านี้ (incremental pull — ใช้คู่ includeDeleted=true เพื่อรับรายการที่ถูกลบ) |
| `sort` | query |   | `string` ค่า: `code`, `updatedAt`, `-updatedAt` | code = เรียงตามรหัส (ค่าเริ่มต้นของหน้าจอ) · updatedAt/-updatedAt สำหรับ sync |
| `fields` | query |   | `string` | รายชื่อ field คั่นด้วย, เช่น id,legalName |
| `q` | query |   | `string` | ค้นหา — รหัส ชื่อ เลขผู้เสียภาษี หรือ externalId (ไม่สนตัวพิมพ์) |
| `status` | query |   | `string` | คั่นด้วย, เช่น active,inactive |
| `externalId` | query |   | `string` | externalId ตรงตัว (ใช้ตรวจว่ามีในระบบแล้วหรือยัง) |
| `includeDeleted` | query |   | `string` | true = รวมรายการที่ถูกลบ (tombstone มี `deletedAt`) — ให้ระบบที่ดึงแบบ incremental รู้ว่ารายการถูกลบ |
| `billingCycle` | query |   | `string` ค่า: `PER_DO`, `WEEKLY`, `MONTHLY`, `MANUAL` |   |
| `code` | query |   | `string` | รหัสขึ้นต้นด้วย/มีคำนี้ |
| `name` | query |   | `string` | ชื่อมีคำนี้ |
| `format` | query |   | `string` ค่า: `xlsx`, `csv` |   |
| `ids` | query |   | `string` | ส่งออกเฉพาะ id เหล่านี้ (คั่นด้วย,) — แถวที่เลือกในตาราง |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | ไฟล์.xlsx หรือ.csv ตามตัวกรองเดียวกับรายการ (สูงสุด 10,000 แถว) |   |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`export:run`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/customers/export" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/customers/export');
```

## PUT /v1/customers/external/{externalId} {#put-customers-external-externalId}

`PUT /v1/customers/external/{externalId}`

scope: `master:write` · operationId: `Customers_upsertExternal`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `externalId` | path | ใช่ | `string` | เลขของระบบต้นทาง (ASCII ที่พิมพ์ได้ 1–100 ตัว ไม่มีช่องว่าง) — unique ต่อ tenant ต่อ resource |
| `If-Match` | header |   | `string` | ETag — ใช้เมื่อแถวมีอยู่แล้ว |

**Request body** `UpsertCustomerDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `taxId` |   | `string` | null ได้ | เลขผู้เสียภาษี 13 หลัก (ตรวจ check digit — ผิด → 422) | `0105536012451` |
| `branchCode` |   | `string` |   | รหัสสาขา 5 หลัก (00000 = สำนักงานใหญ่) | `00000` |
| `billingAddress` |   | `CustomerAddressDto` | null ได้ |   |   |
| `billingAddress.line1` | ใช่ | `string` |   |   | `22 หมู่ 3 ต.บางพลีใหญ่ อ.บางพลี จ.สมุทรปราการ 10540` |
| `billingAddress.line2` |   | `string` |   |   |   |
| `billingAddress.subdistrict` |   | `string` |   |   |   |
| `billingAddress.district` |   | `string` |   |   |   |
| `billingAddress.province` |   | `string` |   |   |   |
| `billingAddress.postcode` |   | `string` |   |   | `10540` |
| `contacts` |   | `array<CustomerContactDto>` |   |   |   |
| `contacts[].name` | ใช่ | `string` |   |   | `คุณธีรพงษ์` |
| `contacts[].phone` |   | `string` |   |   | `02-317-4133` |
| `contacts[].email` |   | `string` |   |   | `ap@example.co.th` |
| `contacts[].isPrimary` |   | `boolean` |   | ผู้ติดต่อหลัก (ค่าเริ่มต้น false) |   |
| `creditTermDays` |   | `number` | ≥ 0 · ≤ 365 | เครดิต (วัน) — ค่าเริ่มต้น 30 |   |
| `billingCycle` |   | `string` | ค่า: `PER_DO`, `WEEKLY`, `MONTHLY`, `MANUAL` | ค่าเริ่มต้น MONTHLY |   |
| `taxInvoiceMode` |   | `string` | ค่า: `ON_PAYMENT`, `ON_ISSUE` | ออกใบกำกับภาษีเมื่อรับชำระ (tax point = รับเงิน — ค่าเริ่มต้น) / พร้อมใบแจ้งหนี้ |   |
| `defaultVatType` |   | `string` | ค่า: `EXEMPT_TRANSPORT`, `VAT_7` · null ได้ | VAT ค่าเริ่มต้นของบรรทัดใหม่ — ค่าจริงอยู่ที่บรรทัด |   |
| `whtExpectedRate` |   | `string` | ค่า: `1.00`, `0.00` · null ได้ | อัตราหัก ณ ที่จ่ายที่ลูกค้าคาดว่าจะหักเรา: 1.00 = หัก 1% (ค่าขนส่ง), 0.00 = ไม่หัก, null = ยังไม่ระบุ |   |
| `creditLimit` |   | `string` | null ได้ |   | `500000.00` |
| `vatRegistered` |   | `boolean` |   | ลูกค้าจดทะเบียน VAT (ค่าเริ่มต้น true) |   |
| `etaxCapable` |   | `boolean` |   | ลูกค้ารับใบกำกับภาษีอิเล็กทรอนิกส์ (e-Tax) ได้ (ค่าเริ่มต้น false) |   |
| `billByActualQty` |   | `boolean` |   | วางบิลตามยอดส่งจริง — true = ค่าขนส่งที่คิดตามน้ำหนัก/ปริมาตร/หน่วยนับ ใช้ปริมาณที่ส่งได้จริงจากหลักฐานส่ง (ค่าเริ่มต้น false = ตามใบสั่ง) |   |
| `freeTimeMin` |   | `number` | ≥ 0 · ≤ 1440 · null ได้ | free time ค่ารอ (นาที) — null = ใช้ค่าตั้งองค์กร `billing.freeTimeMinutes` |   |
| `podRequirements` |   | `PodRequirementsDto` |   | POD checklist ของลูกค้านี้ — `{}` = ใช้ค่าเริ่มต้นขององค์กร (`pod.checklist`); ส่งชุด `success` = กำหนดเองทั้งชุด |   |
| `podRequirements.success` |   | `PodChecklistDto` |   | ชุดเมื่อส่งสำเร็จ — ของลูกค้า: ไม่ส่ง = ใช้ค่าเริ่มต้นขององค์กร |   |
| `podRequirements.success.fields` | ใช่ | `array<PodFieldDto>` |   | PHOTO/SIGNATURE/NOTE/BARCODE/PIN/RATING มีได้อย่างละ 1 (ไม่ส่ง = DISABLED) · BOOLEAN และ SINGLE_CHOICE ได้อย่างละสูงสุด 10 ข้อ — response: ชนิดเดี่ยวครบ 6 ตัวตามลำดับ PHOTO, SIGNATURE, NOTE, BARCODE, PIN, RATING ก่อนเสมอ แล้วตามด้วย BOOLEAN/SINGLE_CHOICE ตามลำดับที่ส่งมา (ไม่จัดกลุ่มตามชนิด) |   |
| `podRequirements.failure` |   | `PodChecklistDto` |   | ชุดเมื่อส่งไม่สำเร็จ (outcome FAILED / UNDELIVERED_RETAIN) — ของลูกค้า: ไม่ส่ง = ใช้ค่าเริ่มต้นขององค์กร · ค่าองค์กร: ไม่ส่ง = ค่าระบบ (รูป ≥ 1 + หมายเหตุ บังคับ) |   |
| `podRequirements.failure.fields` | ใช่ | `array<PodFieldDto>` |   | PHOTO/SIGNATURE/NOTE/BARCODE/PIN/RATING มีได้อย่างละ 1 (ไม่ส่ง = DISABLED) · BOOLEAN และ SINGLE_CHOICE ได้อย่างละสูงสุด 10 ข้อ — response: ชนิดเดี่ยวครบ 6 ตัวตามลำดับ PHOTO, SIGNATURE, NOTE, BARCODE, PIN, RATING ก่อนเสมอ แล้วตามด้วย BOOLEAN/SINGLE_CHOICE ตามลำดับที่ส่งมา (ไม่จัดกลุ่มตามชนิด) |   |
| `billingCompanyId` |   | `string` | null ได้ | ออกบิลในนาม (Invoice As) — null = ใช้ค่าเริ่มต้นขององค์กร | `cmp_…` |
| `salesOwnerUserId` |   | `string` | null ได้ | พนักงานขาย | `usr_…` |
| `legalName` | ใช่ | `string` |   |   | `บจก. สยามพลาสติก` |
| `code` |   | `string` |   | ใช้ตอนสร้างเท่านั้น | `CUS-0001` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | มีอยู่แล้ว → อัปเดต (ส่งซ้ำได้ ไม่เกิดแถวใหม่) | `CustomerDto` |
| `201` | ยังไม่มี → สร้าง | `CustomerDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `409` | ขัดกับข้อมูลที่มีอยู่ (เช่น รหัส/ชื่อซ้ำ, สถานะไม่อนุญาตให้แก้) — [conflict](errors.md#conflict), [duplicate](errors.md#duplicate) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง (รวมทุกช่องใน errors[]) — externalId ใน path ผิดรูปแบบ = field `externalId` — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PUT "$TMS_BASE_URL/v1/customers/external/<externalId>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"branchCode":"00000","legalName":"บจก. สยามพลาสติก","code":"CUS-0001"}'
```

```ts
const { data, error } = await tms.PUT('/v1/customers/external/{externalId}', {
  params: { path: { externalId: "…" } },
  body: {
    "branchCode": "00000",
    "legalName": "บจก. สยามพลาสติก",
    "code": "CUS-0001"
  },
});
```

## แก้บางช่องด้วย externalId {#patch-customers-external-externalId}

`PATCH /v1/customers/external/{externalId}`

scope: `master:write` · operationId: `Customers_patchExternal`

เหมือน `PATCH /customers/ext:{externalId}` (กติกาเดียวกับ PATCH ด้วย id) · ยังไม่มีแถวนี้ → 404 — สร้างใหม่ใช้ PUT

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `externalId` | path | ใช่ | `string` | เลขของระบบต้นทาง (ASCII ที่พิมพ์ได้ 1–100 ตัว ไม่มีช่องว่าง) — unique ต่อ tenant ต่อ resource |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `UpdateCustomerDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `taxId` |   | `string` | null ได้ | เลขผู้เสียภาษี 13 หลัก (ตรวจ check digit — ผิด → 422) | `0105536012451` |
| `branchCode` |   | `string` |   | รหัสสาขา 5 หลัก (00000 = สำนักงานใหญ่) | `00000` |
| `billingAddress` |   | `CustomerAddressDto` | null ได้ |   |   |
| `billingAddress.line1` | ใช่ | `string` |   |   | `22 หมู่ 3 ต.บางพลีใหญ่ อ.บางพลี จ.สมุทรปราการ 10540` |
| `billingAddress.line2` |   | `string` |   |   |   |
| `billingAddress.subdistrict` |   | `string` |   |   |   |
| `billingAddress.district` |   | `string` |   |   |   |
| `billingAddress.province` |   | `string` |   |   |   |
| `billingAddress.postcode` |   | `string` |   |   | `10540` |
| `contacts` |   | `array<CustomerContactDto>` |   |   |   |
| `contacts[].name` | ใช่ | `string` |   |   | `คุณธีรพงษ์` |
| `contacts[].phone` |   | `string` |   |   | `02-317-4133` |
| `contacts[].email` |   | `string` |   |   | `ap@example.co.th` |
| `contacts[].isPrimary` |   | `boolean` |   | ผู้ติดต่อหลัก (ค่าเริ่มต้น false) |   |
| `creditTermDays` |   | `number` | ≥ 0 · ≤ 365 | เครดิต (วัน) — ค่าเริ่มต้น 30 |   |
| `billingCycle` |   | `string` | ค่า: `PER_DO`, `WEEKLY`, `MONTHLY`, `MANUAL` | ค่าเริ่มต้น MONTHLY |   |
| `taxInvoiceMode` |   | `string` | ค่า: `ON_PAYMENT`, `ON_ISSUE` | ออกใบกำกับภาษีเมื่อรับชำระ (tax point = รับเงิน — ค่าเริ่มต้น) / พร้อมใบแจ้งหนี้ |   |
| `defaultVatType` |   | `string` | ค่า: `EXEMPT_TRANSPORT`, `VAT_7` · null ได้ | VAT ค่าเริ่มต้นของบรรทัดใหม่ — ค่าจริงอยู่ที่บรรทัด |   |
| `whtExpectedRate` |   | `string` | ค่า: `1.00`, `0.00` · null ได้ | อัตราหัก ณ ที่จ่ายที่ลูกค้าคาดว่าจะหักเรา: 1.00 = หัก 1% (ค่าขนส่ง), 0.00 = ไม่หัก, null = ยังไม่ระบุ |   |
| `creditLimit` |   | `string` | null ได้ |   | `500000.00` |
| `vatRegistered` |   | `boolean` |   | ลูกค้าจดทะเบียน VAT (ค่าเริ่มต้น true) |   |
| `etaxCapable` |   | `boolean` |   | ลูกค้ารับใบกำกับภาษีอิเล็กทรอนิกส์ (e-Tax) ได้ (ค่าเริ่มต้น false) |   |
| `billByActualQty` |   | `boolean` |   | วางบิลตามยอดส่งจริง — true = ค่าขนส่งที่คิดตามน้ำหนัก/ปริมาตร/หน่วยนับ ใช้ปริมาณที่ส่งได้จริงจากหลักฐานส่ง (ค่าเริ่มต้น false = ตามใบสั่ง) |   |
| `freeTimeMin` |   | `number` | ≥ 0 · ≤ 1440 · null ได้ | free time ค่ารอ (นาที) — null = ใช้ค่าตั้งองค์กร `billing.freeTimeMinutes` |   |
| `podRequirements` |   | `PodRequirementsDto` |   | POD checklist ของลูกค้านี้ — `{}` = ใช้ค่าเริ่มต้นขององค์กร (`pod.checklist`); ส่งชุด `success` = กำหนดเองทั้งชุด |   |
| `podRequirements.success` |   | `PodChecklistDto` |   | ชุดเมื่อส่งสำเร็จ — ของลูกค้า: ไม่ส่ง = ใช้ค่าเริ่มต้นขององค์กร |   |
| `podRequirements.success.fields` | ใช่ | `array<PodFieldDto>` |   | PHOTO/SIGNATURE/NOTE/BARCODE/PIN/RATING มีได้อย่างละ 1 (ไม่ส่ง = DISABLED) · BOOLEAN และ SINGLE_CHOICE ได้อย่างละสูงสุด 10 ข้อ — response: ชนิดเดี่ยวครบ 6 ตัวตามลำดับ PHOTO, SIGNATURE, NOTE, BARCODE, PIN, RATING ก่อนเสมอ แล้วตามด้วย BOOLEAN/SINGLE_CHOICE ตามลำดับที่ส่งมา (ไม่จัดกลุ่มตามชนิด) |   |
| `podRequirements.failure` |   | `PodChecklistDto` |   | ชุดเมื่อส่งไม่สำเร็จ (outcome FAILED / UNDELIVERED_RETAIN) — ของลูกค้า: ไม่ส่ง = ใช้ค่าเริ่มต้นขององค์กร · ค่าองค์กร: ไม่ส่ง = ค่าระบบ (รูป ≥ 1 + หมายเหตุ บังคับ) |   |
| `podRequirements.failure.fields` | ใช่ | `array<PodFieldDto>` |   | PHOTO/SIGNATURE/NOTE/BARCODE/PIN/RATING มีได้อย่างละ 1 (ไม่ส่ง = DISABLED) · BOOLEAN และ SINGLE_CHOICE ได้อย่างละสูงสุด 10 ข้อ — response: ชนิดเดี่ยวครบ 6 ตัวตามลำดับ PHOTO, SIGNATURE, NOTE, BARCODE, PIN, RATING ก่อนเสมอ แล้วตามด้วย BOOLEAN/SINGLE_CHOICE ตามลำดับที่ส่งมา (ไม่จัดกลุ่มตามชนิด) |   |
| `billingCompanyId` |   | `string` | null ได้ | ออกบิลในนาม (Invoice As) — null = ใช้ค่าเริ่มต้นขององค์กร | `cmp_…` |
| `salesOwnerUserId` |   | `string` | null ได้ | พนักงานขาย | `usr_…` |
| `legalName` |   | `string` |   | ชื่อตามจดทะเบียน (พิมพ์บนเอกสารภาษี) | `บจก. สยามพลาสติก` |
| `externalId` |   | `string` | null ได้ | null = ลบการผูก |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `CustomerDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ยังไม่มีแถวที่ externalId นี้ (สร้างใหม่ใช้ PUT) หรืออยู่ tenant อื่น — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | ขัดกับข้อมูลที่มีอยู่ (เช่น รหัส/ชื่อซ้ำ, สถานะไม่อนุญาตให้แก้) — [conflict](errors.md#conflict), [duplicate](errors.md#duplicate) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง (รวมทุกช่องใน errors[]) — externalId ใน path ผิดรูปแบบ = field `externalId` — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PATCH "$TMS_BASE_URL/v1/customers/external/<externalId>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"branchCode":"00000","legalName":"บจก. สยามพลาสติก"}'
```

```ts
const { data, error } = await tms.PATCH('/v1/customers/external/{externalId}', {
  params: { path: { externalId: "…" } },
  body: {
    "branchCode": "00000",
    "legalName": "บจก. สยามพลาสติก"
  },
});
```

## GET /v1/customers/{id} {#get-customers-id}

`GET /v1/customers/{id}`

scope: `master:read` · operationId: `Customers_get`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `CustomerDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/customers/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/customers/{id}', {
  params: { path: { id: "…" } },
});
```

## PATCH /v1/customers/{id} {#patch-customers-id}

`PATCH /v1/customers/{id}`

scope: `master:write` · operationId: `Customers_update`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `UpdateCustomerDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `taxId` |   | `string` | null ได้ | เลขผู้เสียภาษี 13 หลัก (ตรวจ check digit — ผิด → 422) | `0105536012451` |
| `branchCode` |   | `string` |   | รหัสสาขา 5 หลัก (00000 = สำนักงานใหญ่) | `00000` |
| `billingAddress` |   | `CustomerAddressDto` | null ได้ |   |   |
| `billingAddress.line1` | ใช่ | `string` |   |   | `22 หมู่ 3 ต.บางพลีใหญ่ อ.บางพลี จ.สมุทรปราการ 10540` |
| `billingAddress.line2` |   | `string` |   |   |   |
| `billingAddress.subdistrict` |   | `string` |   |   |   |
| `billingAddress.district` |   | `string` |   |   |   |
| `billingAddress.province` |   | `string` |   |   |   |
| `billingAddress.postcode` |   | `string` |   |   | `10540` |
| `contacts` |   | `array<CustomerContactDto>` |   |   |   |
| `contacts[].name` | ใช่ | `string` |   |   | `คุณธีรพงษ์` |
| `contacts[].phone` |   | `string` |   |   | `02-317-4133` |
| `contacts[].email` |   | `string` |   |   | `ap@example.co.th` |
| `contacts[].isPrimary` |   | `boolean` |   | ผู้ติดต่อหลัก (ค่าเริ่มต้น false) |   |
| `creditTermDays` |   | `number` | ≥ 0 · ≤ 365 | เครดิต (วัน) — ค่าเริ่มต้น 30 |   |
| `billingCycle` |   | `string` | ค่า: `PER_DO`, `WEEKLY`, `MONTHLY`, `MANUAL` | ค่าเริ่มต้น MONTHLY |   |
| `taxInvoiceMode` |   | `string` | ค่า: `ON_PAYMENT`, `ON_ISSUE` | ออกใบกำกับภาษีเมื่อรับชำระ (tax point = รับเงิน — ค่าเริ่มต้น) / พร้อมใบแจ้งหนี้ |   |
| `defaultVatType` |   | `string` | ค่า: `EXEMPT_TRANSPORT`, `VAT_7` · null ได้ | VAT ค่าเริ่มต้นของบรรทัดใหม่ — ค่าจริงอยู่ที่บรรทัด |   |
| `whtExpectedRate` |   | `string` | ค่า: `1.00`, `0.00` · null ได้ | อัตราหัก ณ ที่จ่ายที่ลูกค้าคาดว่าจะหักเรา: 1.00 = หัก 1% (ค่าขนส่ง), 0.00 = ไม่หัก, null = ยังไม่ระบุ |   |
| `creditLimit` |   | `string` | null ได้ |   | `500000.00` |
| `vatRegistered` |   | `boolean` |   | ลูกค้าจดทะเบียน VAT (ค่าเริ่มต้น true) |   |
| `etaxCapable` |   | `boolean` |   | ลูกค้ารับใบกำกับภาษีอิเล็กทรอนิกส์ (e-Tax) ได้ (ค่าเริ่มต้น false) |   |
| `billByActualQty` |   | `boolean` |   | วางบิลตามยอดส่งจริง — true = ค่าขนส่งที่คิดตามน้ำหนัก/ปริมาตร/หน่วยนับ ใช้ปริมาณที่ส่งได้จริงจากหลักฐานส่ง (ค่าเริ่มต้น false = ตามใบสั่ง) |   |
| `freeTimeMin` |   | `number` | ≥ 0 · ≤ 1440 · null ได้ | free time ค่ารอ (นาที) — null = ใช้ค่าตั้งองค์กร `billing.freeTimeMinutes` |   |
| `podRequirements` |   | `PodRequirementsDto` |   | POD checklist ของลูกค้านี้ — `{}` = ใช้ค่าเริ่มต้นขององค์กร (`pod.checklist`); ส่งชุด `success` = กำหนดเองทั้งชุด |   |
| `podRequirements.success` |   | `PodChecklistDto` |   | ชุดเมื่อส่งสำเร็จ — ของลูกค้า: ไม่ส่ง = ใช้ค่าเริ่มต้นขององค์กร |   |
| `podRequirements.success.fields` | ใช่ | `array<PodFieldDto>` |   | PHOTO/SIGNATURE/NOTE/BARCODE/PIN/RATING มีได้อย่างละ 1 (ไม่ส่ง = DISABLED) · BOOLEAN และ SINGLE_CHOICE ได้อย่างละสูงสุด 10 ข้อ — response: ชนิดเดี่ยวครบ 6 ตัวตามลำดับ PHOTO, SIGNATURE, NOTE, BARCODE, PIN, RATING ก่อนเสมอ แล้วตามด้วย BOOLEAN/SINGLE_CHOICE ตามลำดับที่ส่งมา (ไม่จัดกลุ่มตามชนิด) |   |
| `podRequirements.failure` |   | `PodChecklistDto` |   | ชุดเมื่อส่งไม่สำเร็จ (outcome FAILED / UNDELIVERED_RETAIN) — ของลูกค้า: ไม่ส่ง = ใช้ค่าเริ่มต้นขององค์กร · ค่าองค์กร: ไม่ส่ง = ค่าระบบ (รูป ≥ 1 + หมายเหตุ บังคับ) |   |
| `podRequirements.failure.fields` | ใช่ | `array<PodFieldDto>` |   | PHOTO/SIGNATURE/NOTE/BARCODE/PIN/RATING มีได้อย่างละ 1 (ไม่ส่ง = DISABLED) · BOOLEAN และ SINGLE_CHOICE ได้อย่างละสูงสุด 10 ข้อ — response: ชนิดเดี่ยวครบ 6 ตัวตามลำดับ PHOTO, SIGNATURE, NOTE, BARCODE, PIN, RATING ก่อนเสมอ แล้วตามด้วย BOOLEAN/SINGLE_CHOICE ตามลำดับที่ส่งมา (ไม่จัดกลุ่มตามชนิด) |   |
| `billingCompanyId` |   | `string` | null ได้ | ออกบิลในนาม (Invoice As) — null = ใช้ค่าเริ่มต้นขององค์กร | `cmp_…` |
| `salesOwnerUserId` |   | `string` | null ได้ | พนักงานขาย | `usr_…` |
| `legalName` |   | `string` |   | ชื่อตามจดทะเบียน (พิมพ์บนเอกสารภาษี) | `บจก. สยามพลาสติก` |
| `externalId` |   | `string` | null ได้ | null = ลบการผูก |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `CustomerDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PATCH "$TMS_BASE_URL/v1/customers/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"branchCode":"00000","legalName":"บจก. สยามพลาสติก"}'
```

```ts
const { data, error } = await tms.PATCH('/v1/customers/{id}', {
  params: { path: { id: "…" } },
  body: {
    "branchCode": "00000",
    "legalName": "บจก. สยามพลาสติก"
  },
});
```

## GET /v1/customers/{id}/history {#get-customers-id-history}

`GET /v1/customers/{id}/history`

scope: `master:read` · operationId: `Customers_history`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | ประวัติการแก้จาก audit log ใหม่สุดก่อน | `AuditPageDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/customers/<id>/history" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/customers/{id}/history', {
  params: { path: { id: "…" } },
});
```

## GET /v1/customers/{id}/pod-checklist {#get-customers-id-pod-checklist}

`GET /v1/customers/{id}/pod-checklist`

scope: `master:read` · operationId: `Customers_podChecklist`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `CustomerPodChecklistDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/customers/<id>/pod-checklist" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/customers/{id}/pod-checklist', {
  params: { path: { id: "…" } },
});
```

## POST /v1/customers/{id}/deactivate {#post-customers-id-deactivate}

`POST /v1/customers/{id}/deactivate`

scope: `master:write` · operationId: `Customers_deactivate`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `MasterReasonDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `เลิกใช้บริการตั้งแต่ ธ.ค. 2569` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `CustomerDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/customers/<id>/deactivate" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"เลิกใช้บริการตั้งแต่ ธ.ค. 2569"}'
```

```ts
const { data, error } = await tms.POST('/v1/customers/{id}/deactivate', {
  params: { path: { id: "…" } },
  body: {
    "reason": "เลิกใช้บริการตั้งแต่ ธ.ค. 2569"
  },
});
```

## POST /v1/customers/{id}/activate {#post-customers-id-activate}

`POST /v1/customers/{id}/activate`

scope: `master:write` · operationId: `Customers_activate`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `MasterOptionalReasonDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` |   | `string` | ยาว ≤ 500 |   |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `CustomerDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/customers/<id>/activate" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{}'
```

```ts
const { data, error } = await tms.POST('/v1/customers/{id}/activate', {
  params: { path: { id: "…" } },
  body: {},
});
```

## POST /v1/customers/{id}/delete {#post-customers-id-delete}

`POST /v1/customers/{id}/delete`

scope: `master:write` · operationId: `Customers_remove`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
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
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/customers/<id>/delete" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"เลิกใช้บริการตั้งแต่ ธ.ค. 2569"}'
```

```ts
const { data, error } = await tms.POST('/v1/customers/{id}/delete', {
  params: { path: { id: "…" } },
  body: {
    "reason": "เลิกใช้บริการตั้งแต่ ธ.ค. 2569"
  },
});
```

## GET /v1/customers/{id}/tracking-link {#get-customers-id-tracking-link}

`GET /v1/customers/{id}/tracking-link`

scope: `master:write` · operationId: `CustomerTracking_get`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | URL มี token — ต้องมีสิทธิ์ออกลิงก์ · ลิงก์หน้าติดตามของผู้รับ (`/t/{token}` — magic link `tracking`, อายุ token 90 วัน; งานจบเกิน `tracking.linkDays` วัน = ใช้ไม่ได้) · ห้าม cache (มี token) | `TrackingLinkStateDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบเที่ยว (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/customers/<id>/tracking-link" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/customers/{id}/tracking-link', {
  params: { path: { id: "…" } },
});
```

## POST /v1/customers/{id}/tracking-link {#post-customers-id-tracking-link}

`POST /v1/customers/{id}/tracking-link`

scope: `master:write` · operationId: `CustomerTracking_issue`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `201` | ออกลิงก์ใหม่ของลูกค้า — ลิงก์เดิมถูกเพิกถอน · URL มี token — ต้องมีสิทธิ์ออกลิงก์ · ลิงก์หน้าติดตามของผู้รับ (`/t/{token}` — magic link `tracking`, อายุ token 90 วัน; งานจบเกิน `tracking.linkDays` วัน = ใช้ไม่ได้) · ห้าม cache (มี token) | `TrackingLinkDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบเที่ยว (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/customers/<id>/tracking-link" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)"
```

```ts
const { data, error } = await tms.POST('/v1/customers/{id}/tracking-link', {
  params: { path: { id: "…" } },
});
```

## POST /v1/customers/{id}/tracking-link/revoke {#post-customers-id-tracking-link-revoke}

`POST /v1/customers/{id}/tracking-link/revoke`

scope: `master:write` · operationId: `CustomerTracking_revoke`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |

**Request body** `MasterReasonDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `เลิกใช้บริการตั้งแต่ ธ.ค. 2569` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | เพิกถอนลิงก์ที่ใช้ได้ (เหตุผล + audit) | `TrackingLinkStateDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบเที่ยว (รวมของบริษัทอื่น) — [not_found](errors.md#not_found) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/customers/<id>/tracking-link/revoke" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"เลิกใช้บริการตั้งแต่ ธ.ค. 2569"}'
```

```ts
const { data, error } = await tms.POST('/v1/customers/{id}/tracking-link/revoke', {
  params: { path: { id: "…" } },
  body: {
    "reason": "เลิกใช้บริการตั้งแต่ ธ.ค. 2569"
  },
});
```

## Schema ของ response {#schemas}

### AuditPageDto {#schema-AuditPageDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<AuditEntryDto>` |   |   |   |
| `nextCursor` | ใช่ | `string` | null ได้ |   |   |
| `hasMore` | ใช่ | `boolean` |   |   |   |

### CustomerDto {#schema-CustomerDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `cus_3f2a…` |
| `code` | ใช่ | `string` |   |   | `CUS-0001` |
| `externalId` | ใช่ | `string` | null ได้ |   |   |
| `legalName` | ใช่ | `string` |   |   |   |
| `taxId` | ใช่ | `string` | null ได้ |   |   |
| `branchCode` | ใช่ | `string` | null ได้ |   |   |
| `billingAddress` | ใช่ | `CustomerAddressDto` | null ได้ |   |   |
| `contacts` | ใช่ | `array<CustomerContactDto>` |   |   |   |
| `creditTermDays` | ใช่ | `number` |   |   |   |
| `billingCycle` | ใช่ | `string` | ค่า: `PER_DO`, `WEEKLY`, `MONTHLY`, `MANUAL` |   |   |
| `taxInvoiceMode` | ใช่ | `string` | ค่า: `ON_PAYMENT`, `ON_ISSUE` |   |   |
| `defaultVatType` | ใช่ | `string` | ค่า: `EXEMPT_TRANSPORT`, `VAT_7`, `ZERO_RATED` · null ได้ |   |   |
| `whtExpectedRate` | ใช่ | `string` | null ได้ |   | `1.00` |
| `creditLimit` | ใช่ | `string` | null ได้ |   |   |
| `vatRegistered` | ใช่ | `boolean` |   |   |   |
| `etaxCapable` | ใช่ | `boolean` |   |   |   |
| `billByActualQty` | ใช่ | `boolean` |   | วางบิลตามยอดส่งจริง |   |
| `freeTimeMin` | ใช่ | `number` | null ได้ |   |   |
| `billingCompanyId` | ใช่ | `string` | null ได้ | ออกบิลในนาม (cmp_…) |   |
| `podRequirements` | ใช่ | `PodRequirementsDto` |   | POD checklist ที่ลูกค้ากำหนดเอง — `{}` = ใช้ค่าเริ่มต้นขององค์กร (ดูที่ใช้จริงที่ `GET /customers/{id}/pod-checklist`) |   |
| `salesOwner` | ใช่ | `CustomerRefDto` | null ได้ |   |   |
| `status` | ใช่ | `string` | ค่า: `active`, `inactive` |   |   |
| `deletedAt` |   | `string (date-time)` | null ได้ | มีค่าเฉพาะเมื่อขอ includeDeleted=true และรายการถูกลบแล้ว (tombstone) |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string (date-time)` |   |   |   |
| `updatedAt` | ใช่ | `string (date-time)` |   |   |   |

### CustomerPageDto {#schema-CustomerPageDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<CustomerDto>` |   |   |   |
| `nextCursor` | ใช่ | `string` | null ได้ |   |   |
| `hasMore` | ใช่ | `boolean` |   |   |   |

### CustomerPodChecklistDto {#schema-CustomerPodChecklistDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<EffectivePodChecklistDto>` |   | checklist ที่ใช้จริงต่อผลการส่ง |   |

### CustomerSummaryDto {#schema-CustomerSummaryDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `total` | ใช่ | `number` |   |   |   |
| `active` | ใช่ | `number` |   |   |   |
| `inactive` | ใช่ | `number` |   |   |   |
| `noTaxId` | ใช่ | `number` |   | ไม่มีเลขผู้เสียภาษี |   |

### NextCodeDto {#schema-NextCodeDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `code` | ใช่ | `string` |   |   | `CUS-0010` |

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
