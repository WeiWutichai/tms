# invoices

1 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`GET /v1/invoices/queue`](#get-invoices-queue) | `invoices:read` |

## คิวพร้อมวางบิล (DO ที่ส่งแล้ว หลักฐานครบ และราคาพร้อม) {#get-invoices-queue}

`GET /v1/invoices/queue`

scope: `invoices:read` · operationId: `Invoices_list`

DO ที่ส่งถึงแล้ว (DELIVERED/POD_PENDING/UNBILLED) ที่ใบสั่ง `pricingStatus = AVAILABLE` และมีบรรทัดรายได้ที่ยืนยันแล้ว (ไม่มีบรรทัดยอดชั่วคราว/ล็อก ไม่มีค่าใช้จ่ายหน้างานฝั่งขายรอยืนยัน) และไม่ถูกระงับวางบิล · ลูกค้าที่เปิด "ไม่มี POD ไม่วางบิล" (`requirePodToBill`, ค่าเริ่มต้นเปิด) → DO ที่หลักฐานส่งยังไม่ครบตาม checklist ไม่ขึ้นคิว · กรองลูกค้า (`customerId` รับ `ext:`) / ช่วงวันที่ส่ง (`doDate`) / หลักฐานครบ / ส่งบัญชีแล้ว · `customers` = ยอดรวมต่อลูกค้าของทุกแถวที่ตรงตัวกรอง · ยอดเงิน (`sell*`) เห็นเมื่อมี `prices.sell:read`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน |
| `updatedAfter` | query |   | `string` | คืนเฉพาะแถวที่ updatedAt > ค่านี้ (incremental pull) |
| `sort` | query |   | `string` ค่า: `updatedAt`, `-updatedAt` |   |
| `fields` | query |   | `string` | รายชื่อ field คั่นด้วย, เช่น id,legalName |
| `customerId` | query |   | `string` | ลูกค้า — id หรือ `ext:{externalId}` (ไม่พบ = รายการว่าง) |
| `dateFrom` | query |   | `string` | วันที่ส่งตั้งแต่ (YYYY-MM-DD — วันที่ของใบส่งของ `doDate`) |
| `dateTo` | query |   | `string` | วันที่ส่งถึง (YYYY-MM-DD — รวมทั้งวัน) |
| `podComplete` | query |   | `string` ค่า: `true`, `false` | กรองตามหลักฐานส่ง (POD): true = ครบ · false = ยังไม่ครบ (มีได้เฉพาะลูกค้าที่ปิด "ไม่มี POD ไม่วางบิล") |
| `released` | query |   | `string` ค่า: `true`, `false` | กรองตามขั้นส่งบัญชี: true = ส่งบัญชีแล้ว (RELEASED) · false = ยังไม่ส่ง |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `BillingQueuePageDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`invoices:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/invoices/queue" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/invoices/queue');
```

## Schema ของ response {#schemas}

### BillingQueuePageDto {#schema-BillingQueuePageDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<BillingQueueRowDto>` |   |   |   |
| `nextCursor` | ใช่ | `string` | null ได้ |   |   |
| `hasMore` | ใช่ | `boolean` |   |   |   |
| `customers` | ใช่ | `array<BillingQueueCustomerDto>` |   | สรุปต่อลูกค้าของทุกแถวที่ตรงตัวกรอง (ไม่ขึ้นกับ cursor/limit) — เรียงตามรหัสลูกค้า |   |
