# Connector ERP (connectors)

5 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`GET /v1/connectors/effective`](#get-connectors-effective) | `settings:read` |
| [`GET /v1/connectors`](#get-connectors) | `settings:read` |
| [`GET /v1/connectors/adapters`](#get-connectors-adapters) | `settings:read` |
| [`GET /v1/connectors/{id}`](#get-connectors-id) | `settings:read` |
| [`GET /v1/connectors/{id}/history`](#get-connectors-id-history) | `settings:read` |

## GET /v1/connectors/effective {#get-connectors-effective}

`GET /v1/connectors/effective`

scope: `settings:read` · operationId: `ConnectorsEffective_effective`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `companyId` | query |   | `string` | นิติบุคคล — ไม่ระบุทั้งนิติบุคคลและสาขา = ค่าเริ่มต้นระดับ tenant (connector ทุกนิติบุคคล หรือ Standalone) |
| `branchId` | query |   | `string` |   |
| `kind` | query |   | `string` ค่า: `invoice`, `tender` | ออกบิลในนาม / จ้างในนาม |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | connector ที่เอกสารของนิติบุคคล/สาขานี้ใช้ (routing: นิติบุคคล → ทุกนิติบุคคล → Standalone) + capability ที่ใช้ได้ | `EffectiveConnectorDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settings:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/connectors/effective" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/connectors/effective');
```

## GET /v1/connectors {#get-connectors}

`GET /v1/connectors`

scope: `settings:read` · operationId: `Connectors_list`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `status` | query |   | `string` ค่า: `ACTIVE`, `PAUSED`, `ERROR`, `DISCONNECTED` | ไม่ระบุ = ทุกสถานะยกเว้น DISCONNECTED |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `ConnectorListDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settings:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/connectors" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/connectors');
```

## GET /v1/connectors/adapters {#get-connectors-adapters}

`GET /v1/connectors/adapters`

scope: `settings:read` · operationId: `Connectors_adapters`

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | adapter ที่เปิดเป็น connector ได้ + capabilities + ช่องตั้งค่า (เรียงตามรหัส ไม่มีตัวใดเป็นค่าเริ่มต้น) | `ErpAdapterListDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settings:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/connectors/adapters" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/connectors/adapters');
```

## GET /v1/connectors/{id} {#get-connectors-id}

`GET /v1/connectors/{id}`

scope: `settings:read` · operationId: `Connectors_get`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `ConnectorDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settings:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/connectors/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/connectors/{id}', {
  params: { path: { id: "…" } },
});
```

## GET /v1/connectors/{id}/history {#get-connectors-id-history}

`GET /v1/connectors/{id}/history`

scope: `settings:read` · operationId: `Connectors_history`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | ประวัติจาก audit log ใหม่สุดก่อน | `AuditPageDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settings:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/connectors/<id>/history" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/connectors/{id}/history', {
  params: { path: { id: "…" } },
});
```

## Schema ของ response {#schemas}

### AuditPageDto {#schema-AuditPageDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<AuditEntryDto>` |   |   |   |
| `nextCursor` | ใช่ | `string` | null ได้ |   |   |
| `hasMore` | ใช่ | `boolean` |   |   |   |

### ConnectorDto {#schema-ConnectorDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `con_8f3a…` |
| `adapterKey` | ใช่ | `string` |   |   | `demo` |
| `displayName` | ใช่ | `string` | null ได้ | null = adapter ไม่ได้ติดตั้งในระบบนี้ | `Demo ERP` |
| `companyId` | ใช่ | `string` | null ได้ | นิติบุคคลที่ใช้ connector นี้ (Invoice As / Tender As) · null = ทุกนิติบุคคลที่ไม่มีของตัวเอง | `cmp_…` |
| `erpCompanyCode` | ใช่ | `string` | null ได้ |   | `PP01` |
| `branchMap` | ใช่ | `object` |   | สาขา TMS → รหัสบริษัท/สาขาฝั่ง ERP (ไม่มี = ใช้ erpCompanyCode) | `{"brn_8f3a":"PP01-BKK"}` |
| `status` | ใช่ | `string` | ค่า: `ACTIVE`, `PAUSED`, `ERROR`, `DISCONNECTED` |   |   |
| `statusReason` | ใช่ | `string` | null ได้ |   |   |
| `statusChangedAt` | ใช่ | `string (date-time)` | null ได้ |   |   |
| `capabilitiesSupported` | ใช่ | `array<string>` |   | capability ที่ adapter รองรับทั้งหมด |   |
| `capabilitiesEnabled` | ใช่ | `array<string>` |   | ที่ tenant เปิด |   |
| `capabilities` | ใช่ | `array<string>` |   | ใช้ได้จริง = รองรับ ∩ เปิด (ว่างเมื่อยกเลิกการเชื่อม) |   |
| `settings` | ใช่ | `object` |   | ค่าตั้งที่ไม่ลับ (base URL ฯลฯ) |   |
| `credentialKeys` | ใช่ | `array<string>` |   | ชื่อช่อง credential ที่ตั้งแล้ว — ค่าไม่ส่งกลับเด็ดขาด | `["apiKey"]` |
| `credentialsUpdatedAt` | ใช่ | `string (date-time)` | null ได้ |   |   |
| `syncFromDate` | ใช่ | `string (date)` | null ได้ |   | `2026-12-01` |
| `lastHealthAt` | ใช่ | `string (date-time)` | null ได้ |   |   |
| `lastHealthOk` | ใช่ | `boolean` | null ได้ |   |   |
| `lastHealthError` | ใช่ | `object` | null ได้ | {errorClass, code, message} ของ healthCheck ล่าสุดที่ล้ม |   |
| `activatedAt` | ใช่ | `string (date-time)` | null ได้ |   |   |
| `disconnectedAt` | ใช่ | `string (date-time)` | null ได้ |   |   |
| `inbound` | ใช่ | `ConnectorInboundDto` |   |   |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string (date-time)` |   |   |   |
| `updatedAt` | ใช่ | `string (date-time)` |   |   |   |

### ConnectorListDto {#schema-ConnectorListDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<ConnectorDto>` |   |   |   |

### EffectiveConnectorDto {#schema-EffectiveConnectorDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `standalone` | ใช่ | `boolean` |   | true = ไม่เชื่อม ERP (ทุก flow ทำใน TMS) |   |
| `connectorId` | ใช่ | `string` | null ได้ |   |   |
| `adapterKey` | ใช่ | `string` |   |   | `standalone` |
| `displayName` | ใช่ | `string` | null ได้ |   |   |
| `adapterAvailable` | ใช่ | `boolean` |   | false = adapter ของ connector ไม่ได้ติดตั้ง/ปิดใน environment นี้ (เช่น demo ใน production) — ไม่ส่ง/ไม่ดึง |   |
| `status` | ใช่ | `string` | ค่า: `ACTIVE`, `PAUSED`, `ERROR`, `DISCONNECTED` · null ได้ |   |   |
| `capabilities` | ใช่ | `array<string>` |   | ใช้ได้จริง (UI แสดงเฉพาะที่อยู่ในรายการนี้) |   |
| `documentSync` | ใช่ | `DocumentSyncDto` |   | มีขั้น sync ไหมต่อประเภทเอกสาร — `NOT_APPLICABLE` = ไม่แสดงสถานะ sync, เอกสารเดินสถานะใน TMS เอง (invoice ISSUED → PAID ไม่มี SENT) |   |
| `sending` | ใช่ | `boolean` |   | ส่ง/ดึงได้ตอนนี้ (ACTIVE) — false = เอกสารเข้าคิวรอ |   |
| `scope` | ใช่ | `string` | ค่า: `company`, `tenant`, `none` |   |   |
| `erpCompanyCode` | ใช่ | `string` | null ได้ |   |   |
| `companyId` | ใช่ | `string` | null ได้ | นิติบุคคลที่ routing เลือก (null = ไม่ได้ระบุ — ค่าระดับ tenant) | `cmp_…` |
| `branchId` | ใช่ | `string` | null ได้ |   | `brn_…` |

### ErpAdapterListDto {#schema-ErpAdapterListDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<ErpAdapterDto>` |   |   |   |
