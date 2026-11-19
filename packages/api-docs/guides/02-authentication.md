# ยืนยันตัวตน

ทุกคำขอส่ง credential ใน header `Authorization: Bearer …` ผ่าน HTTPS เท่านั้น — tenant (บริษัท) ระบุจาก credential ไม่มีใน URL

## API key

| ชนิด | รูปแบบ | ข้อมูลที่เข้าถึง |
|---|---|---|
| Production | `tk_live_` + 48 ตัว hex | ข้อมูลจริงของบริษัท |
| Sandbox | `tk_test_` + 48 ตัว hex | ข้อมูล Sandbox ของบริษัท (แยกขาดจากข้อมูลจริง) |

```bash
curl -sS "$TMS_BASE_URL/v1/orders" -H "Authorization: Bearer $TMS_API_KEY"
```

- สร้าง/เพิกถอน/หมุน key ได้ที่ **ตั้งค่า → นักพัฒนา / Open API → API keys** โดยผู้ใช้ที่ login (key จัดการ key ไม่ได้)
- ต่อ key ตั้งได้: scope, วันหมดอายุ, IP allowlist — หมุน key (rotate) แล้ว key เดิมใช้ต่อได้จนถึง `revokeAt` (≤ 7 วัน)
- key ถูกเพิกถอน = `401 key_revoked`, หมดอายุ = `401 key_expired`, ไม่มี scope = `403 permission_denied` (ใน `required` บอก scope ที่ต้องใช้)

## OAuth2 client credentials

แลก key เป็น access token (JWT RS256 อายุ 1 ชม.) — ขอ scope แคบกว่าของ key ได้

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/oauth/token" \
  -H "Content-Type: application/json" \
  -d '{"grantType":"client_credentials","clientId":"key_...","clientSecret":"tk_live_...","scope":"orders:read orders:write"}'
```

ได้ `accessToken` แล้วส่งเป็น `Authorization: Bearer <accessToken>` · กุญแจตรวจลายเซ็นประกาศที่ `GET /v1/.well-known/jwks.json` · ยกเลิก token ด้วย `POST /v1/oauth/revoke`

## Scope

scope รูปแบบ `resource:verb` (เช่น `companies:read`, `orders:read`, `orders:write`, `orders:cancel`, `master:read`, `trips:dispatch`) — แต่ละ endpoint ในหน้า reference ระบุ scope ที่ต้องใช้ (มีหลายตัว = ตัวใดตัวหนึ่ง) · scope ด้านผู้ใช้/บทบาท/การตั้งค่า (`users:*`, `settings:write`) ให้ key ไม่ได้
