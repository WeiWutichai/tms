# OAuth และระบบ (auth)

4 endpoint · ทุกคำขอส่ง `Authorization: Bearer <API key>` — ดู [ยืนยันตัวตน](authentication.md) และ [แนวทางการใช้ API](conventions.md)

| Endpoint | scope |
|---|---|
| [`POST /v1/oauth/token`](#post-oauth-token) |   |
| [`GET /v1/.well-known/jwks.json`](#get--well-known-jwks-json) |   |
| [`POST /v1/oauth/revoke`](#post-oauth-revoke) |   |
| [`GET /v1/health`](#get-health) |   |

## POST /v1/oauth/token {#post-oauth-token}

`POST /v1/oauth/token`

scope: — · operationId: `Auth_token`

**Request body** `TokenRequestDto`

| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `grantType` | ใช่ | `string` | ค่า: `authorization_code`, `refresh_token`, `client_credentials` | client_credentials (ST7-T01) = client ภายนอกด้วย API key: clientId `key_…` + clientSecret `tk_live_…` (หรือ HTTP Basic) → JWT RS256 1 ชม. |   |
| `code` |   | `string` |   | grantType=authorization_code |   |
| `codeVerifier` |   | `string` |   | grantType=authorization_code (PKCE) |   |
| `clientId` |   | `string` |   | grantType=client_credentials — id ของ key (`key_…`) หรือ prefix ที่แสดงในหน้าจอ · หรือส่งใน Authorization: Basic | `tk_live_8f3a` |
| `clientSecret` |   | `string (password)` |   | grantType=client_credentials — API key เต็ม (`tk_live_…`) |   |
| `scope` |   | `string` |   | grantType=client_credentials — scope ที่ขอ (คั่นด้วยช่องว่าง ⊆ scope ของ key; ไม่ส่ง = ทั้งหมด) | `orders:read orders:write` |

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` | authorization_code / refresh_token: ตั้ง refresh token ใน cookie httpOnly `tms_rt` · client_credentials: ไม่มี refresh token (error: 401 invalid_client / key_revoked / key_expired, 400 invalid_scope, 403 ip_not_allowed) | `TokenDto` |
| `429` | rate_limited — เกิน 120 ครั้ง/นาที ต่อ IP หรือ 30 ครั้ง/นาที ต่อ client id (client_credentials) มี header Retry-After | `ProblemDto` |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/oauth/token" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"grantType":"authorization_code","clientId":"tk_live_8f3a","scope":"orders:read orders:write"}'
```

```ts
const { data, error } = await tms.POST('/v1/oauth/token', {
  body: {
    "grantType": "authorization_code",
    "clientId": "tk_live_8f3a",
    "scope": "orders:read orders:write"
  },
});
```

## GET /v1/.well-known/jwks.json {#get--well-known-jwks-json}

`GET /v1/.well-known/jwks.json`

scope: — · operationId: `Auth_jwks`

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `JwksDto` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/.well-known/jwks.json" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/.well-known/jwks.json');
```

## POST /v1/oauth/revoke {#post-oauth-revoke}

`POST /v1/oauth/revoke`

scope: — · operationId: `Auth_revoke`

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `204` |   |   |

**ตัวอย่าง**

```bash
curl -sS -X POST "$TMS_BASE_URL/v1/oauth/revoke" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Idempotency-Key: $(uuidgen)"
```

```ts
const { data, error } = await tms.POST('/v1/oauth/revoke');
```

## GET /v1/health {#get-health}

`GET /v1/health`

scope: — · operationId: `Health_health`

**Responses**

| สถานะ | ความหมาย | body |
|---|---|---|
| `200` |   | `any` |

**ตัวอย่าง**

```bash
curl -sS -X GET "$TMS_BASE_URL/v1/health" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

```ts
const { data, error } = await tms.GET('/v1/health');
```

## Schema ของ response {#schemas}

### JwksDto {#schema-JwksDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `keys` | ใช่ | `array<object>` |   | RSA public keys (RFC 7517) ที่ใช้ตรวจ token ของ client credentials |   |

### TokenDto {#schema-TokenDto}



| ฟิลด์ | บังคับ | ชนิด | กฎ | คำอธิบาย | ตัวอย่าง |
|---|---|---|---|---|---|
| `accessToken` | ใช่ | `string` |   |   |   |
| `tokenType` | ใช่ | `string` |   |   | `Bearer` |
| `expiresIn` | ใช่ | `number` |   | วินาที | `900` |
| `scope` |   | `string` |   | client_credentials: scope ที่ได้จริง |   |
