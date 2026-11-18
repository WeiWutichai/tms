# Changelog

เวอร์ชันพฤติกรรม (`X-Api-Version`) ล่าสุด: `2026-11-18` — วิธีเลือกเวอร์ชันดู [เวอร์ชันของ API](versioning.md)

## 2026-11-18

API key: สถานะ `rotating` แยกจาก `active` (ST7-T07 — ตัวอย่างกลไก gate) · changed: payload webhook ตั้งฐานก่อน GA (ST7-T06 — id แบบ prefix ใน trip/stop/DO, DO `salesOrderId` → `orderId`, พักใบโดยระบบ = `order.held`, จัดรถใบค้าง = `order.released`; ไม่มี gate เพราะยังไม่มี production)

| ประเภท | รายละเอียด |
|---|---|
|   | API key ที่หมุนแล้ว (ใช้ได้ถึง revokeAt) มีสถานะ `rotating` — ก่อนหน้านี้แสดงเป็น `active` และตัวกรอง `status=active` รวม key เหล่านี้ |

## 2026-11-01

เวอร์ชันแรกของ /v1
