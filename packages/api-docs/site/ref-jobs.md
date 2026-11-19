# งานเบื้องหลัง (jobs)

1 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`GET /v1/jobs/{id}`](#get-jobs-id) | `jobs:read` |

## GET /v1/jobs/{id} {#get-jobs-id}

`GET /v1/jobs/{id}`

scope: `jobs:read` · operationId: `Jobs_get`

ต้องมี `jobs:read` (ดูทุกงานของบริษัท) **หรือ** เป็นผู้สั่งงานนั้นเอง (เช่น `POST /v1/orders:bulk` + `Prefer: respond-async` ด้วยสิทธิ์ `orders:write`) — ไม่มี `jobs:read` และไม่ใช่งานของตน = 403 `permission_denied` (ไม่บอกว่ามีงานนั้นหรือไม่)

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `id` | path | ใช่ | `string` |   |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `JobDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`jobs:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `404` | ไม่พบ (รวมข้อมูลของบริษัทอื่น — ไม่บอกว่ามีอยู่) — [not_found](errors.md#not_found) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/jobs/<id>" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/jobs/{id}', {
  params: { path: { id: "…" } },
});
```

## Schema ของ response {#schemas}

### JobDto {#schema-JobDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `id` | ใช่ | `string` |   |   | `job_…` |
| `type` | ใช่ | `string` |   |   |   |
| `status` | ใช่ | `string` | ค่า: `pending`, `running`, `succeeded`, `succeeded_with_errors`, `failed`, `skipped` | `succeeded_with_errors` = ทำครบแต่บางรายการไม่ผ่าน (bulk — ดู `result.results[]`) · `failed` = งานล้มทั้งงาน · client ต้องรับค่าที่ไม่รู้จักได้ |   |
| `progress` | ใช่ | `number` | ≥ 0 · ≤ 100 |   |   |
| `result` | ใช่ | `object` | null ได้ |   |   |
| `error` | ใช่ | `object` | null ได้ |   |   |
| `attempts` | ใช่ | `number` |   |   |   |
| `createdAt` | ใช่ | `string (date-time)` |   |   |   |
| `finishedAt` | ใช่ | `string (date-time)` | null ได้ |   |   |
