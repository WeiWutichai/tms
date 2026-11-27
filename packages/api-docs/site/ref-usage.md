# usage

2 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`GET /v1/usage/metrics`](#get-usage-metrics) | `master:read` |
| [`GET /v1/usage/active-vehicles`](#get-usage-active-vehicles) | `master:read` |

## การใช้งานอื่นของเดือน (DO, ใบแจ้งหนี้, API calls, พื้นที่ POD, connector, ผู้ใช้) {#get-usage-metrics}

`GET /v1/usage/metrics`

scope: `master:read` · operationId: `Usage_metrics`

Usage & Billing — ยอดเดือน = ผลรวมของยอดรายวัน (`usage_daily`) สำหรับ DO / ใบแจ้งหนี้ / API calls · พื้นที่ POD / connector / ผู้ใช้ = ค่า ณ วันล่าสุดของเดือน (เดือนนี้ = ค่าสด) · ปิดยอดพร้อมรถ active · e-Tax ไม่มีในเฟส 1 (`eTaxDocuments` = null) · sandbox ไม่นับ · ใช้ออกบิลเฉพาะรถ active (เมตริกอื่นเพื่อดู/โควตา)

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `period` | query |   | `string` | เดือนปฏิทินเวลาไทย YYYY-MM (ไม่ส่ง = เดือนนี้) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `UsageMetricsDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/usage/metrics" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/usage/metrics');
```

## รถ active ของเดือน + ทะเบียนที่ถูกนับ {#get-usage-active-vehicles}

`GET /v1/usage/active-vehicles`

scope: `master:read` · operationId: `Usage_activeVehicles`

รถ active = ทะเบียน (normalize: ตัดช่องว่าง/ขีด/จุด, เลขไทย → อารบิก — "กข-1234" = "กข1234") ที่มีเที่ยวเข้าเงื่อนไข ≥ 1 เที่ยวในเดือนปฏิทินเวลาไทย · นับทันทีเมื่อเที่ยวแรกของทะเบียนเข้าเงื่อนไข และนำออกเมื่อเที่ยวย้อนสถานะ (เช่น ยกเลิกหลังปล่อยรถ) ก่อนปิดยอด · ปิดยอดวันที่ 1 เวลา 02:00 น. ไทยของเดือนถัดไป · sandbox ไม่นับ

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `period` | query |   | `string` | เดือนปฏิทินเวลาไทย YYYY-MM (ไม่ส่ง = เดือนนี้) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `ActiveVehicleUsageDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/usage/active-vehicles" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/usage/active-vehicles');
```

## Schema ของ response {#schemas}

### ActiveVehicleUsageDto {#schema-ActiveVehicleUsageDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `period` | ใช่ | `string` |   |   | `2026-11` |
| `status` | ใช่ | `string` | ค่า: `open`, `finalized`, `invoiced` | open = ยังนับอยู่ (ค่าสด) · finalized = ปิดยอดแล้ว (วันที่ 1 เวลา 02:00 น. ไทยของเดือนถัดไป) |   |
| `finalizedAt` | ใช่ | `string (date-time)` | null ได้ |   |   |
| `activeVehicles` | ใช่ | `number` |   | รถ active ของเดือน (metric `vehicles.active`) = ทะเบียน normalize ที่มีเที่ยวเข้าเงื่อนไข ≥ 1 เที่ยว · กติกาปัจจุบัน: เที่ยวที่ปล่อยรถแล้ว (ไม่นับร่าง/ยกเลิกก่อนออกวิ่ง/sandbox) นับตามเวลาไทย R-05 |   |
| `own` | ใช่ | `number` |   | รถบริษัท |   |
| `subcontract` | ใช่ | `number` |   | รถร่วม |   |
| `limit` | ใช่ | `number` | null ได้ | โควตารถ active ต่อเดือน (tenant.vehicle_quota → entitlement `veh`) — null = ไม่จำกัด |   |
| `data` | ใช่ | `array<ActiveVehicleItemDto>` |   |   |   |

### UsageMetricsDto {#schema-UsageMetricsDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `period` | ใช่ | `string` |   |   | `2026-11` |
| `status` | ใช่ | `string` | ค่า: `open`, `finalized`, `invoiced` | open = ยังนับอยู่ (DO/ใบแจ้งหนี้อัปเดตทุก ≤ 10 นาที, API calls ≤ 30 วินาที) · finalized = ปิดยอดพร้อมรถ active (วันที่ 1 เวลา 02:00 น. ไทย) |   |
| `finalizedAt` | ใช่ | `string (date-time)` | null ได้ |   |   |
| `doCreated` | ใช่ | `number` |   | `do.created` — DO ที่สร้างในเดือน (เวลาไทย) ไม่รวมที่ยกเลิก = ผลรวมรายวัน |   |
| `invoicesIssued` | ใช่ | `number` |   | `invoices.issued` — ใบแจ้งหนี้ที่ออกเลขในเดือน = ผลรวมรายวัน |   |
| `apiCalls` | ใช่ | `ApiCallsDto` |   | `api.calls` — คำขอ `/v1` ของ API key / OAuth client ที่ตอบ 2xx/3xx/4xx (ไม่นับ 429 และ 5xx) · UI ของระบบไม่นับ · key ของ sandbox ไม่นับ |   |
| `podStorageGb` | ใช่ | `number` |   | `storage.pod_gb` — ขนาดไฟล์ POD + เอกสารแนบที่อัปโหลด (GB = 1024³ ทศนิยม 2, สะสมไม่รีเซ็ต) ณ วันล่าสุดของเดือน | `1.25` |
| `connectors` | ใช่ | `number` |   | `connectors.accounting` — connector ระบบบัญชีที่ active |   |
| `connectorLimit` | ใช่ | `number` | null ได้ | จำนวน connector สูงสุดตามแพ็กเกจ (entitlement `conn`) — null = ไม่จำกัด/ไม่กำหนด |   |
| `users` | ใช่ | `number` |   | `users.active` — ผู้ใช้สถานะใช้งาน |   |
| `eTaxDocuments` | ใช่ | `number` | null ได้ | เอกสาร e-Tax — ไม่มีในเฟส 1 จึงเป็น null เสมอ (UI แสดง "—") |   |
| `gaugeAsOf` | ใช่ | `string (date)` | null ได้ | วันของค่า POD/connector/ผู้ใช้ (null = ค่าสด) |   |
| `metricsSource` | ใช่ | `string` | ค่า: `usage_record`, `usage_daily` | ที่มาของตัวเลข: usage_record = ยอดปิดของเมตริกเหล่านี้ · usage_daily = คำนวณจากยอดรายวัน (เดือนที่ยังเปิด หรือเดือนที่ปิดยอดรถ active ก่อนมีเมตริกอื่น) |   |
