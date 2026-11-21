# ค้นหา (search)

1 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`GET /v1/search`](#get-search) | `orders:read` / `trips:read` / `invoices:read` / `master:read` |

## ค้นหาเอกสาร ลูกค้า รถ (⌘K) {#get-search}

`GET /v1/search`

scope: `orders:read` หรือ `trips:read` หรือ `invoices:read` หรือ `master:read` · operationId: `Search_find`

ค้นพร้อมกันหลายชนิด: SO (`orders:read`), DO (`orders:read`), เที่ยวรถ (`trips:read`), ใบแจ้งหนี้และใบวางบิล (`invoices:read`), ลูกค้าและรถ (`master:read`) — ค้นเฉพาะชนิดที่ผู้เรียกมี scope (`searched`) · ผลต่อชนิดไม่เกิน `limit` เรียง ตรงทั้งคำ → ขึ้นต้นด้วย → มีอยู่ → แก้ล่าสุด · เห็นเฉพาะข้อมูลของบริษัท (หรือ sandbox) ของ credential นี้ · ไม่ส่งราคา/ยอดเงิน · นับ rate limit แบบอ่าน (GET)

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `q` | query | ใช่ | `string` | คำค้น (ตัดช่องว่างหน้า-หลัง) — ค้นแบบ "มีคำนี้อยู่" ไม่สนตัวพิมพ์ ใน: เลข SO / DO / เที่ยว / ใบแจ้งหนี้ / ใบวางบิล, เลข ลูกค้า (SO/DO `customerRef`, ใบแจ้งหนี้ `customerPoNo`), ทะเบียนรถ (เทียบแบบ normalize: เลขไทย → อารบิก ตัดช่องว่าง/ขีด/จุด), ชื่อ/รหัสลูกค้า |
| `limit` | query |   | `number` | จำนวนสูงสุดต่อชนิด |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `SearchResultDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มี scope อ่านชนิดใดเลย (`orders:read` / `trips:read` / `invoices:read` / `master:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | คำค้นสั้นกว่า 2 หรือยาวกว่า 64 ตัวอักษร (หลังตัดช่องว่าง) / `limit` นอกช่วง 1–10 — [validation_failed](errors.md#validation_failed) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/search" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/search');
```

## Schema ของ response {#schemas}

### SearchResultDto {#schema-SearchResultDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `q` | ใช่ | `string` |   | คำค้นหลังตัดช่องว่าง | `2611-00` |
| `searched` | ใช่ | `array<string>` |   | ชนิดที่ค้นให้ตามสิทธิ์ของผู้เรียก (ชนิดที่ไม่มีสิทธิ์อ่าน = ไม่ค้นและไม่อยู่ในรายการนี้) |   |
| `data` | ใช่ | `array<SearchHitDto>` |   | เรียงตามชนิด แล้วตรงทั้งคำ → ขึ้นต้นด้วย → มีอยู่ → แก้ล่าสุด |   |
