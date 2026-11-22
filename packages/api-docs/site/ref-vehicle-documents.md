# เอกสารรถ (vehicle-documents)

8 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`GET /v1/vehicles/{id}/documents`](#get-vehicles-id-documents) | `master:read` |
| [`POST /v1/vehicles/{id}/documents`](#post-vehicles-id-documents) | `master:write` |
| [`GET /v1/vehicle-documents/summary`](#get-vehicle-documents-summary) | `master:read` |
| [`GET /v1/vehicle-documents/export`](#get-vehicle-documents-export) | `export:run` |
| [`GET /v1/vehicle-documents`](#get-vehicle-documents) | `master:read` |
| [`GET /v1/vehicle-documents/{id}`](#get-vehicle-documents-id) | `master:read` |
| [`POST /v1/vehicle-documents/{id}/renew`](#post-vehicle-documents-id-renew) | `master:write` |
| [`POST /v1/vehicle-documents/{id}/cancel`](#post-vehicle-documents-id-cancel) | `master:write` |

## GET /v1/vehicles/{id}/documents {#get-vehicles-id-documents}

`GET /v1/vehicles/{id}/documents`

scope: `master:read` · operationId: `VehicleDocuments_listForVehicle`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | เอกสารทั้งหมดของรถคันนี้ — ฉบับปัจจุบันและประวัติ (superseded/cancelled) | `VehicleDocumentListDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/vehicles/<id>/documents" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/vehicles/{id}/documents', {
  params: { path: { id: "…" } },
});
```

## POST /v1/vehicles/{id}/documents {#post-vehicles-id-documents}

`POST /v1/vehicles/{id}/documents`

scope: `master:write` · operationId: `VehicleDocuments_create`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` | id ของ resource หรือ `ext:{externalId}` (เลขของระบบต้นทาง — ASCII ที่พิมพ์ได้ 1–100 ตัว; ไม่พบ/ผิดรูปแบบ = 404) |
| `Idempotency-Key` | header |   | `string` |   |

**Request body** `CreateVehicleDocumentDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `docNo` |   | `string` |   | เลขกรมธรรม์ / เลขใบอนุญาต / เลขที่เอกสาร — บังคับ ยกเว้น OTHER | `POL-27-10431` |
| `issuer` |   | `string` | null ได้ | บริษัทประกัน / หน่วยงานที่ออก | `วิริยะประกันภัย` |
| `startsOn` | ใช่ | `string (date)` |   | วันเริ่มมีผล (1980-01-01 – 2100-12-31) | `2026-11-30` |
| `expiresOn` | ใช่ | `string (date)` |   | วันหมดอายุ (ใช้ได้ถึงสิ้นวัน) — ต้องหลังวันเริ่ม | `2027-11-30` |
| `insuranceClass` |   | `string` | null ได้ | ชั้นประกัน — เฉพาะ INSURANCE | `1` |
| `sumInsured` |   | `string` | null ได้ | ทุนประกัน — เฉพาะ INSURANCE | `800000.00` |
| `premiumAmount` |   | `string` | null ได้ | เบี้ยประกัน — เฉพาะ INSURANCE | `28500.00` |
| `costAmount` |   | `string` | null ได้ | ค่าใช้จ่ายของฉบับนี้ (เบี้ย / ค่าธรรมเนียม) — รถบริษัท: เขียน vehicle_cost หมวด DOCUMENT 1 แถว | `28500.00` |
| `fileDocumentIds` | ใช่ | `array<string>` |   | ไฟล์แนบ (PDF/รูป) จาก POST /v1/documents kind=VEHICLE_DOC ที่อัปโหลดเสร็จแล้ว — อย่างน้อย 1 ไฟล์ | `["doc_…"]` |
| `note` |   | `string` | ยาว ≤ 500 · null ได้ |   |   |
| `docType` | ใช่ | `string` | ค่า: `INSURANCE`, `COMPULSORY_ACT`, `ANNUAL_TAX`, `INSPECTION`, `TRANSPORT_LICENSE`, `GPS_DLT_CERT`, `OTHER` |   |   |
| `title` |   | `string` |   | ชื่อเอกสาร — บังคับเมื่อ docType = OTHER | `สัญญาเช่าที่จอด` |
| `isRequiredForDispatch` |   | `boolean` |   | หมดอายุแล้วห้ามจ่ายงาน (ใช้ใน ST3) — ไม่ส่ง = true สำหรับ INSURANCE / COMPULSORY_ACT |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `201` | เพิ่มเอกสาร — มีฉบับปัจจุบันประเภทเดียวกันอยู่แล้ว → 409 `current_exists` (ใช้ต่ออายุ) · รถปลดระวาง → 409 | `VehicleDocumentDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/vehicles/<id>/documents" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"docNo":"POL-27-10431","startsOn":"2026-11-30","expiresOn":"2027-11-30","fileDocumentIds":["doc_…"],"docType":"INSURANCE","title":"สัญญาเช่าที่จอด"}'
```

```ts
const { data, error } = await tms.POST('/v1/vehicles/{id}/documents', {
  params: { path: { id: "…" } },
  body: {
    "docNo": "POL-27-10431",
    "startsOn": "2026-11-30",
    "expiresOn": "2027-11-30",
    "fileDocumentIds": [
      "doc_…"
    ],
    "docType": "INSURANCE",
    "title": "สัญญาเช่าที่จอด"
  },
});
```

## GET /v1/vehicle-documents/summary {#get-vehicle-documents-summary}

`GET /v1/vehicle-documents/summary`

scope: `master:read` · operationId: `VehicleDocuments_summary`

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `VehicleDocumentSummaryDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/vehicle-documents/summary" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/vehicle-documents/summary');
```

## GET /v1/vehicle-documents/export {#get-vehicle-documents-export}

`GET /v1/vehicle-documents/export`

scope: `export:run` · operationId: `VehicleDocuments_export`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน |
| `docType` | query |   | `string` | คั่นด้วย, เช่น INSURANCE,COMPULSORY_ACT |
| `status` | query |   | `string` | คั่นด้วย, (active, expiring, expired, superseded, cancelled) — ไม่ส่ง = ฉบับปัจจุบัน (active,expiring,expired) |
| `expiresWithinDays` | query |   | `number` | หมดภายใน N วันนับจากวันนี้ (ไม่รวมที่หมดแล้ว) เช่น 30 = หมดวันนี้ถึงอีก 30 วัน |
| `expiresBeyondDays` | query |   | `number` | หมดหลังจากอีก N วัน เช่น 30 = เหลือมากกว่า 30 วัน (สถานะ "ปกติ" ของหน้าเอกสารรถรวม) — ใช้ร่วมกับ expiresWithinDays ได้ |
| `dueWithinDays` | query |   | `number` | ถึงกำหนดต่อภายใน N วัน = หมดแล้ว หรือหมดภายใน N วัน (เช่น 30 = ไฟล์ "ส่งออกให้ฝ่ายธุรการ" ของต้นแบบ) |
| `docNo` | query |   | `string` | ค้นหาเลขที่เอกสาร (บางส่วน ไม่สนตัวพิมพ์) |
| `issuer` | query |   | `string` | ค้นหาบริษัท / หน่วยงาน (บางส่วน ไม่สนตัวพิมพ์) |
| `includeRetired` | query |   | `string` ค่า: `true`, `false` | รวมเอกสารของรถปลดระวาง — ค่าเริ่มต้นไม่รวม (รถที่เลิกใช้ไม่ต้องต่ออายุ ตรงกับป้าย docAlert) · ระบุ vehicleId แล้วรวมเสมอ |
| `vehicleId` | query |   | `string` | เฉพาะรถคันนี้ |
| `plate` | query |   | `string` | ค้นหาทะเบียน (ไม่สนช่องว่าง/ขีด) |
| `format` | query |   | `string` ค่า: `xlsx`, `csv` |   |
| `ids` | query |   | `string` | ส่งออกเฉพาะ id เหล่านี้ (คั่นด้วย,) — แถวที่เลือกในตาราง |
| `X-Step-Up` | header |   | `string` | stepUpToken จาก `POST /v1/auth/step-up` (ยืนยัน TOTP อายุ 5 นาที) — ผู้ใช้ต้องส่งเมื่อส่งออกทั้งบริษัท: ไม่มีตัวกรองที่จำกัดแถว (ไม่มี filter/`ids` หรือค่าว่าง/`all`) หรือ resource `accounting-*` ไม่งั้น 403 `step_up_required` · API key / OAuth client ไม่ต้อง |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | ไฟล์.xlsx หรือ.csv ตามตัวกรองเดียวกับรายการ หรือเฉพาะ `ids` (≤ 200; สูงสุด 10,000 แถว) — CSV กันสูตร · header `X-Export-Rows` = จำนวนแถวในไฟล์ |   |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`export:run`) · ต้องยืนยัน 2FA ซ้ำ (`step_up_required`) เมื่อส่งออกทั้งบริษัท: ไม่มีตัวกรองที่จำกัดแถว (ไม่มี filter/`ids` หรือค่าว่าง/`all`) หรือ resource `accounting-*` — [permission_denied](errors.md#permission_denied), [step_up_required](errors.md#step_up_required) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/vehicle-documents/export" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/vehicle-documents/export');
```

## GET /v1/vehicle-documents {#get-vehicle-documents}

`GET /v1/vehicle-documents`

scope: `master:read` · operationId: `VehicleDocuments_list`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน |
| `docType` | query |   | `string` | คั่นด้วย, เช่น INSURANCE,COMPULSORY_ACT |
| `status` | query |   | `string` | คั่นด้วย, (active, expiring, expired, superseded, cancelled) — ไม่ส่ง = ฉบับปัจจุบัน (active,expiring,expired) |
| `expiresWithinDays` | query |   | `number` | หมดภายใน N วันนับจากวันนี้ (ไม่รวมที่หมดแล้ว) เช่น 30 = หมดวันนี้ถึงอีก 30 วัน |
| `expiresBeyondDays` | query |   | `number` | หมดหลังจากอีก N วัน เช่น 30 = เหลือมากกว่า 30 วัน (สถานะ "ปกติ" ของหน้าเอกสารรถรวม) — ใช้ร่วมกับ expiresWithinDays ได้ |
| `dueWithinDays` | query |   | `number` | ถึงกำหนดต่อภายใน N วัน = หมดแล้ว หรือหมดภายใน N วัน (เช่น 30 = ไฟล์ "ส่งออกให้ฝ่ายธุรการ" ของต้นแบบ) |
| `docNo` | query |   | `string` | ค้นหาเลขที่เอกสาร (บางส่วน ไม่สนตัวพิมพ์) |
| `issuer` | query |   | `string` | ค้นหาบริษัท / หน่วยงาน (บางส่วน ไม่สนตัวพิมพ์) |
| `includeRetired` | query |   | `string` ค่า: `true`, `false` | รวมเอกสารของรถปลดระวาง — ค่าเริ่มต้นไม่รวม (รถที่เลิกใช้ไม่ต้องต่ออายุ ตรงกับป้าย docAlert) · ระบุ vehicleId แล้วรวมเสมอ |
| `vehicleId` | query |   | `string` | เฉพาะรถคันนี้ |
| `plate` | query |   | `string` | ค้นหาทะเบียน (ไม่สนช่องว่าง/ขีด) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | เอกสารรถทั้งหมด เรียงวันหมดใกล้สุดก่อน — กรองประเภท/สถานะ/หมดภายใน N วัน/หลัง N วัน/ทะเบียน/รถ · ไม่รวมรถปลดระวาง (เว้นแต่ includeRetired=true) | `VehicleDocumentPageDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/vehicle-documents" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/vehicle-documents');
```

## GET /v1/vehicle-documents/{id} {#get-vehicle-documents-id}

`GET /v1/vehicle-documents/{id}`

scope: `master:read` · operationId: `VehicleDocuments_get`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `VehicleDocumentDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/vehicle-documents/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/vehicle-documents/{id}', {
  params: { path: { id: "…" } },
});
```

## POST /v1/vehicle-documents/{id}/renew {#post-vehicle-documents-id-renew}

`POST /v1/vehicle-documents/{id}/renew`

scope: `master:write` · operationId: `VehicleDocuments_renew`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `Idempotency-Key` | header |   | `string` |   |

**Request body** `RenewVehicleDocumentDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `docNo` |   | `string` |   | เลขกรมธรรม์ / เลขใบอนุญาต / เลขที่เอกสาร — บังคับ ยกเว้น OTHER | `POL-27-10431` |
| `issuer` |   | `string` | null ได้ | บริษัทประกัน / หน่วยงานที่ออก | `วิริยะประกันภัย` |
| `startsOn` | ใช่ | `string (date)` |   | วันเริ่มมีผล (1980-01-01 – 2100-12-31) | `2026-11-30` |
| `expiresOn` | ใช่ | `string (date)` |   | วันหมดอายุ (ใช้ได้ถึงสิ้นวัน) — ต้องหลังวันเริ่ม | `2027-11-30` |
| `insuranceClass` |   | `string` | null ได้ | ชั้นประกัน — เฉพาะ INSURANCE | `1` |
| `sumInsured` |   | `string` | null ได้ | ทุนประกัน — เฉพาะ INSURANCE | `800000.00` |
| `premiumAmount` |   | `string` | null ได้ | เบี้ยประกัน — เฉพาะ INSURANCE | `28500.00` |
| `costAmount` |   | `string` | null ได้ | ค่าใช้จ่ายของฉบับนี้ (เบี้ย / ค่าธรรมเนียม) — รถบริษัท: เขียน vehicle_cost หมวด DOCUMENT 1 แถว | `28500.00` |
| `fileDocumentIds` | ใช่ | `array<string>` |   | ไฟล์แนบ (PDF/รูป) จาก POST /v1/documents kind=VEHICLE_DOC ที่อัปโหลดเสร็จแล้ว — อย่างน้อย 1 ไฟล์ | `["doc_…"]` |
| `note` |   | `string` | ยาว ≤ 500 · null ได้ |   |   |
| `title` |   | `string` |   | ชื่อเอกสารใหม่ — เฉพาะ OTHER (ไม่ส่ง = ชื่อเดิม) |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `201` |   | `VehicleDocumentRenewResultDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/vehicle-documents/<id>/renew" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"docNo":"POL-27-10431","startsOn":"2026-11-30","expiresOn":"2027-11-30","fileDocumentIds":["doc_…"]}'
```

```ts
const { data, error } = await tms.POST('/v1/vehicle-documents/{id}/renew', {
  params: { path: { id: "…" } },
  body: {
    "docNo": "POL-27-10431",
    "startsOn": "2026-11-30",
    "expiresOn": "2027-11-30",
    "fileDocumentIds": [
      "doc_…"
    ]
  },
});
```

## POST /v1/vehicle-documents/{id}/cancel {#post-vehicle-documents-id-cancel}

`POST /v1/vehicle-documents/{id}/cancel`

scope: `master:write` · operationId: `VehicleDocuments_cancel`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Request body** `CancelVehicleDocumentDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 | เหตุผล (ลง audit) |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `VehicleDocumentDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:write`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/vehicle-documents/<id>/cancel" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"string"}'
```

```ts
const { data, error } = await tms.POST('/v1/vehicle-documents/{id}/cancel', {
  params: { path: { id: "…" } },
  body: {
    "reason": "string"
  },
});
```

## Schema ของ response {#schemas}

### VehicleDocumentDto {#schema-VehicleDocumentDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `vdoc_…` |
| `vehicle` | ใช่ | `VehicleDocumentVehicleDto` |   |   |   |
| `docType` | ใช่ | `string` | ค่า: `INSURANCE`, `COMPULSORY_ACT`, `ANNUAL_TAX`, `INSPECTION`, `TRANSPORT_LICENSE`, `GPS_DLT_CERT`, `OTHER` |   |   |
| `title` | ใช่ | `string` | null ได้ | ชื่อเอกสาร (OTHER) |   |
| `docNo` | ใช่ | `string` | null ได้ |   |   |
| `issuer` | ใช่ | `string` | null ได้ |   |   |
| `startsOn` | ใช่ | `string (date)` |   |   |   |
| `expiresOn` | ใช่ | `string (date)` |   |   |   |
| `status` | ใช่ | `string` | ค่า: `active`, `expiring`, `expired`, `superseded`, `cancelled` |   |   |
| `daysToExpiry` | ใช่ | `number` |   | จำนวนวันจากวันนี้ (เวลาไทย) ถึงวันหมด — 0 = หมดวันนี้ (ยังใช้ได้), ติดลบ = หมดแล้ว |   |
| `insuranceClass` | ใช่ | `string` | null ได้ |   |   |
| `sumInsured` | ใช่ | `string` | null ได้ |   |   |
| `premiumAmount` | ใช่ | `string` | null ได้ |   |   |
| `costAmount` | ใช่ | `string` | null ได้ |   |   |
| `files` | ใช่ | `array<VehicleDocumentFileDto>` |   |   |   |
| `isRequiredForDispatch` | ใช่ | `boolean` |   |   |   |
| `renewsDocumentId` | ใช่ | `string` | null ได้ | ฉบับก่อนหน้า (ที่ฉบับนี้ต่ออายุ) |   |
| `renewedByDocumentId` | ใช่ | `string` | null ได้ | ฉบับที่ต่ออายุจากฉบับนี้ |   |
| `note` | ใช่ | `string` | null ได้ |   |   |
| `cancelReason` | ใช่ | `string` | null ได้ |   |   |
| `cancelledAt` | ใช่ | `string (date-time)` | null ได้ |   |   |
| `createdAt` | ใช่ | `string (date-time)` |   |   |   |
| `updatedAt` | ใช่ | `string (date-time)` |   |   |   |

### VehicleDocumentListDto {#schema-VehicleDocumentListDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<VehicleDocumentDto>` |   |   |   |

### VehicleDocumentPageDto {#schema-VehicleDocumentPageDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<VehicleDocumentDto>` |   |   |   |
| `nextCursor` | ใช่ | `string` | null ได้ |   |   |
| `hasMore` | ใช่ | `boolean` |   |   |   |

### VehicleDocumentRenewResultDto {#schema-VehicleDocumentRenewResultDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `document` | ใช่ | `VehicleDocumentDto` |   | ฉบับใหม่ |   |
| `previous` | ใช่ | `VehicleDocumentDto` |   | ฉบับเดิม (superseded) |   |

### VehicleDocumentSummaryDto {#schema-VehicleDocumentSummaryDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `total` | ใช่ | `number` |   | ฉบับปัจจุบันทั้งหมด |   |
| `expired` | ใช่ | `number` |   | หมดแล้ว (เลยวันหมด) |   |
| `within7` | ใช่ | `number` |   | หมดภายใน 7 วัน |   |
| `within30` | ใช่ | `number` |   | หมดภายใน 30 วัน |   |
| `within60` | ใช่ | `number` |   | หมดภายใน 60 วัน |   |
