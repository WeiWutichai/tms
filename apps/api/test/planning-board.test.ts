import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SYSTEM_ROLES } from '@tms/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { requestContext } from '../src/common/request-context';
import { DbService, type Tx } from '../src/db/db.service';
import { DeliveryOrderService } from '../src/modules/delivery-orders/delivery-order.service';
import {
  OrderIntakeService,
  type UpsertOrderInput,
} from '../src/modules/orders/order-intake.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

interface BoardTrip {
  id: string;
  tripNo: string;
  status: string;
  vehicleId: string | null;
  plannedStartAt: string | null;
  plannedEndAt: string | null;
  overlapsWith: string[];
  orders: { orderNo: string; customerName: string | null }[];
  weightKg: string;
  version: number;
}
interface BoardPool {
  id: string;
  orderNo: string;
  customerName: string | null;
  origin: { name: string; province: string | null };
  dest: { name: string; province: string | null };
  weightKg: string;
  deliveryOrders: { id: string; doNo: string }[];
}

/**
 * ST3-T12 กระดานวางแผน: GET /v1/planning/board (แถวรถ + เที่ยว + SO รอจัด) · POST /v1/trips ที่มี `vehicleId`
 * (ลาก SO ลงแถวรถ → เที่ยว PLANNING) · POST /v1/trips/:id/schedule (ย้าย/ปรับขนาด) · ซ้อนเวลา = แดงแต่บันทึกได้
 */
