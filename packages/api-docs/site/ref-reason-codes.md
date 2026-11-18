# รหัสเหตุผล (reason-codes)

12 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`GET /v1/reason-codes`](#get-reason-codes) | `master:read` |
| [`POST /v1/reason-codes`](#post-reason-codes) | `master:write` |
| [`GET /v1/reason-codes/next-code`](#get-reason-codes-next-code) | `master:write` |
| [`GET /v1/reason-codes/export`](#get-reason-codes-export) | `export:run` |
| [`PUT /v1/reason-codes/external/{externalId}`](#put-reason-codes-external-externalId) | `master:write` |
| [`PATCH /v1/reason-codes/external/{externalId}`](#patch-reason-codes-external-externalId) | `master:write` |
| [`GET /v1/reason-codes/{id}`](#get-reason-codes-id) | `master:read` |
| [`PATCH /v1/reason-codes/{id}`](#patch-reason-codes-id) | `master:write` |
| [`GET /v1/reason-codes/{id}/history`](#get-reason-codes-id-history) | `master:read` |
| [`POST /v1/reason-codes/{id}/deactivate`](#post-reason-codes-id-deactivate) | `master:write` |
| [`POST /v1/reason-codes/{id}/activate`](#post-reason-codes-id-activate) | `master:write` |
| [`POST /v1/reason-codes/{id}/delete`](#post-reason-codes-id-delete) | `master:write` |

## GET /v1/reason-codes {#get-reason-codes}

`GET /v1/reason-codes`

scope: `master:read` · operationId: `ReasonCodes_list`

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
| `category` | query |   | `string` | หมวด คั่นด้วย, เช่น DELIVERY_FAILED,DELAY |
| `label` | query |   | `string` | ข้อความเหตุผลมีคำนี้ |
| `system` | query |   | `string` ค่า: `true`, `false` | true = เฉพาะรหัสของระบบ |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `ReasonCodePageDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/reason-codes" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/reason-codes');
```

## POST /v1/reason-codes {#post-reason-codes}

`POST /v1/reason-codes`

scope: `master:write` · operationId: `ReasonCodes_create`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `Idempotency-Key` | header |   | `string` |   |

**Request body** `CreateReasonCodeDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `labelEn` |   | `string` | null ได้ |   | `Shop closed` |
| `requiresPhoto` |   | `boolean` |   | บังคับแนบรูป (ค่าเริ่มต้น false) |   |
| `requiresNote` |   | `boolean` |   | บังคับกรอกโน้ต (ค่าเริ่มต้น false) — รายการ "อื่น ๆ" ของระบบต้องเป็น true เสมอ |   |
| `autoReschedule` |   | `boolean` |   | นัดส่งใหม่อัตโนมัติ ใช้ได้เฉพาะหมวด DELIVERY_FAILED (อื่น → 422 `not_applicable`) |   |
| `showOnTracking` |   | `boolean` |   | แสดงเหตุผลบนหน้า tracking ของผู้รับ — เฉพาะหมวด DELIVERY_FAILED / REJECTED_BY_RECEIVER / POD_MISSING / DELAY (อื่น → 422 `not_applicable`) |   |
| `sortOrder` |   | `number` | ≥ 0 · ≤ 9998 | ลำดับในหมวด (น้อยขึ้นก่อน) — ไม่ส่งตอนสร้าง = ต่อท้ายหมวด (มากสุด + 10); "อื่น ๆ" ของระบบอยู่ท้ายเสมอ (9999) |   |
| `category` | ใช่ | `string` | ค่า: `ORDER_HOLD`, `DELIVERY_FAILED`, `REJECTED_BY_RECEIVER`, `POD_MISSING`, `DELAY`, `SETTLEMENT_DISPUTE`, `CANCEL`, `OVERRIDE` | หมวด — เปลี่ยนไม่ได้หลังสร้าง |   |
| `label` | ใช่ | `string` |   | ข้อความเหตุผล — ห้ามซ้ำในหมวด (ไม่สนตัวพิมพ์) | `ลูกค้าปิดทำการ` |
| `code` |   | `string` |   | รหัส (ตัวใหญ่ A-Z 0-9 _ -) ไม่ซ้ำในหมวด — ไม่ส่ง = ระบบออกเลขถัดไป `RSN-0001` | `SHOP_CLOSED` |
| `externalId` |   | `string` |   | รหัสในระบบต้นทาง — เรียกด้วย ext:{externalId} ได้ |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `201` |   | `ReasonCodeDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/reason-codes" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"category":"ORDER_HOLD","label":"ลูกค้าปิดทำการ","code":"SHOP_CLOSED"}'
```

```ts
const { data, error } = await tms.POST('/v1/reason-codes', {
  body: {
    "category": "ORDER_HOLD",
    "label": "ลูกค้าปิดทำการ",
    "code": "SHOP_CLOSED"
  },
});
```

## GET /v1/reason-codes/next-code {#get-reason-codes-next-code}

`GET /v1/reason-codes/next-code`

scope: `master:write` · operationId: `ReasonCodes_nextCode`

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | รหัสที่ระบบจะออกให้เหตุผลใหม่ (`RSN-0001`) | `NextCodeDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/reason-codes/next-code" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/reason-codes/next-code');
```

## GET /v1/reason-codes/export {#get-reason-codes-export}

`GET /v1/reason-codes/export`

scope: `export:run` · operationId: `ReasonCodes_export`

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
| `category` | query |   | `string` | หมวด คั่นด้วย, เช่น DELIVERY_FAILED,DELAY |
| `label` | query |   | `string` | ข้อความเหตุผลมีคำนี้ |
| `system` | query |   | `string` ค่า: `true`, `false` | true = เฉพาะรหัสของระบบ |
| `format` | query |   | `string` ค่า: `xlsx`, `csv` |   |

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
curl -sS -X GET "$TMS_BASE_URL/v1/reason-codes/export" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/reason-codes/export');
```

## PUT /v1/reason-codes/external/{externalId} {#put-reason-codes-external-externalId}

`PUT /v1/reason-codes/external/{externalId}`

scope: `master:write` · operationId: `ReasonCodes_upsertExternal`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `externalId` | path | ใช่ | `string` | เลขของระบบต้นทาง (ASCII ที่พิมพ์ได้ 1–100 ตัว ไม่มีช่องว่าง) — unique ต่อ tenant ต่อ resource |
| `If-Match` | header |   | `string` | ETag — ใช้เมื่อแถวมีอยู่แล้ว |

**Request body** `UpsertReasonCodeDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `labelEn` |   | `string` | null ได้ |   | `Shop closed` |
| `requiresPhoto` |   | `boolean` |   | บังคับแนบรูป (ค่าเริ่มต้น false) |   |
| `requiresNote` |   | `boolean` |   | บังคับกรอกโน้ต (ค่าเริ่มต้น false) — รายการ "อื่น ๆ" ของระบบต้องเป็น true เสมอ |   |
| `autoReschedule` |   | `boolean` |   | นัดส่งใหม่อัตโนมัติ ใช้ได้เฉพาะหมวด DELIVERY_FAILED (อื่น → 422 `not_applicable`) |   |
| `showOnTracking` |   | `boolean` |   | แสดงเหตุผลบนหน้า tracking ของผู้รับ — เฉพาะหมวด DELIVERY_FAILED / REJECTED_BY_RECEIVER / POD_MISSING / DELAY (อื่น → 422 `not_applicable`) |   |
| `sortOrder` |   | `number` | ≥ 0 · ≤ 9998 | ลำดับในหมวด (น้อยขึ้นก่อน) — ไม่ส่งตอนสร้าง = ต่อท้ายหมวด (มากสุด + 10); "อื่น ๆ" ของระบบอยู่ท้ายเสมอ (9999) |   |
| `category` | ใช่ | `string` | ค่า: `ORDER_HOLD`, `DELIVERY_FAILED`, `REJECTED_BY_RECEIVER`, `POD_MISSING`, `DELAY`, `SETTLEMENT_DISPUTE`, `CANCEL`, `OVERRIDE` | หมวด — เปลี่ยนไม่ได้หลังสร้าง |   |
| `label` | ใช่ | `string` |   | ข้อความเหตุผล — ห้ามซ้ำในหมวด (ไม่สนตัวพิมพ์) | `ลูกค้าปิดทำการ` |
| `code` |   | `string` |   | ใช้ตอนสร้างเท่านั้น | `SHOP_CLOSED` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | มีอยู่แล้ว → อัปเดต (ส่งซ้ำได้ ไม่เกิดแถวใหม่) | `ReasonCodeDto` |
| `201` | ยังไม่มี → สร้าง | `ReasonCodeDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `409` | ขัดกับข้อมูลที่มีอยู่ (เช่น รหัส/ชื่อซ้ำ, สถานะไม่อนุญาตให้แก้) — [conflict](errors.md#conflict), [duplicate](errors.md#duplicate) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง (รวมทุกช่องใน errors[]) — externalId ใน path ผิดรูปแบบ = field `externalId` — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PUT "$TMS_BASE_URL/v1/reason-codes/external/<externalId>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"category":"ORDER_HOLD","label":"ลูกค้าปิดทำการ","code":"SHOP_CLOSED"}'
```

```ts
const { data, error } = await tms.PUT('/v1/reason-codes/external/{externalId}', {
  params: { path: { externalId: "…" } },
  body: {
    "category": "ORDER_HOLD",
    "label": "ลูกค้าปิดทำการ",
    "code": "SHOP_CLOSED"
  },
});
```

## แก้บางช่องด้วย externalId {#patch-reason-codes-external-externalId}

`PATCH /v1/reason-codes/external/{externalId}`

scope: `master:write` · operationId: `ReasonCodes_patchExternal`

เหมือน `PATCH /reason-codes/ext:{externalId}` (กติกาเดียวกับ PATCH ด้วย id) · ยังไม่มีแถวนี้ → 404 — สร้างใหม่ใช้ PUT

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `externalId` | path | ใช่ | `string` | เลขของระบบต้นทาง (ASCII ที่พิมพ์ได้ 1–100 ตัว ไม่มีช่องว่าง) — unique ต่อ tenant ต่อ resource |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `UpdateReasonCodeDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `labelEn` |   | `string` | null ได้ |   | `Shop closed` |
| `requiresPhoto` |   | `boolean` |   | บังคับแนบรูป (ค่าเริ่มต้น false) |   |
| `requiresNote` |   | `boolean` |   | บังคับกรอกโน้ต (ค่าเริ่มต้น false) — รายการ "อื่น ๆ" ของระบบต้องเป็น true เสมอ |   |
| `autoReschedule` |   | `boolean` |   | นัดส่งใหม่อัตโนมัติ ใช้ได้เฉพาะหมวด DELIVERY_FAILED (อื่น → 422 `not_applicable`) |   |
| `showOnTracking` |   | `boolean` |   | แสดงเหตุผลบนหน้า tracking ของผู้รับ — เฉพาะหมวด DELIVERY_FAILED / REJECTED_BY_RECEIVER / POD_MISSING / DELAY (อื่น → 422 `not_applicable`) |   |
| `sortOrder` |   | `number` | ≥ 0 · ≤ 9998 | ลำดับในหมวด (น้อยขึ้นก่อน) — ไม่ส่งตอนสร้าง = ต่อท้ายหมวด (มากสุด + 10); "อื่น ๆ" ของระบบอยู่ท้ายเสมอ (9999) |   |
| `code` |   | `string` |   | รหัสของระบบ (system) เปลี่ยนไม่ได้ | `SHOP_CLOSED` |
| `label` |   | `string` |   |   | `ลูกค้าปิดทำการ` |
| `externalId` |   | `string` | null ได้ | null = ลบการผูก |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `ReasonCodeDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ยังไม่มีแถวที่ externalId นี้ (สร้างใหม่ใช้ PUT) หรืออยู่ tenant อื่น — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | ขัดกับข้อมูลที่มีอยู่ (เช่น รหัส/ชื่อซ้ำ, สถานะไม่อนุญาตให้แก้) — [conflict](errors.md#conflict), [duplicate](errors.md#duplicate) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง (รวมทุกช่องใน errors[]) — externalId ใน path ผิดรูปแบบ = field `externalId` — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PATCH "$TMS_BASE_URL/v1/reason-codes/external/<externalId>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"code":"SHOP_CLOSED","label":"ลูกค้าปิดทำการ"}'
```

```ts
const { data, error } = await tms.PATCH('/v1/reason-codes/external/{externalId}', {
  params: { path: { externalId: "…" } },
  body: {
    "code": "SHOP_CLOSED",
    "label": "ลูกค้าปิดทำการ"
  },
});
```

## GET /v1/reason-codes/{id} {#get-reason-codes-id}

`GET /v1/reason-codes/{id}`

scope: `master:read` · operationId: `ReasonCodes_get`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `ReasonCodeDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/reason-codes/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/reason-codes/{id}', {
  params: { path: { id: "…" } },
});
```

## PATCH /v1/reason-codes/{id} {#patch-reason-codes-id}

`PATCH /v1/reason-codes/{id}`

scope: `master:write` · operationId: `ReasonCodes_update`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `UpdateReasonCodeDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `labelEn` |   | `string` | null ได้ |   | `Shop closed` |
| `requiresPhoto` |   | `boolean` |   | บังคับแนบรูป (ค่าเริ่มต้น false) |   |
| `requiresNote` |   | `boolean` |   | บังคับกรอกโน้ต (ค่าเริ่มต้น false) — รายการ "อื่น ๆ" ของระบบต้องเป็น true เสมอ |   |
| `autoReschedule` |   | `boolean` |   | นัดส่งใหม่อัตโนมัติ ใช้ได้เฉพาะหมวด DELIVERY_FAILED (อื่น → 422 `not_applicable`) |   |
| `showOnTracking` |   | `boolean` |   | แสดงเหตุผลบนหน้า tracking ของผู้รับ — เฉพาะหมวด DELIVERY_FAILED / REJECTED_BY_RECEIVER / POD_MISSING / DELAY (อื่น → 422 `not_applicable`) |   |
| `sortOrder` |   | `number` | ≥ 0 · ≤ 9998 | ลำดับในหมวด (น้อยขึ้นก่อน) — ไม่ส่งตอนสร้าง = ต่อท้ายหมวด (มากสุด + 10); "อื่น ๆ" ของระบบอยู่ท้ายเสมอ (9999) |   |
| `code` |   | `string` |   | รหัสของระบบ (system) เปลี่ยนไม่ได้ | `SHOP_CLOSED` |
| `label` |   | `string` |   |   | `ลูกค้าปิดทำการ` |
| `externalId` |   | `string` | null ได้ | null = ลบการผูก |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `ReasonCodeDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PATCH "$TMS_BASE_URL/v1/reason-codes/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"code":"SHOP_CLOSED","label":"ลูกค้าปิดทำการ"}'
```

```ts
const { data, error } = await tms.PATCH('/v1/reason-codes/{id}', {
  params: { path: { id: "…" } },
  body: {
    "code": "SHOP_CLOSED",
    "label": "ลูกค้าปิดทำการ"
  },
});
```

## GET /v1/reason-codes/{id}/history {#get-reason-codes-id-history}

`GET /v1/reason-codes/{id}/history`

scope: `master:read` · operationId: `ReasonCodes_history`

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
curl -sS -X GET "$TMS_BASE_URL/v1/reason-codes/<id>/history" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/reason-codes/{id}/history', {
  params: { path: { id: "…" } },
});
```

## POST /v1/reason-codes/{id}/deactivate {#post-reason-codes-id-deactivate}

`POST /v1/reason-codes/{id}/deactivate`

scope: `master:write` · operationId: `ReasonCodes_deactivate`

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
| `200` |   | `ReasonCodeDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/reason-codes/<id>/deactivate" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"เลิกใช้บริการตั้งแต่ ธ.ค. 2569"}'
```

```ts
const { data, error } = await tms.POST('/v1/reason-codes/{id}/deactivate', {
  params: { path: { id: "…" } },
  body: {
    "reason": "เลิกใช้บริการตั้งแต่ ธ.ค. 2569"
  },
});
```

## POST /v1/reason-codes/{id}/activate {#post-reason-codes-id-activate}

`POST /v1/reason-codes/{id}/activate`

scope: `master:write` · operationId: `ReasonCodes_activate`

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
| `200` |   | `ReasonCodeDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/reason-codes/<id>/activate" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{}'
```

```ts
const { data, error } = await tms.POST('/v1/reason-codes/{id}/activate', {
  params: { path: { id: "…" } },
  body: {},
});
```

## POST /v1/reason-codes/{id}/delete {#post-reason-codes-id-delete}

`POST /v1/reason-codes/{id}/delete`

scope: `master:write` · operationId: `ReasonCodes_remove`

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
curl -sS -X POST "$TMS_BASE_URL/v1/reason-codes/<id>/delete" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"เลิกใช้บริการตั้งแต่ ธ.ค. 2569"}'
```

```ts
const { data, error } = await tms.POST('/v1/reason-codes/{id}/delete', {
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

### NextCodeDto {#schema-NextCodeDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `code` | ใช่ | `string` |   |   | `CUS-0010` |

### ReasonCodeDto {#schema-ReasonCodeDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `rsn_3f2a…` |
| `category` | ใช่ | `string` | ค่า: `ORDER_HOLD`, `DELIVERY_FAILED`, `REJECTED_BY_RECEIVER`, `POD_MISSING`, `DELAY`, `SETTLEMENT_DISPUTE`, `CANCEL`, `OVERRIDE` |   |   |
| `code` | ใช่ | `string` |   |   | `SHOP_CLOSED` |
| `label` | ใช่ | `string` |   |   | `ลูกค้าปิดทำการ` |
| `labelEn` | ใช่ | `string` | null ได้ |   |   |
| `requiresPhoto` | ใช่ | `boolean` |   |   |   |
| `requiresNote` | ใช่ | `boolean` |   |   |   |
| `autoReschedule` | ใช่ | `boolean` |   |   |   |
| `showOnTracking` | ใช่ | `boolean` |   |   |   |
| `sortOrder` | ใช่ | `number` |   |   |   |
| `system` | ใช่ | `boolean` |   | รหัสของระบบ (state machine/งานอัตโนมัติใช้ หรือรายการ "อื่น ๆ" ของหมวด) — ลบ/ปิดใช้/เปลี่ยนรหัสไม่ได้ แก้ข้อความและธงได้ |   |
| `externalId` | ใช่ | `string` | null ได้ |   |   |
| `status` | ใช่ | `string` | ค่า: `active`, `inactive` |   |   |
| `deletedAt` |   | `string (date-time)` | null ได้ | มีค่าเฉพาะเมื่อขอ includeDeleted=true และรายการถูกลบแล้ว (tombstone) |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string (date-time)` |   |   |   |
| `updatedAt` | ใช่ | `string (date-time)` |   |   |   |

### ReasonCodePageDto {#schema-ReasonCodePageDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<ReasonCodeDto>` |   |   |   |
| `nextCursor` | ใช่ | `string` | null ได้ |   |   |
| `hasMore` | ใช่ | `boolean` |   |   |   |
