# Connector ERP (connectors)

18 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`GET /v1/connectors/effective`](#get-connectors-effective) | `settings:read` |
| [`GET /v1/connectors`](#get-connectors) | `settings:read` |
| [`GET /v1/connectors/adapters`](#get-connectors-adapters) | `settings:read` |
| [`GET /v1/connectors/{id}`](#get-connectors-id) | `settings:read` |
| [`GET /v1/connectors/{id}/history`](#get-connectors-id-history) | `settings:read` |
| [`GET /v1/connectors/{id}/commands`](#get-connectors-id-commands) | `settings:read` |
| [`GET /v1/connectors/{id}/sync-log`](#get-connectors-id-sync-log) | `settings:read` / `integrations:read` |
| [`GET /v1/connectors/{id}/queue`](#get-connectors-id-queue) | `settings:read` / `integrations:read` |
| [`GET /v1/connectors/{id}/queue/summary`](#get-connectors-id-queue-summary) | `settings:read` / `integrations:read` |
| [`POST /v1/connectors/{id}/queue/retry`](#post-connectors-id-queue-retry) | `settings:write` / `integrations:retry` |
| [`POST /v1/connectors/{id}/queue/{commandId}/retry`](#post-connectors-id-queue-commandId-retry) | `settings:write` / `integrations:retry` |
| [`POST /v1/connectors/{id}/queue/{commandId}/skip`](#post-connectors-id-queue-commandId-skip) | `settings:write` / `integrations:retry` |
| [`POST /v1/connectors/{id}/queue/{commandId}/approve`](#post-connectors-id-queue-commandId-approve) | `credit-notes:approve` |
| [`POST /v1/connectors/{id}/queue/{commandId}/external-id`](#post-connectors-id-queue-commandId-external-id) | `settings:write` / `integrations:retry` |
| [`GET /v1/connectors/{id}/master-codes`](#get-connectors-id-master-codes) | `settings:read` |
| [`GET /v1/connectors/{id}/mappings`](#get-connectors-id-mappings) | `settings:read` |
| [`GET /v1/reconcile-results`](#get-reconcile-results) | `integrations:read` |
| [`GET /v1/reconcile-results/{id}`](#get-reconcile-results-id) | `integrations:read` |

## GET /v1/connectors/effective {#get-connectors-effective}

`GET /v1/connectors/effective`

scope: `settings:read` · operationId: `ConnectorsEffective_effective`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `X-Tms-Mode` | header |   | `string` ค่า: `live`, `test` | เฉพาะผู้ใช้ที่ login (UI): `test` = จัดการข้อมูลของ Sandbox ของบริษัท (key `tk_test_`, webhook ของ sandbox) · ไม่ส่ง = live · API key ไม่ใช้ header นี้ (โหมดตาม key) |
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
| `X-Tms-Mode` | header |   | `string` ค่า: `live`, `test` | เฉพาะผู้ใช้ที่ login (UI): `test` = จัดการข้อมูลของ Sandbox ของบริษัท (key `tk_test_`, webhook ของ sandbox) · ไม่ส่ง = live · API key ไม่ใช้ header นี้ (โหมดตาม key) |
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

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `X-Tms-Mode` | header |   | `string` ค่า: `live`, `test` | เฉพาะผู้ใช้ที่ login (UI): `test` = จัดการข้อมูลของ Sandbox ของบริษัท (key `tk_test_`, webhook ของ sandbox) · ไม่ส่ง = live · API key ไม่ใช้ header นี้ (โหมดตาม key) |

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
| `X-Tms-Mode` | header |   | `string` ค่า: `live`, `test` | เฉพาะผู้ใช้ที่ login (UI): `test` = จัดการข้อมูลของ Sandbox ของบริษัท (key `tk_test_`, webhook ของ sandbox) · ไม่ส่ง = live · API key ไม่ใช้ header นี้ (โหมดตาม key) |
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
| `X-Tms-Mode` | header |   | `string` ค่า: `live`, `test` | เฉพาะผู้ใช้ที่ login (UI): `test` = จัดการข้อมูลของ Sandbox ของบริษัท (key `tk_test_`, webhook ของ sandbox) · ไม่ส่ง = live · API key ไม่ใช้ header นี้ (โหมดตาม key) |
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

## GET /v1/connectors/{id}/commands {#get-connectors-id-commands}

`GET /v1/connectors/{id}/commands`

scope: `settings:read` · operationId: `Connectors_commands`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `X-Tms-Mode` | header |   | `string` ค่า: `live`, `test` | เฉพาะผู้ใช้ที่ login (UI): `test` = จัดการข้อมูลของ Sandbox ของบริษัท (key `tk_test_`, webhook ของ sandbox) · ไม่ส่ง = live · API key ไม่ใช้ header นี้ (โหมดตาม key) |
| `id` | path | ใช่ | `string` |   |
| `status` | query |   | `string` ค่า: `PENDING`, `IN_FLIGHT`, `DONE`, `FAILED_RETRYABLE`, `FAILED_FINAL`, `SKIPPED` |   |
| `limit` | query |   | `number` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | บันทึกการซิงก์ย่อ: คำสั่งล่าสุดในคิวของ connector นี้ (ใหม่สุดก่อน) — ไม่มี payload/response | `ConnectorCommandListDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settings:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/connectors/<id>/commands" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/connectors/{id}/commands', {
  params: { path: { id: "…" } },
});
```

## GET /v1/connectors/{id}/sync-log {#get-connectors-id-sync-log}

`GET /v1/connectors/{id}/sync-log`

scope: `settings:read` หรือ `integrations:read` · operationId: `Connectors_syncLog`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `X-Tms-Mode` | header |   | `string` ค่า: `live`, `test` | เฉพาะผู้ใช้ที่ login (UI): `test` = จัดการข้อมูลของ Sandbox ของบริษัท (key `tk_test_`, webhook ของ sandbox) · ไม่ส่ง = live · API key ไม่ใช้ header นี้ (โหมดตาม key) |
| `id` | path | ใช่ | `string` |   |
| `commandId` | query |   | `string` | เฉพาะการเรียกของคำสั่งนี้ (บันทึกการซิงก์) |
| `documentNo` | query |   | `string` | เลขเอกสาร TMS |
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน (เรียงใหม่สุดก่อน) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | sync log: 1 แถวต่อ 1 HTTP call ที่ connector นี้เรียกระบบบัญชี (ใหม่สุดก่อน) — body ตัด credential / เลขบัตรประชาชนแล้ว (≤ 16 KB) · ไม่มี header · URL ไม่มี query string · `commandId` = เฉพาะการเรียกของคำสั่งนั้น · `documentNo` = เลขเอกสาร TMS | `ErpSyncLogListDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settings:read` / `integrations:read` — มีตัวใดตัวหนึ่งก็พอ) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/connectors/<id>/sync-log" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/connectors/{id}/sync-log', {
  params: { path: { id: "…" } },
});
```

## GET /v1/connectors/{id}/queue {#get-connectors-id-queue}

`GET /v1/connectors/{id}/queue`

scope: `settings:read` หรือ `integrations:read` · operationId: `Connectors_queueList`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `X-Tms-Mode` | header |   | `string` ค่า: `live`, `test` | เฉพาะผู้ใช้ที่ login (UI): `test` = จัดการข้อมูลของ Sandbox ของบริษัท (key `tk_test_`, webhook ของ sandbox) · ไม่ส่ง = live · API key ไม่ใช้ header นี้ (โหมดตาม key) |
| `id` | path | ใช่ | `string` |   |
| `tab` | query |   | `string` ค่า: `queued`, `failed`, `done` | รอคิว / ล้มเหลว (ต้องมีคนทำ) / สำเร็จ |
| `errorClass` | query |   | `string` ค่า: `TRANSIENT`, `AMBIGUOUS`, `DUPLICATE`, `VALIDATION`, `AUTH`, `NOT_FOUND`, `PERIOD_CLOSED`, `CAPABILITY` | กรองตาม ErrorClass (จัดกลุ่มแท็บล้มเหลว) |
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน (เรียงตามเวลาที่เปลี่ยนล่าสุด ใหม่สุดก่อน) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | คิวของ connector แยกแท็บ `queued` (PENDING/IN_FLIGHT/FAILED_RETRYABLE + `nextRunAt`) / `failed` (ต้องมีคนทำ: FAILED_FINAL, SKIPPED ที่แจ้งบัญชี, DUPLICATE ที่ต้องกรอกเลขเอง — ยังไม่ได้จัดการ) / `done` · `errorClass` กรองกลุ่ม · แต่ละรายการมี `guide` (คู่มือภาษาไทยต่อ error code), `link` + `missing[]` (mapping/ผังรหัสที่ขาด), `actions` · request/response ของคำสั่ง = `GET /connectors/{id}/sync-log?commandId=` · keyset cursor | `ConnectorQueueListDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settings:read` / `integrations:read` — มีตัวใดตัวหนึ่งก็พอ) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/connectors/<id>/queue" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/connectors/{id}/queue', {
  params: { path: { id: "…" } },
});
```

## GET /v1/connectors/{id}/queue/summary {#get-connectors-id-queue-summary}

`GET /v1/connectors/{id}/queue/summary`

scope: `settings:read` หรือ `integrations:read` · operationId: `Connectors_queueSummary`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `X-Tms-Mode` | header |   | `string` ค่า: `live`, `test` | เฉพาะผู้ใช้ที่ login (UI): `test` = จัดการข้อมูลของ Sandbox ของบริษัท (key `tk_test_`, webhook ของ sandbox) · ไม่ส่ง = live · API key ไม่ใช้ header นี้ (โหมดตาม key) |
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | ตัวนับต่อแท็บ (`failed` = badge ที่เมนู — ไม่รวมคิวที่ระบบกำลังส่งเอง) + แท็บล้มเหลวแยก ErrorClass | `ConnectorQueueSummaryDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settings:read` / `integrations:read` — มีตัวใดตัวหนึ่งก็พอ) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/connectors/<id>/queue/summary" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/connectors/{id}/queue/summary', {
  params: { path: { id: "…" } },
});
```

## POST /v1/connectors/{id}/queue/retry {#post-connectors-id-queue-retry}

`POST /v1/connectors/{id}/queue/retry`

scope: `settings:write` หรือ `integrations:retry` · operationId: `Connectors_queueRetryAll`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `X-Tms-Mode` | header |   | `string` ค่า: `live`, `test` | เฉพาะผู้ใช้ที่ login (UI): `test` = จัดการข้อมูลของ Sandbox ของบริษัท (key `tk_test_`, webhook ของ sandbox) · ไม่ส่ง = live · API key ไม่ใช้ header นี้ (โหมดตาม key) |
| `id` | path | ใช่ | `string` |   |

**Request body** `QueueRetryAllDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `errorClass` |   | `string` | ค่า: `TRANSIENT`, `AMBIGUOUS`, `DUPLICATE`, `VALIDATION`, `AUTH`, `NOT_FOUND`, `PERIOD_CLOSED`, `CAPABILITY` | ส่งซ้ำเฉพาะ ErrorClass นี้ (ไม่ส่ง = ทุกรายการที่ส่งซ้ำได้) |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | ส่งซ้ำทุกรายการในแท็บล้มเหลวที่ส่งซ้ำได้ (ครั้งละ ≤ 200; `errorClass` = เฉพาะกลุ่ม) — แต่ละรายการ = `ErpSyncService.resend` (canonical ฉบับที่ออก) · รายการที่ต้องทำในระบบบัญชีเองนับใน `notRetryable` | `QueueRetryAllResultDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settings:write` / `integrations:retry` — มีตัวใดตัวหนึ่งก็พอ) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/connectors/<id>/queue/retry" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{}'
```

```ts
const { data, error } = await tms.POST('/v1/connectors/{id}/queue/retry', {
  params: { path: { id: "…" } },
  body: {},
});
```

## POST /v1/connectors/{id}/queue/{commandId}/retry {#post-connectors-id-queue-commandId-retry}

`POST /v1/connectors/{id}/queue/{commandId}/retry`

scope: `settings:write` หรือ `integrations:retry` · operationId: `Connectors_queueRetry`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `X-Tms-Mode` | header |   | `string` ค่า: `live`, `test` | เฉพาะผู้ใช้ที่ login (UI): `test` = จัดการข้อมูลของ Sandbox ของบริษัท (key `tk_test_`, webhook ของ sandbox) · ไม่ส่ง = live · API key ไม่ใช้ header นี้ (โหมดตาม key) |
| `id` | path | ใช่ | `string` |   |
| `commandId` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | ส่งซ้ำ 1 รายการในแท็บล้มเหลว (หลังแก้ mapping / ผังรหัส / เปิดงวดบัญชี) → คำสั่งใหม่ (รายการเดิมออกจากคิว) · ส่งซ้ำไม่ได้ (จัดการแล้ว / ไม่ใช่รายการล้มเหลว / ต้องทำในระบบบัญชีเอง / ก่อนวันเริ่มซิงก์) → 409 `queue_action_not_allowed` (`why`) | `QueueRetryResultDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settings:write` / `integrations:retry` — มีตัวใดตัวหนึ่งก็พอ) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/connectors/<id>/queue/<commandId>/retry" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)"
```

```ts
const { data, error } = await tms.POST('/v1/connectors/{id}/queue/{commandId}/retry', {
  params: { path: { id: "…", commandId: "…" } },
});
```

## POST /v1/connectors/{id}/queue/{commandId}/skip {#post-connectors-id-queue-commandId-skip}

`POST /v1/connectors/{id}/queue/{commandId}/skip`

scope: `settings:write` หรือ `integrations:retry` · operationId: `Connectors_queueSkip`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `X-Tms-Mode` | header |   | `string` ค่า: `live`, `test` | เฉพาะผู้ใช้ที่ login (UI): `test` = จัดการข้อมูลของ Sandbox ของบริษัท (key `tk_test_`, webhook ของ sandbox) · ไม่ส่ง = live · API key ไม่ใช้ header นี้ (โหมดตาม key) |
| `id` | path | ใช่ | `string` |   |
| `commandId` | path | ใช่ | `string` |   |

**Request body** `QueueSkipDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `เลิกใช้บริการตั้งแต่ ธ.ค. 2569` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | ข้ามรายการในแท็บล้มเหลว (เช่น บัญชีบันทึกในระบบบัญชีเองแล้ว / งวดปิดและรับทราบ) — เหตุผล ≥ 10 ตัว · audit `connector.queue_skipped` · ย้ายไปแท็บสำเร็จ | `ConnectorQueueItemDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settings:write` / `integrations:retry` — มีตัวใดตัวหนึ่งก็พอ) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/connectors/<id>/queue/<commandId>/skip" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"เลิกใช้บริการตั้งแต่ ธ.ค. 2569"}'
```

```ts
const { data, error } = await tms.POST('/v1/connectors/{id}/queue/{commandId}/skip', {
  params: { path: { id: "…", commandId: "…" } },
  body: {
    "reason": "เลิกใช้บริการตั้งแต่ ธ.ค. 2569"
  },
});
```

## POST /v1/connectors/{id}/queue/{commandId}/approve {#post-connectors-id-queue-commandId-approve}

`POST /v1/connectors/{id}/queue/{commandId}/approve`

scope: `credit-notes:approve` · operationId: `Connectors_queueApprove`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `X-Tms-Mode` | header |   | `string` ค่า: `live`, `test` | เฉพาะผู้ใช้ที่ login (UI): `test` = จัดการข้อมูลของ Sandbox ของบริษัท (key `tk_test_`, webhook ของ sandbox) · ไม่ส่ง = live · API key ไม่ใช้ header นี้ (โหมดตาม key) |
| `id` | path | ใช่ | `string` |   |
| `commandId` | path | ใช่ | `string` |   |

**Request body** `QueueApproveDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `เลิกใช้บริการตั้งแต่ ธ.ค. 2569` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | อนุมัติการแทนที่เอกสารในระบบบัญชี (รายการ `replace_requires_approval` — ลงบัญชีแล้ว (ERP แจ้ง / ปุ่ม "ลงบัญชีแล้ว") หรือใบอายุเกิน `billing.erpReplaceApprovalDays` วัน, A.2) — คนเท่านั้น · เหตุผล ≥ 10 ตัว · ผู้อนุมัติต้องไม่ใช่ผู้ขอ (ผู้ออกใบใหม่ / ผู้ยกเลิกใบเดิม / ผู้สั่งส่งซ้ำ) → 403 `erp_replace_self_approval` · ผล: คำสั่งใหม่ที่ส่งได้ทันที (`resolution.supersededBy`) · audit `connector.queue_approved` · ไม่ใช่รายการรออนุมัติ → 409 `queue_action_not_allowed` (`why`: `not_awaiting_approval` ฯลฯ) | `ConnectorQueueItemDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`credit-notes:approve`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/connectors/<id>/queue/<commandId>/approve" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"เลิกใช้บริการตั้งแต่ ธ.ค. 2569"}'
```

```ts
const { data, error } = await tms.POST('/v1/connectors/{id}/queue/{commandId}/approve', {
  params: { path: { id: "…", commandId: "…" } },
  body: {
    "reason": "เลิกใช้บริการตั้งแต่ ธ.ค. 2569"
  },
});
```

## POST /v1/connectors/{id}/queue/{commandId}/external-id {#post-connectors-id-queue-commandId-external-id}

`POST /v1/connectors/{id}/queue/{commandId}/external-id`

scope: `settings:write` หรือ `integrations:retry` · operationId: `Connectors_queueExternalId`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `X-Tms-Mode` | header |   | `string` ค่า: `live`, `test` | เฉพาะผู้ใช้ที่ login (UI): `test` = จัดการข้อมูลของ Sandbox ของบริษัท (key `tk_test_`, webhook ของ sandbox) · ไม่ส่ง = live · API key ไม่ใช้ header นี้ (โหมดตาม key) |
| `id` | path | ใช่ | `string` |   |
| `commandId` | path | ใช่ | `string` |   |

**Request body** `QueueExternalIdDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `reason` | ใช่ | `string` | ยาว ≤ 500 · ยาว ≥ 10 |   | `เลิกใช้บริการตั้งแต่ ธ.ค. 2569` |
| `externalId` |   | `string` | ยาว ≤ 100 · ยาว ≥ 1 | id เอกสารฝั่งระบบบัญชี (เอกสารใบเดียว) — ส่งอย่างใดอย่างหนึ่งกับ `documents` | `IV6611-00042` |
| `externalDocNo` |   | `string` | ยาว ≤ 60 | เลขเอกสารที่แสดงในระบบบัญชี (ถ้าต่างจาก id) |   |
| `documents` |   | `array<QueueExternalDocumentDto>` | ≤ 200 รายการ | เอกสารที่ระบบบัญชีเก็บเป็นหลายใบ (เช่น KRS แยกใบตามชนิด VAT): เลขฝั่งระบบบัญชีต่อใบ — `ref` ต้องอยู่ในการแยกใบของเอกสาร · กรอกเฉพาะใบที่มีในระบบบัญชีแล้ว (ใบที่ไม่กรอก ระบบส่งให้ภายหลัง) · ระบบอ่านเอกสารจากระบบบัญชีมาเทียบก่อนเสมอ ไม่ส่งซ้ำ |   |
| `documents[].ref` | ใช่ | `string` | ยาว ≤ 100 · ยาว ≥ 1 | เลขอ้างอิงที่ TMS ส่งของใบนี้ (ต้องตรงกับการแยกใบของเอกสาร) | `2611-0001-V7` |
| `documents[].externalId` | ใช่ | `string` | ยาว ≤ 100 · ยาว ≥ 1 | id เอกสารฝั่งระบบบัญชีของใบนี้ (เช่น transactionNo ของ KRS) | `100042` |
| `documents[].externalDocNo` |   | `string` | ยาว ≤ 60 | เลขเอกสารที่แสดงในระบบบัญชี (ถ้าต่างจาก id) |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | กรอกเลขเอกสารฝั่งระบบบัญชีเอง (DUPLICATE ที่หาไม่เจอ หรือคำสั่งส่งเอกสารที่ล้มเหลวแต่เอกสารอยู่ในระบบบัญชีแล้ว) — เหตุผล ≥ 10 ตัว · audit `connector.queue_external_id` · external_mapping = MISMATCH `erp_content_unverified` (รอบ reconcile ยืนยัน) · เลขผูกกับเอกสารอื่นแล้ว → 409 `external_id_conflict` ระบบบัญชีที่แยกเอกสารเป็นหลายใบ (เช่น KRS แยกตามชนิด VAT): กรอก `documents` ต่อใบ (`ref` ต้องอยู่ในการแยกใบ — นอกแผน/ซ้ำ/ไม่ตรงกับเลขที่ระบบรู้แล้ว = 422) · แผนมีใบเดียวรับ `externalId` ได้ · ผล: external_mapping PENDING + คำสั่งส่งใหม่ (`resolution.supersededBy`) ที่อ่านเอกสารจากระบบบัญชีมาเทียบก่อน (ตรง = SYNCED · ต่าง = MISMATCH · ไม่พบ = REMOTE_MISSING) และส่งเฉพาะใบที่ไม่ได้กรอก — ไม่ส่งใบที่กรอกแล้วซ้ำ | `ConnectorQueueItemDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settings:write` / `integrations:retry` — มีตัวใดตัวหนึ่งก็พอ) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/connectors/<id>/queue/<commandId>/external-id" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"reason":"เลิกใช้บริการตั้งแต่ ธ.ค. 2569","externalId":"IV6611-00042"}'
```

```ts
const { data, error } = await tms.POST('/v1/connectors/{id}/queue/{commandId}/external-id', {
  params: { path: { id: "…", commandId: "…" } },
  body: {
    "reason": "เลิกใช้บริการตั้งแต่ ธ.ค. 2569",
    "externalId": "IV6611-00042"
  },
});
```

## GET /v1/connectors/{id}/master-codes {#get-connectors-id-master-codes}

`GET /v1/connectors/{id}/master-codes`

scope: `settings:read` · operationId: `ErpMasterCodes_list`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `X-Tms-Mode` | header |   | `string` ค่า: `live`, `test` | เฉพาะผู้ใช้ที่ login (UI): `test` = จัดการข้อมูลของ Sandbox ของบริษัท (key `tk_test_`, webhook ของ sandbox) · ไม่ส่ง = live · API key ไม่ใช้ header นี้ (โหมดตาม key) |
| `id` | path | ใช่ | `string` |   |
| `kind` | query |   | `string` ค่า: `UNIT`, `SALESPERSON`, `ACCOUNT`, `ITEM`, `VAT_RATE` |   |
| `includeInactive` | query |   | `boolean` | true = รวมรหัสที่ปิดใช้แล้ว |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | ผังรหัสที่ระบบบัญชียอมรับ (หน่วย พนักงานขาย ผังบัญชี รหัสสินค้า/บริการ อัตรา VAT) | `ErpMasterCodeListDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settings:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/connectors/<id>/master-codes" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/connectors/{id}/master-codes', {
  params: { path: { id: "…" } },
});
```

## GET /v1/connectors/{id}/mappings {#get-connectors-id-mappings}

`GET /v1/connectors/{id}/mappings`

scope: `settings:read` · operationId: `ErpMasterCodes_mappings`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `X-Tms-Mode` | header |   | `string` ค่า: `live`, `test` | เฉพาะผู้ใช้ที่ login (UI): `test` = จัดการข้อมูลของ Sandbox ของบริษัท (key `tk_test_`, webhook ของ sandbox) · ไม่ส่ง = live · API key ไม่ใช้ header นี้ (โหมดตาม key) |
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | ค่าบริการฝั่งขายทุกตัว + รหัสสินค้า ERP ที่จับคู่ · รายการที่ไม่ครบ (UNMAPPED/CODE_UNKNOWN) ทำให้เอกสารที่ใช้ส่งเข้า ERP ไม่ได้ (คำสั่ง push = FAILED_FINAL `VALIDATION` `erp_mapping_incomplete` — เอกสารยังออกได้) | `ErpItemMappingListDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settings:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/connectors/<id>/mappings" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/connectors/{id}/mappings', {
  params: { path: { id: "…" } },
});
```

## GET /v1/reconcile-results {#get-reconcile-results}

`GET /v1/reconcile-results`

scope: `integrations:read` · operationId: `Reconcile_list`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `X-Tms-Mode` | header |   | `string` ค่า: `live`, `test` | เฉพาะผู้ใช้ที่ login (UI): `test` = จัดการข้อมูลของ Sandbox ของบริษัท (key `tk_test_`, webhook ของ sandbox) · ไม่ส่ง = live · API key ไม่ใช้ header นี้ (โหมดตาม key) |
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน |
| `updatedAfter` | query |   | `string` | คืนเฉพาะแถวที่ updatedAt > ค่านี้ (incremental pull) |
| `sort` | query |   | `string` ค่า: `updatedAt`, `-updatedAt` |   |
| `fields` | query |   | `string` | รายชื่อ field คั่นด้วย, เช่น id,legalName |
| `status` | query |   | `string` ค่า: `OPEN`, `ACKNOWLEDGED`, `RESOLVED` | OPEN = ยังต่างอยู่และยังไม่มีคนยอมรับ · ACKNOWLEDGED = คนยอมรับความต่างแล้ว · RESOLVED = ระบบปิดแล้ว (รอบถัดไปตรงกัน/ส่วนต่างเปลี่ยน) |
| `connectorId` | query |   | `string` |   |
| `invoiceId` | query |   | `string` | ผลของใบแจ้งหนี้นี้ |
| `severity` | query |   | `string` ค่า: `MONEY`, `FIELD`, `INFO` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | รายการที่ข้อมูล TMS ไม่ตรงกับระบบบัญชีที่เชื่อมต่อ (MISMATCH) — ตอนนี้ = ยอดรับชำระของใบแจ้งหนี้ (`check` PAYMENT_STATUS, severity MONEY) · กรอง `status` OPEN/ACKNOWLEDGED/RESOLVED, `connectorId`, `invoiceId`, `severity` · cursor มาตรฐาน (updatedAt, id) · ส่วนต่างเดิมไม่สร้างรายการซ้ำ (`lastSeenAt` = รอบล่าสุดที่ยังพบ) · ระบบ**ไม่ปรับยอดใน TMS เอง** — แก้ที่ต้นเหตุ (บันทึก/กลับรายการรับชำระ) แล้วรอบถัดไปปิดให้ (`RESOLVED`) · ยอดเงินต้องมี `prices.sell:read` | `ReconcileResultPageDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`integrations:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง (query/body) — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/reconcile-results" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/reconcile-results');
```

## GET /v1/reconcile-results/{id} {#get-reconcile-results-id}

`GET /v1/reconcile-results/{id}`

scope: `integrations:read` · operationId: `Reconcile_get`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `X-Tms-Mode` | header |   | `string` ค่า: `live`, `test` | เฉพาะผู้ใช้ที่ login (UI): `test` = จัดการข้อมูลของ Sandbox ของบริษัท (key `tk_test_`, webhook ของ sandbox) · ไม่ส่ง = live · API key ไม่ใช้ header นี้ (โหมดตาม key) |
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `ReconcileResultDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`integrations:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/reconcile-results/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/reconcile-results/{id}', {
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

### ConnectorCommandListDto {#schema-ConnectorCommandListDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<ConnectorCommandDto>` |   |   |   |

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
| `capabilitiesSupported` | ใช่ | `array<string>` |   | capability ที่ adapter รองรับ (ใช้งานได้จริง — ไม่รวมที่ยังไม่ได้ทำ) |   |
| `capabilitiesPending` | ใช่ | `array<string>` |   | capability ที่ adapter ประกาศแต่ยังไม่ได้ทำ — เปิดไม่ได้ แสดงเป็น "ยังไม่รองรับ" |   |
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
| `systemOfRecord` | ใช่ | `SystemOfRecordDto` |   |   |   |
| `version` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string (date-time)` |   |   |   |
| `updatedAt` | ใช่ | `string (date-time)` |   |   |   |

### ConnectorListDto {#schema-ConnectorListDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<ConnectorDto>` |   |   |   |

### ConnectorQueueItemDto {#schema-ConnectorQueueItemDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `obx_…` |
| `operation` | ใช่ | `string` |   |   | `PUSH_INVOICE` |
| `entityType` | ใช่ | `string` |   |   | `invoice` |
| `localId` | ใช่ | `string` |   | id ของเอกสารใน TMS (uuid) |   |
| `status` | ใช่ | `string` | ค่า: `PENDING`, `IN_FLIGHT`, `DONE`, `FAILED_RETRYABLE`, `FAILED_FINAL`, `SKIPPED` |   |   |
| `attempt` | ใช่ | `number` |   |   |   |
| `errorClass` | ใช่ | `string` | null ได้ |   | `TRANSIENT` |
| `errorCode` | ใช่ | `string` | null ได้ | รหัสผิดพลาดล่าสุด (ไม่มีข้อความดิบ) |   |
| `createdAt` | ใช่ | `string (date-time)` |   |   |   |
| `doneAt` | ใช่ | `string (date-time)` | null ได้ |   |   |
| `updatedAt` | ใช่ | `string (date-time)` |   |   |   |
| `tab` | ใช่ | `string` | ค่า: `queued`, `failed`, `done` |   |   |
| `documentNo` | ใช่ | `string` | null ได้ |   | `2611-0001` |
| `nextRunAt` | ใช่ | `string (date-time)` | null ได้ | รอคิว: เวลาที่จะลองครั้งถัดไป |   |
| `errorMessage` | ใช่ | `string` | null ได้ | ข้อความผิดพลาด (ตัด secret แล้ว) |   |
| `link` | ใช่ | `string` | null ได้ | ลิงก์หน้าที่ต้องแก้ (mapping / ผังรหัส) |   |
| `missing` | ใช่ | `array<QueueMissingDto>` |   |   |   |
| `fields` | ใช่ | `array<QueueFieldErrorDto>` |   | ช่องที่ระบบบัญชีแจ้งว่าผิด |   |
| `manualExternalIdRequired` | ใช่ | `boolean` |   |   |   |
| `guide` | ใช่ | `QueueGuideDto` | null ได้ |   |   |
| `resolution` | ใช่ | `QueueResolutionDto` | null ได้ |   |   |
| `actions` | ใช่ | `QueueActionsDto` |   |   |   |
| `bodiesHidden` | ใช่ | `boolean` |   | ผู้เรียกไม่มีสิทธิ์ดูราคาของเอกสารชนิดนี้ — sync log ของคำสั่งนี้จะไม่มี body (ซ่อนปุ่ม "ดู payload") |   |

### ConnectorQueueListDto {#schema-ConnectorQueueListDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<ConnectorQueueItemDto>` |   |   |   |
| `nextCursor` | ใช่ | `string` | null ได้ |   |   |
| `hasMore` | ใช่ | `boolean` |   |   |   |

### ConnectorQueueSummaryDto {#schema-ConnectorQueueSummaryDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `queued` | ใช่ | `number` |   |   |   |
| `failed` | ใช่ | `number` |   | ต้องมีคนทำ (badge ที่เมนู) |   |
| `done` | ใช่ | `number` |   |   |   |
| `failedByClass` | ใช่ | `object` |   | แท็บล้มเหลวแยกตาม ErrorClass | `{"VALIDATION":2,"PERIOD_CLOSED":1}` |

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
| `systemOfRecord` | ใช่ | `EffectiveSystemOfRecordDto` |   | system-of-record ที่ใช้กับนิติบุคคลนี้ — connector ที่ยังไม่ยกเลิก (แม้หยุดชั่วคราว/แพ็กเกจปิดการเชื่อมต่อ) ใช้กฎของ connector · ไม่มี = TMS ทั้งหมด |   |

### ErpAdapterListDto {#schema-ErpAdapterListDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<ErpAdapterDto>` |   |   |   |

### ErpItemMappingListDto {#schema-ErpItemMappingListDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<ErpItemMappingDto>` |   |   |   |
| `summary` | ใช่ | `ErpMappingSummaryDto` |   |   |   |

### ErpMasterCodeListDto {#schema-ErpMasterCodeListDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<ErpMasterCodeDto>` |   |   |   |

### ErpSyncLogListDto {#schema-ErpSyncLogListDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<ErpSyncLogDto>` |   |   |   |
| `nextCursor` | ใช่ | `string` | null ได้ | ส่งเป็น `cursor` เพื่อดูหน้าถัดไป |   |
| `hasMore` | ใช่ | `boolean` |   |   |   |

### QueueRetryAllResultDto {#schema-QueueRetryAllResultDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `retried` | ใช่ | `number` |   | จำนวนที่สร้างคำสั่งส่งซ้ำ |   |
| `notRetryable` | ใช่ | `number` |   | จำนวนในแท็บล้มเหลวที่ส่งซ้ำไม่ได้ (ต้องข้าม/กรอกเลขเอง) |   |
| `remaining` | ใช่ | `number` |   | เหลือที่ยังไม่ได้ทำ (ทำครั้งละไม่เกิน 200) |   |

### QueueRetryResultDto {#schema-QueueRetryResultDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `command` | ใช่ | `ConnectorQueueItemDto` |   | คำสั่งใหม่ที่ส่งแทน |   |

### ReconcileResultDto {#schema-ReconcileResultDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `rec_0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e` |
| `connector` | ใช่ | `ReconcileConnectorDto` |   |   |   |
| `entityType` | ใช่ | `string` |   | ชนิดเอกสารฝั่ง TMS ที่เทียบ | `INVOICE` |
| `invoiceId` | ใช่ | `string` | null ได้ |   | `ivc_…` |
| `localNumber` | ใช่ | `string` | null ได้ |   | `2611-0001` |
| `result` | ใช่ | `string` | ค่า: `MATCH`, `MISMATCH`, `REMOTE_MISSING`, `ERP_UNREACHABLE` |   |   |
| `severity` | ใช่ | `string` | ค่า: `MONEY`, `FIELD`, `INFO` | MONEY = กระทบยอดเงิน |   |
| `source` | ใช่ | `string` | ค่า: `AFTER_PUSH`, `NIGHTLY`, `PRE_CLOSE`, `MANUAL` | NIGHTLY = รอบดึงรายวัน · MANUAL = สั่งเอง (`POST /reconcile-runs`) |   |
| `status` | ใช่ | `string` | ค่า: `OPEN`, `ACKNOWLEDGED`, `RESOLVED` |   |   |
| `check` | ใช่ | `string` | null ได้ | PAYMENT_STATUS = ยอดรับชำระ · DOCUMENT = เอกสารที่ส่งแล้วหาไม่พบในระบบบัญชี | `PAYMENT_STATUS` |
| `code` | ใช่ | `string` | ค่า: `remote_exceeds_total`, `remote_paid_amount_short`, `remote_less_than_tms`, `tms_has_other_payments`, `connector_payment_reversed`, `remote_wht_unknown`, `remote_wht_inconsistent`, `remote_paid_at_invalid`, `payment_rejected`, `remote_missing` · null ได้ | `remote_exceeds_total` ระบบบัญชีตัดหนี้เกินยอดใบ · `remote_paid_amount_short` ระบบบัญชีบอกชำระครบแต่ยอดตัดหนี้น้อยกว่ายอดใบ · `remote_less_than_tms` ระบบบัญชีตัดหนี้น้อยกว่าที่ TMS บันทึกรับ · `tms_has_other_payments` ระบบบัญชีตัดหนี้มากกว่า TMS แต่ใบมีรับชำระที่บันทึกเอง (ไม่บันทึกเพิ่มให้เอง) · `connector_payment_reversed` ใบนี้เคยมีรายการที่ระบบสร้างแล้วถูกกลับรายการใน TMS (ไม่สร้างให้อีก) · `remote_wht_unknown` ระบบบัญชีไม่บอกภาษีหัก ณ ที่จ่าย · `remote_wht_inconsistent` ภาษีหัก ณ ที่จ่ายที่รายงานขัดกัน · `remote_paid_at_invalid` วันที่รับชำระไม่มี/เป็นอนาคต/ก่อนวันออกใบ · `payment_rejected` กฎรับชำระของ TMS ไม่รับ (ดู `reason`) · `remote_missing` แทนที่/อ่านเอกสารแล้วระบบบัญชีตอบว่าไม่พบ — ส่งใหม่เป็นเลขใหม่ต้องให้บัญชีรับรู้ |   |
| `reason` | ใช่ | `string` | null ได้ | รหัสเหตุผลเพิ่มเติม (เฉพาะ `payment_rejected`) — เป็นรหัสเท่านั้น ไม่มียอดเงิน | `invoice_not_payable` |
| `localStatus` | ใช่ | `string` | null ได้ |   | `PARTIALLY_PAID` |
| `remoteStatus` | ใช่ | `string` | null ได้ |   | `PAID` |
| `remotePaidAt` | ใช่ | `string (date-time)` | null ได้ |   |   |
| `externalDocNo` | ใช่ | `string` | null ได้ | เลขเอกสารฝั่งระบบบัญชี |   |
| `sellLocalPaidAmount` |   | `string` |   | ยอดตัดหนี้ของใบใน TMS (รวม WHT) — `prices.sell:read` |   |
| `sellRemotePaidAmount` |   | `string` |   | ยอดตัดหนี้สะสมที่ระบบบัญชีรายงาน — `prices.sell:read` |   |
| `sellDifferenceAmount` |   | `string` |   | ระบบบัญชี − TMS — `prices.sell:read` |   |
| `runAt` | ใช่ | `string (date-time)` |   | รอบที่พบครั้งแรก |   |
| `lastSeenAt` | ใช่ | `string (date-time)` |   | รอบล่าสุดที่ยังพบส่วนต่างเดิม |   |
| `resolvedAt` | ใช่ | `string (date-time)` | null ได้ |   |   |
| `acknowledgedAt` | ใช่ | `string (date-time)` | null ได้ |   |   |
| `createdAt` | ใช่ | `string (date-time)` |   |   |   |
| `updatedAt` | ใช่ | `string (date-time)` |   |   |   |

### ReconcileResultPageDto {#schema-ReconcileResultPageDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<ReconcileResultDto>` |   |   |   |
| `nextCursor` | ใช่ | `string` | null ได้ |   |   |
| `hasMore` | ใช่ | `boolean` |   |   |   |
