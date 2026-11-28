import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureSystemRoles } from '../src/auth/system-roles';
import { encodeId } from '../src/common/ids';
import { DbService } from '../src/db/db.service';
import {
  assertNotSampleCarrier,
  assertNotSampleCustomer,
} from '../src/modules/sample-data/sample-guard';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { api, bootApp, platform, tokenFor, truncateAll } from './helpers';

/** ตารางข้อมูลธุรกิจที่การใส่/ล้างข้อมูลตัวอย่างแตะ — เกณฑ์ตรวจรับ "ใส่ → ล้าง → จำนวนแถวกลับเท่าเดิม" */
const TABLES = [
  'customer',
  'customer_site',
  'carrier',
  'vehicle',
  'driver',
  'rate_card',
  'rate_card_accessorial',
  'sales_order',
  'sales_order_stop',
  'sales_order_line',
  'sales_order_charge',
  'delivery_order',
  'delivery_order_line',
  'revenue_line',
  'order_source_change',
  'sample_record',
] as const;

/** P1-ST2-T09 ข้อมูลตัวอย่างสำหรับ trial */
describe('ข้อมูลตัวอย่าง (P1-ST2-T09)', () => {
  let app: NestExpressApplication;
  const db = platform();

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  /** บริษัทแบบสมัครจริง (ค่าเริ่มต้นครบ) + นิติบุคคล 1 + owner */
  async function tenant(status: 'TRIALING' | 'ACTIVE' = 'TRIALING') {
    const t = await createTenantWithDefaults(db, { name: `บริษัท ทดลอง ${status}`, status });
    const co = await db.company.create({
      data: { tenantId: t.id, legalName: 'บริษัท ทดลอง จำกัด', taxId: '0105561000001' },
    });
    await db.branch.create({
      data: {
        tenantId: t.id,
        companyId: co.id,
        branchCode: '00000',
        branchLabel: 'สำนักงานใหญ่',
        address: { line1: '1 ถนนทดลอง', province: 'กรุงเทพมหานคร', postcode: '10000' },
        isDefaultIssuer: true,
      },
    });
    const roles = await ensureSystemRoles(db, t.id);
    const u = await db.appUser.create({
      data: {
        tenantId: t.id,
        email: `owner-${t.id.slice(0, 6)}@sample.test`,
        name: 'owner',
        status: 'ACTIVE',
      },
    });
    await db.userRole.create({ data: { tenantId: t.id, userId: u.id, roleId: roles.owner! } });
    return { id: t.id, a: api(app, await tokenFor(t.id, '*', u.id)) };
  }

  const counts = async (tenantId: string) => {
    const out: Record<string, number> = {};
    for (const t of TABLES) {
      const [r] = await db.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM "${t}" WHERE tenant_id = $1::uuid`,
        tenantId,
      );
      out[t] = r!.n;
    }
    return out;
  };

  it('เกณฑ์ตรวจรับ: ใส่ → ล้าง → จำนวนแถวกลับเท่าเดิม · ข้อมูลจริงไม่ถูกแตะ · checklist ไม่นับเป็นนำเข้าข้อมูลหลัก', async () => {
    const { id, a } = await tenant();
    // ข้อมูลจริงที่มีก่อน
    const real = (
      await a.post('/v1/customers').send({ legalName: 'บริษัท ลูกค้าจริง จำกัด' }).expect(201)
    ).body;
    const before = await counts(id);
    expect((await a.get('/v1/sample-data').expect(200)).body).toMatchObject({
      allowed: true,
      loaded: false,
    });

    const loaded = (await a.post('/v1/sample-data').expect(200)).body;
    expect(loaded).toMatchObject({
      allowed: true,
      loaded: true,
      counts: {
        customer: 3,
        customer_site: 7,
        carrier: 2,
        vehicle: 5,
        driver: 2,
        rate_card: 6,
        sales_order: 4,
      },
    });
    // ใบสั่งตัวอย่างพ้นร่าง (มีเลข SO) และคิดราคาจาก rate card ตัวอย่างได้
    const sos = await db.salesOrder.findMany({ where: { tenantId: id } });
    expect(sos).toHaveLength(4);
    for (const so of sos) {
      expect(so.soNo).toBeTruthy();
      expect(so.pricingStatus).toBe('AVAILABLE');
    }
    // ชื่อสมมติ ไม่ใช้ชื่อในต้นแบบ (design/README.md)
    const names = (await db.customer.findMany({ where: { tenantId: id } })).map((c) => c.legalName);
    expect(names.filter((n) => n.includes('ตัวอย่าง'))).toHaveLength(3);
    expect(names.join()).not.toContain('ศรีไทย');
    // รายการลูกค้าเห็นข้อมูลตัวอย่าง (เรียก /v1 ชุดเดียวกัน)
    expect((await a.get('/v1/customers').expect(200)).body.data).toHaveLength(4);
    // ใส่ซ้ำ → 409
    expect((await a.post('/v1/sample-data').expect(409)).body.code).toBe('sample_data_loaded');

    const cleared = (await a.post('/v1/sample-data/clear').expect(200)).body;
    expect(cleared).toMatchObject({
      loaded: false,
      kept: [],
      removed: {
        customer: 3,
        customer_site: 7,
        carrier: 2,
        vehicle: 5,
        driver: 2,
        rate_card: 6,
        sales_order: 4,
      },
    });
    expect(await counts(id)).toEqual(before);
    expect(
      (await a.get('/v1/customers').expect(200)).body.data.map((c: { id: string }) => c.id),
    ).toEqual([real.id]);
    // audit ทั้งสองครั้ง
    const audit = await db.auditLog.findMany({
      where: { tenantId: id, action: { startsWith: 'sample_data.' } },
      orderBy: { at: 'asc' },
    });
    expect(audit.map((x) => x.action)).toEqual(['sample_data.loaded', 'sample_data.cleared']);
    // audit ของการล้างเก็บรายการที่ลบ (ชนิด + id + ป้าย)
    const removedList = (
      audit[1]!.after as { removed: { type: string; id: string; label: string }[] }
    ).removed;
    expect(removedList).toHaveLength(29);
    expect(removedList).toContainEqual(
      expect.objectContaining({
        type: 'vehicle',
        label: 'ตย-9001',
        id: expect.stringMatching(/^veh_/),
      }),
    );
    // ใส่ใหม่ได้หลังล้าง
    await a.post('/v1/sample-data').expect(200);
  });

  it('ข้อมูลตัวอย่างไม่ทำให้ขั้น "นำเข้าข้อมูลหลัก" ของ checklist เสร็จ', async () => {
    const { a } = await tenant();
    await a.post('/v1/sample-data').expect(200);
    const s = (await a.get('/v1/setup-checklist').expect(200)).body;
    expect(s.steps.find((x: { key: string }) => x.key === 'import').status).toBe('todo');
  });

  it('แถวตัวอย่างที่ถูกใช้ต่อแล้ว (ใบสั่งจริงอ้างลูกค้า/สถานที่ตัวอย่าง) ไม่ลบ คงธงไว้ + บอกเหตุผล', async () => {
    const { id, a } = await tenant();
    await a.post('/v1/sample-data').expect(200);
    const cus = await db.customer.findFirst({
      where: { tenantId: id, legalName: 'บริษัท ตัวอย่างค้าวัสดุ จำกัด' },
    });
    const sites = await db.customerSite.findMany({
      where: { tenantId: id, customerId: cus!.id },
      orderBy: { code: 'asc' },
    });
    // ผู้ใช้สร้างใบสั่งจริงด้วยลูกค้า/สถานที่ตัวอย่าง
    const real = (
      await a
        .post('/v1/orders')
        .send({
          customer: { id: encodeId('customer', cus!.id) },
          requestedDate: '2026-12-20',
          stops: [
            { type: 'PICKUP', siteId: encodeId('site', sites[0]!.id) },
            { type: 'DELIVERY', siteId: encodeId('site', sites[1]!.id) },
          ],
        })
        .expect(201)
    ).body;
    const r = (await a.post('/v1/sample-data/clear').expect(200)).body;
    expect(r.loaded).toBe(true);
    expect(r.counts).toMatchObject({ customer: 1, customer_site: 2, sales_order: 0, vehicle: 0 });
    expect(r.removed).toMatchObject({ customer: 2, customer_site: 5, sales_order: 4, vehicle: 5 });
    expect(r.kept).toHaveLength(3);
    expect(r.kept[0]).toMatchObject({ entityType: 'customer_site', reason: 'in_use' });
    expect(r.kept.find((k: { entityType: string }) => k.entityType === 'customer')).toMatchObject({
      id: encodeId('customer', cus!.id),
      label: expect.stringContaining('ตัวอย่างค้าวัสดุ'),
    });
    // ใบสั่งจริงยังอยู่
    await a.get(`/v1/orders/${real.id}`).expect(200);
  });

  it('เกณฑ์ตรวจรับ: ข้อมูลตัวอย่างไม่ถูกนับรถ active (เที่ยวที่ใช้รถ/รถร่วมตัวอย่าง) — รถจริงยังนับ', async () => {
    const { id, a } = await tenant();
    await a.post('/v1/sample-data').expect(200);
    const sampleOwn = await db.vehicle.findFirst({ where: { tenantId: id, plate: 'ตย-9001' } });
    const sampleSub = await db.vehicle.findFirst({ where: { tenantId: id, plate: 'ตย-9004' } });
    const realV = await db.vehicle.create({
      data: {
        tenantId: id,
        plate: '70-5555',
        plateProvince: 'TH-10',
        plateKey: '705555|TH-10',
        plateNorm: '705555',
        vehicleTypeId: sampleOwn!.vehicleTypeId,
        ownership: 'OWN',
      },
    });
    let n = 0;
    const dispatched = (v: typeof realV) =>
      db.trip.create({
        data: {
          tenantId: id,
          tripNo: `TRP-SMP-${++n}`,
          tripDate: new Date(),
          vehicleId: v.id,
          carrierId: v.carrierId,
          carrierNameSnapshot: v.carrierId ? 'รถร่วม' : null,
          vehicleTypeId: v.vehicleTypeId,
          vehiclePlateSnapshot: v.plate,
          vehicleTypeSnapshot: '6 ล้อ',
          status: 'DISPATCHED',
          dispatchedAt: new Date(),
        },
      });
    await dispatched(sampleOwn!);
    await dispatched(sampleSub!);
    expect(await db.activeVehicleUsage.count({ where: { tenantId: id } })).toBe(0);
    await dispatched(realV);
    const rows = await db.activeVehicleUsage.findMany({ where: { tenantId: id } });
    expect(rows.map((r) => r.plate)).toEqual(['70-5555']);
    // API ของลูกค้า: นับ 1 คัน
    const u = (await a.get('/v1/usage/active-vehicles').expect(200)).body;
    expect(u.activeVehicles).toBe(1);
    expect(u.data.map((x: { plate: string; trips: number }) => [x.plate, x.trips])).toEqual([
      ['70-5555', 1],
    ]);
  });

  it('B1: พ้น trial แล้ว (ACTIVE) เที่ยวรถตัวอย่าง และรถจริงใต้รถร่วมตัวอย่าง นับรถ active ตามปกติ', async () => {
    const { id, a } = await tenant();
    await a.post('/v1/sample-data').expect(200);
    const sampleOwn = await db.vehicle.findFirst({ where: { tenantId: id, plate: 'ตย-9002' } });
    const sampleCarrier = await db.carrier.findFirst({
      where: { tenantId: id, legalName: { contains: 'ตัวอย่างรถร่วม' } },
    });
    const underSample = await db.vehicle.create({
      data: {
        tenantId: id,
        plate: '71-7777',
        plateProvince: 'TH-10',
        plateKey: '717777|TH-10',
        plateNorm: '717777',
        vehicleTypeId: sampleOwn!.vehicleTypeId,
        ownership: 'SUBCONTRACT',
        carrierId: sampleCarrier!.id,
      },
    });
    // แปลงเป็นลูกค้าจ่ายเงิน (สถานะ + ประวัติ)
    await db.tenant.update({ where: { id }, data: { status: 'ACTIVE' } });
    await db.tenantStatusHistory.create({
      data: {
        tenantId: id,
        fromStatus: 'TRIALING',
        toStatus: 'ACTIVE',
        reason: 'ชำระเงินแล้ว',
        actorType: 'system',
        at: new Date(Date.now() - 1000),
      },
    });
    let n = 0;
    for (const v of [sampleOwn!, underSample])
      await db.trip.create({
        data: {
          tenantId: id,
          tripNo: `TRP-ACT-${++n}`,
          tripDate: new Date(),
          vehicleId: v.id,
          carrierId: v.carrierId,
          carrierNameSnapshot: v.carrierId ? 'รถร่วม' : null,
          vehicleTypeId: v.vehicleTypeId,
          vehiclePlateSnapshot: v.plate,
          vehicleTypeSnapshot: '6 ล้อ',
          status: 'DISPATCHED',
          dispatchedAt: new Date(),
        },
      });
    const rows = await db.activeVehicleUsage.findMany({ where: { tenantId: id } });
    expect(rows.map((r) => r.plate).sort()).toEqual(['71-7777', 'ตย-9002']);
  });

  it('S6: SO ตัวอย่างที่ DO เดินสถานะ / ลงเที่ยว / บรรทัดรายได้ล็อก → เก็บไว้ (kept) · ใบที่ยังไม่ถูกใช้ลบได้', async () => {
    const { id, a } = await tenant();
    await a.post('/v1/sample-data').expect(200);
    const sos = await db.salesOrder.findMany({ where: { tenantId: id }, orderBy: { soNo: 'asc' } });
    const dos = await db.deliveryOrder.findMany({ where: { tenantId: id } });
    const doOf = (soId: string) => dos.find((d) => d.salesOrderId === soId)!;
    // (1) ใบสั่งพ้นขั้นรับงาน (วางแผนแล้ว)
    await db.salesOrder.update({ where: { id: sos[0]!.id }, data: { status: 'PLANNED' } });
    // (2) DO ลงเที่ยว
    const v = await db.vehicle.findFirst({ where: { tenantId: id, plate: 'ตย-9001' } });
    const trip = await db.trip.create({
      data: {
        tenantId: id,
        tripNo: 'TRP-S6-1',
        tripDate: new Date(),
        vehicleId: v!.id,
        vehicleTypeId: v!.vehicleTypeId,
        vehiclePlateSnapshot: v!.plate,
        vehicleTypeSnapshot: '6 ล้อ',
      },
    });
    await db.deliveryOrder.update({
      where: { id: doOf(sos[1]!.id).id },
      data: { tripId: trip.id, status: 'PLANNED' },
    });
    // (3) บรรทัดรายได้ล็อก (ออกเอกสารแล้ว)
    await db.revenueLine.updateMany({
      where: { tenantId: id, salesOrderId: sos[2]!.id },
      data: { lockedAt: new Date() },
    });
    const r = (await a.post('/v1/sample-data/clear').expect(200)).body;
    const keptSo = r.kept
      .filter((k: { entityType: string }) => k.entityType === 'sales_order')
      .map((k: { id: string }) => k.id)
      .sort();
    expect(keptSo).toEqual(
      [sos[0]!.id, sos[1]!.id, sos[2]!.id].map((x) => encodeId('salesOrder', x)).sort(),
    );
    expect(r.removed.sales_order).toBe(1);
    expect(await db.salesOrder.count({ where: { id: sos[3]!.id } })).toBe(0);
    expect(await db.deliveryOrder.count({ where: { salesOrderId: sos[1]!.id } })).toBe(1);
    // รถที่ลงเที่ยวแล้วก็เก็บไว้ (FK)
    expect(r.kept).toContainEqual(
      expect.objectContaining({ entityType: 'vehicle', label: 'ตย-9001' }),
    );
  });

  it('S2: role แอปเขียนธงตรงไม่ได้ · tms_sample_flag ปฏิเสธแถวที่ไม่ได้สร้างใน transaction นี้', async () => {
    const { id, a } = await tenant();
    const real = (
      await a.post('/v1/customers').send({ legalName: 'บริษัท ลูกค้าจริง สอง จำกัด' }).expect(201)
    ).body;
    const realId = (await db.customer.findFirst({ where: { tenantId: id, code: real.code } }))!.id;
    const dbs = app.get(DbService);
    await expect(
      dbs.withTenant(id, (tx) =>
        tx.sampleRecord.create({
          data: { tenantId: id, entityType: 'customer', entityId: realId },
        }),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      dbs.withTenant(
        id,
        (tx) => tx.$queryRaw`SELECT tms_sample_flag('customer', ${[realId]}::uuid[])`,
      ),
    ).rejects.toThrow(/written in this transaction/);
    expect(await db.sampleRecord.count({ where: { tenantId: id } })).toBe(0);
  });

  it('S3: ใส่ข้อมูลตัวอย่างไม่สร้างคำสั่ง outbox (webhook/ERP) · ข้อมูลจริงยังสร้างตามปกติ · M4 ออกใบแจ้งหนี้ให้ลูกค้าตัวอย่างไม่ได้', async () => {
    const { id, a } = await tenant();
    await db.integrationSubscription.create({
      data: { tenantId: id, kind: 'WEBHOOK', sink: 'webhook', targetId: 'test', eventTypes: ['*'] },
    });
    await a.post('/v1/sample-data').expect(200);
    expect(await db.integrationOutbox.count({ where: { tenantId: id } })).toBe(0);
    await a.post('/v1/sample-data/clear').expect(200);
    expect(await db.integrationOutbox.count({ where: { tenantId: id } })).toBe(0);
    await a.post('/v1/customers').send({ legalName: 'บริษัท ลูกค้าจริง สาม จำกัด' }).expect(201);
    expect(await db.integrationOutbox.count({ where: { tenantId: id } })).toBeGreaterThan(0);

    await a.post('/v1/sample-data').expect(200);
    const cus = await db.customer.findFirst({
      where: { tenantId: id, legalName: 'บริษัท ตัวอย่างค้าวัสดุ จำกัด' },
    });
    await expect(
      app.get(DbService).withTenant(id, (tx) => assertNotSampleCustomer(tx, cus!.id)),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('รอบ 2 ข้อ 1: event ของข้อมูลตัวอย่างไม่อยู่ใน GET /v1/events · GET/redeliver = 404 (แม้ล้างแล้ว)', async () => {
    const { id, a } = await tenant();
    const t0 = new Date();
    await a.post('/v1/sample-data').expect(200);
    const evs = await db.domainEvent.findMany({ where: { tenantId: id, occurredAt: { gte: t0 } } });
    expect(evs.length).toBeGreaterThan(0);
    expect(await db.sampleEvent.count({ where: { tenantId: id } })).toBe(evs.length);
    const feedIds = new Set(
      (await a.get('/v1/events?limit=200').expect(200)).body.data.map((e: { id: string }) => e.id),
    );
    for (const e of evs) expect(feedIds.has(encodeId('event', e.id))).toBe(false);
    const ev = encodeId('event', evs[0]!.id);
    await a.get(`/v1/events/${ev}`).expect(404);
    await a.post(`/v1/events/${ev}/redeliver`).expect(404);
    await a.post('/v1/sample-data/clear').expect(200);
    await a.get(`/v1/events/${ev}`).expect(404);
    // event จริงหลังจากนี้ไม่ถูกติดป้ายตัวอย่าง (ธงอยู่แค่ใน transaction ที่ใส่)
    const n = await db.sampleEvent.count({ where: { tenantId: id } });
    await a.post('/v1/customers').send({ legalName: 'บริษัท ลูกค้าจริง สี่ จำกัด' }).expect(201);
    expect(await db.sampleEvent.count({ where: { tenantId: id } })).toBe(n);
  });

  it('รอบ 2 ข้อ 2: tms_app เรียกฟังก์ชันนับด้วย tenant อื่น ไม่ได้ข้อมูลของ tenant นั้น', async () => {
    const A = await tenant();
    const B = await tenant();
    await A.a.post('/v1/sample-data').expect(200);
    const v = await db.vehicle.findFirst({ where: { tenantId: A.id, plate: 'ตย-9001' } });
    const dbs = app.get(DbService);
    const own = await dbs.withTenant(
      A.id,
      (tx) =>
        tx.$queryRaw<{ s: boolean; st: string | null }[]>`
        SELECT tms_trip_is_sample(${A.id}::uuid, ${v!.id}::uuid, NULL, now()) AS s,
               tms_tenant_status_at(${A.id}::uuid, now()) AS st`,
    );
    expect(own[0]).toEqual({ s: true, st: 'TRIALING' });
    const other = await dbs.withTenant(
      B.id,
      (tx) =>
        tx.$queryRaw<{ s: boolean; st: string | null }[]>`
        SELECT tms_trip_is_sample(${A.id}::uuid, ${v!.id}::uuid, NULL, now()) AS s,
               tms_tenant_status_at(${A.id}::uuid, now()) AS st`,
    );
    expect(other[0]).toEqual({ s: false, st: null });
  });

  it('รอบ 2 ข้อ 8: อนุมัติใบสำคัญจ่ายให้รถร่วมตัวอย่างไม่ได้ (422 sample_carrier)', async () => {
    const { id, a } = await tenant();
    await a.post('/v1/sample-data').expect(200);
    const c = await db.carrier.findFirst({ where: { tenantId: id } });
    await expect(
      app.get(DbService).withTenant(id, (tx) => assertNotSampleCarrier(tx, c!.id)),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('ใส่ได้เฉพาะช่วงทดลองใช้ / sandbox — บริษัทที่ใช้งานจริงแล้ว 409 · ล้างได้เสมอ (ไม่มี = ไม่ทำอะไร)', async () => {
    const { a } = await tenant('ACTIVE');
    expect((await a.get('/v1/sample-data').expect(200)).body).toMatchObject({
      allowed: false,
      loaded: false,
    });
    expect((await a.post('/v1/sample-data').expect(409)).body.code).toBe('sample_data_not_allowed');
    expect((await a.post('/v1/sample-data/clear').expect(200)).body).toMatchObject({
      loaded: false,
      kept: [],
    });
  });

  it('แยก tenant: B ไม่เห็นและล้างข้อมูลตัวอย่างของ A ไม่ได้', async () => {
    const A = await tenant();
    const B = await tenant();
    await A.a.post('/v1/sample-data').expect(200);
    const before = await counts(A.id);
    expect((await B.a.get('/v1/sample-data').expect(200)).body.loaded).toBe(false);
    expect((await B.a.post('/v1/sample-data/clear').expect(200)).body.removed.customer).toBe(0);
    expect(await counts(A.id)).toEqual(before);
  });

  it('สิทธิ์: ต้องมี settings:write', async () => {
    const { id } = await tenant();
    const viewer = api(app, await tokenFor(id, 'orders:read'));
    await viewer.get('/v1/sample-data').expect(403);
    await viewer.post('/v1/sample-data').expect(403);
    await viewer.post('/v1/sample-data/clear').expect(403);
  });
});
