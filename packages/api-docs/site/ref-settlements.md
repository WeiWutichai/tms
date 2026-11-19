# จ่ายรถร่วม (settlements)

1 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`GET /v1/settlements/queue`](#get-settlements-queue) | `settlements:read` |

## คิวจ่ายรถร่วม (เที่ยวที่ปิดต้นทุนแล้วและยังไม่อยู่ในใบสำคัญจ่าย) {#get-settlements-queue}

`GET /v1/settlements/queue`

scope: `settlements:read` · operationId: `Settlements_list`

เที่ยว **COSTED** ของรถร่วมที่ยังมีบรรทัดต้นทุนรอจ่าย (ค่าจ้าง CARRIER_FEE + ค่าใช้จ่ายหน้างานฝั่งซื้อที่ยืนยันแล้ว ของรถร่วมรายปัจจุบัน ที่ยังไม่อยู่ในใบสำคัญจ่าย) · รถร่วมที่ตั้ง "ไม่มี POD ไม่จ่าย" (`requirePodToPay`) → เที่ยวที่หลักฐานส่งยังไม่ครบไม่ขึ้นคิว · กรองรถร่วม (`carrierId` รับ `ext:`) / ช่วงวันที่เที่ยวจบ (เวลาไทย) / หลักฐานครบ · `carriers` = ยอดรวมต่อรถร่วมของทุกแถวที่ตรงตัวกรอง · ยอดเงิน (`buy*`) เห็นเมื่อมี `prices.buy:read` · ปิดต้นทุนเที่ยว (COMPLETED → COSTED) ยังปิดใช้จนกว่าจะกำหนดวิธีปันต้นทุนลง DO (`POST /trips/{id}/cost` → 409 `trip_costing_unavailable`) — ระหว่างนั้นคิวว่าง

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน |
| `updatedAfter` | query |   | `string` | คืนเฉพาะแถวที่ updatedAt > ค่านี้ (incremental pull) |
| `sort` | query |   | `string` ค่า: `updatedAt`, `-updatedAt` |   |
| `fields` | query |   | `string` | รายชื่อ field คั่นด้วย, เช่น id,legalName |
| `carrierId` | query |   | `string` | รถร่วม — id หรือ `ext:{externalId}` (ไม่พบ = รายการว่าง) |
| `dateFrom` | query |   | `string` | วันที่เที่ยวจบตั้งแต่ (YYYY-MM-DD ตามเวลาไทย — `completedAt`) |
| `dateTo` | query |   | `string` | วันที่เที่ยวจบถึง (YYYY-MM-DD ตามเวลาไทย — รวมทั้งวัน) |
| `podComplete` | query |   | `string` ค่า: `true`, `false` | กรองตามหลักฐานส่ง (POD) ของเที่ยว: true = ครบ · false = ยังไม่ครบ (มีได้เฉพาะรถร่วมที่ปิด "ไม่มี POD ไม่จ่าย") |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `SettlementQueuePageDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`settlements:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/settlements/queue" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/settlements/queue');
```

## Schema ของ response {#schemas}

### SettlementQueuePageDto {#schema-SettlementQueuePageDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `data` | ใช่ | `array<SettlementQueueTripDto>` |   |   |   |
| `nextCursor` | ใช่ | `string` | null ได้ |   |   |
| `hasMore` | ใช่ | `boolean` |   |   |   |
| `carriers` | ใช่ | `array<SettlementQueueCarrierDto>` |   | สรุปต่อรถร่วมของทุกเที่ยวที่ตรงตัวกรอง (ไม่ขึ้นกับ cursor/limit) — เรียงตามรหัสรถร่วม |   |
