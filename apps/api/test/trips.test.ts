import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import { SYSTEM_ROLES } from '@tms/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { requestContext } from '../src/common/request-context';
import { DbService, type Tx } from '../src/db/db.service';
import { DeliveryOrderService } from '../src/modules/delivery-orders/delivery-order.service';
import { TripService } from '../src/modules/trips/trip.service';
import {
  OrderIntakeService,
  type UpsertOrderInput,
} from '../src/modules/orders/order-intake.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST3-T11 เที่ยวรถ (trip + trip_stop): สร้างจาก DO, จุดแวะ, snapshot รถ/คนขับต่อเที่ยว (เกณฑ์ตรวจรับ: เปลี่ยนคนขับประจำ
 * หลังสร้างเที่ยวแล้วเที่ยวเดิมไม่เปลี่ยน), state machine + action API (transition ผิด → 409), ยกเลิกปล่อย DO/SO,
 * หลาย SO ลูกค้าเดียวในเที่ยวเดียว, เพิ่ม/ถอด DO, รถร่วม (offer → assign), พร้อมกัน, สิทธิ์, แยก tenant, constraint
 */
describe('trips (ST3-T11)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let otherId: string;
  let admin: string;
  let planner: string;
  let dispatcher: string;
  let viewer: string;
  let other: string;
  let seed = 0;
  let unitTon: string;
  let vt6: string;
  const today = bangkokToday();
  const uuid = (kind: Parameters<typeof tryDecodeId>[0], id: string) => tryDecodeId(kind, id)!;
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };
  const yymm = () => {
    const [y, m] = today.split('-');
    return `${String(Number(y) + 543).slice(-2)}${m}`;
  };
  const jur = (n: number) => {
    const base = `0105${String(80_000 + n).padStart(8, '0')}`;
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
    return base + String((11 - (sum % 11)) % 10);
  };

  async function company(tid: string) {
    const c = await db.company.create({
      data: {
        tenantId: tid,
        legalName: `บริษัท ผู้ออกบิล ${++seed}`,
        taxId: validTaxId(900 + seed),
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
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท เที่ยวรถ' })).id;
    otherId = (await createTenantWithDefaults(db, { name: 'บริษัท อื่น' })).id;
    await company(tenantId);
    await company(otherId);
    admin = await tokenFor(tenantId);
    planner = await tokenFor(tenantId, SYSTEM_ROLES.planner.permissions.join(' '), 'u-planner');
    dispatcher = await tokenFor(tenantId, SYSTEM_ROLES.dispatcher.permissions.join(' '), 'u-disp');
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
  const upsert = (input: UpsertOrderInput, tid = tenantId) =>
    run((tx) => app.get(OrderIntakeService).upsertOrder(input, tx), tid);

  const newSite = async (token = admin) =>
    uuid(
      'site',
      (
        await api(app, token)
          .post('/v1/customer-sites')
          .send({ name: `จุดรับส่ง ${++seed}`, kind: 'DROPOFF', address: ADDR })
          .expect(201)
      ).body.id,
    );
  const newCustomer = async (token = admin) =>
    uuid(
      'customer',
      (
        await api(app, token)
          .post('/v1/customers')
          .send({ legalName: `ลูกค้า ${++seed}`, taxId: validTaxId(9700 + seed) })
          .expect(201)
      ).body.id,
    );
  type Key = { customer: string; origin: string; dest: string };
  const key = async (): Promise<Key> => ({
    customer: await newCustomer(),
    origin: await newSite(),
    dest: await newSite(),
  });
  const order = (k: Key, window?: [string, string]): UpsertOrderInput => ({
    source: 'MANUAL',
    customer: { id: k.customer },
    requestedDate: today,
    stops: [
      { type: 'PICKUP', siteId: k.origin },
      {
        type: 'DELIVERY',
        siteId: k.dest,
        ...(window ? { windowStart: window[0], windowEnd: window[1] } : {}),
      },
    ],
    lines: [{ description: 'ปูนซีเมนต์', qty: '10', unitId: unitTon, weightKg: '10000' }],
  });
  /** SO ใหม่ → DO (public id) + uuid SO */
  const newDo = async (k?: Key, tid = tenantId) => {
    const kk = k ?? (await key());
    const { order: so } = await upsert(order(kk), tid);
    const [d] = await run((tx) => app.get(DeliveryOrderService).listForOrder(so.id, {}, tx), tid);
    return { id: encodeId('deliveryOrder', d!.id), uuid: d!.id, soId: so.id, key: kk };
  };
  const soStatus = async (id: string) =>
    await db.salesOrder.findUniqueOrThrow({ where: { id }, include: { holdReasonCode: true } });
  const doRow = (id: string) => db.deliveryOrder.findUniqueOrThrow({ where: { id } });

  const newVehicle = async (extra: object = {}) =>
    (
      await api(app, admin)
        .post('/v1/vehicles')
        .send({
          plate: `7${++seed % 10}-${String(1000 + seed)}`,
          plateProvince: 'TH-10',
          vehicleTypeId: vt6,
          ownership: 'OWN',
          ...extra,
        })
        .expect(201)
    ).body as { id: string; plate: string; version: number };
  const newDriver = async (extra: object = {}) => {
    const n = ++seed;
    return (
      await api(app, admin)
        .post('/v1/drivers')
        .send({
          name: `คนขับ ${n}`,
          phone: `089-${String(n).padStart(3, '0')}-${String(n).padStart(4, '0')}`,
          employmentType: 'EMPLOYEE_SALARIED',
          licenceClass: 'T2',
          licenceExpiresOn: '2030-03-31',
          ...extra,
        })
        .expect(201)
    ).body as { id: string; name: string; version: number };
  };
  const newCarrier = async () =>
    (
      await api(app, admin)
        .post('/v1/carriers')
        .send({ legalName: `หจก. รถร่วม ${++seed}`, entityType: 'JURISTIC', taxId: jur(seed) })
        .expect(201)
    ).body as { id: string };

  const createTrip = (deliveryOrderIds: string[], extra: object = {}, token = admin) =>
    api(app, token)
      .post('/v1/trips')
      .send({ tripDate: today, deliveryOrderIds, ...extra });
  const act = (id: string, verb: string, body: object = {}, token = admin) =>
    api(app, token).post(`/v1/trips/${id}/${verb}`).send(body);

  it('สร้างเที่ยวจาก DO ของ 2 SO ลูกค้าเดียว จุดเดียวกัน → PLANNING, เลข TRP, จุดรับ/ส่งร่วมกัน, SO → PLANNED, ประวัติ/event/audit', async () => {
    const k = await key();
    const a = await newDo(k);
    const b = await newDo(k);
    const r = await createTrip([a.id, b.id]).set('Idempotency-Key', randomUUID()).expect(201);
    expect(r.headers.etag).toBe(`"${r.body.version}"`);
    expect(r.body).toMatchObject({
      status: 'PLANNING',
      tripDate: today,
      vehicle: null,
      driver: null,
    });
    expect(r.body.tripNo).toMatch(new RegExp(`^TRP-${yymm()}-\\d{4}$`));
    expect(
      r.body.stops.map((s: { sequence: number; type: string; deliveryOrderIds: string[] }) => [
        s.sequence,
        s.type,
        [...s.deliveryOrderIds].sort(),
      ]),
    ).toEqual([
      [1, 'PICKUP', [a.id, b.id].sort()],
      [2, 'DELIVERY', [a.id, b.id].sort()],
    ]);
    expect(r.body.stops[0].siteId).toBe(encodeId('site', k.origin));
    for (const d of [a, b]) {
      const row = await doRow(d.uuid);
      expect(row).toMatchObject({ status: 'DRAFT', tripId: uuid('trip', r.body.id) });
      expect(row.tripStopId).toBe(uuid('tripStop', r.body.stops[1].id));
      expect(row.pickupTripStopId).toBe(uuid('tripStop', r.body.stops[0].id));
      const so = await soStatus(d.soId);
      expect(so.status).toBe('PLANNED');
      expect(so.holdReasonCodeId).toBeNull();
    }
    const tid = uuid('trip', r.body.id);
    const hist = await db.docStatusHistory.findMany({ where: { docType: 'trip', docId: tid } });
    expect(hist.map((h) => [h.fromStatus, h.toStatus])).toEqual([['NONE', 'PLANNING']]);
    expect(await db.domainEvent.count({ where: { localId: tid, type: 'trip.created' } })).toBe(1);
    expect(await db.auditLog.count({ where: { entityId: tid, action: 'trip.created' } })).toBe(1);
    // GET + list
    await api(app, admin).get(`/v1/trips/${r.body.id}`).expect(200);
    const list = await api(app, admin)
      .get(`/v1/trips?status=PLANNING&dateFrom=${today}`)
      .expect(200);
    expect(list.body.data.map((t: { id: string }) => t.id)).toContain(r.body.id);
    // DO เดิมลงเที่ยวอื่นไม่ได้ (409)
    expect((await createTrip([a.id]).expect(409)).body.code).toBe('delivery_order_on_trip');
  });

  it('เกณฑ์ตรวจรับ: assign ใช้คนขับประจำ ณ ตอนนั้นเป็น snapshot — เปลี่ยนคนขับประจำ/ชื่อ/ทะเบียนภายหลังแล้วเที่ยวเดิมไม่เปลี่ยน', async () => {
    const v = await newVehicle();
    const d1 = await newDriver({ defaultVehicleId: v.id });
    const reliefD = await newDriver();
    const x = await newDo();
    const t = (await createTrip([x.id]).expect(201)).body;
    const r = await act(t.id, 'assign', { vehicleId: v.id, reliefDriverId: reliefD.id }).set(
      'If-Match',
      `"${t.version}"`,
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      status: 'ASSIGNED',
      vehicle: { id: v.id, plate: v.plate, vehicleTypeId: vt6, vehicleTypeName: '6 ล้อ' },
      driver: { id: d1.id, name: d1.name },
      reliefDriver: { id: reliefD.id, name: reliefD.name },
      carrier: null,
    });
    expect((await doRow(x.uuid)).status).toBe('PLANNED');
    expect(Array.isArray(r.body.warnings)).toBe(true);
    // เปลี่ยนคนขับประจำของรถ + ชื่อคนขับ + ทะเบียน หลังสร้างเที่ยว
    const d2 = await newDriver({ defaultVehicleId: v.id });
    const cur1 = (await api(app, admin).get(`/v1/drivers/${d1.id}`).expect(200)).body;
    await api(app, admin)
      .patch(`/v1/drivers/${d1.id}`)
      .set('If-Match', `"${cur1.version}"`)
      .send({ name: 'ชื่อใหม่หลังจัดรถ', defaultVehicleId: null })
      .expect(200);
    const cv = (await api(app, admin).get(`/v1/vehicles/${v.id}`).expect(200)).body;
    await api(app, admin)
      .patch(`/v1/vehicles/${v.id}`)
      .set('If-Match', `"${cv.version}"`)
      .send({ plate: '99-9999' })
      .expect(200);
    const after = (await api(app, admin).get(`/v1/trips/${t.id}`).expect(200)).body;
    expect(after.driver).toEqual(r.body.driver);
    expect(after.vehicle).toEqual(r.body.vehicle);
    expect(after.driver.id).not.toBe(d2.id);
  });

  it('transition ผิด → 409 ทุก action · ปล่อยรถ → DO DISPATCHED + SO IN_TRANSIT · หลังปล่อยแก้ snapshot ไม่ได้ · complete เมื่อทุกจุดจบ', async () => {
    const v = await newVehicle();
    const drv = await newDriver();
    const x = await newDo();
    const t = (await createTrip([x.id]).expect(201)).body;
    const code409 = async (verb: string, body: object = {}) => {
      const r = await act(t.id, verb, body);
      expect(r.status, verb).toBe(409);
      expect(r.body.code).toBe('invalid_state_transition');
    };
    await code409('dispatch');
    await code409('complete');
    // บริษัทต้องมีคนขับ (ไม่มีคนขับประจำ)
    expect(
      (await act(t.id, 'assign', { vehicleId: v.id }).expect(422)).body.errors[0],
    ).toMatchObject({
      field: 'driverId',
      code: 'required',
    });
    await act(t.id, 'assign', { vehicleId: v.id, driverId: drv.id }).expect(200);
    await code409('offer', { carrierId: (await newCarrier()).id });
    await code409('complete');
    // If-Match เก่า → 412
    expect((await act(t.id, 'dispatch').set('If-Match', '"1"')).status).toBe(412);
    const disp = await act(t.id, 'dispatch', {}, dispatcher).expect(200);
    expect(disp.body.status).toBe('DISPATCHED');
    expect(disp.body.dispatchedAt).toBeTruthy();
    expect((await doRow(x.uuid)).status).toBe('DISPATCHED');
    expect((await soStatus(x.soId)).status).toBe('IN_TRANSIT');
    await code409('assign', { vehicleId: v.id, driverId: drv.id });
    await code409('dispatch');
    await code409('complete');
    await code409('attach', { deliveryOrderIds: [(await newDo()).id] });
    // เริ่มวิ่ง (ST4 stop event) — จำลองในฐาน
    const tid = uuid('trip', t.id);
    await db.trip.update({ where: { id: tid }, data: { status: 'IN_PROGRESS' } });
    expect((await act(t.id, 'complete', {}, dispatcher).expect(409)).body.code).toBe(
      'trip_stops_open',
    );
    await db.tripStop.updateMany({ where: { tripId: tid }, data: { status: 'COMPLETED' } });
    expect((await act(t.id, 'complete', {}, planner).expect(403)).body.code).toBe(
      'permission_denied',
    );
    const done = await act(t.id, 'complete', {}, dispatcher).expect(200);
    expect(done.body).toMatchObject({ status: 'COMPLETED' });
    expect(done.body.completedAt).toBeTruthy();
    await code409('cancel', { reason: 'ยกเลิกหลังจบเที่ยวไม่ได้' });
    const hist = await db.docStatusHistory.findMany({
      where: { docType: 'trip', docId: tid },
      orderBy: { at: 'asc' },
    });
    expect(hist.map((h) => h.event)).toEqual(['create', 'assign', 'dispatch', 'complete']);
  });

  it('ยกเลิกเที่ยวที่ปล่อยแล้ว: เหตุผล ≥ 10 + audit · DO กลับ DRAFT ล้าง trip_id · SO กลับใบค้างเดิม (RATE_MISSING) · planner ยกเลิกเที่ยวที่ปล่อยแล้วไม่ได้', async () => {
    const v = await newVehicle();
    const drv = await newDriver();
    const x = await newDo();
    expect((await soStatus(x.soId)).holdReasonCode?.code).toBe('RATE_MISSING');
    const t = (await createTrip([x.id]).expect(201)).body;
    await act(t.id, 'assign', { vehicleId: v.id, driverId: drv.id }).expect(200);
    await act(t.id, 'dispatch').expect(200);
    expect((await act(t.id, 'cancel', { reason: 'สั้น' }).expect(422)).body.code).toBe(
      'validation_failed',
    );
    expect(
      (await act(t.id, 'cancel', { reason: 'ลูกค้ายกเลิกทั้งเที่ยว' }, planner).expect(403)).body
        .code,
    ).toBe('permission_denied');
    const r = await act(t.id, 'cancel', { reason: 'ลูกค้ายกเลิกทั้งเที่ยว' }, dispatcher).expect(
      200,
    );
    expect(r.body).toMatchObject({ status: 'CANCELLED', cancelReason: 'ลูกค้ายกเลิกทั้งเที่ยว' });
    expect(r.body.deliveryOrders).toEqual([]);
    const row = await doRow(x.uuid);
    expect(row).toMatchObject({
      status: 'DRAFT',
      tripId: null,
      tripStopId: null,
      pickupTripStopId: null,
    });
    const so = await soStatus(x.soId);
    expect(so.status).toBe('ON_HOLD');
    expect(so.holdReasonCode?.code).toBe('RATE_MISSING');
    const doHist = await db.docStatusHistory.findMany({
      where: { docType: 'delivery_order', docId: x.uuid },
      orderBy: { at: 'asc' },
    });
    expect(doHist.map((h) => h.event)).toEqual(['create', 'plan', 'dispatch', 'recall']);
    const soHist = await db.docStatusHistory.findMany({
      where: { docType: 'sales_order', docId: x.soId },
      orderBy: { at: 'asc' },
    });
    // recall → unplan → (ประเมินใหม่) hold อยู่ใน transaction เดียวกัน
    expect(soHist.map((h) => h.event)).toEqual(
      expect.arrayContaining(['plan', 'dispatch', 'recall', 'unplan', 'hold']),
    );
    const audit = await db.auditLog.findFirstOrThrow({
      where: { entityId: uuid('trip', t.id), action: 'trip.cancelled' },
    });
    expect(audit.reason).toBe('ลูกค้ายกเลิกทั้งเที่ยว');
    // DO ลงเที่ยวใหม่ได้
    await createTrip([x.id]).expect(201);
  });

  it('ยกเลิกเที่ยวที่มี DO รับของแล้ว (PICKED_UP) → 409 trip_has_loaded_orders ไม่มีอะไรเปลี่ยน', async () => {
    const v = await newVehicle();
    const drv = await newDriver();
    const x = await newDo();
    const y = await newDo();
    const t = (await createTrip([x.id, y.id]).expect(201)).body;
    await act(t.id, 'assign', { vehicleId: v.id, driverId: drv.id }).expect(200);
    await act(t.id, 'dispatch').expect(200);
    await db.deliveryOrder.update({ where: { id: y.uuid }, data: { status: 'PICKED_UP' } });
    expect(
      (await act(t.id, 'cancel', { reason: 'รถเสียกลางทางระหว่างวิ่ง' }).expect(409)).body.code,
    ).toBe('trip_has_loaded_orders');
    expect((await doRow(x.uuid)).status).toBe('DISPATCHED');
    expect((await api(app, admin).get(`/v1/trips/${t.id}`).expect(200)).body.status).toBe(
      'DISPATCHED',
    );
  });

  it('เพิ่ม/ถอด DO: เที่ยว ASSIGNED → DO ใหม่ PLANNED · ถอด → DRAFT + จุดที่ไม่ใช้ removed · SO กลับ', async () => {
    const v = await newVehicle();
    const drv = await newDriver();
    const x = await newDo();
    const t = (await createTrip([x.id]).expect(201)).body;
    const asg = (await act(t.id, 'assign', { vehicleId: v.id, driverId: drv.id }).expect(200)).body;
    const y = await newDo();
    const att = await act(t.id, 'attach', { deliveryOrderIds: [y.id] })
      .set('If-Match', `"${asg.version}"`)
      .expect(200);
    expect(att.body.stops.map((s: { type: string }) => s.type)).toEqual([
      'PICKUP',
      'PICKUP',
      'DELIVERY',
      'DELIVERY',
    ]);
    expect((await doRow(y.uuid)).status).toBe('PLANNED');
    expect((await soStatus(y.soId)).status).toBe('PLANNED');
    expect(
      (await act(t.id, 'attach', { deliveryOrderIds: [y.id] }).expect(422)).body.errors[0].code,
    ).toBe('already_on_trip');
    const det = await act(t.id, 'detach', {
      deliveryOrderIds: [y.id],
      note: 'ย้ายไปคันอื่น',
    }).expect(200);
    expect(det.body.stops.map((s: { sequence: number }) => s.sequence)).toEqual([1, 2]);
    expect(
      await db.tripStop.count({ where: { tripId: uuid('trip', t.id), removedAt: { not: null } } }),
    ).toBe(2);
    expect(await doRow(y.uuid)).toMatchObject({ status: 'DRAFT', tripId: null });
    expect((await soStatus(y.soId)).status).toBe('ON_HOLD');
    expect(
      (await act(t.id, 'detach', { deliveryOrderIds: [y.id] }).expect(422)).body.errors[0].code,
    ).toBe('not_on_trip');
  });

  it('รถร่วม: offer → OFFERED (ผู้เสนอ/เวลา/หมดอายุ 48 ชม.) · assign รถบริษัท → 422 · assign รถของรถร่วมรายนั้น → ASSIGNED (ACCEPTED, snapshot รถร่วม) · ยกเลิกจาก OFFERED ได้', async () => {
    const car = await newCarrier();
    const sub = await newVehicle({ ownership: 'SUBCONTRACT', carrierId: car.id });
    const own = await newVehicle();
    const x = await newDo();
    const t = (await createTrip([x.id]).expect(201)).body;
    const off = await act(t.id, 'offer', { carrierId: car.id }, planner).expect(200);
    expect(off.body).toMatchObject({
      status: 'OFFERED',
      assignmentStatus: 'OFFERED',
      carrier: { id: car.id },
    });
    expect(Date.parse(off.body.offerExpiresAt) - Date.parse(off.body.offeredAt)).toBe(
      48 * 3600_000,
    );
    const row = await db.trip.findUniqueOrThrow({ where: { id: uuid('trip', t.id) } });
    expect(row.offeredBy).toBe('u-planner');
    expect(
      (
        await act(t.id, 'assign', { vehicleId: own.id, driverId: (await newDriver()).id }).expect(
          422,
        )
      ).body.errors[0].code,
    ).toBe('carrier_mismatch');
    const acc = await act(t.id, 'assign', { vehicleId: sub.id }).expect(200);
    expect(acc.body).toMatchObject({
      status: 'ASSIGNED',
      assignmentStatus: 'ACCEPTED',
      carrier: { id: car.id },
      vehicle: { id: sub.id },
      driver: null,
    });
    // เปลี่ยนรถร่วม / สลับเป็นรถบริษัท หลังรับงาน → 409 (ยกเลิกการจ้างเดิมก่อน — ST3-T25)
    const car2 = await newCarrier();
    const sub2 = await newVehicle({ ownership: 'SUBCONTRACT', carrierId: car2.id });
    expect((await act(t.id, 'assign', { vehicleId: sub2.id }).expect(409)).body.code).toBe(
      'carrier_change_requires_cancel',
    );
    expect(
      (
        await act(t.id, 'assign', { vehicleId: own.id, driverId: (await newDriver()).id }).expect(
          409,
        )
      ).body.code,
    ).toBe('carrier_change_requires_cancel');
    // รถคันอื่นของรถร่วมรายเดิม → เปลี่ยนได้ คง ACCEPTED
    const sub1b = await newVehicle({ ownership: 'SUBCONTRACT', carrierId: car.id });
    expect((await act(t.id, 'assign', { vehicleId: sub1b.id }).expect(200)).body).toMatchObject({
      assignmentStatus: 'ACCEPTED',
      vehicle: { id: sub1b.id },
      carrier: { id: car.id },
    });
    // รถร่วมจาก PLANNING ต้อง /offer ก่อน (409 offer_required)
    const z = await newDo();
    const t3 = (await createTrip([z.id]).expect(201)).body;
    expect((await act(t3.id, 'assign', { vehicleId: sub.id }).expect(409)).body.code).toBe(
      'offer_required',
    );
    // เที่ยวว่าง (ถอด DO หมด) → assign/offer 409 trip_empty
    await act(t3.id, 'detach', { deliveryOrderIds: [z.id] }).expect(200);
    expect(
      (
        await act(t3.id, 'assign', { vehicleId: own.id, driverId: (await newDriver()).id }).expect(
          409,
        )
      ).body.code,
    ).toBe('trip_empty');
    expect((await act(t3.id, 'offer', { carrierId: car.id }).expect(409)).body.code).toBe(
      'trip_empty',
    );
    // เที่ยวอื่น: ยกเลิกระหว่างรอรถร่วมตอบ
    const y = await newDo();
    const t2 = (await createTrip([y.id]).expect(201)).body;
    await act(t2.id, 'offer', { carrierId: car.id }).expect(200);
    const c = await act(t2.id, 'cancel', { reason: 'รถร่วมไม่ตอบรับทางโทรศัพท์' }, planner).expect(
      200,
    );
    expect(c.body).toMatchObject({ status: 'CANCELLED', assignmentStatus: null });
    expect((await doRow(y.uuid)).tripId).toBeNull();
  });

  it('พร้อมกัน: สองคนลง DO เดียวกันเข้าคนละเที่ยว → สำเร็จ 1 อีกใบ 409 (ไม่ซ้อน) · จัดรถคันเดียวกันซ้อนวัน → บันทึกได้ + คำเตือน vehicle_overlap', async () => {
    const x = await newDo();
    const rs = await Promise.all([createTrip([x.id]), createTrip([x.id])]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    const win = rs.find((r) => r.status === 201)!.body;
    expect((await doRow(x.uuid)).tripId).toBe(uuid('trip', win.id));
    expect(await db.trip.count({ where: { deliveryOrders: { some: { id: x.uuid } } } })).toBe(1);

    const v = await newVehicle();
    const [d1, d2] = [await newDriver(), await newDriver()];
    const t1 = (await createTrip([(await newDo()).id]).expect(201)).body;
    const t2 = (await createTrip([(await newDo()).id]).expect(201)).body;
    const [a1, a2] = await Promise.all([
      act(t1.id, 'assign', { vehicleId: v.id, driverId: d1.id }),
      act(t2.id, 'assign', { vehicleId: v.id, driverId: d2.id }),
    ]);
    expect([a1.status, a2.status]).toEqual([200, 200]);
    const codes = [...a1.body.warnings, ...a2.body.warnings].map((w: { code: string }) => w.code);
    expect(codes).toContain('vehicle_overlap');
  });

  it('สิทธิ์ + แยก tenant + id อ้างอิงผิด', async () => {
    const x = await newDo();
    expect((await createTrip([x.id], {}, viewer).expect(403)).body.code).toBe('permission_denied');
    const t = (await createTrip([x.id], {}, planner).expect(201)).body;
    await api(app, viewer).get(`/v1/trips/${t.id}`).expect(200);
    const v = await newVehicle();
    const drv = await newDriver();
    await act(t.id, 'assign', { vehicleId: v.id, driverId: drv.id }, planner).expect(200);
    expect((await act(t.id, 'dispatch', {}, planner).expect(403)).body.code).toBe(
      'permission_denied',
    );
    // tenant อื่น: ไม่เห็นเที่ยว (404) และลง DO ของ tenant นี้ไม่ได้ (422)
    await api(app, other).get(`/v1/trips/${t.id}`).expect(404);
    expect((await api(app, other).get('/v1/trips').expect(200)).body.data).toEqual([]);
    const y = await newDo();
    const r = await createTrip([y.id], {}, other).expect(422);
    expect(r.body.errors[0]).toMatchObject({
      field: 'deliveryOrderIds[0]',
      code: 'invalid_reference',
    });
    expect((await createTrip(['bad'], {}).expect(422)).body.code).toBe('validation_failed');
    expect(
      (
        await createTrip([y.id], {
          plannedStartAt: '2026-11-13T10:00:00+07:00',
          plannedEndAt: '2026-11-13T09:00:00+07:00',
        }).expect(422)
      ).body.errors[0].code,
    ).toBe('before_start');
  });

  it('constraint ในฐานข้อมูล: เลขเที่ยวบังคับ, ยกเลิกต้องมีเหตุผล, snapshot คู่ id, ลำดับจุดไม่ซ้ำ, tms_app ลบเที่ยว/จุดไม่ได้', async () => {
    const t = (await createTrip([(await newDo()).id]).expect(201)).body;
    const id = uuid('trip', t.id);
    await expect(
      db.$executeRaw`UPDATE trip SET trip_no = NULL WHERE id = ${id}::uuid`,
    ).rejects.toThrow(/trip_number/);
    await expect(
      db.$executeRaw`UPDATE trip SET status = 'CANCELLED' WHERE id = ${id}::uuid`,
    ).rejects.toThrow(/trip_cancel/);
    await expect(
      db.$executeRaw`UPDATE trip SET driver_id = ${uuid('driver', (await newDriver()).id)}::uuid WHERE id = ${id}::uuid`,
    ).rejects.toThrow(/trip_snapshot/);
    await expect(
      db.$executeRaw`UPDATE trip_stop SET sequence = 1 WHERE trip_id = ${id}::uuid`,
    ).rejects.toThrow(/already exists/);
    // จุดของ DO ต้องเป็นของเที่ยวเดียวกัน (composite FK)
    const t2 = (await createTrip([(await newDo()).id]).expect(201)).body;
    const d1 = t.deliveryOrders[0].id as string;
    await expect(
      db.$executeRaw`UPDATE delivery_order SET trip_stop_id = ${uuid('tripStop', t2.stops[1].id)}::uuid WHERE id = ${uuid('deliveryOrder', d1)}::uuid`,
    ).rejects.toThrow(/delivery_order_drop_stop_same_trip_fkey/);
    const appDb = new PrismaClient({ datasources: { db: { url: process.env.APP_DATABASE_URL } } });
    try {
      await expect(
        appDb.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
          await tx.$executeRaw`DELETE FROM trip_stop WHERE trip_id = ${id}::uuid`;
        }),
      ).rejects.toThrow(/permission denied/);
      await expect(
        appDb.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
          await tx.$executeRaw`DELETE FROM trip WHERE id = ${id}::uuid`;
        }),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await appDb.$disconnect();
    }
  });

  it('M1: สิทธิ์ยกเลิกเที่ยวที่ปล่อยแล้วตรวจหลังล็อก — คำขอที่เห็น ASSIGNED แต่เที่ยวถูกปล่อยก่อนล็อก → 403 ไม่ยกเลิก', async () => {
    const v = await newVehicle();
    const drv = await newDriver();
    const x = await newDo();
    const t = (await createTrip([x.id]).expect(201)).body;
    await act(t.id, 'assign', { vehicleId: v.id, driverId: drv.id }).expect(200);
    const id = uuid('trip', t.id);
    const seen = await run((tx) => app.get(TripService).get(id, tx));
    expect(seen.status).toBe('ASSIGNED'); // planner อ่านได้ ASSIGNED (ผ่านด่าน controller)
    await act(t.id, 'dispatch', {}, dispatcher).expect(200); // ผู้จ่ายงานปล่อยรถก่อน planner ได้ล็อก
    const err = await run((tx) =>
      app.get(TripService).cancel(id, { reason: 'ยกเลิกจากผู้วางแผนที่ช้าไป' }, tx, undefined, {
        canCancelDispatched: false,
      }),
    ).catch((e: { code?: string }) => e);
    expect((err as { code?: string }).code).toBe('permission_denied');
    expect((await api(app, admin).get(`/v1/trips/${t.id}`).expect(200)).body.status).toBe(
      'DISPATCHED',
    );
    expect((await doRow(x.uuid)).status).toBe('DISPATCHED');
  });

  it('ซ้อนเวลาตามช่วงวิ่ง (ข้ามวัน) ไม่ใช่แค่วันเดียวกัน', async () => {
    const v = await newVehicle();
    const [d1, d2] = [await newDriver(), await newDriver()];
    const a = (
      await createTrip([(await newDo()).id], {
        tripDate: '2026-12-01',
        plannedStartAt: '2026-12-01T20:00:00+07:00',
        plannedEndAt: '2026-12-02T06:00:00+07:00',
      }).expect(201)
    ).body;
    const b = (
      await createTrip([(await newDo()).id], {
        tripDate: '2026-12-02',
        plannedStartAt: '2026-12-02T04:00:00+07:00',
        plannedEndAt: '2026-12-02T09:00:00+07:00',
      }).expect(201)
    ).body;
    await act(a.id, 'assign', { vehicleId: v.id, driverId: d1.id }).expect(200);
    const r = await act(b.id, 'assign', { vehicleId: v.id, driverId: d2.id }).expect(200);
    expect(r.body.warnings.map((w: { code: string }) => w.code)).toContain('vehicle_overlap');
  });
});
