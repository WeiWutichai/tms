# เริ่มต้นใช้งาน (Quickstart)

สร้างใบสั่งขนส่ง (order) แรกใน **Sandbox** ภายใน 15 นาที — ข้อมูล Sandbox แยกจากข้อมูลจริงทั้งหมด ลองได้ไม่ต้องกลัวพัง

## สิ่งที่ต้องมี

- บัญชีผู้ใช้ TMS ที่เข้าเมนู **ตั้งค่า → นักพัฒนา / Open API** ได้ (เจ้าของ/ผู้ดูแล หรือบทบาทที่มีสิทธิ์ตั้งค่า) และแพ็กเกจที่เปิด Open API
- เครื่องที่มี `curl` และ `jq` หรือ Node.js 20 ขึ้นไป (ถ้าจะใช้ TypeScript SDK)

## 1. สร้าง API key ของ Sandbox

1. เข้า **ตั้งค่า → นักพัฒนา / Open API** แล้วกดสวิตช์มุมขวาเป็น **Sandbox** (ครั้งแรกระบบสร้าง Sandbox ของบริษัทให้อัตโนมัติ — มีแถบสีส้ม "SANDBOX" ตลอดเวลา)
2. แท็บ **API keys** → **สร้าง API key** → ตั้งชื่อ เช่น `quickstart` และเลือก scope: `master:read` `master:write` `orders:read` `orders:write`
3. คัดลอก secret ที่ขึ้นต้นด้วย `tk_test_` — **แสดงครั้งเดียว** เก็บไว้ใน secret manager ห้ามใส่ในโค้ดฝั่ง browser

โหมดของคำขอขึ้นกับ key ไม่ใช่ URL: key `tk_test_` เข้าถึงได้เฉพาะข้อมูล Sandbox, key `tk_live_` เฉพาะข้อมูลจริง

## 2. ตั้งค่าตัวแปร

```bash
export TMS_BASE_URL="https://api.tms.example"   # base URL ที่ได้รับจากผู้ให้บริการ (ไม่ต้องใส่ /v1)
export TMS_API_KEY="tk_test_..."                # secret จากขั้นที่ 1
```

ทดสอบว่า key ใช้ได้ (ได้ `200` และรายการว่าง `{"data":[],...}`):

