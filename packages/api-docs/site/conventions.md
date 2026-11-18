# แนวทางการใช้ API

มาตรฐานที่ทุก endpoint ใช้ร่วมกัน (docs/04 G1)

## รูปแบบข้อมูล

- base `https://api.<domain>/v1/` · JSON camelCase · resource พหูพจน์ · action = `POST /{resource}/{id}/{verb}` เช่น `POST /v1/orders/{id}/cancel`
- id มี prefix ตามชนิด เช่น `ord_` `trp_` `stp_` `cus_` `loc_` `veh_` `drv_` `car_` `evt_` `job_`
- **เงิน** เป็น string ทศนิยม 2 ตำแหน่ง เช่น `"1250.00"` (สกุล THB) — ห้ามแปลงเป็น float
- **จำนวน/น้ำหนัก** เป็น string ทศนิยม เช่น `"12.5"`
- **เวลา** ISO 8601 พร้อม offset (response ใช้ `+07:00` Asia/Bangkok) · **วันที่** `YYYY-MM-DD`
- client ต้องรับค่า enum ที่ไม่รู้จักได้ (เพิ่ม enum = ไม่ breaking)

## externalId

resource หลักมี `externalId` (รหัสในระบบของคุณ) unique ต่อบริษัท
- `PUT /v1/{resource}/external/{externalId}` = สร้างหรือแทนทั้งรายการ (`201`/`200`) · `PATCH …/external/{externalId}` = แก้บางช่อง
- path `{id}` รับ `ext:{externalId}` ได้ เช่น `GET /v1/orders/ext:PO-2026-0001`

## Idempotency-Key

ทุก `POST` รับ header `Idempotency-Key` (ASCII 1–255 ตัว เช่น UUID) เก็บ 24 ชม. ต่อ (บริษัท, key, path)
- ส่งซ้ำด้วย key + body เดิม → ได้ผลเดิม (สถานะ + ETag เดิม) พร้อม header `Idempotent-Replayed: true` ไม่สร้างซ้ำ
- key เดิมแต่ body ต่าง → `422 idempotency_mismatch` · คำขอแรกยังทำไม่เสร็จ → `409`
- SDK ใส่ให้อัตโนมัติทุก POST และใช้ key เดิมตอน retry

## Pagination แบบ cursor

```http
GET /v1/orders?limit=100&cursor=<nextCursor ของหน้าก่อน>
```

ได้ `{ "data": [...], "nextCursor": "...", "hasMore": true }` · `limit` ค่าเริ่ม 25 สูงสุด 200 · ไม่มี offset · ห้ามสร้าง cursor เอง · ดึงเฉพาะที่เปลี่ยนด้วย `updatedAfter=<ISO 8601>` · เรียงด้วย `sort=-updatedAt` · list ว่าง = `200` และ `data: []`

## ETag / If-Match

GET ใบเดียว / PUT / PATCH ตอบ header `ETag` (เช่น `"3"`) — ส่ง `If-Match: "3"` ตอนแก้เพื่อกันทับงานคนอื่น · ไม่ตรง = `412` (อ่านใหม่แล้วแก้อีกครั้ง) · ไม่ส่ง If-Match = แก้ได้เลย

## รูปแบบ error (RFC 9457)

ทุก 4xx/5xx เป็น `application/problem+json`:

```json
{
  "type": "https://docs.tms.example/problems/validation_failed",
  "title": "ข้อมูลไม่ถูกต้อง",
  "status": 422,
  "code": "validation_failed",
  "detail": "...",
  "instance": "/v1/orders",
  "requestId": "b6a1c2d3-…",
  "errors": [{ "field": "stops[0].type", "code": "invalid", "message": "..." }]
}
```

ตัดสินใจจาก `code` (คงที่ — รายการเต็มที่ [รหัส error](errors.md)) ไม่ใช่จาก `title` (ข้อความเปลี่ยนตามภาษา `Accept-Language`) · แจ้งปัญหาให้ส่ง `requestId` · ข้อมูลของบริษัทอื่น = `404` เสมอ
