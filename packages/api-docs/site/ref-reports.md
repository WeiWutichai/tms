# reports

1 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`GET /v1/reports/unbilled-delivery-orders`](#get-reports-unbilled-delivery-orders) | `reports.finance:read` |

## DO ยังไม่วางบิลเกิน N วัน {#get-reports-unbilled-delivery-orders}

`GET /v1/reports/unbilled-delivery-orders`

scope: `reports.finance:read` · operationId: `Reports_unbilledDeliveryOrders`

DO ที่ส่งถึงแล้ว (DELIVERED / POD_PENDING / UNBILLED) และ**ยังไม่อยู่ในใบแจ้งหนี้ใด** ที่ **วันนี้ − วันที่ส่งถึง > N** (เวลาไทย) · วันที่ส่งถึง = เวลาบันทึกสถานะส่งถึงครั้งล่าสุด (ไม่มีประวัติ = วันที่ DO) · N = `minDays` หรือค่าตั้งองค์กร `billing.unbilledAlertDays` (ค่าเริ่ม 7) · เรียงส่งถึงเก่าสุดก่อน cursor (วันที่ส่งถึง, id) · มูลค่า = Σ บรรทัดรายได้ที่ยังใช้ (ก่อน VAT) — `sell*` เห็นเมื่อมี `prices.sell:read` · ส่งออก: `POST /v1/exports` resource `unbilled-delivery-orders`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `minDays` | query |   | `integer` | ส่งถึงแล้ว**เกิน**กี่วัน (วันนี้ − วันที่ส่งถึง > ค่านี้ เวลาไทย) — ไม่ส่ง = ค่าตั้งองค์กร `billing.unbilledAlertDays` (ค่าเริ่ม 7) |
| `customerId` | query |   | `string` | ลูกค้ารายเดียว — id หรือ `ext:{externalId}` |
| `limit` | query |   | `number` |   |
| `cursor` | query |   | `string` | ค่า nextCursor จากหน้าก่อน (เรียงวันที่ส่งถึงเก่าสุดก่อน) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `UnbilledReportDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`reports.finance:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/reports/unbilled-delivery-orders" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/reports/unbilled-delivery-orders');
```

## Schema ของ response {#schemas}

### UnbilledReportDto {#schema-UnbilledReportDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `asOf` | ใช่ | `string` |   | วันที่คำนวณ (วันนี้ เวลาไทย) | `2026-11-22` |
| `minDays` | ใช่ | `number` |   | เกณฑ์ที่ใช้ (วัน) — จาก `minDays` หรือค่าตั้งองค์กร | `7` |
| `deliveredOnOrBefore` | ใช่ | `string` |   | DO ที่ส่งถึงวันนี้หรือก่อนหน้านี้ (เวลาไทย) ขึ้นรายงาน = asOf − minDays − 1 | `2026-11-14` |
| `count` | ใช่ | `number` | null ได้ | จำนวน DO ทั้งหมดที่ตรงเงื่อนไข — **เฉพาะหน้าแรก** (ไม่มี cursor); หน้าถัดไป = null |   |
| `sellAmount` |   | `string` |   | มูลค่ารวมทุก DO ที่ตรงเงื่อนไข — เฉพาะหน้าแรก · `prices.sell:read` |   |
| `data` | ใช่ | `array<UnbilledDeliveryOrderDto>` |   |   |   |
| `nextCursor` | ใช่ | `string` | null ได้ |   |   |
| `hasMore` | ใช่ | `boolean` |   |   |   |