```bash
curl -sS "$TMS_BASE_URL/v1/orders?limit=1" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

## 3. สร้างลูกค้า

ทุกขั้นใช้ `PUT …/external/{externalId}` (upsert ด้วยรหัสของระบบคุณ) — รันซ้ำได้ ได้รายการเดิม ไม่สร้างซ้ำ

```bash
CUSTOMER_ID=$(curl -sS -X PUT "$TMS_BASE_URL/v1/customers/external/QS-CUS-001" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"legalName":"บริษัท ลูกค้าทดลอง จำกัด"}' | jq -r .id)
echo "$CUSTOMER_ID"
```

## 4. สร้างจุดรับและจุดส่ง

```bash
PICKUP_ID=$(curl -sS -X PUT "$TMS_BASE_URL/v1/customer-sites/external/QS-SITE-PICKUP" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"คลังสินค้าบางนา","kind":"PICKUP","customerId":"'"$CUSTOMER_ID"'","address":{"line1":"99 ถ.บางนา-ตราด ต.บางแก้ว อ.บางพลี จ.สมุทรปราการ 10540"}}' | jq -r .id)
```

```bash
DROPOFF_ID=$(curl -sS -X PUT "$TMS_BASE_URL/v1/customer-sites/external/QS-SITE-DROPOFF" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"ร้านค้าปลายทาง ชลบุรี","kind":"DROPOFF","customerId":"'"$CUSTOMER_ID"'","address":{"line1":"1 ถ.สุขุมวิท ต.บ้านสวน อ.เมืองชลบุรี จ.ชลบุรี 20000"}}' | jq -r .id)
```

## 5. สร้างใบสั่งขนส่ง

```bash
PICKUP_DATE=2026-12-01   # วันรับของ YYYY-MM-DD
ORDER_ID=$(curl -sS -X PUT "$TMS_BASE_URL/v1/orders/external/QS-ORDER-001" \
  -H "Authorization: Bearer $TMS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"customer":{"id":"'"$CUSTOMER_ID"'"},"requestedDate":"'"$PICKUP_DATE"'","stops":[{"type":"PICKUP","siteId":"'"$PICKUP_ID"'","windowStart":"'"$PICKUP_DATE"'T08:00:00+07:00"},{"type":"DELIVERY","siteId":"'"$DROPOFF_ID"'","windowEnd":"'"$PICKUP_DATE"'T17:00:00+07:00"}],"lines":[{"description":"น้ำดื่มบรรจุขวด","qty":"120","unit":"ลัง","weightKg":"1800"}]}' | jq -r .id)
```

ได้ `201` (สร้างใหม่) หรือ `200` (รันซ้ำ = อัปเดตใบเดิม) และ `id` ขึ้นต้นด้วย `ord_` — สถานะ `received` หรือ `on_hold` (ข้อมูลยังไม่ครบ เช่น หน่วยเป็นข้อความที่ไม่อยู่ใน master — ดู `holdReason`)

## 6. อ่านใบสั่งกลับ

```bash
curl -sS "$TMS_BASE_URL/v1/orders/$ORDER_ID" \
  -H "Authorization: Bearer $TMS_API_KEY"
```

เปิดหน้า **ใบสั่งขนส่ง** ในเว็บ (โหมด Sandbox) จะเห็นใบนี้ — เสร็จแล้ว

## ทำแบบเดียวกันด้วย TypeScript SDK

ติดตั้ง `@tms/sdk` (ดู [TypeScript SDK](sdk.md)) แล้วรันไฟล์นี้ด้วย `TMS_BASE_URL=… TMS_API_KEY=… npx tsx quickstart.ts`

```ts
/**
 * Quickstart: สร้าง order แรกใน Sandbox ด้วย @tms/sdk
 * รัน: TMS_BASE_URL=https://api.tms.example TMS_API_KEY=tk_test_… npx tsx quickstart.ts
 * ใช้ PUT …/external/{externalId} ทุกขั้น → รันซ้ำได้ ไม่สร้างข้อมูลซ้ำ
 */
import { createTmsClient, unwrap } from '@tms/sdk';

/** scope ที่ key ของ quickstart ต้องมี */
export const QUICKSTART_SCOPES = ['master:read', 'master:write', 'orders:read', 'orders:write'];

export async function runQuickstart(opts: { baseUrl: string; apiKey: string }) {
  const tms = createTmsClient({ baseUrl: opts.baseUrl, apiKey: opts.apiKey });

  // 1) ลูกค้า
  const customer = unwrap(
    await tms.PUT('/v1/customers/external/{externalId}', {
      params: { path: { externalId: 'QS-CUS-001' } },
      body: { legalName: 'บริษัท ลูกค้าทดลอง จำกัด' },
    }),
  );

  // 2) จุดรับและจุดส่งของลูกค้า
  const pickup = unwrap(
    await tms.PUT('/v1/customer-sites/external/{externalId}', {
      params: { path: { externalId: 'QS-SITE-PICKUP' } },
      body: {
        name: 'คลังสินค้าบางนา',
        kind: 'PICKUP',
        customerId: customer.id,
        address: { line1: '99 ถ.บางนา-ตราด ต.บางแก้ว อ.บางพลี จ.สมุทรปราการ 10540' },
      },
    }),
  );
  const dropoff = unwrap(
    await tms.PUT('/v1/customer-sites/external/{externalId}', {
      params: { path: { externalId: 'QS-SITE-DROPOFF' } },
      body: {
        name: 'ร้านค้าปลายทาง ชลบุรี',
        kind: 'DROPOFF',
        customerId: customer.id,
        address: { line1: '1 ถ.สุขุมวิท ต.บ้านสวน อ.เมืองชลบุรี จ.ชลบุรี 20000' },
      },
    }),
  );

  // 3) ใบสั่งขนส่ง (order) — วันรับของ = พรุ่งนี้ (เวลาไทย)
  const tomorrow = new Date(Date.now() + 31 * 3600_000).toISOString().slice(0, 10);
  const order = unwrap(
    await tms.PUT('/v1/orders/external/{externalId}', {
      params: { path: { externalId: 'QS-ORDER-001' } },
      body: {
        customer: { id: customer.id },
        requestedDate: tomorrow,
        stops: [
          { type: 'PICKUP', siteId: pickup.id, windowStart: `${tomorrow}T08:00:00+07:00` },
          { type: 'DELIVERY', siteId: dropoff.id, windowEnd: `${tomorrow}T17:00:00+07:00` },
        ],
        lines: [{ description: 'น้ำดื่มบรรจุขวด', qty: '120', unit: 'ลัง', weightKg: '1800' }],
      },
    }),
  );

  // 4) อ่านกลับ
  const again = unwrap(await tms.GET('/v1/orders/{id}', { params: { path: { id: order.id } } }));
  return { customer, pickup, dropoff, order: again };
}

// รันตรง ๆ จาก command line
if (typeof process !== 'undefined' && process.argv[1]?.endsWith('quickstart.ts')) {
  const baseUrl = process.env.TMS_BASE_URL ?? 'https://api.tms.example';
  const apiKey = process.env.TMS_API_KEY ?? '';
  runQuickstart({ baseUrl, apiKey }).then(
    (r) => console.log(`สร้าง order ${r.order.id} สถานะ ${r.order.status}`),
    (e: unknown) => {
      console.error(e);
      process.exit(1);
    },
  );
}
```

## ขั้นต่อไป

- [ยืนยันตัวตน](authentication.md) — OAuth2 client credentials, scope, IP allowlist
- [แนวทางการใช้ API](conventions.md) — Idempotency-Key, pagination, ETag/If-Match, รูปแบบ error
- [Webhook และการตรวจลายเซ็น](webhooks.md) และ [Sandbox](sandbox.md) — ยิง event จำลองด้วย `POST /v1/test/events/trigger`
- [ใบสั่งขนส่ง (orders)](ref-orders.md) — ทุก endpoint ของ orders
