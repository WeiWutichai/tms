# เลขที่เอกสาร (document-sequences)

2 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`GET /v1/document-sequences`](#get-document-sequences) | `settings:read` |
| [`GET /v1/document-sequences/{id}`](#get-document-sequences-id) | `settings:read` |

## GET /v1/document-sequences {#get-document-sequences}

`GET /v1/document-sequences`

scope: `settings:read` · operationId: `Sequences_list`

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `SequenceListDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settings:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/document-sequences" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/document-sequences');
```

## GET /v1/document-sequences/{id} {#get-document-sequences-id}

`GET /v1/document-sequences/{id}`

scope: `settings:read` · operationId: `Sequences_get`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `SequenceDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settings:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/document-sequences/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/document-sequences/{id}', {
  params: { path: { id: "…" } },
});
```

## Schema ของ response {#schemas}

### SequenceDto {#schema-SequenceDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `seq_…` |
| `docType` | ใช่ | `string` | ค่า: `SO`, `TRIP`, `DO`, `BN`, `INV`, `TXINV`, `RCP`, `CN`, `DN`, `STL`, `WHT`, `WO`, `INC` |   |   |
| `prefix` | ใช่ | `string` |   |   | `INV-{BR}-` |
| `resetPolicy` | ใช่ | `string` | ค่า: `monthly`, `yearly`, `never` |   |   |
| `padding` | ใช่ | `number` |   |   |   |
| `perBranch` | ใช่ | `boolean` |   | นับแยกต่อสาขาผู้ออก (เอกสารภาษี) |   |
| `pattern` | ใช่ | `string` |   |   | `{YYMM}-{NNNN}` |
| `nextNumber` | ใช่ | `string` | null ได้ | เลขถัดไปของงวดนี้ (ไม่จอง) — null เมื่อยังไม่มีสาขาออกเอกสาร | `INV-00000-2611-0042` |
| `version` | ใช่ | `number` |   |   |   |
| `updatedAt` | ใช่ | `string (date-time)` |   |   |   |

### SequenceListDto {#schema-SequenceListDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<SequenceDto>` |   |   |   |
