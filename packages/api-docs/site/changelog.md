# Changelog

เวอร์ชันพฤติกรรม (`X-Api-Version`) ล่าสุด: `2026-11-18` — วิธีเลือกเวอร์ชันดู [เวอร์ชันของ API](versioning.md)

## 2026-11-18

API key: สถานะ `rotating` แยกจาก `active` · changed: payload webhook ตั้งฐานก่อน GA

| รหัสการเปลี่ยน | รายละเอียด |
|---|---|
| `api_key.status_rotating` | API key ที่หมุนแล้ว (ใช้ได้ถึง revokeAt) มีสถานะ `rotating` — ก่อนหน้านี้แสดงเป็น `active` และตัวกรอง `status=active` รวม key เหล่านี้ |

## 2026-11-01

เวอร์ชันแรกของ /v1
