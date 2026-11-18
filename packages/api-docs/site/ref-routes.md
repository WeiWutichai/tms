# เส้นทาง (routes)

14 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`GET /v1/routes`](#get-routes) | `master:read` |
| [`POST /v1/routes`](#post-routes) | `master:write` |
| [`GET /v1/routes/summary`](#get-routes-summary) | `master:read` |
| [`GET /v1/routes/next-code`](#get-routes-next-code) | `master:write` |
| [`GET /v1/routes/export`](#get-routes-export) | `export:run` |
| [`POST /v1/routes/estimate`](#post-routes-estimate) | `master:write` |
| [`PUT /v1/routes/external/{externalId}`](#put-routes-external-externalId) | `master:write` |
| [`PATCH /v1/routes/external/{externalId}`](#patch-routes-external-externalId) | `master:write` |
| [`GET /v1/routes/{id}`](#get-routes-id) | `master:read` |
| [`PATCH /v1/routes/{id}`](#patch-routes-id) | `master:write` |
| [`GET /v1/routes/{id}/history`](#get-routes-id-history) | `master:read` |
| [`POST /v1/routes/{id}/deactivate`](#post-routes-id-deactivate) | `master:write` |
| [`POST /v1/routes/{id}/activate`](#post-routes-id-activate) | `master:write` |
| [`POST /v1/routes/{id}/delete`](#post-routes-id-delete) | `master:write` |

## GET /v1/routes {#get-routes}

`GET /v1/routes`

scope: `master:read` · operationId: `Routes_list`

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
| `originId` | query |   | `string` | ต้นทางตรงตัว (id สถานที่) |
| `destinationId` | query |   | `string` | ปลายทางตรงตัว (id สถานที่) |
| `siteId` | query |   | `string` | สถานที่นี้เป็นต้นทางหรือปลายทาง (id สถานที่) |
| `route` | query |   | `string` | ชื่อ/รหัสต้นทางหรือปลายทางมีคำนี้ (ตัวกรองคอลัมน์ "เส้นทาง") |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `RoutePageDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/routes" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/routes');
```

## POST /v1/routes {#post-routes}

`POST /v1/routes`

scope: `master:write` · operationId: `Routes_create`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `Idempotency-Key` | header |   | `string` |   |

**Request body** `CreateRouteDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `standardMinutes` |   | `number` | null ได้ | เวลาเดินทางมาตรฐาน (นาที) 1–10,080 · null = ไม่ระบุ | `150` |
| `tollAmount` |   | `string` | null ได้ | ค่าผ่านทางต่อเที่ยว (บาท) เป็นข้อความ ทศนิยม ≤ 2 ตำแหน่ง ≥ 0 (เงินห้ามใช้ float) · null = ไม่มี/ไม่ระบุ | `120.00` |
| `notes` |   | `string` | ยาว ≤ 1000 · null ได้ | หมายเหตุ |   |
| `originId` | ใช่ | `string` |   | ต้นทาง (สถานที่ — `customer-sites`) | `loc_3f2a…` |
| `destinationId` | ใช่ | `string` |   | ปลายทาง (สถานที่) — ต้องต่างจากต้นทาง · คู่ต้นทาง→ปลายทางห้ามซ้ำ (ทิศทางมีผล) | `loc_8c1d…` |
| `distanceKm` | ใช่ | `number` |   | ระยะทางอ้างอิง (กม.) > 0 ทศนิยม ≤ 1 ตำแหน่ง — ราคาแบบต่อ กม. ใช้ค่านี้ | `95` |
| `code` |   | `string` |   | รหัส — ไม่ส่ง = ระบบออกเลขถัดไป `RT-0001` | `BKK-CBI` |
| `externalId` |   | `string` |   | รหัสในระบบต้นทาง — เรียกด้วย ext:{externalId} ได้ |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `201` |   | `RouteDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/routes" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"originId":"loc_3f2a…","destinationId":"loc_8c1d…","distanceKm":95,"code":"BKK-CBI"}'
```

```ts
const { data, error } = await tms.POST('/v1/routes', {
  body: {
    "originId": "loc_3f2a…",
    "destinationId": "loc_8c1d…",
    "distanceKm": 95,
    "code": "BKK-CBI"
  },
});
```

## GET /v1/routes/summary {#get-routes-summary}

`GET /v1/routes/summary`

scope: `master:read` · operationId: `Routes_summary`

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `RouteSummaryDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/routes/summary" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/routes/summary');
```

## GET /v1/routes/next-code {#get-routes-next-code}

`GET /v1/routes/next-code`

scope: `master:write` · operationId: `Routes_nextCode`

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | รหัสที่ระบบจะออกให้เส้นทางใหม่ (`RT-0001`) | `NextCodeDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/routes/next-code" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/routes/next-code');
```

## GET /v1/routes/export {#get-routes-export}

`GET /v1/routes/export`

scope: `export:run` · operationId: `Routes_export`

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
| `originId` | query |   | `string` | ต้นทางตรงตัว (id สถานที่) |
| `destinationId` | query |   | `string` | ปลายทางตรงตัว (id สถานที่) |
| `siteId` | query |   | `string` | สถานที่นี้เป็นต้นทางหรือปลายทาง (id สถานที่) |
| `route` | query |   | `string` | ชื่อ/รหัสต้นทางหรือปลายทางมีคำนี้ (ตัวกรองคอลัมน์ "เส้นทาง") |
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
curl -sS -X GET "$TMS_BASE_URL/v1/routes/export" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/routes/export');
```

## POST /v1/routes/estimate {#post-routes-estimate}

`POST /v1/routes/estimate`

scope: `master:write` · operationId: `Routes_estimate`

**Request body** `RouteEstimateRequestDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `originId` | ใช่ | `string` |   |   | `loc_3f2a…` |
| `destinationId` | ใช่ | `string` |   |   | `loc_8c1d…` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `RouteEstimateDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เกินเพดานต่อบริษัท มี header Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/routes/estimate" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"originId":"loc_3f2a…","destinationId":"loc_8c1d…"}'
```

```ts
const { data, error } = await tms.POST('/v1/routes/estimate', {
  body: {
    "originId": "loc_3f2a…",
    "destinationId": "loc_8c1d…"
  },
});
```

## PUT /v1/routes/external/{externalId} {#put-routes-external-externalId}

`PUT /v1/routes/external/{externalId}`

scope: `master:write` · operationId: `Routes_upsertExternal`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `externalId` | path | ใช่ | `string` | เลขของระบบต้นทาง (ASCII ที่พิมพ์ได้ 1–100 ตัว ไม่มีช่องว่าง) — unique ต่อ tenant ต่อ resource |
| `If-Match` | header |   | `string` | ETag — ใช้เมื่อแถวมีอยู่แล้ว |

**Request body** `UpsertRouteDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `standardMinutes` |   | `number` | null ได้ | เวลาเดินทางมาตรฐาน (นาที) 1–10,080 · null = ไม่ระบุ | `150` |
| `tollAmount` |   | `string` | null ได้ | ค่าผ่านทางต่อเที่ยว (บาท) เป็นข้อความ ทศนิยม ≤ 2 ตำแหน่ง ≥ 0 (เงินห้ามใช้ float) · null = ไม่มี/ไม่ระบุ | `120.00` |
| `notes` |   | `string` | ยาว ≤ 1000 · null ได้ | หมายเหตุ |   |
| `originId` | ใช่ | `string` |   | ต้นทาง (สถานที่ — `customer-sites`) | `loc_3f2a…` |
| `destinationId` | ใช่ | `string` |   | ปลายทาง (สถานที่) — ต้องต่างจากต้นทาง · คู่ต้นทาง→ปลายทางห้ามซ้ำ (ทิศทางมีผล) | `loc_8c1d…` |
| `distanceKm` | ใช่ | `number` |   | ระยะทางอ้างอิง (กม.) > 0 ทศนิยม ≤ 1 ตำแหน่ง — ราคาแบบต่อ กม. ใช้ค่านี้ | `95` |
| `code` |   | `string` |   | ใช้ตอนสร้างเท่านั้น | `BKK-CBI` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | มีอยู่แล้ว → อัปเดต (ส่งซ้ำได้ ไม่เกิดแถวใหม่) | `RouteDto` |
| `201` | ยังไม่มี → สร้าง | `RouteDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `409` | ขัดกับข้อมูลที่มีอยู่ (เช่น รหัส/ชื่อซ้ำ, สถานะไม่อนุญาตให้แก้) — [conflict](errors.md#conflict), [duplicate](errors.md#duplicate) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง (รวมทุกช่องใน errors[]) — externalId ใน path ผิดรูปแบบ = field `externalId` — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PUT "$TMS_BASE_URL/v1/routes/external/<externalId>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"originId":"loc_3f2a…","destinationId":"loc_8c1d…","distanceKm":95,"code":"BKK-CBI"}'
```

```ts
const { data, error } = await tms.PUT('/v1/routes/external/{externalId}', {
  params: { path: { externalId: "…" } },
  body: {
    "originId": "loc_3f2a…",
    "destinationId": "loc_8c1d…",
    "distanceKm": 95,
    "code": "BKK-CBI"
  },
});
```

## แก้บางช่องด้วย externalId {#patch-routes-external-externalId}

`PATCH /v1/routes/external/{externalId}`

scope: `master:write` · operationId: `Routes_patchExternal`

เหมือน `PATCH /routes/ext:{externalId}` (กติกาเดียวกับ PATCH ด้วย id) · ยังไม่มีแถวนี้ → 404 — สร้างใหม่ใช้ PUT

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `externalId` | path | ใช่ | `string` | เลขของระบบต้นทาง (ASCII ที่พิมพ์ได้ 1–100 ตัว ไม่มีช่องว่าง) — unique ต่อ tenant ต่อ resource |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `UpdateRouteDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `standardMinutes` |   | `number` | null ได้ | เวลาเดินทางมาตรฐาน (นาที) 1–10,080 · null = ไม่ระบุ | `150` |
| `tollAmount` |   | `string` | null ได้ | ค่าผ่านทางต่อเที่ยว (บาท) เป็นข้อความ ทศนิยม ≤ 2 ตำแหน่ง ≥ 0 (เงินห้ามใช้ float) · null = ไม่มี/ไม่ระบุ | `120.00` |
| `notes` |   | `string` | ยาว ≤ 1000 · null ได้ | หมายเหตุ |   |
| `originId` |   | `string` |   |   | `loc_3f2a…` |
| `destinationId` |   | `string` |   |   | `loc_8c1d…` |
| `distanceKm` |   | `number` |   |   | `95` |
| `externalId` |   | `string` | null ได้ | null = ลบการผูก |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `RouteDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ยังไม่มีแถวที่ externalId นี้ (สร้างใหม่ใช้ PUT) หรืออยู่ tenant อื่น — [not_found](errors.md#not_found) | `ProblemDto` |
| `409` | ขัดกับข้อมูลที่มีอยู่ (เช่น รหัส/ชื่อซ้ำ, สถานะไม่อนุญาตให้แก้) — [conflict](errors.md#conflict), [duplicate](errors.md#duplicate) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง (รวมทุกช่องใน errors[]) — externalId ใน path ผิดรูปแบบ = field `externalId` — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PATCH "$TMS_BASE_URL/v1/routes/external/<externalId>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"originId":"loc_3f2a…","destinationId":"loc_8c1d…","distanceKm":95}'
```

```ts
const { data, error } = await tms.PATCH('/v1/routes/external/{externalId}', {
  params: { path: { externalId: "…" } },
  body: {
    "originId": "loc_3f2a…",
    "destinationId": "loc_8c1d…",
    "distanceKm": 95
  },
});
```

## GET /v1/routes/{id} {#get-routes-id}

`GET /v1/routes/{id}`

scope: `master:read` · operationId: `Routes_get`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `RouteDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/routes/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/routes/{id}', {
  params: { path: { id: "…" } },
});
```

## PATCH /v1/routes/{id} {#patch-routes-id}

`PATCH /v1/routes/{id}`

scope: `master:write` · operationId: `Routes_update`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `If-Match` | header |   | `string` | ETag จาก GET — ไม่ตรง → 412 |

**Request body** `UpdateRouteDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `standardMinutes` |   | `number` | null ได้ | เวลาเดินทางมาตรฐาน (นาที) 1–10,080 · null = ไม่ระบุ | `150` |
| `tollAmount` |   | `string` | null ได้ | ค่าผ่านทางต่อเที่ยว (บาท) เป็นข้อความ ทศนิยม ≤ 2 ตำแหน่ง ≥ 0 (เงินห้ามใช้ float) · null = ไม่มี/ไม่ระบุ | `120.00` |
| `notes` |   | `string` | ยาว ≤ 1000 · null ได้ | หมายเหตุ |   |
| `originId` |   | `string` |   |   | `loc_3f2a…` |
| `destinationId` |   | `string` |   |   | `loc_8c1d…` |
| `distanceKm` |   | `number` |   |   | `95` |
| `externalId` |   | `string` | null ได้ | null = ลบการผูก |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `RouteDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X PATCH "$TMS_BASE_URL/v1/routes/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"originId":"loc_3f2a…","destinationId":"loc_8c1d…","distanceKm":95}'
```

```ts
const { data, error } = await tms.PATCH('/v1/routes/{id}', {
  params: { path: { id: "…" } },
  body: {
    "originId": "loc_3f2a…",
    "destinationId": "loc_8c1d…",
    "distanceKm": 95
  },
});
```

## GET /v1/routes/{id}/history {#get-routes-id-history}

`GET /v1/routes/{id}/history`

scope: `master:read` · operationId: `Routes_history`

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
curl -sS -X GET "$TMS_BASE_URL/v1/routes/<id>/history" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/routes/{id}/history', {
  params: { path: { id: "…" } },
});
```

## POST /v1/routes/{id}/deactivate {#post-routes-id-deactivate}

`POST /v1/routes/{id}/deactivate`

scope: `master:write` · operationId: `Routes_deactivate`

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
| `200` |   | `RouteDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/routes/<id>/deactivate" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"เลิกใช้บริการตั้งแต่ ธ.ค. 2569"}'
```

```ts
const { data, error } = await tms.POST('/v1/routes/{id}/deactivate', {
  params: { path: { id: "…" } },
  body: {
    "reason": "เลิกใช้บริการตั้งแต่ ธ.ค. 2569"
  },
});
```

## POST /v1/routes/{id}/activate {#post-routes-id-activate}

`POST /v1/routes/{id}/activate`

scope: `master:write` · operationId: `Routes_activate`

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
| `200` |   | `RouteDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `412` | If-Match ไม่ตรงกับ version ปัจจุบัน (ETag จาก GET) — [precondition_failed](errors.md#precondition_failed) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/routes/<id>/activate" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{}'
```

```ts
const { data, error } = await tms.POST('/v1/routes/{id}/activate', {
  params: { path: { id: "…" } },
  body: {},
});
```

## POST /v1/routes/{id}/delete {#post-routes-id-delete}

`POST /v1/routes/{id}/delete`

scope: `master:write` · operationId: `Routes_remove`

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
curl -sS -X POST "$TMS_BASE_URL/v1/routes/<id>/delete" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"เลิกใช้บริการตั้งแต่ ธ.ค. 2569"}'
```

```ts
const { data, error } = await tms.POST('/v1/routes/{id}/delete', {
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

### RouteDto {#schema-RouteDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `rte_3f2a…` |
| `code` | ใช่ | `string` |   |   | `RT-0001` |
| `externalId` | ใช่ | `string` | null ได้ |   |   |
| `origin` | ใช่ | `RouteSiteRefDto` |   |   |   |
| `destination` | ใช่ | `RouteSiteRefDto` |   |   |   |
| `distanceKm` | ใช่ | `number` |   | ระยะทาง (กม.) | `95` |
| `standardMinutes` | ใช่ | `number` | null ได้ |   | `150` |
| `tollAmount` | ใช่ | `string` | null ได้ | ค่าผ่านทาง (บาท) เป็นข้อความทศนิยม 2 ตำแหน่ง (เงิน ห้ามใช้ float) | `120.00` |
| `notes` | ใช่ | `string` | null ได้ |   |   |
| `status` | ใช่ | `string` | ค่า: `active`, `inactive` |   |   |
| `deletedAt` |   | `string (date-time)` | null ได้ | มีค่าเฉพาะเมื่อขอ includeDeleted=true และรายการถูกลบแล้ว (tombstone) |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string (date-time)` |   |   |   |
| `updatedAt` | ใช่ | `string (date-time)` |   |   |   |

### RouteEstimateDto {#schema-RouteEstimateDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `result` | ใช่ | `string` | ค่า: `ok`, `no_coords`, `unavailable` | ok = ได้ระยะทาง (ให้ผู้ใช้ตรวจแล้วบันทึก) · no_coords = สถานที่ยังไม่ปักหมุด · unavailable = ผู้ให้บริการแผนที่ไม่รองรับ/ขัดข้อง → กรอกเอง |   |
| `distanceKm` | ใช่ | `number` | null ได้ |   | `95.4` |
| `standardMinutes` | ใช่ | `number` | null ได้ |   | `120` |
| `provider` | ใช่ | `string` |   | ผู้ให้บริการที่ใช้คำนวณ | `mock` |

### RoutePageDto {#schema-RoutePageDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<RouteDto>` |   |   |   |
| `nextCursor` | ใช่ | `string` | null ได้ |   |   |
| `hasMore` | ใช่ | `boolean` |   |   |   |

### RouteSummaryDto {#schema-RouteSummaryDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `total` | ใช่ | `number` |   | เส้นทางทั้งหมด (ไม่รวมที่ลบ) |   |
| `active` | ใช่ | `number` |   |   |   |
| `inactive` | ใช่ | `number` |   |   |   |
| `withToll` | ใช่ | `number` |   | เส้นทางที่มีค่าผ่านทาง > 0 |   |
| `noStandardTime` | ใช่ | `number` |   | เส้นทางที่ยังไม่ระบุเวลามาตรฐาน |   |
