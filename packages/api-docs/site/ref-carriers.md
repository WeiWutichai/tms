# รถร่วม (carriers)

15 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`GET /v1/carriers/{id}/recent-prices`](#get-carriers-id-recent-prices) | `prices.buy:read` |
| [`GET /v1/carriers`](#get-carriers) | `master:read` |
| [`POST /v1/carriers`](#post-carriers) | `master:write` |
| [`GET /v1/carriers/summary`](#get-carriers-summary) | `master:read` |
| [`GET /v1/carriers/next-code`](#get-carriers-next-code) | `master:write` |
| [`GET /v1/carriers/export`](#get-carriers-export) | `export:run` |
| [`PUT /v1/carriers/external/{externalId}`](#put-carriers-external-externalId) | `master:write` |
| [`PATCH /v1/carriers/external/{externalId}`](#patch-carriers-external-externalId) | `master:write` |
| [`GET /v1/carriers/{id}`](#get-carriers-id) | `master:read` |
| [`PATCH /v1/carriers/{id}`](#patch-carriers-id) | `master:write` |
| [`GET /v1/carriers/{id}/history`](#get-carriers-id-history) | `master:read` |
| [`POST /v1/carriers/{id}/reveal`](#post-carriers-id-reveal) | `settlements:pay` |
| [`POST /v1/carriers/{id}/deactivate`](#post-carriers-id-deactivate) | `master:write` |
| [`POST /v1/carriers/{id}/activate`](#post-carriers-id-activate) | `master:write` |
| [`POST /v1/carriers/{id}/delete`](#post-carriers-id-delete) | `master:write` |

## GET /v1/carriers/{id}/recent-prices {#get-carriers-id-recent-prices}

`GET /v1/carriers/{id}/recent-prices`

scope: `prices.buy:read` · operationId: `CarrierRecentPrices_recentPrices`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `originId` | query |   | `string` | เฉพาะเที่ยวที่ต้นทาง (จุดแรก) เป็นสถานที่นี้ (loc_…) |
| `destinationId` | query |   | `string` | เฉพาะเที่ยวที่ปลายทาง (จุดสุดท้าย) เป็นสถานที่นี้ (loc_…) |
| `vehicleTypeId` | query |   | `string` | เฉพาะเที่ยวที่ใช้รถประเภทนี้ (vty_…) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `CarrierRecentPricesDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`prices.buy:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/carriers/<id>/recent-prices" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/carriers/{id}/recent-prices', {
  params: { path: { id: "…" } },
});
```

## GET /v1/carriers {#get-carriers}

`GET /v1/carriers`

scope: `master:read` · operationId: `Carriers_list`

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
| `name` | query |   | `string` | ชื่อมีคำนี้ |
| `entityType` | query |   | `string` ค่า: `INDIVIDUAL`, `JURISTIC` |   |
| `parentCarrierId` | query |   | `string` | เฉพาะที่สังกัด carrier นี้ (car_…) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `CarrierPageDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/carriers" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/carriers');
```

## POST /v1/carriers {#post-carriers}

`POST /v1/carriers`

scope: `master:write` · operationId: `Carriers_create`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `Idempotency-Key` | header |   | `string` |   |

**Request body** `CreateCarrierDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `branchCode` |   | `string` | null ได้ | รหัสสาขา 5 หลัก — นิติบุคคลไม่ส่ง = 00000 (สำนักงานใหญ่); บุคคลธรรมดาไม่มีสาขา | `00000` |
| `address` |   | `CarrierAddressDto` | null ได้ | ที่อยู่ (พิมพ์บน 50 ทวิ) |   |
| `address.line1` | ใช่ | `string` |   |   | `22 หมู่ 3 ต.บางพลีใหญ่ อ.บางพลี จ.สมุทรปราการ 10540` |
| `address.line2` |   | `string` |   |   |   |
| `address.subdistrict` |   | `string` |   |   |   |
| `address.district` |   | `string` |   |   |   |
| `address.province` |   | `string` |   |   |   |
| `address.postcode` |   | `string` |   |   | `10540` |
| `whtRate` |   | `string` | ค่า: `1.00`, `3.00` | อัตราหัก ณ ที่จ่ายตั้งต้น (ค่าเริ่มต้น 1.00 = ค่าขนส่ง) — ค่าจริงอยู่ที่บรรทัด settlement |   |
| `bankAccount` |   | `CarrierBankAccountInputDto` | null ได้ | บัญชีรับเงิน — null = ลบบัญชี |   |
| `bankAccount.bankCode` | ใช่ | `string` | ค่า: `KBANK`, `SCB`, `BBL`, `KTB`, `BAY`, `TTB`, `GSB`, `BAAC`, `GHB`, `KKP`, `CIMBT`, `UOBT`, `TISCO`, `LHFG`, `ICBCT`, `TCRB`, `IBANK` | รหัสธนาคาร | `KBANK` |
| `bankAccount.accountNo` |   | `string` |   | เลขบัญชี 10–15 หลัก (ขีด/ช่องว่างตัดให้) — ตอนแก้ไม่ส่ง = คงเลขเดิม (ต้องมีบัญชีอยู่แล้ว) | `1234567891` |
| `bankAccount.accountName` | ใช่ | `string` |   | ชื่อบัญชี | `หจก. ทรัพย์สมบูรณ์ขนส่ง` |
| `paymentTermDays` |   | `number` | ≥ 0 · ≤ 365 | เงื่อนไขจ่าย (วัน) — ค่าเริ่มต้น 30 |   |
| `requirePodToPay` |   | `boolean` |   | ไม่มี POD ไม่จ่าย (ค่าเริ่มต้น true) |   |
| `phone` |   | `string` | null ได้ |   | `081-234-5678` |
| `lineContact` |   | `string` | null ได้ | LINE ID สำหรับส่งใบสั่งงาน | `@sapsomboon` |
| `parentCarrierId` |   | `string` | null ได้ | สังกัด (parent carrier) — ต้องอยู่ใน tenant เดียวกัน ห้ามวน | `car_…` |
| `billingCompanyId` |   | `string` | null ได้ | จ้างในนาม — null = ใช้ค่าเริ่มต้นขององค์กร | `cmp_…` |
| `maxTripsPerDay` |   | `number` | ≥ 1 · ≤ 999 · null ได้ | เพดานเที่ยว/วัน — null = ไม่จำกัด |   |
| `priority` |   | `number` | ≥ 1 · ≤ 999 · null ได้ | ลำดับใน cascade (1 = เสนองานก่อน) — null = ไม่จัดลำดับ |   |
| `legalName` | ใช่ | `string` |   | ชื่อผู้รับเหมา (ตามบัตร/จดทะเบียน) | `หจก. ทรัพย์สมบูรณ์ขนส่ง` |
| `entityType` | ใช่ | `string` | ค่า: `INDIVIDUAL`, `JURISTIC` | INDIVIDUAL = บุคคลธรรมดา (ภ.ง.ด.3), JURISTIC = นิติบุคคล (ภ.ง.ด.53) |   |
| `taxId` | ใช่ | `string` |   | เลขผู้เสียภาษี 13 หลัก (ตรวจ check digit — ผิด → 422) · บุคคลธรรมดา = เลขบัตรประชาชน (เก็บแบบเข้ารหัส ไม่คืนใน response) | `0103556012345` |
| `code` |   | `string` |   | รหัส — ไม่ส่ง = ระบบออกเลขถัดไป | `SUB-0001` |
| `externalId` |   | `string` |   | รหัสในระบบต้นทาง — เรียกด้วย ext:{externalId} ได้ |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `201` |   | `CarrierDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/carriers" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"legalName":"หจก. ทรัพย์สมบูรณ์ขนส่ง","entityType":"INDIVIDUAL","taxId":"0103556012345","code":"SUB-0001"}'
```

```ts
const { data, error } = await tms.POST('/v1/carriers', {
  body: {
    "legalName": "หจก. ทรัพย์สมบูรณ์ขนส่ง",
    "entityType": "INDIVIDUAL",
    "taxId": "0103556012345",
    "code": "SUB-0001"
  },
});
```

## GET /v1/carriers/summary {#get-carriers-summary}

`GET /v1/carriers/summary`

scope: `master:read` · operationId: `Carriers_summary`

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `CarrierSummaryDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/carriers/summary" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/carriers/summary');
```

## GET /v1/carriers/next-code {#get-carriers-next-code}

`GET /v1/carriers/next-code`

scope: `master:write` · operationId: `Carriers_nextCode`

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | รหัสที่ระบบจะออกให้ผู้รับเหมาใหม่ (`SUB-0001`) | `NextCodeDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/carriers/next-code" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/carriers/next-code');
```

## GET /v1/carriers/export {#get-carriers-export}

`GET /v1/carriers/export`

scope: `export:run` · operationId: `Carriers_export`

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
| `name` | query |   | `string` | ชื่อมีคำนี้ |
| `entityType` | query |   | `string` ค่า: `INDIVIDUAL`, `JURISTIC` |   |
| `parentCarrierId` | query |   | `string` | เฉพาะที่สังกัด carrier นี้ (car_…) |
| `format` | query |   | `string` ค่า: `xlsx`, `csv` |   |
| `ids` | query |   | `string` | ส่งออกเฉพาะ id เหล่านี้ (คั่นด้วย,) — แถวที่เลือกในตาราง |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | ไฟล์.xlsx หรือ.csv ตามตัวกรองเดียวกับรายการ (สูงสุด 10,000 แถว) — เลขบัตร/เลขบัญชีปิดบังเสมอ |   |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`export:run`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/carriers/export" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/carriers/export');
```

## PUT /v1/carriers/external/{externalId} {#put-carriers-external-externalId}

`PUT /v1/carriers/external/{externalId}`

scope: `master:write` · operationId: `Carriers_upsertExternal`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `externalId` | path | ใช่ | `string` | เลขของระบบต้นทาง (ASCII ที่พิมพ์ได้ 1–100 ตัว ไม่มีช่องว่าง) — unique ต่อ tenant ต่อ resource |
| `If-Match` | header |   | `string` | ETag — ใช้เมื่อแถวมีอยู่แล้ว |

**Request body** `UpsertCarrierDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `branchCode` |   | `string` | null ได้ | รหัสสาขา 5 หลัก — นิติบุคคลไม่ส่ง = 00000 (สำนักงานใหญ่); บุคคลธรรมดาไม่มีสาขา | `00000` |
| `address` |   | `CarrierAddressDto` | null ได้ | ที่อยู่ (พิมพ์บน 50 ทวิ) |   |
| `address.line1` | ใช่ | `string` |   |   | `22 หมู่ 3 ต.บางพลีใหญ่ อ.บางพลี จ.สมุทรปราการ 10540` |
| `address.line2` |   | `string` |   |   |   |
| `address.subdistrict` |   | `string` |   |   |   |
| `address.district` |   | `string` |   |   |   |
| `address.province` |   | `string` |   |   |   |
| `address.postcode` |   | `string` |   |   | `10540` |
| `whtRate` |   | `string` | ค่า: `1.00`, `3.00` | อัตราหัก ณ ที่จ่ายตั้งต้น (ค่าเริ่มต้น 1.00 = ค่าขนส่ง) — ค่าจริงอยู่ที่บรรทัด settlement |   |
| `bankAccount` |   | `CarrierBankAccountInputDto` | null ได้ | บัญชีรับเงิน — null = ลบบัญชี |   |
| `bankAccount.bankCode` | ใช่ | `string` | ค่า: `KBANK`, `SCB`, `BBL`, `KTB`, `BAY`, `TTB`, `GSB`, `BAAC`, `GHB`, `KKP`, `CIMBT`, `UOBT`, `TISCO`, `LHFG`, `ICBCT`, `TCRB`, `IBANK` | รหัสธนาคาร | `KBANK` |
| `bankAccount.accountNo` |   | `string` |   | เลขบัญชี 10–15 หลัก (ขีด/ช่องว่างตัดให้) — ตอนแก้ไม่ส่ง = คงเลขเดิม (ต้องมีบัญชีอยู่แล้ว) | `1234567891` |
| `bankAccount.accountName` | ใช่ | `string` |   | ชื่อบัญชี | `หจก. ทรัพย์สมบูรณ์ขนส่ง` |
| `paymentTermDays` |   | `number` | ≥ 0 · ≤ 365 | เงื่อนไขจ่าย (วัน) — ค่าเริ่มต้น 30 |   |
| `requirePodToPay` |   | `boolean` |   | ไม่มี POD ไม่จ่าย (ค่าเริ่มต้น true) |   |
| `phone` |   | `string` | null ได้ |   | `081-234-5678` |
| `lineContact` |   | `string` | null ได้ | LINE ID สำหรับส่งใบสั่งงาน | `@sapsomboon` |
| `parentCarrierId` |   | `string` | null ได้ | สังกัด (parent carrier) — ต้องอยู่ใน tenant เดียวกัน ห้ามวน | `car_…` |
| `billingCompanyId` |   | `string` | null ได้ | จ้างในนาม — null = ใช้ค่าเริ่มต้นขององค์กร | `cmp_…` |
| `maxTripsPerDay` |   | `number` | ≥ 1 · ≤ 999 · null ได้ | เพดานเที่ยว/วัน — null = ไม่จำกัด |   |
| `priority` |   | `number` | ≥ 1 · ≤ 999 · null ได้ | ลำดับใน cascade (1 = เสนองานก่อน) — null = ไม่จัดลำดับ |   |
| `legalName` | ใช่ | `string` |   | ชื่อผู้รับเหมา (ตามบัตร/จดทะเบียน) | `หจก. ทรัพย์สมบูรณ์ขนส่ง` |
| `entityType` | ใช่ | `string` | ค่า: `INDIVIDUAL`, `JURISTIC` | INDIVIDUAL = บุคคลธรรมดา (ภ.ง.ด.3), JURISTIC = นิติบุคคล (ภ.ง.ด.53) |   |
| `taxId` | ใช่ | `string` |   | เลขผู้เสียภาษี 13 หลัก (ตรวจ check digit — ผิด → 422) · บุคคลธรรมดา = เลขบัตรประชาชน (เก็บแบบเข้ารหัส ไม่คืนใน response) | `0103556012345` |
| `code` |   | `string` |   | ใช้ตอนสร้างเท่านั้น | `SUB-0001` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | มีอยู่แล้ว → อัปเดต (ส่งซ้ำได้ ไม่เกิดแถวใหม่) | `CarrierDto` |
| `201` | ยังไม่มี → สร้าง | `CarrierDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `409` | ขัดกับข้อมูลที่มีอยู่ (เช่น รหัส/ชื่อซ้ำ, สถานะไม่อนุญาตให้แก้) — [conflict](errors.md#conflict), [duplicate](errors.md#duplicate) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง (รวมทุกช่องใน errors[]) — externalId ใน path ผิดรูปแบบ = field `externalId` — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PUT "$TMS_BASE_URL/v1/carriers/external/<externalId>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"legalName":"หจก. ทรัพย์สมบูรณ์ขนส่ง","entityType":"INDIVIDUAL","taxId":"0103556012345","code":"SUB-0001"}'
```

```ts
const { data, error } = await tms.PUT('/v1/carriers/external/{externalId}', {
  params: { path: { externalId: "…" } },
  body: {
    "legalName": "หจก. ทรัพย์สมบูรณ์ขนส่ง",
    "entityType": "INDIVIDUAL",
    "taxId": "0103556012345",
    "code": "SUB-0001"
  },
});
```

## แก้บางช่องด้วย externalId {#patch-carriers-external-externalId}

`PATCH /v1/carriers/external/{externalId}`

scope: `master:write` · operationId: `Carriers_patchExternal`

เหมือน `PATCH /carriers/ext:{externalId}` (กติกาเดียวกับ PATCH ด้วย id) · ยังไม่มีแถวนี้ → 404 — สร้างใหม่ใช้ PUT

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `externalId` | path | ใช่ | `string` | เลขของระบบต้นทาง (ASCII ที่พิมพ์ได้ 1–100 ตัว ไม่มีช่องว่าง) — unique ต่อ tenant ต่อ resource |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `UpdateCarrierDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `branchCode` |   | `string` | null ได้ | รหัสสาขา 5 หลัก — นิติบุคคลไม่ส่ง = 00000 (สำนักงานใหญ่); บุคคลธรรมดาไม่มีสาขา | `00000` |
| `address` |   | `CarrierAddressDto` | null ได้ | ที่อยู่ (พิมพ์บน 50 ทวิ) |   |
| `address.line1` | ใช่ | `string` |   |   | `22 หมู่ 3 ต.บางพลีใหญ่ อ.บางพลี จ.สมุทรปราการ 10540` |
| `address.line2` |   | `string` |   |   |   |
| `address.subdistrict` |   | `string` |   |   |   |
| `address.district` |   | `string` |   |   |   |
| `address.province` |   | `string` |   |   |   |
| `address.postcode` |   | `string` |   |   | `10540` |
| `whtRate` |   | `string` | ค่า: `1.00`, `3.00` | อัตราหัก ณ ที่จ่ายตั้งต้น (ค่าเริ่มต้น 1.00 = ค่าขนส่ง) — ค่าจริงอยู่ที่บรรทัด settlement |   |
| `bankAccount` |   | `CarrierBankAccountInputDto` | null ได้ | บัญชีรับเงิน — null = ลบบัญชี |   |
| `bankAccount.bankCode` | ใช่ | `string` | ค่า: `KBANK`, `SCB`, `BBL`, `KTB`, `BAY`, `TTB`, `GSB`, `BAAC`, `GHB`, `KKP`, `CIMBT`, `UOBT`, `TISCO`, `LHFG`, `ICBCT`, `TCRB`, `IBANK` | รหัสธนาคาร | `KBANK` |
| `bankAccount.accountNo` |   | `string` |   | เลขบัญชี 10–15 หลัก (ขีด/ช่องว่างตัดให้) — ตอนแก้ไม่ส่ง = คงเลขเดิม (ต้องมีบัญชีอยู่แล้ว) | `1234567891` |
| `bankAccount.accountName` | ใช่ | `string` |   | ชื่อบัญชี | `หจก. ทรัพย์สมบูรณ์ขนส่ง` |
| `paymentTermDays` |   | `number` | ≥ 0 · ≤ 365 | เงื่อนไขจ่าย (วัน) — ค่าเริ่มต้น 30 |   |
| `requirePodToPay` |   | `boolean` |   | ไม่มี POD ไม่จ่าย (ค่าเริ่มต้น true) |   |
| `phone` |   | `string` | null ได้ |   | `081-234-5678` |
| `lineContact` |   | `string` | null ได้ | LINE ID สำหรับส่งใบสั่งงาน | `@sapsomboon` |
| `parentCarrierId` |   | `string` | null ได้ | สังกัด (parent carrier) — ต้องอยู่ใน tenant เดียวกัน ห้ามวน | `car_…` |
| `billingCompanyId` |   | `string` | null ได้ | จ้างในนาม — null = ใช้ค่าเริ่มต้นขององค์กร | `cmp_…` |
| `maxTripsPerDay` |   | `number` | ≥ 1 · ≤ 999 · null ได้ | เพดานเที่ยว/วัน — null = ไม่จำกัด |   |
| `priority` |   | `number` | ≥ 1 · ≤ 999 · null ได้ | ลำดับใน cascade (1 = เสนองานก่อน) — null = ไม่จัดลำดับ |   |
| `legalName` |   | `string` |   |   | `หจก. ทรัพย์สมบูรณ์ขนส่ง` |
| `entityType` |   | `string` | ค่า: `INDIVIDUAL`, `JURISTIC` | เปลี่ยนประเภท: เลขเดิมย้ายที่เก็บให้เอง (นิติบุคคล ↔ เข้ารหัส) |   |
| `taxId` |   | `string` |   | ไม่ส่ง = คงเลขเดิม | `0103556012345` |
| `externalId` |   | `string` | null ได้ | null = ลบการผูก |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `CarrierDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ยังไม่มีแถวที่ externalId นี้ (สร้างใหม่ใช้ PUT) หรืออยู่ tenant อื่น — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | ขัดกับข้อมูลที่มีอยู่ (เช่น รหัส/ชื่อซ้ำ, สถานะไม่อนุญาตให้แก้) — [conflict](errors.md#conflict), [duplicate](errors.md#duplicate) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง (รวมทุกช่องใน errors[]) — externalId ใน path ผิดรูปแบบ = field `externalId` — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PATCH "$TMS_BASE_URL/v1/carriers/external/<externalId>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"legalName":"หจก. ทรัพย์สมบูรณ์ขนส่ง","taxId":"0103556012345"}'
```

```ts
const { data, error } = await tms.PATCH('/v1/carriers/external/{externalId}', {
  params: { path: { externalId: "…" } },
  body: {
    "legalName": "หจก. ทรัพย์สมบูรณ์ขนส่ง",
    "taxId": "0103556012345"
  },
});
```

## GET /v1/carriers/{id} {#get-carriers-id}

`GET /v1/carriers/{id}`

scope: `master:read` · operationId: `Carriers_get`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `CarrierDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/carriers/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/carriers/{id}', {
  params: { path: { id: "…" } },
});
```

## PATCH /v1/carriers/{id} {#patch-carriers-id}

`PATCH /v1/carriers/{id}`

scope: `master:write` · operationId: `Carriers_update`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `UpdateCarrierDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `branchCode` |   | `string` | null ได้ | รหัสสาขา 5 หลัก — นิติบุคคลไม่ส่ง = 00000 (สำนักงานใหญ่); บุคคลธรรมดาไม่มีสาขา | `00000` |
| `address` |   | `CarrierAddressDto` | null ได้ | ที่อยู่ (พิมพ์บน 50 ทวิ) |   |
| `address.line1` | ใช่ | `string` |   |   | `22 หมู่ 3 ต.บางพลีใหญ่ อ.บางพลี จ.สมุทรปราการ 10540` |
| `address.line2` |   | `string` |   |   |   |
| `address.subdistrict` |   | `string` |   |   |   |
| `address.district` |   | `string` |   |   |   |
| `address.province` |   | `string` |   |   |   |
| `address.postcode` |   | `string` |   |   | `10540` |
| `whtRate` |   | `string` | ค่า: `1.00`, `3.00` | อัตราหัก ณ ที่จ่ายตั้งต้น (ค่าเริ่มต้น 1.00 = ค่าขนส่ง) — ค่าจริงอยู่ที่บรรทัด settlement |   |
| `bankAccount` |   | `CarrierBankAccountInputDto` | null ได้ | บัญชีรับเงิน — null = ลบบัญชี |   |
| `bankAccount.bankCode` | ใช่ | `string` | ค่า: `KBANK`, `SCB`, `BBL`, `KTB`, `BAY`, `TTB`, `GSB`, `BAAC`, `GHB`, `KKP`, `CIMBT`, `UOBT`, `TISCO`, `LHFG`, `ICBCT`, `TCRB`, `IBANK` | รหัสธนาคาร | `KBANK` |
| `bankAccount.accountNo` |   | `string` |   | เลขบัญชี 10–15 หลัก (ขีด/ช่องว่างตัดให้) — ตอนแก้ไม่ส่ง = คงเลขเดิม (ต้องมีบัญชีอยู่แล้ว) | `1234567891` |
| `bankAccount.accountName` | ใช่ | `string` |   | ชื่อบัญชี | `หจก. ทรัพย์สมบูรณ์ขนส่ง` |
| `paymentTermDays` |   | `number` | ≥ 0 · ≤ 365 | เงื่อนไขจ่าย (วัน) — ค่าเริ่มต้น 30 |   |
| `requirePodToPay` |   | `boolean` |   | ไม่มี POD ไม่จ่าย (ค่าเริ่มต้น true) |   |
| `phone` |   | `string` | null ได้ |   | `081-234-5678` |
| `lineContact` |   | `string` | null ได้ | LINE ID สำหรับส่งใบสั่งงาน | `@sapsomboon` |
| `parentCarrierId` |   | `string` | null ได้ | สังกัด (parent carrier) — ต้องอยู่ใน tenant เดียวกัน ห้ามวน | `car_…` |
| `billingCompanyId` |   | `string` | null ได้ | จ้างในนาม — null = ใช้ค่าเริ่มต้นขององค์กร | `cmp_…` |
| `maxTripsPerDay` |   | `number` | ≥ 1 · ≤ 999 · null ได้ | เพดานเที่ยว/วัน — null = ไม่จำกัด |   |
| `priority` |   | `number` | ≥ 1 · ≤ 999 · null ได้ | ลำดับใน cascade (1 = เสนองานก่อน) — null = ไม่จัดลำดับ |   |
| `legalName` |   | `string` |   |   | `หจก. ทรัพย์สมบูรณ์ขนส่ง` |
| `entityType` |   | `string` | ค่า: `INDIVIDUAL`, `JURISTIC` | เปลี่ยนประเภท: เลขเดิมย้ายที่เก็บให้เอง (นิติบุคคล ↔ เข้ารหัส) |   |
| `taxId` |   | `string` |   | ไม่ส่ง = คงเลขเดิม | `0103556012345` |
| `externalId` |   | `string` | null ได้ | null = ลบการผูก |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `CarrierDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PATCH "$TMS_BASE_URL/v1/carriers/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"legalName":"หจก. ทรัพย์สมบูรณ์ขนส่ง","taxId":"0103556012345"}'
```

```ts
const { data, error } = await tms.PATCH('/v1/carriers/{id}', {
  params: { path: { id: "…" } },
  body: {
    "legalName": "หจก. ทรัพย์สมบูรณ์ขนส่ง",
    "taxId": "0103556012345"
  },
});
```

## GET /v1/carriers/{id}/history {#get-carriers-id-history}

`GET /v1/carriers/{id}/history`

scope: `master:read` · operationId: `Carriers_history`

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
curl -sS -X GET "$TMS_BASE_URL/v1/carriers/<id>/history" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/carriers/{id}/history', {
  params: { path: { id: "…" } },
});
```

## POST /v1/carriers/{id}/reveal {#post-carriers-id-reveal}

`POST /v1/carriers/{id}/reveal`

scope: `settlements:pay` · operationId: `Carriers_reveal`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |

**Request body** `RevealCarrierDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `field` | ใช่ | `string` | ค่า: `taxId`, `bankAccountNo` | taxId = เลขผู้เสียภาษี/เลขบัตรประชาชนเต็ม · bankAccountNo = เลขบัญชีเต็ม |   |
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 | เหตุผล ≥ 10 ตัวอักษร (ลง audit log) |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `RevealCarrierResultDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settlements:pay`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เกิน 20 ครั้ง/นาที/ผู้ใช้ (Retry-After) | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/carriers/<id>/reveal" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"field":"taxId","reason":"string"}'
```

```ts
const { data, error } = await tms.POST('/v1/carriers/{id}/reveal', {
  params: { path: { id: "…" } },
  body: {
    "field": "taxId",
    "reason": "string"
  },
});
```

## POST /v1/carriers/{id}/deactivate {#post-carriers-id-deactivate}

`POST /v1/carriers/{id}/deactivate`

scope: `master:write` · operationId: `Carriers_deactivate`

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
| `200` |   | `CarrierDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/carriers/<id>/deactivate" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"เลิกใช้บริการตั้งแต่ ธ.ค. 2569"}'
```

```ts
const { data, error } = await tms.POST('/v1/carriers/{id}/deactivate', {
  params: { path: { id: "…" } },
  body: {
    "reason": "เลิกใช้บริการตั้งแต่ ธ.ค. 2569"
  },
});
```

## POST /v1/carriers/{id}/activate {#post-carriers-id-activate}

`POST /v1/carriers/{id}/activate`

scope: `master:write` · operationId: `Carriers_activate`

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
| `200` |   | `CarrierDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/carriers/<id>/activate" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{}'
```

```ts
const { data, error } = await tms.POST('/v1/carriers/{id}/activate', {
  params: { path: { id: "…" } },
  body: {},
});
```

## POST /v1/carriers/{id}/delete {#post-carriers-id-delete}

`POST /v1/carriers/{id}/delete`

scope: `master:write` · operationId: `Carriers_remove`

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
curl -sS -X POST "$TMS_BASE_URL/v1/carriers/<id>/delete" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"เลิกใช้บริการตั้งแต่ ธ.ค. 2569"}'
```

```ts
const { data, error } = await tms.POST('/v1/carriers/{id}/delete', {
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

### CarrierDto {#schema-CarrierDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `car_3f2a…` |
| `code` | ใช่ | `string` |   |   | `SUB-0001` |
| `externalId` | ใช่ | `string` | null ได้ |   |   |
| `legalName` | ใช่ | `string` |   |   | `หจก. ทรัพย์สมบูรณ์ขนส่ง` |
| `entityType` | ใช่ | `string` | ค่า: `INDIVIDUAL`, `JURISTIC` |   |   |
| `whtForm` | ใช่ | `string` | ค่า: `PND3`, `PND53` | แบบยื่นภาษีหัก ณ ที่จ่าย (คำนวณจากประเภท) |   |
| `taxId` | ใช่ | `string` | null ได้ | เลขผู้เสียภาษีเต็ม — เฉพาะนิติบุคคล; บุคคลธรรมดา = null (ดู taxIdLast4) |   |
| `taxIdLast4` | ใช่ | `string` | null ได้ | 4 หลักท้าย | `2345` |
| `branchCode` | ใช่ | `string` | null ได้ |   |   |
| `address` | ใช่ | `CarrierAddressDto` | null ได้ |   |   |
| `whtRate` | ใช่ | `string` | ค่า: `1.00`, `3.00` |   |   |
| `bankAccount` | ใช่ | `CarrierBankAccountDto` | null ได้ |   |   |
| `paymentTermDays` | ใช่ | `number` |   |   |   |
| `requirePodToPay` | ใช่ | `boolean` |   |   |   |
| `phone` | ใช่ | `string` | null ได้ |   |   |
| `lineContact` | ใช่ | `string` | null ได้ |   |   |
| `parent` | ใช่ | `CarrierRefDto` | null ได้ |   |   |
| `billingCompanyId` | ใช่ | `string` | null ได้ | จ้างในนาม (cmp_…) |   |
| `maxTripsPerDay` | ใช่ | `number` | null ได้ |   |   |
| `priority` | ใช่ | `number` | null ได้ |   |   |
| `usage` | ใช่ | `CarrierUsageDto` |   |   |   |
| `status` | ใช่ | `string` | ค่า: `active`, `inactive` | inactive = ระงับชั่วคราว |   |
| `deletedAt` |   | `string (date-time)` | null ได้ | มีค่าเฉพาะเมื่อขอ includeDeleted=true และรายการถูกลบแล้ว (tombstone) |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string (date-time)` |   |   |   |
| `updatedAt` | ใช่ | `string (date-time)` |   |   |   |

### CarrierPageDto {#schema-CarrierPageDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<CarrierDto>` |   |   |   |
| `nextCursor` | ใช่ | `string` | null ได้ |   |   |
| `hasMore` | ใช่ | `boolean` |   |   |   |

### CarrierRecentPricesDto {#schema-CarrierRecentPricesDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<CarrierRecentPriceDto>` |   | ใหม่สุดก่อน ไม่เกิน 5 เที่ยว · ยังไม่เคยจ้าง = [] |   |

### CarrierSummaryDto {#schema-CarrierSummaryDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `total` | ใช่ | `number` |   | ผู้รับเหมาทั้งหมด (ไม่รวมที่ลบ) |   |
| `active` | ใช่ | `number` |   |   |   |
| `inactive` | ใช่ | `number` |   | ระงับชั่วคราว |   |
| `individual` | ใช่ | `number` |   |   |   |
| `juristic` | ใช่ | `number` |   |   |   |

### NextCodeDto {#schema-NextCodeDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `code` | ใช่ | `string` |   |   | `CUS-0010` |

### RevealCarrierResultDto {#schema-RevealCarrierResultDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `field` | ใช่ | `string` | ค่า: `taxId`, `bankAccountNo` |   |   |
| `value` | ใช่ | `string` | null ได้ | ค่าเต็ม — null = ไม่มีข้อมูล |   |
