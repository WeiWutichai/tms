import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTenant, platform, truncateAll } from './helpers';

/** ST0-T19: schema v0 — กติกาที่ฐานข้อมูลบังคับเอง (ไม่พึ่งโค้ดแอป) */
describe('schema v0 constraints', () => {
  const db = platform();
  const app = new PrismaClient({ datasources: { db: { url: process.env.APP_DATABASE_URL } } });
  let t: string;
  let vt: string;

  beforeAll(async () => {
    await truncateAll();
    t = (await createTenant(db)).id;
    vt = (
      await db.vehicleType.create({
        data: { tenantId: t, code: '6W', nameTh: '6 ล้อ', vehicleClass: '6W' },
      })
    ).id;
  });
  afterAll(async () => {
    await db.$disconnect();
    await app.$disconnect();
  });

  it('รถร่วม (SUBCONTRACT) ต้องมี carrier', async () => {
    await expect(
      db.vehicle.create({
        data: {
          tenantId: t,
          plate: '70-1234',
          plateProvince: 'TH-10',
          plateKey: '701234|TH-10',
          plateNorm: '701234',
          vehicleTypeId: vt,
          ownership: 'SUBCONTRACT',
        },
      }),
    ).rejects.toThrow(/vehicle_subcontract_needs_carrier/);
    await expect(
      db.vehicle.create({
        data: {
          tenantId: t,
          plate: '70-1234',
          plateProvince: 'TH-10',
          plateKey: '701234|TH-10',
          plateNorm: '701234',
          vehicleTypeId: vt,
          ownership: 'OWN',
        },
      }),
    ).resolves.toBeTruthy();
  });

  it('คนขับรถร่วมต้องมี carrier', async () => {
    await expect(
      db.driver.create({
        data: {
          tenantId: t,
          code: 'DRV-0001',
          name: 'สมชาย',
          phone: '0812345678',
          phoneNorm: '0812345678',
          employmentType: 'CARRIER_DRIVER',
        },
      }),
    ).rejects.toThrow(/driver_carrier_driver_needs_carrier/);
  });

  it('rate card: ฝั่งขายต้องมีลูกค้า ฝั่งซื้อต้องมีรถร่วม และช่วงวันที่ถูกต้อง', async () => {
    const si = await db.serviceItem.create({
      data: {
        tenantId: t,
        code: 'FREIGHT',
        nameTh: 'ค่าขนส่ง',
        vatType: 'EXEMPT_TRANSPORT',
        whtRate: '1.00',
        unitLabel: 'เที่ยว',
      },
    });
    const base = {
      tenantId: t,
      pricingModel: 'PER_TRIP' as const,
      unitPrice: '6500.00',
      serviceItemId: si.id,
      validFrom: new Date('2026-11-01'),
    };
    await expect(db.rateCard.create({ data: { ...base, side: 'SELL' } })).rejects.toThrow(
      /rate_card_side_party/,
    );
    const cus = await db.customer.create({
      data: { tenantId: t, code: 'C001', legalName: 'ลูกค้า ก', billingAddress: {} },
    });
    await expect(
      db.rateCard.create({
        data: { ...base, side: 'SELL', customerId: cus.id, validTo: new Date('2026-10-01') },
      }),
    ).rejects.toThrow(/rate_card_valid_range/);
    await expect(
      db.rateCard.create({ data: { ...base, side: 'SELL', customerId: cus.id } }),
    ).resolves.toBeTruthy();
  });

  it('stop_event idempotent ด้วย client_event_id ต่อ tenant', async () => {
    const ev = {
      tenantId: t,
      tripStopId: '00000000-0000-4000-8000-000000000001',
      type: 'ARRIVE' as const,
      clientEventId: '00000000-0000-4000-8000-0000000000e1',
      source: 'WEB',
      occurredAt: new Date(),
    };
    await db.stopEvent.create({ data: ev });
    await expect(db.stopEvent.create({ data: ev })).rejects.toThrow(/Unique constraint/);
  });

  it('role แอปแก้/ลบ audit_log, stop_event, vehicle_cost ไม่ได้', async () => {
    for (const table of ['audit_log', 'stop_event', 'vehicle_cost']) {
      await expect(
        app.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${t}, true)`;
          await tx.$executeRawUnsafe(`DELETE FROM ${table}`);
        }),
      ).rejects.toThrow(/permission denied/);
    }
  });
});
