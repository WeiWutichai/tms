# Changelog

เวอร์ชันพฤติกรรม (`X-Api-Version`) ล่าสุด: `2026-11-28` — วิธีเลือกเวอร์ชันดู [เวอร์ชันของ API](versioning.md)

## 2026-11-28

โควตา: จ่ายงานให้รถที่ยังไม่ถูกนับเดือนนี้และจะทำให้รถ active เกินโควตา → คำเตือน `vehicle_quota_exceeded` — `POST /v1/trips/{id}/dispatch` (และ `/assign` แบบ `dispatch: true`) ตอบ 409 `assignment_warnings` จนกว่าจะยืนยันด้วย `ruleKeys` + `overrideReason` · 409 `connector_limit_reached` / `webhook_limit_reached` / `seat_limit_reached` เพิ่ม `featureKey` `used` `upgradePlan` (เพิ่มค่า — ไม่มี gate)

## 2026-11-27

สถานะบริษัท 7 ค่า: `GET /v1/me` `tenant.status` = pending_verification / trialing / active / past_due / read_only / suspended / cancelled — ก่อนหน้านี้ trial / active / suspended / cancelled (gate `tenant.status_lifecycle`)

| รหัสการเปลี่ยน | รายละเอียด |
|---|---|
| `tenant.status_lifecycle` | สถานะบริษัท (`tenant.status`) มี 7 ค่า — ก่อนหน้านี้ 4 ค่า (trial / active / suspended / cancelled) |

## 2026-11-18

API key: สถานะ `rotating` แยกจาก `active` · changed: payload webhook ตั้งฐานก่อน GA

| รหัสการเปลี่ยน | รายละเอียด |
|---|---|
| `api_key.status_rotating` | API key ที่หมุนแล้ว (ใช้ได้ถึง revokeAt) มีสถานะ `rotating` — ก่อนหน้านี้แสดงเป็น `active` และตัวกรอง `status=active` รวม key เหล่านี้ |

## 2026-11-01

เวอร์ชันแรกของ /v1
