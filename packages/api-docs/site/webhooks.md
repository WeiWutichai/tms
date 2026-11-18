# Webhook และการตรวจลายเซ็น

TMS ส่ง event เป็น `POST` JSON ไปยัง endpoint ของคุณ (สมัครที่ **นักพัฒนา / Open API → Webhooks**) — รายการ event และ schema ของแต่ละตัวอยู่ที่ [Webhook events](webhook-events.md)

## Envelope

```json
{
  "id": "evt_…",
  "type": "order.created",
  "version": "2026-11-18",
  "occurredAt": "2026-11-20T08:00:00+07:00",
  "tenantId": "…",
  "mode": "live",
  "data": { "object": { "id": "ord_…" }, "previousAttributes": null }
}
```

## Header

| Header | ความหมาย |
|---|---|
| `X-TMS-Event` | ชนิด event |
| `X-TMS-Event-Id` | id ของ event (`evt_…`) — ใช้กันประมวลผลซ้ำ (ส่งแบบ at-least-once) |
| `X-TMS-Timestamp` | เวลาส่ง (วินาที unix) |
| `X-TMS-Signature` | `t=<unix>,v1=<hex>` — ช่วงหมุน secret มี `v1` สองตัว (ใหม่ + เดิม) 24 ชม. |
| `X-TMS-Attempt` | ครั้งที่ส่ง (เริ่ม 1) |

## วิธีตรวจลายเซ็น

1. แยก `t` และ `v1` ทุกตัวจาก `X-TMS-Signature`
2. ปฏิเสธถ้า `|เวลาปัจจุบัน − t| > 300 วินาที` (กัน replay)
3. คำนวณ `HMAC-SHA256(signing secret, t + "." + body ดิบ)` เป็น hex แล้วเทียบแบบ constant-time กับ `v1` ตัวใดตัวหนึ่ง — ต้องใช้ body **ดิบ** ก่อน parse JSON

ด้วย SDK:

```ts
import { constructWebhookEvent } from '@tms/sdk';

// Express: app.post('/tms-webhook', express.raw({ type: 'application/json' }), handler)
const event = await constructWebhookEvent({
  rawBody: req.body, // Buffer/Uint8Array หรือ string ดิบ
  header: req.get('X-TMS-Signature'),
  secret: process.env.TMS_WEBHOOK_SECRET!, // whsec_…
});
```

Node.js ไม่ใช้ SDK:

```js
const crypto = require('crypto');

function verify(rawBody, header, secret) {
  const parts = header.split(',').map((p) => p.trim().split('='));
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const want = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return parts.some(([k, v]) => k === 'v1' && v.length === want.length &&
    crypto.timingSafeEqual(Buffer.from(v), Buffer.from(want)));
}
```

Python:

```python
import hmac, hashlib, time

def verify(raw_body: bytes, header: str, secret: str) -> bool:
    parts = [p.strip().split('=', 1) for p in header.split(',')]
    t = next((v for k, v in parts if k == 't'), '')
    if not t.isdigit() or abs(time.time() - int(t)) > 300:
        return False
    want = hmac.new(secret.encode(), t.encode() + b'.' + raw_body, hashlib.sha256).hexdigest()
    return any(k == 'v1' and hmac.compare_digest(v, want) for k, v in parts)
```

## การส่งและลองใหม่

- ตอบ `2xx` ภายใน 10 วินาที = สำเร็จ · ไม่สำเร็จลองใหม่ 8 ครั้ง (1 นาที, 5 นาที, 30 นาที, 2 ชม., 6 ชม., 12 ชม., 24 ชม., 24 ชม.)
- event ส่งไม่สำเร็จขั้นสุดท้ายติดกัน 50 event → endpoint ถูกปิดอัตโนมัติและแจ้งอีเมลผู้ดูแล
- ดูประวัติ: `GET /v1/webhook-deliveries?eventId=…` · ดู event ย้อนหลัง: `GET /v1/events` (เก็บ 30 วัน)
