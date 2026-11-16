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
 * ST3-T17 ปุ่ม Assign แยกจาก Assign & dispatch + bulk (docs/04 D2; spec/03 PLN-047/048) — เกณฑ์ตรวจรับ:
 * Assign แล้วสถานะ ASSIGNED ยังไม่ส่งงาน · Dispatch แล้ว DO ทุกใบในเที่ยวเป็น DISPATCHED
 * + จัดรถและปล่อยในคำขอเดียว (atomic) · เปลี่ยนรถของเที่ยว ASSIGNED ผ่านกระดาน (reassign) · bulk ผลต่อรายการ
 *
 * (ชุดเตรียมข้อมูลเดียวกับ trips.test.ts — ST3-T11 เที่ยวรถ (trip + trip_stop): สร้างจาก DO, จุดแวะ, snapshot รถ/คนขับต่อเที่ยว (เกณฑ์ตรวจรับ: เปลี่ยนคนขับประจำ
 * หลังสร้างเที่ยวแล้วเที่ยวเดิมไม่เปลี่ยน), state machine + action API (transition ผิด → 409), ยกเลิกปล่อย DO/SO,
 * หลาย SO ลูกค้าเดียวในเที่ยวเดียว, เพิ่ม/ถอด DO, รถร่วม (offer → assign), พร้อมกัน, สิทธิ์, แยก tenant, constraint
 */
describe('trips: assign / dispatch / bulk (ST3-T17)', () => {
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
    lines: [{ description: 'ปูนซีเมนต์', qty: '2', unitId: unitTon, weightKg: '2000' }],
  });
  /** SO ใหม่ → DO (public id) + uuid SO */
  const newDo = async (k?: Key, tid = tenantId, window?: [string, string]) => {
    const kk = k ?? (await key());
    const { order: so } = await upsert(order(kk, window), tid);
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
  const createTrip = (deliveryOrderIds: string[], extra: object = {}, token = admin) =>
    api(app, token)
      .post('/v1/trips')
      .send({ tripDate: today, deliveryOrderIds, ...extra });
  const act = (id: string, verb: string, body: object = {}, token = admin) =>
    api(app, token).post(`/v1/trips/${id}/${verb}`).send(body);

  const audit = (id: string, action: string) =>
    db.auditLog.findMany({ where: { entityId: uuid('trip', id), action } });
  const hist = (id: string) =>
    db.docStatusHistory
      .findMany({ where: { docType: 'trip', docId: uuid('trip', id) }, orderBy: { at: 'asc' } })
      .then((h) => h.map((x) => x.event));
  /** เที่ยว PLANNING 2 DO บนรถที่มีคนขับประจำ */
  const planned = async () => {
    const v = await newVehicle();
    const d = await newDriver({ defaultVehicleId: v.id });
    const k = await key();
    const a = await newDo(k);
    const b = await newDo(k);
    const t = (await createTrip([a.id, b.id], { vehicleId: v.id }).expect(201)).body;
    return { v, d, a, b, t };
  };

  it('เกณฑ์ตรวจรับ: Assign → ASSIGNED ยังไม่ส่งงาน (DO PLANNED, ไม่มี dispatchedAt) · Dispatch → DO ทุกใบ DISPATCHED + SO IN_TRANSIT', async () => {
    const { v, d, a, b, t } = await planned();
    expect(t.status).toBe('PLANNING');
    const r = await act(t.id, 'assign', { vehicleId: v.id }).set('If-Match', `"${t.version}"`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'ASSIGNED', dispatchedAt: null, driver: { id: d.id } });
    expect(r.body.deliveryOrders.map((x: { status: string }) => x.status)).toEqual([
      'PLANNED',
      'PLANNED',
    ]);
    expect((await doRow(a.uuid)).status).toBe('PLANNED');
    expect((await soStatus(a.soId)).status).toBe('PLANNED');
    const disp = await act(t.id, 'dispatch', {}, dispatcher)
      .set('If-Match', `"${r.body.version}"`)
      .expect(200);
    expect(disp.body.status).toBe('DISPATCHED');
    expect(disp.body.dispatchedAt).toBeTruthy();
    for (const x of [a, b]) {
      expect((await doRow(x.uuid)).status).toBe('DISPATCHED');
      expect((await soStatus(x.soId)).status).toBe('IN_TRANSIT');
    }
    expect(await hist(t.id)).toEqual(['create', 'assign', 'dispatch']);
    expect(await audit(t.id, 'trip.dispatched')).toHaveLength(1);
    const ev = await db.domainEvent.findMany({
      where: { localId: uuid('trip', t.id), type: 'trip.dispatched' },
    });
    expect(ev).toHaveLength(1);
  });

  it('Assign & dispatch ในคำขอเดียว: DISPATCHED + DO ทุกใบ DISPATCHED · ต้องมี trips:dispatch (planner 403 ไม่มีอะไรเปลี่ยน) · คำเตือนค้าง → 409 ทั้งคำขอย้อน', async () => {
    const { v, a, b, t } = await planned();
    // planner มี trips:assign แต่ไม่มี trips:dispatch
    const denied = await act(t.id, 'assign', { vehicleId: v.id, dispatch: true }, planner);
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ code: 'permission_denied', required: ['trips:dispatch'] });
    expect((await api(app, admin).get(`/v1/trips/${t.id}`).expect(200)).body.status).toBe(
      'PLANNING',
    );
    const r = await act(t.id, 'assign', { vehicleId: v.id, dispatch: true }, dispatcher)
      .set('If-Match', `"${t.version}"`)
      .expect(200);
    expect(r.body).toMatchObject({ status: 'DISPATCHED' });
    expect(r.body.assignedAt).toBeTruthy();
    expect(r.body.dispatchedAt).toBeTruthy();
    for (const x of [a, b]) expect((await doRow(x.uuid)).status).toBe('DISPATCHED');
    expect(await hist(t.id)).toEqual(['create', 'assign', 'dispatch']);

    // คำเตือนค้าง (น้ำหนักเกิน) → 409 assignment_warnings และเที่ยว/DO ไม่เปลี่ยน (atomic)
    const v2 = await newVehicle();
    await newDriver({ defaultVehicleId: v2.id });
    const k = await key();
    const heavy = await upsert({
      ...order(k),
      lines: [{ description: 'เหล็ก', qty: '20', unitId: unitTon, weightKg: '20000' }],
    });
    const [hd] = await run((tx) =>
      app.get(DeliveryOrderService).listForOrder(heavy.order.id, {}, tx),
    );
    const hid = encodeId('deliveryOrder', hd!.id);
    const t2 = (await createTrip([hid], { vehicleId: v2.id }).expect(201)).body;
    const w = await act(t2.id, 'assign', { vehicleId: v2.id, dispatch: true }, dispatcher);
    expect(w.status).toBe(409);
    expect(w.body.code).toBe('assignment_warnings');
    const still = (await api(app, admin).get(`/v1/trips/${t2.id}`).expect(200)).body;
    expect(still).toMatchObject({ status: 'PLANNING', driver: null, version: t2.version });
    expect((await doRow(hd!.id)).status).toBe('DRAFT');
    const ok = await act(
      t2.id,
      'assign',
      {
        vehicleId: v2.id,
        dispatch: true,
        ruleKeys: w.body.warnings.map((x: { key: string }) => x.key),
        overrideReason: 'ลูกค้ายืนยันแยกส่งไม่ได้',
      },
      dispatcher,
    ).expect(200);
    expect(ok.body.status).toBe('DISPATCHED');
    expect((await doRow(hd!.id)).status).toBe('DISPATCHED');
    expect(await audit(t2.id, 'trip.rules_overridden')).toHaveLength(1);
  });

  it('เปลี่ยนรถของเที่ยว ASSIGNED ผ่าน /schedule = จัดรถใหม่ในคำขอเดียว (คนขับประจำรถใหม่, คนขับสำรองคงไว้, หางล้าง) · ถอดรถ → 409 · รถไม่มีคนขับประจำ → 422', async () => {
    const { v, t } = await planned();
    const relief = await newDriver();
    const asg = await act(t.id, 'assign', { vehicleId: v.id, reliefDriverId: relief.id }).expect(
      200,
    );
    const v2 = await newVehicle();
    const d2 = await newDriver({ defaultVehicleId: v2.id });
    // ถอดรถของเที่ยวที่จัดแล้ว — docs/01 §4.2 ไม่มี ASSIGNED → PLANNING
    const un = await act(t.id, 'schedule', { vehicleId: null });
    expect(un.status).toBe(409);
    expect(un.body).toMatchObject({ code: 'invalid_state_transition', event: 'unassign' });
    // รถที่ไม่มีคนขับประจำ → 422 driverId (ไม่มีอะไรเปลี่ยน)
    const lone = await newVehicle();
    const nd = await act(t.id, 'schedule', { vehicleId: lone.id });
    expect(nd.status).toBe(422);
    expect(nd.body.errors[0]).toMatchObject({ field: 'driverId', code: 'required' });
    const mv = await act(t.id, 'schedule', { vehicleId: v2.id })
      .set('If-Match', `"${asg.body.version}"`)
      .expect(200);
    expect(mv.body).toMatchObject({
      status: 'ASSIGNED',
      vehicle: { id: v2.id, plate: v2.plate },
      driver: { id: d2.id },
      reliefDriver: { id: relief.id },
      trailer: null,
    });
    expect(await hist(t.id)).toEqual(['create', 'assign', 'reassign']);
    expect(await audit(t.id, 'trip.reassigned')).toHaveLength(1);
    expect(await audit(t.id, 'trip.rescheduled')).toHaveLength(1);
    // คนขับสำรองเป็นคนขับประจำของรถใหม่ → ล้างคนขับสำรอง (ไม่ให้ซ้ำคนขับหลัก)
    const v3 = await newVehicle();
    const cur = (await api(app, admin).get(`/v1/drivers/${relief.id}`).expect(200)).body;
    await api(app, admin)
      .patch(`/v1/drivers/${relief.id}`)
      .set('If-Match', `"${cur.version}"`)
      .send({ defaultVehicleId: v3.id })
      .expect(200);
    const mv2 = await act(t.id, 'schedule', { vehicleId: v3.id }).expect(200);
    expect(mv2.body).toMatchObject({ driver: { id: relief.id }, reliefDriver: null });
    // หลังปล่อยรถ เปลี่ยนรถไม่ได้
    await act(t.id, 'dispatch', {}, dispatcher).expect(200);
    expect((await act(t.id, 'schedule', { vehicleId: v.id })).status).toBe(409);
  });

  it('bulk: ผลต่อรายการ (207) — สำเร็จบางรายการ ไม่ใช่ all-or-nothing · 409 กฎพร้อม key · 412/404/422 ต่อรายการ · สิทธิ์ · รายการซ้ำ', async () => {
    const p1 = await planned(); // PLANNING + รถ + คนขับประจำ → จัดรถและปล่อย
    const p2 = await planned(); // ASSIGNED → ปล่อยอย่างเดียว
    await act(p2.t.id, 'assign', { vehicleId: p2.v.id }).expect(200);
    const noVeh = (await createTrip([(await newDo()).id]).expect(201)).body; // ไม่มีรถ → 422
    const p4 = await planned(); // version เก่า → 412
    const p5 = await planned(); // ปล่อยแล้ว → 409
    await act(p5.t.id, 'assign', { vehicleId: p5.v.id, dispatch: true }).expect(200);
    // คำเตือนค้าง (คนขับประจำใบขับขี่หมดอายุ = บล็อก) → 409 assignment_blocked พร้อม key
    const v6 = await newVehicle();
    await newDriver({ defaultVehicleId: v6.id, licenceExpiresOn: '2020-01-01' });
    const t6 = (await createTrip([(await newDo()).id], { vehicleId: v6.id }).expect(201)).body;
    const items = [
      { tripId: p1.t.id, version: p1.t.version },
      { tripId: p2.t.id },
      { tripId: noVeh.id },
      { tripId: p4.t.id, version: p4.t.version + 5 },
      { tripId: p5.t.id },
      { tripId: t6.id },
    ];
    expect(
      (await api(app, planner).post('/v1/trips/bulk-assign').send({ items, dispatch: true }))
        .status,
    ).toBe(403);
    const dup = await api(app, dispatcher)
      .post('/v1/trips/bulk-assign')
      .send({ items: [{ tripId: p1.t.id }, { tripId: p1.t.id }] });
    expect(dup.status).toBe(422);
    const r = await api(app, dispatcher)
      .post('/v1/trips/bulk-assign')
      .send({ items, dispatch: true })
      .expect(207);
    expect(r.body).toMatchObject({ succeeded: 2, failed: 4 });
    const by = r.body.results as {
      tripId: string;
      status: number;
      trip: { status: string } | null;
      problem: { code: string; blocks?: { key: string }[]; errors?: { field: string }[] } | null;
    }[];
    expect(by.map((x) => x.tripId)).toEqual(items.map((i) => i.tripId));
    expect(by.map((x) => x.status)).toEqual([200, 200, 422, 412, 409, 409]);
    expect(by[0]!.trip!.status).toBe('DISPATCHED');
    expect(by[1]!.trip!.status).toBe('DISPATCHED');
    expect(by[2]!.problem!.errors![0]!.field).toBe('vehicleId');
    expect(by[4]!.problem!.code).toBe('invalid_state_transition');
    expect(by[5]!.problem!.code).toBe('assignment_blocked');
    expect(by[5]!.problem!.blocks!.length).toBeGreaterThan(0);
    for (const x of [p1.a, p1.b, p2.a]) expect((await doRow(x.uuid)).status).toBe('DISPATCHED');
    // รายการที่ไม่ผ่านย้อนเฉพาะของตัวเอง (บล็อกหลังจัดรถ → ไม่จัดรถ)
    const t6now = (await api(app, admin).get(`/v1/trips/${t6.id}`).expect(200)).body;
    expect(t6now).toMatchObject({ status: 'PLANNING', driver: null });
    expect((await api(app, admin).get(`/v1/trips/${p4.t.id}`).expect(200)).body.status).toBe(
      'PLANNING',
    );
    // บริษัทอื่นเห็นเป็น 404 ต่อรายการ (ไม่เปลี่ยน)
    const x = await api(app, other)
      .post('/v1/trips/bulk-assign')
      .send({ items: [{ tripId: p4.t.id }] })
      .expect(207);
    expect(x.body.results[0]).toMatchObject({ status: 404, problem: { code: 'not_found' } });
    expect((await api(app, admin).get(`/v1/trips/${p4.t.id}`).expect(200)).body.status).toBe(
      'PLANNING',
    );
    // ยกเว้นบล็อก (ผู้มี trips:override) ด้วย key จากผลรายการ
    const ovr = await api(app, admin)
      .post('/v1/trips/bulk-assign')
      .send({
        items: [{ tripId: t6.id, ruleKeys: by[5]!.problem!.blocks!.map((b) => b.key) }],
        overrideReason: 'ผู้จัดการอนุมัติ ใบขับขี่กำลังต่ออายุ',
      })
      .expect(207);
    expect(ovr.body.results[0]).toMatchObject({ status: 200, trip: { status: 'ASSIGNED' } });
    // ไม่ dispatch: เที่ยว ASSIGNED อยู่แล้ว = สำเร็จ ไม่เปลี่ยน version
    const same = await api(app, planner)
      .post('/v1/trips/bulk-assign')
      .send({ items: [{ tripId: t6.id }] })
      .expect(207);
    expect(same.body.results[0].trip.version).toBe(ovr.body.results[0].trip.version);
  });
});
