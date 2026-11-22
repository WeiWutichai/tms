# reports

2 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`GET /v1/reports/revenue`](#get-reports-revenue) | `reports.finance:read` |
| [`GET /v1/reports/unbilled-delivery-orders`](#get-reports-unbilled-delivery-orders) | `reports.finance:read` |

## รายงานรายได้ {#get-reports-revenue}

`GET /v1/reports/revenue`

scope: `reports.finance:read` · operationId: `Reports_revenueReport`

รายได้จาก**บรรทัดใบแจ้งหนี้ที่ออกเลขแล้ว** (ISSUED / PARTIALLY_PAID / PAID / ADJUSTED — ไม่รวมร่างและใบที่ยกเลิก/void) ตามวันที่ออกใบ (เวลาไทย) ในช่วง `fromMonth`–`toMonth` จัดกลุ่มตาม `groupBy` (ลูกค้า / เส้นทาง / รถ / ประเภทรถ / นิติบุคคล / เดือน) · รายได้ = Σ ยอดบรรทัดหลังส่วนลด **ก่อน VAT** · Σ แถว = `sellAmount` รวม ทุกมิติ · บรรทัดที่ไม่ผูก DO / DO ที่ไม่มีเที่ยวหรือรถ อยู่แถว "ไม่ระบุ" (`id: none`) · `sell*` เห็นเมื่อมี `prices.sell:read` (ไม่มี = เห็นจำนวน) · ส่งออก: `POST /v1/exports` resource `revenue` (xlsx / csv / pdf) · แพ็กเกจต้องมีโมดูลรายงาน (`report`)

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `groupBy` | query |   | `string` ค่า: `customer`, `route`, `vehicle`, `vehicleType`, `legalEntity`, `month` | จัดกลุ่มตาม: `customer` ลูกค้า · `route` เส้นทาง (ต้นทาง – ปลายทางของ DO) · `vehicle` รถ · `vehicleType` ประเภทรถ · `legalEntity` นิติบุคคลผู้ออกใบ · `month` เดือนที่ออกใบ |
| `fromMonth` | query |   | `string` | เดือนแรก (YYYY-MM ตามวันที่ออกใบ เวลาไทย) — ไม่ส่ง = เท่ากับ `toMonth` · ช่วงยาวสุด 24 เดือน |
| `toMonth` | query |   | `string` | เดือนสุดท้าย (YYYY-MM รวมเดือนนี้) — ไม่ส่ง = เดือนปัจจุบัน (เวลาไทย) |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `RevenueReportDto` |
| `401` | ไม่มี/ผิด credential (Bearer JWT, `tk_live_…` / `tk_test_…`) — key ถูกเพิกถอน = `key_revoked`, หมดอายุ = `key_expired` — [unauthorized](errors.md#unauthorized) | `ProblemDto` |
| `403` | ไม่มีสิทธิ์ (`reports.finance:read`) — [permission_denied](errors.md#permission_denied) | `ProblemDto` |
| `422` | ข้อมูลไม่ถูกต้อง — `errors[]` รายช่อง — [validation_failed](errors.md#validation_failed), [idempotency_mismatch](errors.md#idempotency_mismatch) | `ProblemDto` |
| `429` | rate_limited — เรียกถี่เกินเพดาน (problem+json มี `scope`: tenant \| key \| user \| endpoint \| ip \| link และ `retryAfter`) รอตาม Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/reports/revenue" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/reports/revenue');
```

## DO ยังไม่วางบิลเกิน N วัน {#get-reports-unbilled-delivery-orders}

`GET /v1/reports/unbilled-delivery-orders`

scope: `reports.finance:read` · operationId: `Reports_unbilledDeliveryOrders`

DO ที่ส่งถึงแล้ว (DELIVERED / POD_PENDING / UNBILLED) และ**ยังไม่อยู่ในใบแจ้งหนี้ใด**: `includeStaleDrafts=true` รวม DO ที่อยู่ในร่างใบแจ้งหนี้นานเกิน N วัน (วันนี้ − วันที่เข้าร่าง > N) พร้อม `draftInvoice` (id ร่าง + อายุ) ที่ **วันนี้ − วันที่ส่งถึง > N** (เวลาไทย) · วันที่ส่งถึง = เวลาบันทึกสถานะส่งถึงครั้งล่าสุด (ไม่มีประวัติ = วันที่ DO) · N = `minDays` หรือค่าตั้งองค์กร `billing.unbilledAlertDays` (ค่าเริ่ม 7) · เรียงส่งถึงเก่าสุดก่อน cursor (วันที่ส่งถึง, id) · มูลค่า = Σ บรรทัดรายได้ที่ยังใช้ (ก่อน VAT) — `sell*` เห็นเมื่อมี `prices.sell:read` · ส่งออก: `POST /v1/exports` resource `unbilled-delivery-orders`

**Parameters**

| ชื่อ | อยู่ที่ | บังคับ | ชนิด | คำอธิบาย |
|---|---|---|---|---|
| `minDays` | query |   | `integer` | ส่งถึงแล้ว**เกิน**กี่วัน (วันนี้ − วันที่ส่งถึง > ค่านี้ เวลาไทย) — ไม่ส่ง = ค่าตั้งองค์กร `billing.unbilledAlertDays` (ค่าเริ่ม 7) |
| `customerId` | query |   | `string` | ลูกค้ารายเดียว — id หรือ `ext:{externalId}` |
| `includeStaleDrafts` | query |   | `string` ค่า: `true`, `false` | รวม DO ที่อยู่ใน**ร่าง**ใบแจ้งหนี้ (`billingStatus` IN_DRAFT) นานเกิน N วัน (วันนี้ − วันที่ DO เข้าร่าง > N เวลาไทย — N ตัวเดียวกับ `minDays`) — แถวนั้นมี `draftInvoice` · ไม่ส่ง/false = เฉพาะ DO ที่ยังไม่อยู่ในใบใด (เดิม) |
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

### RevenueReportDto {#schema-RevenueReportDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `groupBy` | ใช่ | `string` | ค่า: `customer`, `route`, `vehicle`, `vehicleType`, `legalEntity`, `month` |   |   |
| `fromMonth` | ใช่ | `string` |   |   | `2026-11` |
| `toMonth` | ใช่ | `string` |   |   | `2026-11` |
| `from` | ใช่ | `string` |   | วันที่ออกใบตั้งแต่ (เวลาไทย) | `2026-11-01` |
| `to` | ใช่ | `string` |   | วันที่ออกใบถึง (รวม) | `2026-11-30` |
| `asOf` | ใช่ | `string` |   | วันที่คำนวณ (วันนี้ เวลาไทย) | `2026-11-22` |
| `invoiceCount` | ใช่ | `number` |   | จำนวนใบแจ้งหนี้ที่ออกในช่วง (ไม่รวมร่าง/ยกเลิก) |   |
| `deliveryOrderCount` | ใช่ | `number` |   | จำนวน DO ทั้งหมดที่มีบรรทัดในช่วง |   |
| `lineCount` | ใช่ | `number` |   | จำนวนบรรทัดทั้งหมด |   |
| `sellAmount` |   | `string` |   | รายได้รวมทั้งช่วง (ก่อน VAT) = Σ `sellAmount` ของทุกแถวในทุกมิติ = Σ ยอดก่อน VAT ของใบที่ออกในช่วง — `prices.sell:read` | `480000.00` |
| `data` | ใช่ | `array<RevenueRowDto>` |   |   |   |

### UnbilledReportDto {#schema-UnbilledReportDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `asOf` | ใช่ | `string` |   | วันที่คำนวณ (วันนี้ เวลาไทย) | `2026-11-22` |
| `minDays` | ใช่ | `number` |   | เกณฑ์ที่ใช้ (วัน) — จาก `minDays` หรือค่าตั้งองค์กร | `7` |
| `deliveredOnOrBefore` | ใช่ | `string` |   | DO ที่ส่งถึงวันนี้หรือก่อนหน้านี้ (เวลาไทย) ขึ้นรายงาน = asOf − minDays − 1 | `2026-11-14` |
| `count` | ใช่ | `number` | null ได้ | จำนวน DO ทั้งหมดที่ตรงเงื่อนไข — **เฉพาะหน้าแรก** (ไม่มี cursor); หน้าถัดไป = null |   |
| `includeStaleDrafts` | ใช่ | `boolean` |   | รวม DO ในร่างค้างเกิน N วันหรือไม่ (ตาม `includeStaleDrafts`) |   |
| `staleDraftCount` | ใช่ | `number` | null ได้ | จำนวน DO ในร่างค้างเกิน N วัน (รวมอยู่ใน `count`) — เฉพาะหน้าแรกและเมื่อ `includeStaleDrafts=true`; อื่น ๆ = null |   |
| `sellAmount` |   | `string` |   | มูลค่ารวมทุก DO ที่ตรงเงื่อนไข — เฉพาะหน้าแรก · `prices.sell:read` |   |
| `data` | ใช่ | `array<UnbilledDeliveryOrderDto>` |   |   |   |
| `nextCursor` | ใช่ | `string` | null ได้ |   |   |
| `hasMore` | ใช่ | `boolean` |   |   |   |