describe('planning board (ST3-T12)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let otherId: string;
  let admin: string;
  let planner: string;
  let viewer: string;
  let other: string;
  let seed = 0;
  let unitTon: string;
  let vt6: string;
  const today = bangkokToday();
  const at = (hh: string) => `${today}T${hh}:00+07:00`;
  const uuid = (kind: Parameters<typeof tryDecodeId>[0], id: string) => tryDecodeId(kind, id)!;
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };

  async function company(tid: string) {
    const c = await db.company.create({
      data: {
        tenantId: tid,
        legalName: `บริษัท ผู้ออกบิล ${++seed}`,
        taxId: validTaxId(800 + seed),
      },
    });
    await db.branch.create({
      data: {
        tenantId: tid,
        companyId: c.id,
        branchCode: '00000',
        branchLabel: 'สำนักงานใหญ่',
        address: ADDR,
        isDefaultIssuer: true,
      },
    });
  }

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท กระดาน' })).id;
    otherId = (await createTenantWithDefaults(db, { name: 'บริษัท อื่น' })).id;
    await company(tenantId);
    await company(otherId);
    admin = await tokenFor(tenantId);
    planner = await tokenFor(tenantId, SYSTEM_ROLES.planner.permissions.join(' '), 'u-planner');
    viewer = await tokenFor(tenantId, SYSTEM_ROLES.viewer.permissions.join(' '), 'u-view');
    other = await tokenFor(otherId);
    const us = (await api(app, admin).get('/v1/units?limit=50').expect(200)).body.data as {
      id: string;
      code: string;
    }[];
    unitTon = uuid('unit', us.find((u) => u.code === 'TON')!.id);
    const types = (await api(app, admin).get('/v1/vehicle-types?limit=50').expect(200)).body
      .data as { id: string; code: string }[];
    vt6 = types.find((t) => t.code === '6W')!.id;
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  const run = <T>(fn: (tx: Tx) => Promise<T>, tid = tenantId) =>
    app
      .get(DbService)
      .withTenant(tid, (tx) =>
        requestContext.run(
          { requestId: randomUUID(), tenantId: tid, actorId: 'user-test', locale: 'th', tx },
          () => fn(tx),
        ),
      );
  const site = async (province: string) =>
    uuid(
      'site',
      (
        await api(app, admin)
          .post('/v1/customer-sites')
          .send({ name: `จุด ${++seed}`, kind: 'DROPOFF', address: { ...ADDR, province } })
          .expect(201)
      ).body.id,
    );
  const customer = async (name: string) =>
    uuid(
      'customer',
      (
        await api(app, admin)
          .post('/v1/customers')
          .send({ legalName: name, taxId: validTaxId(7700 + ++seed) })
          .expect(201)
      ).body.id,
    );
  /** SO ใหม่ (จุดส่งเดียว → DO อัตโนมัติ) */
  const newOrder = async (
    o: { weightKg?: string; requestedDate?: string; customer?: string } = {},
  ) => {
    const input: UpsertOrderInput = {
      source: 'MANUAL',
      customer: { id: o.customer ?? (await customer(`ลูกค้า ${++seed}`)) },
      requestedDate: o.requestedDate ?? today,
      stops: [
        { type: 'PICKUP', siteId: await site('สมุทรปราการ') },
        { type: 'DELIVERY', siteId: await site('ชลบุรี') },
      ],
      lines: [
        { description: 'ปูนซีเมนต์', qty: '5', unitId: unitTon, weightKg: o.weightKg ?? '5400' },
      ],
    };
    const { order: so } = await run((tx) => app.get(OrderIntakeService).upsertOrder(input, tx));
    const dos = await run((tx) => app.get(DeliveryOrderService).listForOrder(so.id, {}, tx));
    return {
      soId: encodeId('salesOrder', so.id),
      soNo: so.soNo!,
      doIds: dos.map((d) => encodeId('deliveryOrder', d.id)),
    };
  };
  const newVehicle = async (extra: object = {}) =>
    (
      await api(app, admin)
        .post('/v1/vehicles')
        .send({
          plate: `7${++seed % 10}-${String(2000 + seed)}`,
          plateProvince: 'TH-10',
          vehicleTypeId: vt6,
          ownership: 'OWN',
          payloadKg: 6000,
          ...extra,
        })
        .expect(201)
    ).body as { id: string; plate: string };
  const board = async (q = '', token = admin) =>
    (await api(app, token).get(`/v1/planning/board${q}`).expect(200)).body as {
      from: string;
      to: string;
      today: string;
      vehicles: {
        id: string;
        plate: string;
        plateProvince: string;
        capacityKg: string | null;
        driver: unknown;
      }[];
      trips: BoardTrip[];
      pool: BoardPool[];
    };
  const drop = (doIds: string[], vehicleId: string, s: string, e: string, token = admin) =>
    api(app, token)
      .post('/v1/trips')
      .set('Idempotency-Key', randomUUID())
      .send({
        tripDate: today,
        deliveryOrderIds: doIds,
        vehicleId,
        plannedStartAt: at(s),
        plannedEndAt: at(e),
      });
  const schedule = (id: string, body: object, token = admin) =>
    api(app, token).post(`/v1/trips/${id}/schedule`).send(body);

  it('เกณฑ์ตรวจรับ: ลาก SO ลงแถวรถ → เที่ยว PLANNING มีรถที่วางไว้ (ไม่มีคนขับ, DO ยัง DRAFT) · ออกจาก SO รอจัด · ขึ้นบนแถวรถ', async () => {
    const v = await newVehicle();
    const o = await newOrder();
    const before = await board();
    const card = before.pool.find((p) => p.orderNo === o.soNo)!;
    expect(card).toMatchObject({
      id: o.soId,
      origin: { province: 'สมุทรปราการ' },
      dest: { province: 'ชลบุรี' },
      weightKg: '5400',
    });
    expect(card.customerName).toMatch(/^ลูกค้า /);
    expect(card.deliveryOrders.map((d) => d.id)).toEqual(o.doIds);
    expect(before.vehicles.find((x) => x.id === v.id)).toMatchObject({
      capacityKg: '6000',
      plateProvince: 'TH-10',
    });

    const r = await drop(o.doIds, v.id, '09:00', '12:00').expect(201);
    expect(r.body).toMatchObject({
      status: 'PLANNING',
      vehicle: { id: v.id, plate: v.plate },
      driver: null,
      carrier: null,
      warnings: [],
    });
    const dRow = await db.deliveryOrder.findUniqueOrThrow({
      where: { id: uuid('deliveryOrder', o.doIds[0]!) },
    });
    expect(dRow.status).toBe('DRAFT');
    const after = await board();
    expect(after.pool.find((p) => p.orderNo === o.soNo)).toBeUndefined();
    const t = after.trips.find((x) => x.id === r.body.id)!;
    expect(t).toMatchObject({
      status: 'PLANNING',
      vehicleId: v.id,
      overlapsWith: [],
      weightKg: '5400',
      orders: [{ orderNo: o.soNo }],
    });
    expect(Date.parse(t.plannedStartAt!)).toBe(Date.parse(at('09:00')));
    // เที่ยว PLANNING ที่มีรถวางไว้ → จัดรถจริงได้ตามปกติ (ASSIGNED)
    const d = (
      await api(app, admin)
        .post('/v1/drivers')
        .send({
          name: `คนขับ ${++seed}`,
          phone: `081-${String(seed).padStart(3, '0')}-${String(seed).padStart(4, '0')}`,
          employmentType: 'EMPLOYEE_SALARIED',
          licenceClass: 'T2',
          licenceExpiresOn: '2030-03-31',
        })
        .expect(201)
    ).body as { id: string };
    const a = await api(app, admin)
      .post(`/v1/trips/${r.body.id}/assign`)
      .send({ vehicleId: v.id, driverId: d.id })
      .expect(200);
    expect(a.body.status).toBe('ASSIGNED');
  });

  it('เกณฑ์ตรวจรับ: ลากซ้อนเวลาบนรถเดียว → บันทึกสำเร็จ + คำเตือน vehicle_overlap · กระดานแดงทั้งสองเที่ยว · ย้ายออกแล้วหายแดง', async () => {
    const v = await newVehicle();
    const a = await drop((await newOrder()).doIds, v.id, '09:00', '12:00').expect(201);
    const b = await drop((await newOrder()).doIds, v.id, '11:00', '14:00').expect(201);
    expect(b.body.status).toBe('PLANNING');
    expect(b.body.warnings.map((w: { code: string }) => w.code)).toContain('vehicle_overlap');
    let bd = await board();
    const ta = bd.trips.find((t) => t.id === a.body.id)!;
    const tb = bd.trips.find((t) => t.id === b.body.id)!;
    expect(ta.overlapsWith).toEqual([b.body.tripNo]);
    expect(tb.overlapsWith).toEqual([a.body.tripNo]);

    // ย้าย (ลากแนวนอน) B ไป 12:00–15:00 → ขอบชนพอดีไม่ซ้อน · version +1 · audit
    const m = await schedule(b.body.id, { plannedStartAt: at('12:00'), plannedEndAt: at('15:00') })
      .set('If-Match', `"${b.body.version}"`)
      .expect(200);
    expect(m.body.version).toBeGreaterThan(b.body.version);
    expect(m.headers.etag).toBe(`"${m.body.version}"`);
    expect(m.body.warnings).toEqual([]);
    bd = await board();
    expect(bd.trips.find((t) => t.id === a.body.id)!.overlapsWith).toEqual([]);
    expect(
      await db.auditLog.count({
        where: { entityId: uuid('trip', b.body.id), action: 'trip.rescheduled' },
      }),
    ).toBe(1);
    expect(
      await db.domainEvent.count({
        where: { localId: uuid('trip', b.body.id), type: 'trip.updated' },
      }),
    ).toBe(1);
    // ค่าเดิม → ไม่เปลี่ยน version · If-Match เก่า → 412
    const same = await schedule(b.body.id, { plannedStartAt: at('12:00') }).expect(200);
    expect(same.body.version).toBe(m.body.version);
    await schedule(b.body.id, { plannedEndAt: at('16:00') })
      .set('If-Match', `"${b.body.version}"`)
      .expect(412);
    // ปรับขนาด (ลากขอบขวา) ให้ทับ A อีก → บันทึกได้ แดง
    const rs = await schedule(b.body.id, {
      plannedStartAt: at('10:00'),
      plannedEndAt: at('15:00'),
    }).expect(200);
    expect(rs.body.warnings.map((w: { code: string }) => w.code)).toContain('vehicle_overlap');
    // จบก่อนเริ่ม → 422
    expect(
      (await schedule(b.body.id, { plannedEndAt: at('09:00') }).expect(422)).body.errors[0].code,
    ).toBe('before_start');
  });

  it('ย้ายเที่ยวไปรถอื่น (PLANNING) · ถอดรถที่วางไว้ · ASSIGNED เปลี่ยนรถผ่าน schedule ไม่ได้ (409) แต่ปรับเวลาได้', async () => {
    const v1 = await newVehicle();
    const v2 = await newVehicle();
    const t = (await drop((await newOrder()).doIds, v1.id, '08:00', '10:00').expect(201)).body;
    const moved = await schedule(t.id, { vehicleId: v2.id }).expect(200);
    expect(moved.body.vehicle).toMatchObject({ id: v2.id, plate: v2.plate });
    expect(moved.body.status).toBe('PLANNING');
    const none = await schedule(t.id, { vehicleId: null }).expect(200);
    expect(none.body.vehicle).toBeNull();
    // รถที่ไม่ถูกต้อง → 422 รายช่อง
    const trailer = await newVehicle({ unitRole: 'TRAILER' });
    expect(
      (await schedule(t.id, { vehicleId: trailer.id }).expect(422)).body.errors[0],
    ).toMatchObject({ field: 'vehicleId', code: 'is_trailer' });
    expect(
      (await schedule(t.id, { vehicleId: `veh_${'0'.repeat(32)}` }).expect(422)).body.errors[0]
        .code,
    ).toBe('invalid_reference');

    const d = (
      await api(app, admin)
        .post('/v1/drivers')
        .send({
          name: `คนขับ ${++seed}`,
          phone: `082-${String(seed).padStart(3, '0')}-${String(seed).padStart(4, '0')}`,
          employmentType: 'EMPLOYEE_SALARIED',
          licenceClass: 'T2',
          licenceExpiresOn: '2030-03-31',
        })
        .expect(201)
    ).body as { id: string };
    await api(app, admin)
      .post(`/v1/trips/${t.id}/assign`)
      .send({ vehicleId: v1.id, driverId: d.id })
      .expect(200);
    const r = await schedule(t.id, { vehicleId: v2.id }).expect(409);
    expect(r.body).toMatchObject({ code: 'invalid_state_transition', event: 'schedule_vehicle' });
    const ok = await schedule(t.id, {
      plannedStartAt: at('13:00'),
      plannedEndAt: at('15:00'),
    }).expect(200);
    expect(ok.body.status).toBe('ASSIGNED');
    expect(ok.body.driver).toMatchObject({ id: d.id });
  });

  it('SO รอจัด: เฉพาะ DO DRAFT นอกเที่ยวของ SO ที่ลงเที่ยวได้ · ค้างเพราะยังจับคู่ลูกค้าไม่ได้ไม่ขึ้น · เรียงกำหนดส่ง', async () => {
    const late = await newOrder({ requestedDate: '2026-01-05' });
    const ok = await newOrder();
    const pickup = await site('ระยอง');
    const { order: unmapped } = await run((tx) =>
      app.get(OrderIntakeService).upsertOrder(
        {
          source: 'MANUAL',
          customer: { externalId: 'PB-C-404', text: 'ลูกค้าที่ยังไม่มีในระบบ' },
          requestedDate: today,
          stops: [
            { type: 'PICKUP', siteId: pickup },
            { type: 'DELIVERY', siteText: 'ปลายทางที่ไม่รู้จัก' },
          ],
        },
        tx,
      ),
    );
    const bd = await board();
    const nos = bd.pool.map((p) => p.orderNo);
    expect(nos).toContain(ok.soNo);
    expect(nos.indexOf(late.soNo)).toBeLessThan(nos.indexOf(ok.soNo));
    expect(nos).not.toContain(unmapped.soNo);
  });

  it('สิทธิ์ + แยก tenant + query ผิด', async () => {
    const v = await newVehicle();
    const o = await newOrder();
    // viewer อ่านกระดานได้ แต่ลาก/ย้ายไม่ได้
    await board('', viewer);
    expect((await drop(o.doIds, v.id, '06:00', '07:00', viewer).expect(403)).body.code).toBe(
      'permission_denied',
    );
    const t = (await drop(o.doIds, v.id, '06:00', '07:00', planner).expect(201)).body;
    expect(
      (await schedule(t.id, { plannedEndAt: at('08:00') }, viewer).expect(403)).body.code,
    ).toBe('permission_denied');
    // ไม่มี orders:read → 403
    const tripsOnly = await tokenFor(tenantId, 'trips:read', 'u-trips-only');
    expect((await api(app, tripsOnly).get('/v1/planning/board').expect(403)).body).toMatchObject({
      code: 'permission_denied',
      required: ['orders:read'],
    });
    // tenant อื่น: ไม่เห็นรถ/เที่ยว/งานของ tenant นี้ · ย้ายเที่ยวของ tenant นี้ → 404 · วางรถของ tenant นี้ → 422
    const ob = await board('', other);
    expect(ob.vehicles).toEqual([]);
    expect(ob.trips).toEqual([]);
    expect(ob.pool).toEqual([]);
    await schedule(t.id, { plannedEndAt: at('08:00') }, other).expect(404);
    // query
    expect((await board(`?date=${today}&days=7`)).to).not.toBe(today);
    await api(app, admin).get('/v1/planning/board?days=3').expect(422);
    expect(
      (await api(app, admin).get('/v1/planning/board?date=2026-02-31').expect(422)).body.errors[0]
        .code,
    ).toBe('invalid_date');
  });
});
