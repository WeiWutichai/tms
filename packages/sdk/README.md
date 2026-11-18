# @tms/sdk

TypeScript SDK ของ TMS Open API `/v1` — type ทุก path/body/response generate จาก `packages/contracts/openapi.json`
(แหล่งเดียวกับเอกสารใน `packages/api-docs/site/` และ Postman collection) · วิธีใช้: `packages/api-docs/guides/09-sdk.md`

ทำให้: Bearer API key / `getToken()` · `X-Api-Version` = `API_VERSION` · `Idempotency-Key` อัตโนมัติทุก POST ·
retry `429` ตาม `Retry-After` และ `502/503/504`/network error เฉพาะคำขอที่ส่งซ้ำได้ปลอดภัย · `ifMatch()`/`etagOf()` ·
`paginate()` (cursor) · `unwrap()` → `TmsApiError` · `verifyWebhookSignature()`/`constructWebhookEvent()` (Web Crypto)

## พัฒนา

```bash
pnpm --filter @tms/sdk test        # generate type จาก openapi.json แล้วรัน unit test
pnpm --filter @tms/sdk build       # dist/ (CommonJS + .d.ts + schema.d.ts)
```

`API_VERSION` ต้องตรง `info.x-api-version-latest` (test ตรวจ) — เปลี่ยนเวอร์ชัน API แล้วแก้ค่าใน `src/index.ts`

## Release (ยังไม่ทำ — รอ PO อนุมัติ, spec/12 §3 แถว "เอกสาร API: การเผยแพร่")

ห้าม publish/deploy เองจาก lane พัฒนา ขั้นตอนเมื่อ PO อนุมัติ:

1. ตัดสินชื่อ scope บน npm (เช่น `@innovera/tms-sdk`), license, และ base URL จริง (แทน `https://api.tms.example` ใน `DEFAULT_BASE_URL`, guides และ Postman)
2. ตั้ง `version` ตาม semver (major ตาม `/v1`; minor เมื่อ openapi.json เพิ่ม endpoint/field) · ลบ `"private": true`
3. `pnpm --filter @tms/sdk build && cd packages/sdk && npm pack` → ตรวจไฟล์ใน `.tgz` (`dist/` + `README.md` เท่านั้น)
4. `npm publish --access public` จากเครื่อง/CI ที่มี token ของบริษัท (2FA)
5. เอกสาร: deploy โฟลเดอร์ `packages/api-docs/site/` เป็น static site ที่โดเมนเอกสาร · ตั้ง redirect
   `https://<docs>/problems/<code>` → `errors.html#<code>` (ค่า `type` ของ problem+json) · แก้ข้อความ "ยังไม่เผยแพร่บน npm" ใน `guides/09-sdk.md`
