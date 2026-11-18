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
