# TypeScript SDK

`@tms/sdk` — client ที่มี type ครบทุก path ของ `/v1` (generate จาก OpenAPI ชุดเดียวกับเอกสารนี้) ใช้ได้กับ Node.js ≥ 20, Deno, Bun และ browser/edge

> ยังไม่เผยแพร่บน npm — ระหว่างนี้ขอไฟล์ package (`.tgz`) จากทีม TMS แล้ว `npm install ./tms-sdk-<version>.tgz`

```ts
import { createTmsClient, unwrap, paginate, ifMatch, etagOf } from '@tms/sdk';

const tms = createTmsClient({
  baseUrl: process.env.TMS_BASE_URL, // ไม่ต้องใส่ /v1
  apiKey: process.env.TMS_API_KEY, // tk_live_… / tk_test_…
});

// ทุกเมธอดคืน { data, error, response } — unwrap() คืน data หรือ throw TmsApiError (status, code, requestId, problem)
const order = unwrap(await tms.GET('/v1/orders/{id}', { params: { path: { id: 'ord_…' } } }));

// เดินทุกหน้า (cursor)
for await (const o of paginate((cursor) =>
  tms.GET('/v1/orders', { params: { query: { limit: 200, cursor } } }),
)) {
  console.log(o.id, o.status);
}

// แก้แบบกันทับ (ETag → If-Match; ไม่ตรง = 412)
const got = await tms.GET('/v1/orders/{id}', { params: { path: { id: order.id } } });
await tms.PATCH('/v1/orders/{id}', {
  params: { path: { id: order.id }, header: ifMatch(etagOf(got.response)!) },
  body: { customerRef: 'PO-0099' },
});
```

## สิ่งที่ SDK ทำให้

| เรื่อง | พฤติกรรม | ตั้งค่า |
|---|---|---|
| ยืนยันตัวตน | `Authorization: Bearer <apiKey>` หรือ token จาก `getToken()` (เช่น OAuth ที่ต่ออายุเอง) | `apiKey`, `getToken` |
| เวอร์ชัน | ส่ง `X-Api-Version` = เวอร์ชันที่ SDK สร้างจาก (`API_VERSION`) | `apiVersion` (`null` = ใช้ค่าที่ pin บน key) |
| Idempotency | ใส่ `Idempotency-Key` (UUID) ให้ทุก POST ที่ยังไม่มี · ส่งเองได้ใน `params.header` | `autoIdempotencyKey: false` ปิด |
| Retry | `429` รอตาม `Retry-After` · `502/503/504`/network error ลองใหม่เฉพาะคำขอที่ส่งซ้ำได้ปลอดภัย (GET/PUT/DELETE หรือมี Idempotency-Key) · ค่าเริ่ม 3 ครั้ง รอไม่เกิน 30 วินาที | `retry: { maxRetries, maxDelayMs, baseDelayMs }` หรือ `false` |
| Webhook | `verifyWebhookSignature()` / `constructWebhookEvent()` — ดู [Webhook](webhooks.md) | `toleranceSec` |
