import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tryDecodeId } from '../src/common/ids';
import { DbService } from '../src/db/db.service';
import { PricingService, type QuoteInput } from '../src/modules/pricing/pricing.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { addDays, bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/** ST2-T15 PricingService (rate card จริง + เส้นทาง + หน่วย/สินค้า → engine ใน @tms/domain) */
describe('pricing (PricingService.quote)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let otherTenantId: string;
  let admin: string;
  let seed = 0;
  let vt6: string;
  let units: Record<string, string>;
  const today = bangkokToday();
  const d = (n: number) => addDays(today, n);
  const uuid = (kind: Parameters<typeof tryDecodeId>[0], id: string) => tryDecodeId(kind, id)!;

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท คิดราคา' })).id;
    otherTenantId = (await createTenantWithDefaults(db, { name: 'บริษัท อื่น' })).id;
    admin = await tokenFor(tenantId);
    const types = (await api(app, admin).get('/v1/vehicle-types?limit=50').expect(200)).body.data;
    vt6 = types.find((t: { code: string }) => t.code === '6W').id;
    const us = (await api(app, admin).get('/v1/units?limit=50').expect(200)).body.data as {
      id: string;
      code: string;
    }[];
    units = Object.fromEntries(us.map((u) => [u.code, u.id]));
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };
  const newSite = async () =>
    (
      await api(app, admin)
        .post('/v1/customer-sites')
        .send({ name: `จุดคิดราคา ${++seed}`, kind: 'DROPOFF', address: ADDR })
        .expect(201)
    ).body.id as string;
  const newCustomer = async () =>
    (
      await api(app, admin)
        .post('/v1/customers')
        .send({ legalName: `ลูกค้าคิดราคา ${++seed}`, taxId: validTaxId(7000 + seed) })
        .expect(201)
    ).body.id as string;
  const newKey = async (distanceKm?: number) => {
    const [customerId, originId, destinationId] = [
      await newCustomer(),
      await newSite(),
      await newSite(),
    ];
    if (distanceKm !== undefined)
      await api(app, admin)
        .post('/v1/routes')
        .send({ originId, destinationId, distanceKm })
        .expect(201);
    return { customerId, originId, destinationId, vehicleTypeId: vt6 };
  };
  type Key = Awaited<ReturnType<typeof newKey>>;
  const sellRate = async (key: Key, body: object) => {
    const r = (
      await api(app, admin)
        .post('/v1/rate-cards')
        .send({ ...key, validFrom: d(-30), ...body })
        .expect(201)
    ).body;
    await api(app, admin)
      .post(`/v1/rate-cards/${r.id}/approve`)
      .send({ reason: 'อนุมัติตามใบเสนอราคา' })
      .expect(200);
    return r;
  };
  const quote = (key: Key, extra: Partial<QuoteInput> = {}, tid = tenantId) =>
    app.get(DbService).withTenant(tid, (tx) =>
      app.get(PricingService).quote(
        {
          side: 'SELL',
          partyId: uuid('customer', key.customerId),
          originSiteId: uuid('site', key.originId),
          destSiteId: uuid('site', key.destinationId),
          vehicleTypeId: uuid('vehicleType', key.vehicleTypeId),
          date: today,
          ...extra,
        },
        tx,
      ),
    );

  it('เหมาเที่ยว 4,500 + จุดที่ 4 ขึ้นไป +300/จุด (บรรทัด EXTRA_STOP แยก) — ภาษีติดบรรทัดจากรายการบริการ', async () => {
    const key = await newKey();
    const rc = await sellRate(key, {
      pricingModel: 'PER_TRIP',
      sellRate: '4500',
      sellExtraStopRate: '300',
      includedStops: 3,
    });
    const r = await quote(key, { stops: 5 });
    expect(r.pricingStatus).toBe('AVAILABLE');
    expect(r.total).toBe('5100.00');
    expect(
      r.lines.map((l) => [
        l.kind,
        l.serviceItem.code,
        l.qty,
        l.unitPrice,
        l.amount,
        l.vatType,
        l.whtRate,
      ]),
    ).toEqual([
      ['FREIGHT', 'FREIGHT', '1', '4500.00', '4500.00', 'EXEMPT_TRANSPORT', '1.00'],
      ['EXTRA_STOP', 'EXTRA_STOP', '2', '300.00', '600.00', 'EXEMPT_TRANSPORT', '1.00'],
    ]);
    expect(r.params).toMatchObject({
      rateCardId: uuid('rateCard', rc.id),
      rateCode: rc.code,
      rateRevision: 1,
      pricingModel: 'PER_TRIP',
      extraStops: 2,
    });
    // snapshot มีที่มา (sourceItemId + version) ไม่ต้อง join กลับ
    expect(r.lines[0]!.serviceItem.sourceVersion).toBeGreaterThanOrEqual(1);
  });

  it('ตามระยะทาง 18 บาท/กม. ขั้นต่ำ 1,500 — ระยะจากเส้นทาง; ไม่มีเส้นทาง → CALCULATION_FAILURE DISTANCE_MISSING', async () => {
    const near = await newKey(50);
    await sellRate(near, { pricingModel: 'PER_KM', sellRate: '18', sellMinCharge: '1500' });
    const a = await quote(near, { stops: 2 });
    expect(a).toMatchObject({ pricingStatus: 'AVAILABLE', total: '1500.00' });
    expect(a.lines[0]).toMatchObject({
      qty: '50',
      calculatedAmount: '900.00',
      minChargeApplied: true,
    });
    expect(a.routeId).not.toBeNull();

    const far = await newKey(120.5);
    await sellRate(far, { pricingModel: 'PER_KM', sellRate: '18', sellMinCharge: '1500' });
    expect((await quote(far)).total).toBe('2169.00');

    const noRoute = await newKey();
    await sellRate(noRoute, { pricingModel: 'PER_KM', sellRate: '18' });
    const f = await quote(noRoute);
    expect(f).toMatchObject({
      pricingStatus: 'CALCULATION_FAILURE',
      total: null,
      lines: [],
      routeId: null,
    });
    expect(f.reasons.map((x) => x.code)).toEqual(['DISTANCE_MISSING']);
  });

  it('350 บาท/ตัน: กก. และถุงผ่านข้อมูลสินค้า; ต่อพาเลท (PER_UNIT) แปลงจากถุงด้วยหน่วยรอง; แปลงไม่ได้ → UNIT_CONVERSION_FAILED', async () => {
    const product = (
      await api(app, admin)
        .post('/v1/products')
        .send({
          name: `ปูนถุง ${++seed}`,
          unitId: units.BAG,
          weightPerUnitKg: 50,
          altUnits: [{ unitId: units.PLT, factorToBase: 40 }],
        })
        .expect(201)
    ).body.id as string;
    const productId = uuid('product', product);
    const ton = await newKey();
    await sellRate(ton, { pricingModel: 'PER_TON', sellRate: '350' });
    const r = await quote(ton, {
      quantities: [
        { qty: '300', unitId: uuid('unit', units.BAG!), productId }, // 15 ตัน
        { qty: '2500', unitId: uuid('unit', units.KG!) }, // 2.5 ตัน
      ],
    });
    expect(r).toMatchObject({ pricingStatus: 'AVAILABLE', total: '6125.00' });
    expect(r.params.quantity).toBe('17.5');

    const plt = await newKey();
    await sellRate(plt, { pricingModel: 'PER_UNIT', sellRate: '250', unitId: units.PLT });
    const p = await quote(plt, {
      quantities: [{ qty: '100', unitId: uuid('unit', units.BAG!), productId }],
    });
    expect(p).toMatchObject({ pricingStatus: 'AVAILABLE', total: '625.00' });
    const bad = await quote(plt, {
      quantities: [{ qty: '100', unitId: uuid('unit', units.BAG!) }],
    });
    expect(bad.pricingStatus).toBe('CALCULATION_FAILURE');
    expect(bad.reasons.map((x) => x.code)).toEqual(['UNIT_CONVERSION_FAILED']);
    const none = await quote(plt);
    expect(none.reasons.map((x) => x.code)).toEqual(['QUANTITY_MISSING']);
  });

  it('ค่าบริการเสริม: ราคาเฉพาะใน rate card ก่อนราคาตั้งต้น; รายการไม่พบ → 422', async () => {
    const items = (await api(app, admin).get('/v1/service-items?limit=50').expect(200)).body
      .data as {
      id: string;
      code: string;
    }[];
    const id = (code: string) => uuid('serviceItem', items.find((s) => s.code === code)!.id);
    const key = await newKey();
    await sellRate(key, {
      pricingModel: 'PER_TRIP',
      sellRate: '4500',
      accessorials: [{ serviceItemId: items.find((s) => s.code === 'WAIT')!.id, sellPrice: '250' }],
    });
    const r = await quote(key, {
      accessorials: [
        { serviceItemId: id('WAIT'), qty: '3' },
        { serviceItemId: id('OVERNIGHT'), qty: '1' },
      ],
    });
    expect(r.pricingStatus).toBe('AVAILABLE');
    const wait = r.lines.find((l) => l.serviceItem.code === 'WAIT')!;
    expect(wait).toMatchObject({
      kind: 'ACCESSORIAL',
      qty: '3',
      unitPrice: '250.00',
      amount: '750.00',
    });
    const night = r.lines.find((l) => l.serviceItem.code === 'OVERNIGHT')!;
    expect(night.unitPrice).toBe(night.serviceItem.unitPrice);
    await expect(
      quote(key, {
        accessorials: [{ serviceItemId: '00000000-0000-4000-8000-000000000000', qty: '1' }],
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('RATE_MISSING: ไม่มี rate / rate หมดอายุไม่ถูกใช้ / ร่างไม่ถูกใช้ / ข้าม tenant ไม่เห็น', async () => {
    const key = await newKey();
    expect((await quote(key)).pricingStatus).toBe('RATE_MISSING');
    // หมดอายุเมื่อวาน
    await sellRate(key, {
      pricingModel: 'PER_TRIP',
      sellRate: '4000',
      validFrom: d(-60),
      validTo: d(-1),
    });
    const exp = await quote(key);
    expect(exp).toMatchObject({ pricingStatus: 'RATE_MISSING', total: null, lines: [] });
    expect(exp.reasons[0]).toMatchObject({ code: 'RATE_MISSING' });
    // วันรับของอยู่ในช่วง → ใช้ได้
    expect((await quote(key, { date: d(-1) })).total).toBe('4000.00');
    // ร่างไม่ถูกใช้
    await api(app, admin)
      .post('/v1/rate-cards')
      .send({ ...key, pricingModel: 'PER_TRIP', sellRate: '4500', validFrom: d(0) })
      .expect(201);
    expect((await quote(key)).pricingStatus).toBe('RATE_MISSING');
    // tenant อื่นมองไม่เห็น rate ของเรา
    expect((await quote(key, { date: d(-1) }, otherTenantId)).pricingStatus).toBe('RATE_MISSING');
  });

  it('ขาซื้อ (BUY): rate ของรถร่วมคิดด้วย engine เดียวกัน; ลูกค้า (SELL) ไม่ปน', async () => {
    const key = await newKey(200);
    const carrier = (
      await api(app, admin)
        .post('/v1/carriers')
        .send({
          legalName: `รถร่วมคิดราคา ${++seed}`,
          entityType: 'INDIVIDUAL',
          taxId: validTaxId(8000 + seed),
        })
        .expect(201)
    ).body.id as string;
    const carrierId = uuid('carrier', carrier);
    const freight = await db.serviceItem.findFirstOrThrow({
      where: { tenantId, systemKey: 'FREIGHT' },
    });
    // T14 (API ขาซื้อ) ยังไม่อยู่บน main — ใส่แถว BUY ตรงในฐาน (โครงเดียวกับขาขาย)
    await db.rateCard.create({
      data: {
        tenantId,
        side: 'BUY',
        code: 'RC-B-9001',
        carrierId,
        originSiteId: uuid('site', key.originId),
        destSiteId: uuid('site', key.destinationId),
        vehicleTypeId: uuid('vehicleType', vt6),
        pricingModel: 'PER_KM',
        unitPrice: '14.50',
        minCharge: '1200',
        extraStopPrice: '200',
        includedStops: 2,
        serviceItemId: freight.id,
        validFrom: new Date(`${d(-10)}T00:00:00Z`),
        status: 'APPROVED',
      },
    });
    const buy = await quote(key, { side: 'BUY', partyId: carrierId, stops: 3 });
    expect(buy).toMatchObject({ pricingStatus: 'AVAILABLE', total: '3100.00' }); // 200 × 14.50 + 1 × 200
    expect(buy.lines.map((l) => [l.kind, l.amount])).toEqual([
      ['FREIGHT', '2900.00'],
      ['EXTRA_STOP', '200.00'],
    ]);
    // SELL ของ key เดียวกันยังไม่มี rate · BUY ด้วย id ลูกค้า → ไม่พบ
    expect((await quote(key)).pricingStatus).toBe('RATE_MISSING');
    expect((await quote(key, { side: 'BUY' })).pricingStatus).toBe('RATE_MISSING');
  });
  // ---------- review ST2-T15 ----------
  it('ค่าบริการเสริมตามสัญญา snapshotFor: ปิดใช้ → 422 service_item_inactive, ผิดฝั่ง → service_item_side, รายการสงวน → service_item_reserved', async () => {
    const key = await newKey();
    await sellRate(key, { pricingModel: 'PER_TRIP', sellRate: '4500' });
    const item = (code: string) => db.serviceItem.findFirstOrThrow({ where: { tenantId, code } });
    const [load, unload, extra, freight] = await Promise.all(
      ['LOAD', 'UNLOAD', 'EXTRA_STOP', 'FREIGHT'].map(item),
    );
    await db.serviceItem.update({ where: { id: load!.id }, data: { side: 'BUY' } });
    await db.serviceItem.update({ where: { id: unload!.id }, data: { status: 'INACTIVE' } });
    try {
      const err = async (serviceItemId: string) => {
        const e: unknown = await quote(key, { accessorials: [{ serviceItemId, qty: '1' }] }).then(
          () => null,
          (x: unknown) => x,
        );
        expect(e).toMatchObject({ status: 422 });
        return JSON.stringify(e);
      };
      expect(await err(load!.id)).toContain('service_item_side');
      expect(await err(unload!.id)).toContain('service_item_inactive');
      expect(await err(extra!.id)).toContain('service_item_reserved');
      expect(await err(freight!.id)).toContain('service_item_reserved');
      // ฝั่งซื้อใช้รายการ BUY ได้ (ไม่พบ rate ซื้อ → RATE_MISSING ไม่ใช่ 422)
      const buy = await quote(key, {
        side: 'BUY',
        accessorials: [{ serviceItemId: load!.id, qty: '1' }],
      });
      expect(buy.pricingStatus).toBe('RATE_MISSING');
    } finally {
      await db.serviceItem.update({ where: { id: load!.id }, data: { side: 'BOTH' } });
      await db.serviceItem.update({ where: { id: unload!.id }, data: { status: 'ACTIVE' } });
    }
  });

  it('วันที่ผิดรูป → 422 invalid_date (ไม่ใช่ 500)', async () => {
    const key = await newKey();
    for (const date of ['2026-13-01', '12/11/2026', ''])
      await expect(quote(key, { date })).rejects.toMatchObject({ status: 422 });
  });

  it('FSC บน rate → คำเตือน FSC_IGNORED (ยังคิดราคาได้) · หน่วยของ rate ถูกลบแบบ soft ยังคิดได้', async () => {
    const key = await newKey();
    const rc = await sellRate(key, { pricingModel: 'PER_TRIP', sellRate: '4500' });
    await db.rateCard.update({
      where: { id: uuid('rateCard', rc.id) },
      data: { fuelSurchargePct: '5.00' },
    });
    const r = await quote(key);
    expect(r).toMatchObject({ pricingStatus: 'AVAILABLE', total: '4500.00' });
    expect(r.warnings.map((w) => w.code)).toEqual(['FSC_IGNORED']);

    const box = uuid('unit', units.BOX!);
    const product = (
      await api(app, admin)
        .post('/v1/products')
        .send({
          name: `สินค้ากล่อง ${++seed}`,
          unitId: units.BAG,
          weightPerUnitKg: 1,
          altUnits: [{ unitId: units.BOX, factorToBase: 10 }],
        })
        .expect(201)
    ).body.id as string;
    const k2 = await newKey();
    await sellRate(k2, { pricingModel: 'PER_UNIT', sellRate: '100', unitId: units.BOX });
    await db.unit.update({ where: { id: box }, data: { deletedAt: new Date() } });
    try {
      const q2 = await quote(k2, {
        quantities: [
          { qty: '20', unitId: uuid('unit', units.BAG!), productId: uuid('product', product) },
        ],
      });
      expect(q2).toMatchObject({ pricingStatus: 'AVAILABLE', total: '200.00' });
      // หน่วยของงานที่ถูกลบแล้ว → 422
      await expect(quote(k2, { quantities: [{ qty: '1', unitId: box }] })).rejects.toMatchObject({
        status: 422,
      });
    } finally {
      await db.unit.update({ where: { id: box }, data: { deletedAt: null } });
    }
  });
});
