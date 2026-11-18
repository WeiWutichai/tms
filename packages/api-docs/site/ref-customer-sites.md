# สถานที่ (customer-sites)

17 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`GET /v1/customer-sites`](#get-customer-sites) | `master:read` |
| [`POST /v1/customer-sites`](#post-customer-sites) | `master:write` |
| [`GET /v1/customer-sites/summary`](#get-customer-sites-summary) | `master:read` |
| [`GET /v1/customer-sites/next-code`](#get-customer-sites-next-code) | `master:write` |
| [`GET /v1/customer-sites/export`](#get-customer-sites-export) | `export:run` |
| [`POST /v1/customer-sites/geocode`](#post-customer-sites-geocode) | `master:write` |
| [`PUT /v1/customer-sites/external/{externalId}`](#put-customer-sites-external-externalId) | `master:write` |
| [`PATCH /v1/customer-sites/external/{externalId}`](#patch-customer-sites-external-externalId) | `master:write` |
| [`GET /v1/customer-sites/{id}`](#get-customer-sites-id) | `master:read` |
| [`PATCH /v1/customer-sites/{id}`](#patch-customer-sites-id) | `master:write` |
| [`GET /v1/customer-sites/{id}/history`](#get-customer-sites-id-history) | `master:read` |
| [`POST /v1/customer-sites/{id}/deactivate`](#post-customer-sites-id-deactivate) | `master:write` |
| [`POST /v1/customer-sites/{id}/activate`](#post-customer-sites-id-activate) | `master:write` |
| [`POST /v1/customer-sites/{id}/geocode/confirm`](#post-customer-sites-id-geocode-confirm) | `master:write` |
| [`POST /v1/customer-sites/{id}/geocode/retry`](#post-customer-sites-id-geocode-retry) | `master:write` |
| [`POST /v1/customer-sites/{id}/geocode/reject`](#post-customer-sites-id-geocode-reject) | `master:write` |
| [`POST /v1/customer-sites/{id}/delete`](#post-customer-sites-id-delete) | `master:write` |

## GET /v1/customer-sites {#get-customer-sites}

`GET /v1/customer-sites`

scope: `master:read` · operationId: `Sites_list`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน (ใช้กับ sort เดิมเท่านั้น) |
| `updatedAfter` | query |   | `string` | คืนเฉพาะแถวที่ updatedAt > ค่านี้ (incremental pull — ใช้คู่ includeDeleted=true เพื่อรับรายการที่ถูกลบ) |
| `sort` | query |   | `string` ค่า: `code`, `updatedAt`, `-updatedAt` | code = เรียงตามรหัส (ค่าเริ่มต้นของหน้าจอ) · updatedAt/-updatedAt สำหรับ sync |
| `fields` | query |   | `string` | รายชื่อ field คั่นด้วย , เช่น id,legalName |
| `q` | query |   | `string` | ค้นหา — รหัส ชื่อ เลขผู้เสียภาษี หรือ externalId (ไม่สนตัวพิมพ์) |
| `status` | query |   | `string` | คั่นด้วย , เช่น active,inactive |
| `externalId` | query |   | `string` | externalId ตรงตัว (ใช้ตรวจว่ามีในระบบแล้วหรือยัง) |
| `includeDeleted` | query |   | `string` | true = รวมรายการที่ถูกลบ (tombstone มี `deletedAt`) — ให้ระบบที่ดึงแบบ incremental รู้ว่ารายการถูกลบ |
| `kind` | query |   | `string` ค่า: `PICKUP`, `DROPOFF`, `WAREHOUSE` |   |
| `customerId` | query |   | `string` | กรองตามลูกค้า (cus_…) หรือ `none` = เฉพาะจุดของบริษัทเอง |
| `customerName` | query |   | `string` | ชื่อลูกค้ามีคำนี้ |
| `alias` | query |   | `string` | alias ตรงตัว (ไม่สนตัวพิมพ์) — ใช้จับคู่ข้อความปลายทางกับสถานที่ |
| `pinned` | query |   | `string` ค่า: `true`, `false` | true = มีพิกัด, false = ยังไม่ปักหมุด |
| `geocode` | query |   | `string` ค่า: `OK`, `REVIEW`, `PENDING`, `FAILED` | สถานะพิกัด: OK = มีพิกัด · REVIEW = รอยืนยันพิกัดที่ geocode เสนอ · PENDING = ยังไม่มีพิกัดและไม่มีข้อเสนอ · FAILED = หาพิกัดไม่พบ |
| `maxVehicleClass` | query |   | `string` ค่า: `6W`, `10W`, `TRAILER`, `SEMI_TRAILER` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `SitePageDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/customer-sites" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/customer-sites');
```

## POST /v1/customer-sites {#post-customer-sites}

`POST /v1/customer-sites`

scope: `master:write` · operationId: `Sites_create`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `Idempotency-Key` | header |   | `string` |   |

**Request body** `CreateSiteDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `kind` |   | `string` | ค่า: `PICKUP`, `DROPOFF`, `WAREHOUSE` | PICKUP = ต้นทาง, DROPOFF = ปลายทาง (ค่าเริ่มต้น), WAREHOUSE = คลัง / ศูนย์กระจาย |   |
| `customerId` |   | `string` | null ได้ | ลูกค้าเจ้าของจุด — null = จุดของบริษัทเอง (คลัง/ลานจอด) ใช้ได้กับทุกลูกค้า | `cus_…` |
| `lat` |   | `number` | null ได้ | ละติจูด (ส่งคู่กับ lng) — มีพิกัด → geocodeStatus OK, null ทั้งคู่ → PENDING | `13.417` |
| `lng` |   | `number` | null ได้ |   | `101.001` |
| `geofenceRadiusM` |   | `number` | ≥ 50 · ≤ 2000 | รัศมี geofence (เมตร) — ค่าเริ่มต้น 200 (spec/02 §2) |   |
| `aliases` |   | `array<string>` | ≤ 50 รายการ | ชื่อเรียกอื่น — ค้นหา `q` เจอด้วย alias และใช้จับคู่ข้อความปลายทางอัตโนมัติ (ST3-T06) | `["โรงงานสยามพลาสติก","SPC ชลบุรี"]` |
| `openTime` |   | `string` | null ได้ | HH:MM | `08:00` |
| `closeTime` |   | `string` | null ได้ | HH:MM — น้อยกว่า openTime = ปิดวันถัดไป (ข้ามเที่ยงคืน); ว่างทั้งคู่ = 24 ชม. | `17:00` |
| `maxVehicleClass` |   | `string` | ค่า: `6W`, `10W`, `TRAILER`, `SEMI_TRAILER` · null ได้ | รถเข้าได้สูงสุด: 6W = 6 ล้อ, 10W = 10 ล้อ, TRAILER = พ่วง, SEMI_TRAILER = เทรลเลอร์ · null = ไม่จำกัด |   |
| `serviceTimeMin` |   | `number` | ≥ 0 · ≤ 720 · null ได้ | service time — เวลาขึ้น/ลงของโดยประมาณ (นาที) |   |
| `freeTimeMin` |   | `number` | ≥ 0 · ≤ 1440 · null ได้ | free time ค่ารอที่จุดนี้ (นาที) — null = ใช้ค่าของลูกค้า/องค์กร |   |
| `dockCount` |   | `number` | ≥ 0 · ≤ 999 · null ได้ | ช่องโหลด (loading bays) — ใช้กับคลัง/ต้นทาง (docs/04 B คลัง, spec/02 §2 dockCount) · null = ไม่ระบุ |   |
| `contact` |   | `SiteContactDto` | null ได้ |   |   |
| `contact.name` | ใช่ | `string` |   |   | `คุณวิไล` |
| `contact.phone` |   | `string` |   |   | `02-300-4100` |
| `contact.email` |   | `string` |   |   | `receiving@example.co.th` |
| `notes` |   | `string` | ยาว ≤ 1000 · null ได้ | หมายเหตุ |   |
| `name` | ใช่ | `string` | ยาว ≤ 150 |   | `โรงงานสยามพลาสติก ชลบุรี` |
| `address` | ใช่ | `SiteAddressDto` |   |   |   |
| `address.line1` | ใช่ | `string` |   |   | `22 หมู่ 3 ต.บางพลีใหญ่ อ.บางพลี จ.สมุทรปราการ 10540` |
| `address.line2` |   | `string` |   |   |   |
| `address.subdistrict` |   | `string` |   |   |   |
| `address.district` |   | `string` |   |   |   |
| `address.province` |   | `string` |   |   |   |
| `address.postcode` |   | `string` |   |   | `10540` |
| `code` |   | `string` |   | รหัสสถานที่ — ไม่ส่ง = ระบบออกเลขถัดไป (MD-002) | `LOC-00001` |
| `externalId` |   | `string` |   | รหัสในระบบต้นทาง — เรียกด้วย ext:{externalId} ได้ |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `201` |   | `SiteDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/customer-sites" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"aliases":["โรงงานสยามพลาสติก","SPC ชลบุรี"],"name":"โรงงานสยามพลาสติก ชลบุรี","address":{"line1":"22 หมู่ 3 ต.บางพลีใหญ่ อ.บางพลี จ.สมุทรปราการ 10540","postcode":"10540"},"code":"LOC-00001"}'
```

```ts
const { data, error } = await tms.POST('/v1/customer-sites', {
  body: {
    "aliases": [
      "โรงงานสยามพลาสติก",
      "SPC ชลบุรี"
    ],
    "name": "โรงงานสยามพลาสติก ชลบุรี",
    "address": {
      "line1": "22 หมู่ 3 ต.บางพลีใหญ่ อ.บางพลี จ.สมุทรปราการ 10540",
      "postcode": "10540"
    },
    "code": "LOC-00001"
  },
});
```

## GET /v1/customer-sites/summary {#get-customer-sites-summary}

`GET /v1/customer-sites/summary`

scope: `master:read` · operationId: `Sites_summary`

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `SiteSummaryDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/customer-sites/summary" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/customer-sites/summary');
```

## GET /v1/customer-sites/next-code {#get-customer-sites-next-code}

`GET /v1/customer-sites/next-code`

scope: `master:write` · operationId: `Sites_nextCode`

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | รหัสที่ระบบจะออกให้สถานที่ใหม่ (MD-002) | `NextCodeDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/customer-sites/next-code" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/customer-sites/next-code');
```

## GET /v1/customer-sites/export {#get-customer-sites-export}

`GET /v1/customer-sites/export`

scope: `export:run` · operationId: `Sites_export`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน (ใช้กับ sort เดิมเท่านั้น) |
| `updatedAfter` | query |   | `string` | คืนเฉพาะแถวที่ updatedAt > ค่านี้ (incremental pull — ใช้คู่ includeDeleted=true เพื่อรับรายการที่ถูกลบ) |
| `sort` | query |   | `string` ค่า: `code`, `updatedAt`, `-updatedAt` | code = เรียงตามรหัส (ค่าเริ่มต้นของหน้าจอ) · updatedAt/-updatedAt สำหรับ sync |
| `fields` | query |   | `string` | รายชื่อ field คั่นด้วย , เช่น id,legalName |
| `q` | query |   | `string` | ค้นหา — รหัส ชื่อ เลขผู้เสียภาษี หรือ externalId (ไม่สนตัวพิมพ์) |
| `status` | query |   | `string` | คั่นด้วย , เช่น active,inactive |
| `externalId` | query |   | `string` | externalId ตรงตัว (ใช้ตรวจว่ามีในระบบแล้วหรือยัง) |
| `includeDeleted` | query |   | `string` | true = รวมรายการที่ถูกลบ (tombstone มี `deletedAt`) — ให้ระบบที่ดึงแบบ incremental รู้ว่ารายการถูกลบ |
| `kind` | query |   | `string` ค่า: `PICKUP`, `DROPOFF`, `WAREHOUSE` |   |
| `customerId` | query |   | `string` | กรองตามลูกค้า (cus_…) หรือ `none` = เฉพาะจุดของบริษัทเอง |
| `customerName` | query |   | `string` | ชื่อลูกค้ามีคำนี้ |
| `alias` | query |   | `string` | alias ตรงตัว (ไม่สนตัวพิมพ์) — ใช้จับคู่ข้อความปลายทางกับสถานที่ |
| `pinned` | query |   | `string` ค่า: `true`, `false` | true = มีพิกัด, false = ยังไม่ปักหมุด |
| `geocode` | query |   | `string` ค่า: `OK`, `REVIEW`, `PENDING`, `FAILED` | สถานะพิกัด: OK = มีพิกัด · REVIEW = รอยืนยันพิกัดที่ geocode เสนอ · PENDING = ยังไม่มีพิกัดและไม่มีข้อเสนอ · FAILED = หาพิกัดไม่พบ |
| `maxVehicleClass` | query |   | `string` ค่า: `6W`, `10W`, `TRAILER`, `SEMI_TRAILER` |   |
| `format` | query |   | `string` ค่า: `xlsx`, `csv` |   |
| `ids` | query |   | `string` | ส่งออกเฉพาะ id เหล่านี้ (คั่นด้วย ,) — แถวที่เลือกในตาราง |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | ไฟล์ .xlsx หรือ .csv ตามตัวกรองเดียวกับรายการ (สูงสุด 10,000 แถว) |   |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`export:run`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/customer-sites/export" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/customer-sites/export');
```

## POST /v1/customer-sites/geocode {#post-customer-sites-geocode}

`POST /v1/customer-sites/geocode`

scope: `master:write` · operationId: `Sites_geocode`

**Request body** `GeocodeRequestDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `address` | ใช่ | `string` | ยาว ≤ 500 |   | `99 ถ.สุขุมวิท ต.ศรีราชา อ.ศรีราชา จ.ชลบุรี 20110` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `GeocodeResultDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เกินเพดานต่อบริษัท มี header Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/customer-sites/geocode" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"address":"99 ถ.สุขุมวิท ต.ศรีราชา อ.ศรีราชา จ.ชลบุรี 20110"}'
```

```ts
const { data, error } = await tms.POST('/v1/customer-sites/geocode', {
  body: {
    "address": "99 ถ.สุขุมวิท ต.ศรีราชา อ.ศรีราชา จ.ชลบุรี 20110"
  },
});
```

## PUT /v1/customer-sites/external/{externalId} {#put-customer-sites-external-externalId}

`PUT /v1/customer-sites/external/{externalId}`

scope: `master:write` · operationId: `Sites_upsertExternal`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `externalId` | path | ใช่ | `string` | เลขของระบบต้นทาง (ASCII ที่พิมพ์ได้ 1–100 ตัว ไม่มีช่องว่าง) — unique ต่อ tenant ต่อ resource |
| `If-Match` | header |   | `string` | ETag — ใช้เมื่อแถวมีอยู่แล้ว |

**Request body** `UpsertSiteDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `kind` |   | `string` | ค่า: `PICKUP`, `DROPOFF`, `WAREHOUSE` | PICKUP = ต้นทาง, DROPOFF = ปลายทาง (ค่าเริ่มต้น), WAREHOUSE = คลัง / ศูนย์กระจาย |   |
| `customerId` |   | `string` | null ได้ | ลูกค้าเจ้าของจุด — null = จุดของบริษัทเอง (คลัง/ลานจอด) ใช้ได้กับทุกลูกค้า | `cus_…` |
| `lat` |   | `number` | null ได้ | ละติจูด (ส่งคู่กับ lng) — มีพิกัด → geocodeStatus OK, null ทั้งคู่ → PENDING | `13.417` |
| `lng` |   | `number` | null ได้ |   | `101.001` |
| `geofenceRadiusM` |   | `number` | ≥ 50 · ≤ 2000 | รัศมี geofence (เมตร) — ค่าเริ่มต้น 200 (spec/02 §2) |   |
| `aliases` |   | `array<string>` | ≤ 50 รายการ | ชื่อเรียกอื่น — ค้นหา `q` เจอด้วย alias และใช้จับคู่ข้อความปลายทางอัตโนมัติ (ST3-T06) | `["โรงงานสยามพลาสติก","SPC ชลบุรี"]` |
| `openTime` |   | `string` | null ได้ | HH:MM | `08:00` |
| `closeTime` |   | `string` | null ได้ | HH:MM — น้อยกว่า openTime = ปิดวันถัดไป (ข้ามเที่ยงคืน); ว่างทั้งคู่ = 24 ชม. | `17:00` |
| `maxVehicleClass` |   | `string` | ค่า: `6W`, `10W`, `TRAILER`, `SEMI_TRAILER` · null ได้ | รถเข้าได้สูงสุด: 6W = 6 ล้อ, 10W = 10 ล้อ, TRAILER = พ่วง, SEMI_TRAILER = เทรลเลอร์ · null = ไม่จำกัด |   |
| `serviceTimeMin` |   | `number` | ≥ 0 · ≤ 720 · null ได้ | service time — เวลาขึ้น/ลงของโดยประมาณ (นาที) |   |
| `freeTimeMin` |   | `number` | ≥ 0 · ≤ 1440 · null ได้ | free time ค่ารอที่จุดนี้ (นาที) — null = ใช้ค่าของลูกค้า/องค์กร |   |
| `dockCount` |   | `number` | ≥ 0 · ≤ 999 · null ได้ | ช่องโหลด (loading bays) — ใช้กับคลัง/ต้นทาง (docs/04 B คลัง, spec/02 §2 dockCount) · null = ไม่ระบุ |   |
| `contact` |   | `SiteContactDto` | null ได้ |   |   |
| `contact.name` | ใช่ | `string` |   |   | `คุณวิไล` |
| `contact.phone` |   | `string` |   |   | `02-300-4100` |
| `contact.email` |   | `string` |   |   | `receiving@example.co.th` |
| `notes` |   | `string` | ยาว ≤ 1000 · null ได้ | หมายเหตุ |   |
| `name` | ใช่ | `string` | ยาว ≤ 150 |   |   |
| `address` | ใช่ | `SiteAddressDto` |   |   |   |
| `address.line1` | ใช่ | `string` |   |   | `22 หมู่ 3 ต.บางพลีใหญ่ อ.บางพลี จ.สมุทรปราการ 10540` |
| `address.line2` |   | `string` |   |   |   |
| `address.subdistrict` |   | `string` |   |   |   |
| `address.district` |   | `string` |   |   |   |
| `address.province` |   | `string` |   |   |   |
| `address.postcode` |   | `string` |   |   | `10540` |
| `code` |   | `string` |   | ใช้ตอนสร้างเท่านั้น | `LOC-00001` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | มีอยู่แล้ว → อัปเดต (ส่งซ้ำได้ ไม่เกิดแถวใหม่) | `SiteDto` |
| `201` | ยังไม่มี → สร้าง | `SiteDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `409` | ขัดกับข้อมูลที่มีอยู่ (เช่น รหัส/ชื่อซ้ำ, สถานะไม่อนุญาตให้แก้) — [conflict](errors.md#conflict), [duplicate](errors.md#duplicate) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง (รวมทุกช่องใน errors[]) — externalId ใน path ผิดรูปแบบ = field `externalId` — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PUT "$TMS_BASE_URL/v1/customer-sites/external/<externalId>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"aliases":["โรงงานสยามพลาสติก","SPC ชลบุรี"],"name":"string","address":{"line1":"22 หมู่ 3 ต.บางพลีใหญ่ อ.บางพลี จ.สมุทรปราการ 10540","postcode":"10540"},"code":"LOC-00001"}'
```

```ts
const { data, error } = await tms.PUT('/v1/customer-sites/external/{externalId}', {
  params: { path: { externalId: "…" } },
  body: {
    "aliases": [
      "โรงงานสยามพลาสติก",
      "SPC ชลบุรี"
    ],
    "name": "string",
    "address": {
      "line1": "22 หมู่ 3 ต.บางพลีใหญ่ อ.บางพลี จ.สมุทรปราการ 10540",
      "postcode": "10540"
    },
    "code": "LOC-00001"
  },
});
```

## แก้บางช่องด้วย externalId {#patch-customer-sites-external-externalId}

`PATCH /v1/customer-sites/external/{externalId}`

scope: `master:write` · operationId: `Sites_patchExternal`

เหมือน `PATCH /customer-sites/ext:{externalId}` (กติกาเดียวกับ PATCH ด้วย id) · ยังไม่มีแถวนี้ → 404 — สร้างใหม่ใช้ PUT

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `externalId` | path | ใช่ | `string` | เลขของระบบต้นทาง (ASCII ที่พิมพ์ได้ 1–100 ตัว ไม่มีช่องว่าง) — unique ต่อ tenant ต่อ resource |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `UpdateSiteDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `kind` |   | `string` | ค่า: `PICKUP`, `DROPOFF`, `WAREHOUSE` | PICKUP = ต้นทาง, DROPOFF = ปลายทาง (ค่าเริ่มต้น), WAREHOUSE = คลัง / ศูนย์กระจาย |   |
| `customerId` |   | `string` | null ได้ | ลูกค้าเจ้าของจุด — null = จุดของบริษัทเอง (คลัง/ลานจอด) ใช้ได้กับทุกลูกค้า | `cus_…` |
| `lat` |   | `number` | null ได้ | ละติจูด (ส่งคู่กับ lng) — มีพิกัด → geocodeStatus OK, null ทั้งคู่ → PENDING | `13.417` |
| `lng` |   | `number` | null ได้ |   | `101.001` |
| `geofenceRadiusM` |   | `number` | ≥ 50 · ≤ 2000 | รัศมี geofence (เมตร) — ค่าเริ่มต้น 200 (spec/02 §2) |   |
| `aliases` |   | `array<string>` | ≤ 50 รายการ | ชื่อเรียกอื่น — ค้นหา `q` เจอด้วย alias และใช้จับคู่ข้อความปลายทางอัตโนมัติ (ST3-T06) | `["โรงงานสยามพลาสติก","SPC ชลบุรี"]` |
| `openTime` |   | `string` | null ได้ | HH:MM | `08:00` |
| `closeTime` |   | `string` | null ได้ | HH:MM — น้อยกว่า openTime = ปิดวันถัดไป (ข้ามเที่ยงคืน); ว่างทั้งคู่ = 24 ชม. | `17:00` |
| `maxVehicleClass` |   | `string` | ค่า: `6W`, `10W`, `TRAILER`, `SEMI_TRAILER` · null ได้ | รถเข้าได้สูงสุด: 6W = 6 ล้อ, 10W = 10 ล้อ, TRAILER = พ่วง, SEMI_TRAILER = เทรลเลอร์ · null = ไม่จำกัด |   |
| `serviceTimeMin` |   | `number` | ≥ 0 · ≤ 720 · null ได้ | service time — เวลาขึ้น/ลงของโดยประมาณ (นาที) |   |
| `freeTimeMin` |   | `number` | ≥ 0 · ≤ 1440 · null ได้ | free time ค่ารอที่จุดนี้ (นาที) — null = ใช้ค่าของลูกค้า/องค์กร |   |
| `dockCount` |   | `number` | ≥ 0 · ≤ 999 · null ได้ | ช่องโหลด (loading bays) — ใช้กับคลัง/ต้นทาง (docs/04 B คลัง, spec/02 §2 dockCount) · null = ไม่ระบุ |   |
| `contact` |   | `SiteContactDto` | null ได้ |   |   |
| `contact.name` | ใช่ | `string` |   |   | `คุณวิไล` |
| `contact.phone` |   | `string` |   |   | `02-300-4100` |
| `contact.email` |   | `string` |   |   | `receiving@example.co.th` |
| `notes` |   | `string` | ยาว ≤ 1000 · null ได้ | หมายเหตุ |   |
| `name` |   | `string` | ยาว ≤ 150 |   |   |
| `address` |   | `SiteAddressDto` |   |   |   |
| `address.line1` | ใช่ | `string` |   |   | `22 หมู่ 3 ต.บางพลีใหญ่ อ.บางพลี จ.สมุทรปราการ 10540` |
| `address.line2` |   | `string` |   |   |   |
| `address.subdistrict` |   | `string` |   |   |   |
| `address.district` |   | `string` |   |   |   |
| `address.province` |   | `string` |   |   |   |
| `address.postcode` |   | `string` |   |   | `10540` |
| `externalId` |   | `string` | null ได้ | null = ลบการผูก |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `SiteDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ยังไม่มีแถวที่ externalId นี้ (สร้างใหม่ใช้ PUT) หรืออยู่ tenant อื่น — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | ขัดกับข้อมูลที่มีอยู่ (เช่น รหัส/ชื่อซ้ำ, สถานะไม่อนุญาตให้แก้) — [conflict](errors.md#conflict), [duplicate](errors.md#duplicate) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง (รวมทุกช่องใน errors[]) — externalId ใน path ผิดรูปแบบ = field `externalId` — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PATCH "$TMS_BASE_URL/v1/customer-sites/external/<externalId>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"aliases":["โรงงานสยามพลาสติก","SPC ชลบุรี"]}'
```

```ts
const { data, error } = await tms.PATCH('/v1/customer-sites/external/{externalId}', {
  params: { path: { externalId: "…" } },
  body: {
    "aliases": [
      "โรงงานสยามพลาสติก",
      "SPC ชลบุรี"
    ]
  },
});
```

## GET /v1/customer-sites/{id} {#get-customer-sites-id}

`GET /v1/customer-sites/{id}`

scope: `master:read` · operationId: `Sites_get`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `SiteDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/customer-sites/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/customer-sites/{id}', {
  params: { path: { id: "…" } },
});
```

## PATCH /v1/customer-sites/{id} {#patch-customer-sites-id}

`PATCH /v1/customer-sites/{id}`

scope: `master:write` · operationId: `Sites_update`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `UpdateSiteDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `kind` |   | `string` | ค่า: `PICKUP`, `DROPOFF`, `WAREHOUSE` | PICKUP = ต้นทาง, DROPOFF = ปลายทาง (ค่าเริ่มต้น), WAREHOUSE = คลัง / ศูนย์กระจาย |   |
| `customerId` |   | `string` | null ได้ | ลูกค้าเจ้าของจุด — null = จุดของบริษัทเอง (คลัง/ลานจอด) ใช้ได้กับทุกลูกค้า | `cus_…` |
| `lat` |   | `number` | null ได้ | ละติจูด (ส่งคู่กับ lng) — มีพิกัด → geocodeStatus OK, null ทั้งคู่ → PENDING | `13.417` |
| `lng` |   | `number` | null ได้ |   | `101.001` |
| `geofenceRadiusM` |   | `number` | ≥ 50 · ≤ 2000 | รัศมี geofence (เมตร) — ค่าเริ่มต้น 200 (spec/02 §2) |   |
| `aliases` |   | `array<string>` | ≤ 50 รายการ | ชื่อเรียกอื่น — ค้นหา `q` เจอด้วย alias และใช้จับคู่ข้อความปลายทางอัตโนมัติ (ST3-T06) | `["โรงงานสยามพลาสติก","SPC ชลบุรี"]` |
| `openTime` |   | `string` | null ได้ | HH:MM | `08:00` |
| `closeTime` |   | `string` | null ได้ | HH:MM — น้อยกว่า openTime = ปิดวันถัดไป (ข้ามเที่ยงคืน); ว่างทั้งคู่ = 24 ชม. | `17:00` |
| `maxVehicleClass` |   | `string` | ค่า: `6W`, `10W`, `TRAILER`, `SEMI_TRAILER` · null ได้ | รถเข้าได้สูงสุด: 6W = 6 ล้อ, 10W = 10 ล้อ, TRAILER = พ่วง, SEMI_TRAILER = เทรลเลอร์ · null = ไม่จำกัด |   |
| `serviceTimeMin` |   | `number` | ≥ 0 · ≤ 720 · null ได้ | service time — เวลาขึ้น/ลงของโดยประมาณ (นาที) |   |
| `freeTimeMin` |   | `number` | ≥ 0 · ≤ 1440 · null ได้ | free time ค่ารอที่จุดนี้ (นาที) — null = ใช้ค่าของลูกค้า/องค์กร |   |
| `dockCount` |   | `number` | ≥ 0 · ≤ 999 · null ได้ | ช่องโหลด (loading bays) — ใช้กับคลัง/ต้นทาง (docs/04 B คลัง, spec/02 §2 dockCount) · null = ไม่ระบุ |   |
| `contact` |   | `SiteContactDto` | null ได้ |   |   |
| `contact.name` | ใช่ | `string` |   |   | `คุณวิไล` |
| `contact.phone` |   | `string` |   |   | `02-300-4100` |
| `contact.email` |   | `string` |   |   | `receiving@example.co.th` |
| `notes` |   | `string` | ยาว ≤ 1000 · null ได้ | หมายเหตุ |   |
| `name` |   | `string` | ยาว ≤ 150 |   |   |
| `address` |   | `SiteAddressDto` |   |   |   |
| `address.line1` | ใช่ | `string` |   |   | `22 หมู่ 3 ต.บางพลีใหญ่ อ.บางพลี จ.สมุทรปราการ 10540` |
| `address.line2` |   | `string` |   |   |   |
| `address.subdistrict` |   | `string` |   |   |   |
| `address.district` |   | `string` |   |   |   |
| `address.province` |   | `string` |   |   |   |
| `address.postcode` |   | `string` |   |   | `10540` |
| `externalId` |   | `string` | null ได้ | null = ลบการผูก |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `SiteDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PATCH "$TMS_BASE_URL/v1/customer-sites/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"aliases":["โรงงานสยามพลาสติก","SPC ชลบุรี"]}'
```

```ts
const { data, error } = await tms.PATCH('/v1/customer-sites/{id}', {
  params: { path: { id: "…" } },
  body: {
    "aliases": [
      "โรงงานสยามพลาสติก",
      "SPC ชลบุรี"
    ]
  },
});
```

## GET /v1/customer-sites/{id}/history {#get-customer-sites-id-history}

`GET /v1/customer-sites/{id}/history`

scope: `master:read` · operationId: `Sites_history`

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
curl -sS -X GET "$TMS_BASE_URL/v1/customer-sites/<id>/history" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/customer-sites/{id}/history', {
  params: { path: { id: "…" } },
});
```

## POST /v1/customer-sites/{id}/deactivate {#post-customer-sites-id-deactivate}

`POST /v1/customer-sites/{id}/deactivate`

scope: `master:write` · operationId: `Sites_deactivate`

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
| `200` | ปิดใช้ได้เสมอ · `warnings` บอกจำนวนเส้นทางที่ใช้งานอ้างจุดนี้ (ไม่ถูกใช้คิดราคาระหว่างจุดปิดใช้) | `SiteDeactivateResultDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/customer-sites/<id>/deactivate" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"เลิกใช้บริการตั้งแต่ ธ.ค. 2569"}'
```

```ts
const { data, error } = await tms.POST('/v1/customer-sites/{id}/deactivate', {
  params: { path: { id: "…" } },
  body: {
    "reason": "เลิกใช้บริการตั้งแต่ ธ.ค. 2569"
  },
});
```

## POST /v1/customer-sites/{id}/activate {#post-customer-sites-id-activate}

`POST /v1/customer-sites/{id}/activate`

scope: `master:write` · operationId: `Sites_activate`

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
| `200` |   | `SiteDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/customer-sites/<id>/activate" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{}'
```

```ts
const { data, error } = await tms.POST('/v1/customer-sites/{id}/activate', {
  params: { path: { id: "…" } },
  body: {},
});
```

## POST /v1/customer-sites/{id}/geocode/confirm {#post-customer-sites-id-geocode-confirm}

`POST /v1/customer-sites/{id}/geocode/confirm`

scope: `master:write` · operationId: `Sites_confirmGeocode`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `ConfirmGeocodeDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` |   | `string` | ยาว ≤ 500 |   | `ตรวจกับ Street View แล้ว ตรงประตูทางเข้า` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `SiteDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/customer-sites/<id>/geocode/confirm" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"ตรวจกับ Street View แล้ว ตรงประตูทางเข้า"}'
```

```ts
const { data, error } = await tms.POST('/v1/customer-sites/{id}/geocode/confirm', {
  params: { path: { id: "…" } },
  body: {
    "reason": "ตรวจกับ Street View แล้ว ตรงประตูทางเข้า"
  },
});
```

## POST /v1/customer-sites/{id}/geocode/retry {#post-customer-sites-id-geocode-retry}

`POST /v1/customer-sites/{id}/geocode/retry`

scope: `master:write` · operationId: `Sites_retryGeocode`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `SiteDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/customer-sites/<id>/geocode/retry" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)"
```

```ts
const { data, error } = await tms.POST('/v1/customer-sites/{id}/geocode/retry', {
  params: { path: { id: "…" } },
});
```

## POST /v1/customer-sites/{id}/geocode/reject {#post-customer-sites-id-geocode-reject}

`POST /v1/customer-sites/{id}/geocode/reject`

scope: `master:write` · operationId: `Sites_rejectGeocode`

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
| `200` |   | `SiteDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/customer-sites/<id>/geocode/reject" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"เลิกใช้บริการตั้งแต่ ธ.ค. 2569"}'
```

```ts
const { data, error } = await tms.POST('/v1/customer-sites/{id}/geocode/reject', {
  params: { path: { id: "…" } },
  body: {
    "reason": "เลิกใช้บริการตั้งแต่ ธ.ค. 2569"
  },
});
```

## POST /v1/customer-sites/{id}/delete {#post-customer-sites-id-delete}

`POST /v1/customer-sites/{id}/delete`

scope: `master:write` · operationId: `Sites_remove`

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
curl -sS -X POST "$TMS_BASE_URL/v1/customer-sites/<id>/delete" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"เลิกใช้บริการตั้งแต่ ธ.ค. 2569"}'
```

```ts
const { data, error } = await tms.POST('/v1/customer-sites/{id}/delete', {
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

### GeocodeResultDto {#schema-GeocodeResultDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `provider` | ใช่ | `string` |   | ผู้ให้บริการที่ใช้ (`none` = ยังไม่ได้ตั้งค่า → candidates ว่างเสมอ ให้ปักหมุดเอง) | `mock` |
| `candidates` | ใช่ | `array<GeocodeCandidateDto>` |   | เรียงความมั่นใจมาก → น้อย · ว่าง = หาไม่พบ |   |

### NextCodeDto {#schema-NextCodeDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `code` | ใช่ | `string` |   |   | `CUS-0010` |

### SiteDeactivateResultDto {#schema-SiteDeactivateResultDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `loc_3f2a…` |
| `code` | ใช่ | `string` |   |   | `LOC-00001` |
| `externalId` | ใช่ | `string` | null ได้ |   |   |
| `kind` | ใช่ | `string` | ค่า: `PICKUP`, `DROPOFF`, `WAREHOUSE` |   |   |
| `name` | ใช่ | `string` |   |   |   |
| `address` | ใช่ | `SiteAddressDto` |   |   |   |
| `customer` | ใช่ | `SiteCustomerRefDto` | null ได้ | null = จุดของบริษัทเอง |   |
| `lat` | ใช่ | `number` | null ได้ |   |   |
| `lng` | ใช่ | `number` | null ได้ |   |   |
| `geocodeStatus` | ใช่ | `string` | ค่า: `OK`, `PENDING`, `FAILED` | OK = มีพิกัดแล้ว (กรอกเอง/ยืนยันแล้ว) · PENDING = ยังไม่ปักหมุด (รอ geocode หรือรอคนยืนยัน geocodeProposal) · FAILED = geocode ไม่พบ/คนปฏิเสธพิกัดที่เสนอ → ต้องปักหมุดเอง |   |
| `geocodeProposal` | ใช่ | `SiteGeocodeProposalDto` | null ได้ | พิกัดที่ geocode อัตโนมัติเสนอ รอคนยืนยัน (มีค่าเฉพาะเมื่อ geocodeStatus = PENDING) — ยืนยันด้วย POST /customer-sites/{id}/geocode/confirm, ปฏิเสธด้วย /geocode/reject |   |
| `geofenceRadiusM` | ใช่ | `number` |   |   |   |
| `aliases` | ใช่ | `array<string>` |   |   |   |
| `openTime` | ใช่ | `string` | null ได้ |   |   |
| `closeTime` | ใช่ | `string` | null ได้ |   |   |
| `maxVehicleClass` | ใช่ | `string` | ค่า: `6W`, `10W`, `TRAILER`, `SEMI_TRAILER` · null ได้ |   |   |
| `serviceTimeMin` | ใช่ | `number` | null ได้ |   |   |
| `freeTimeMin` | ใช่ | `number` | null ได้ |   |   |
| `dockCount` | ใช่ | `number` | null ได้ | ช่องโหลด (คลัง/ต้นทาง) |   |
| `contact` | ใช่ | `SiteContactDto` | null ได้ |   |   |
| `notes` | ใช่ | `string` | null ได้ |   |   |
| `status` | ใช่ | `string` | ค่า: `active`, `inactive` |   |   |
| `deletedAt` |   | `string (date-time)` | null ได้ | มีค่าเฉพาะเมื่อขอ includeDeleted=true และรายการถูกลบแล้ว (tombstone) |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string (date-time)` |   |   |   |
| `updatedAt` | ใช่ | `string (date-time)` |   |   |   |
| `warnings` | ใช่ | `array<SiteWarningDto>` |   |   |   |

### SiteDto {#schema-SiteDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `loc_3f2a…` |
| `code` | ใช่ | `string` |   |   | `LOC-00001` |
| `externalId` | ใช่ | `string` | null ได้ |   |   |
| `kind` | ใช่ | `string` | ค่า: `PICKUP`, `DROPOFF`, `WAREHOUSE` |   |   |
| `name` | ใช่ | `string` |   |   |   |
| `address` | ใช่ | `SiteAddressDto` |   |   |   |
| `customer` | ใช่ | `SiteCustomerRefDto` | null ได้ | null = จุดของบริษัทเอง |   |
| `lat` | ใช่ | `number` | null ได้ |   |   |
| `lng` | ใช่ | `number` | null ได้ |   |   |
| `geocodeStatus` | ใช่ | `string` | ค่า: `OK`, `PENDING`, `FAILED` | OK = มีพิกัดแล้ว (กรอกเอง/ยืนยันแล้ว) · PENDING = ยังไม่ปักหมุด (รอ geocode หรือรอคนยืนยัน geocodeProposal) · FAILED = geocode ไม่พบ/คนปฏิเสธพิกัดที่เสนอ → ต้องปักหมุดเอง |   |
| `geocodeProposal` | ใช่ | `SiteGeocodeProposalDto` | null ได้ | พิกัดที่ geocode อัตโนมัติเสนอ รอคนยืนยัน (มีค่าเฉพาะเมื่อ geocodeStatus = PENDING) — ยืนยันด้วย POST /customer-sites/{id}/geocode/confirm, ปฏิเสธด้วย /geocode/reject |   |
| `geofenceRadiusM` | ใช่ | `number` |   |   |   |
| `aliases` | ใช่ | `array<string>` |   |   |   |
| `openTime` | ใช่ | `string` | null ได้ |   |   |
| `closeTime` | ใช่ | `string` | null ได้ |   |   |
| `maxVehicleClass` | ใช่ | `string` | ค่า: `6W`, `10W`, `TRAILER`, `SEMI_TRAILER` · null ได้ |   |   |
| `serviceTimeMin` | ใช่ | `number` | null ได้ |   |   |
| `freeTimeMin` | ใช่ | `number` | null ได้ |   |   |
| `dockCount` | ใช่ | `number` | null ได้ | ช่องโหลด (คลัง/ต้นทาง) |   |
| `contact` | ใช่ | `SiteContactDto` | null ได้ |   |   |
| `notes` | ใช่ | `string` | null ได้ |   |   |
| `status` | ใช่ | `string` | ค่า: `active`, `inactive` |   |   |
| `deletedAt` |   | `string (date-time)` | null ได้ | มีค่าเฉพาะเมื่อขอ includeDeleted=true และรายการถูกลบแล้ว (tombstone) |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string (date-time)` |   |   |   |
| `updatedAt` | ใช่ | `string (date-time)` |   |   |   |

### SitePageDto {#schema-SitePageDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<SiteDto>` |   |   |   |
| `nextCursor` | ใช่ | `string` | null ได้ |   |   |
| `hasMore` | ใช่ | `boolean` |   |   |   |

### SiteSummaryDto {#schema-SiteSummaryDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `total` | ใช่ | `number` |   | ทั้งหมด (ไม่รวมที่ลบ) |   |
| `pinned` | ใช่ | `number` |   | มีพิกัดแล้ว |   |
| `unpinned` | ใช่ | `number` |   | ยังไม่ปักหมุด |   |
| `restricted` | ใช่ | `number` |   | จำกัดประเภทรถ (เข้าได้สูงสุด 6 ล้อ/10 ล้อ) |   |
| `geocodeReview` | ใช่ | `number` |   | รอยืนยันพิกัดที่ geocode เสนอ (ST2-T03) |   |
| `geocodeFailed` | ใช่ | `number` |   | หาพิกัดจากที่อยู่ไม่พบ — ต้องปักหมุดเอง (ST2-T03) |   |
| `byKind` | ใช่ | `SiteKindCountDto` |   |   |   |
| `active` | ใช่ | `number` |   |   |   |
| `inactive` | ใช่ | `number` |   |   |   |
