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
 * ST3-T18 Send all (docs/04 D2 "checkbox ส่งงานทั้งวันของทุกรถทีเดียว; ปฏิทินขึ้นเขียวเมื่อส่งครบ"; spec/03 §9 PLN-170)
 * เกณฑ์ตรวจรับ: กด Send all แล้วทุก trip ของวันนั้นเป็น DISPATCHED และวันนั้นเป็นสีเขียว (`days[].complete`)
 * + เที่ยวที่ติดกฎ/ไม่มีรถ/รอรถร่วมตอบ ไม่ผ่านพร้อมเหตุผล (ไม่ข้ามเงียบ) · เลือกบางเที่ยว · สิทธิ์ · แยก tenant · audit
 * (ชุดเตรียมข้อมูลเดียวกับ trip-assign-dispatch.test.ts)
 */
describe('trips: send all (ST3-T18)', () => {
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
  let vtTrl: string;
  const today = bangkokToday();
  const addDays = (d: string, n: number) =>
    new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const jur = (n: number) => {
    const base = `0105${String(80_000 + n).padStart(8, '0')}`;
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
    return base + String((11 - (sum % 11)) % 10);
  };
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
    vtTrl = types.find((t) => t.code === 'TRL')!.id;
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

  const audit = (id: string, action: string) =>
    db.auditLog.findMany({ where: { entityId: uuid('trip', id), action } });
  const hist = (id: string) =>
    db.docStatusHistory
      .findMany({ where: { docType: 'trip', docId: uuid('trip', id) }, orderBy: { at: 'asc' } })
      .then((h) => h.map((x) => x.event));
  /** เที่ยว PLANNING 2 DO บนรถที่มีคนขับประจำ วัน `date` */
  const planned = async (date: string) => {
    const v = await newVehicle();
    const d = await newDriver({ defaultVehicleId: v.id });
    const k = await key();
    const a = await newDo(k);
    const b = await newDo(k);
    const t = (await createTrip([a.id, b.id], { vehicleId: v.id, tripDate: date }).expect(201))
      .body;
    return { v, d, a, b, t };
  };
  const sendAll = (body: object, token = dispatcher) =>
    api(app, token).post('/v1/trips/send-all').send(body);
  const board = async (date: string) =>
    (await api(app, admin).get(`/v1/planning/board?date=${date}&days=1`).expect(200)).body as {
      days: { date: string; trips: number; sent: number; complete: boolean }[];
    };
  const sentAudits = () =>
    db.auditLog.findMany({ where: { action: 'trip.sent_all' }, orderBy: { at: 'asc' } });

  it('เกณฑ์ตรวจรับ: Send all → ทุกเที่ยวของวันเป็น DISPATCHED (DO ทุกใบ DISPATCHED) และวันนั้นส่งครบ (เขียว) · วันอื่นไม่ถูกแตะ · audit 1 แถว + event ต่อเที่ยว', async () => {
    const D = addDays(today, 2);
    const p1 = await planned(D); // PLANNING + รถ + คนขับประจำ → จัดรถและปล่อย
    const p2 = await planned(D); // ASSIGNED → ปล่อย
    await act(p2.t.id, 'assign', { vehicleId: p2.v.id }).expect(200);
    const p3 = await planned(D); // ปล่อยแล้ว → ไม่อยู่ในรายการ (ส่งแล้ว)
    await act(p3.t.id, 'assign', { vehicleId: p3.v.id, dispatch: true }).expect(200);
    const gone = await planned(D); // ยกเลิก → ไม่นับ
    await act(gone.t.id, 'cancel', { reason: 'ลูกค้ายกเลิกการส่งทั้งเที่ยว' }).expect(200);
    const other = await planned(addDays(today, 10)); // วันอื่น
    const before = await board(D);
    expect(before.days).toEqual([{ date: D, trips: 3, sent: 1, complete: false }]);

    const r = await sendAll({ date: D }).expect(207);
    expect(r.body).toMatchObject({
      succeeded: 2,
      unchanged: 0,
      failed: 0,
      day: { date: D, trips: 3, sent: 3, complete: true },
    });
    expect(r.body.results.map((x: { tripId: string }) => x.tripId).sort()).toEqual(
      [p1.t.id, p2.t.id].sort(),
    );
    for (const x of r.body.results) expect(x).toMatchObject({ outcome: 'DISPATCHED', status: 200 });
    for (const x of [p1.a, p1.b, p2.a, p2.b])
      expect((await doRow(x.uuid)).status).toBe('DISPATCHED');
    expect((await board(D)).days[0]).toMatchObject({ complete: true, sent: 3 });
    // วันอื่นไม่ถูกแตะ
    expect((await api(app, admin).get(`/v1/trips/${other.t.id}`).expect(200)).body.status).toBe(
      'PLANNING',
    );
    expect((await board(addDays(today, 10))).days[0]).toMatchObject({ complete: false, sent: 0 });
    // audit การส่งทั้งวัน 1 แถว + event trip.dispatched ต่อเที่ยว
    const au = await sentAudits();
    expect(au).toHaveLength(1);
    expect(au[0]!.after).toMatchObject({
      date: D,
      scope: 'ALL',
      requested: 2,
      failed: [],
      dayComplete: true,
    });
    expect(((au[0]!.after as { dispatched: string[] }).dispatched ?? []).sort()).toEqual(
      [p1.t.tripNo, p2.t.tripNo].sort(),
    );
    for (const t of [p1.t, p2.t])
      expect(
        await db.domainEvent.count({
          where: { localId: uuid('trip', t.id), type: 'trip.dispatched' },
        }),
      ).toBe(1);
    // ส่งซ้ำ = ไม่มีอะไรให้ส่ง (ยังเขียว)
    const again = await sendAll({ date: D }).expect(207);
    expect(again.body).toMatchObject({ results: [], succeeded: 0, day: { complete: true } });
  });

  it('เที่ยวที่ส่งไม่ได้ไม่ผ่านพร้อมเหตุผล (ไม่ข้ามเงียบ): ไม่มีรถ 422 · ติดกฎ 409 พร้อม key · รอรถร่วมตอบ 409 — วันยังไม่เขียว · ยกเว้นด้วยเหตุผลแล้วส่งซ้ำได้', async () => {
    const D = addDays(today, 3);
    const ok = await planned(D);
    const noVeh = (await createTrip([(await newDo()).id], { tripDate: D }).expect(201)).body;
    const v6 = await newVehicle();
    await newDriver({ defaultVehicleId: v6.id, licenceExpiresOn: '2020-01-01' });
    const blocked = (
      await createTrip([(await newDo()).id], { vehicleId: v6.id, tripDate: D }).expect(201)
    ).body;
    const offered = (await createTrip([(await newDo()).id], { tripDate: D }).expect(201)).body;
    await act(offered.id, 'offer', {
      carrierId: (await newCarrier()).id,
      cost: '5000.00',
      selectionReason: 'ทดสอบจ้างรถร่วมราคาตกลง',
    }).expect(200);

    const r = await sendAll({ date: D }).expect(207);
    expect(r.body).toMatchObject({
      succeeded: 1,
      failed: 3,
      day: { trips: 4, sent: 1, complete: false },
    });
    const by = new Map(
      (
        r.body.results as {
          tripId: string;
          tripNo: string | null;
          status: number;
          problem: { code: string; blocks?: { key: string }[] } | null;
        }[]
      ).map((x) => [x.tripId, x]),
    );
    expect(by.get(ok.t.id)!.status).toBe(200);
    expect(by.get(noVeh.id)).toMatchObject({ status: 422, tripNo: noVeh.tripNo });
    expect(by.get(blocked.id)).toMatchObject({
      status: 409,
      problem: { code: 'assignment_blocked' },
    });
    expect(by.get(offered.id)).toMatchObject({
      status: 409,
      problem: {
        code: 'invalid_state_transition',
        from: 'OFFERED',
        detail: 'รอรถร่วมตอบรับ — ส่งได้หลังรถร่วมรับงาน',
      },
    });
    expect((await board(D)).days[0]!.complete).toBe(false);
    const au = (await sentAudits()).at(-1)!;
    expect((au.after as { failed: { tripNo: string; code: string }[] }).failed).toEqual(
      expect.arrayContaining([
        { tripNo: noVeh.tripNo, code: 'validation_failed' },
        { tripNo: blocked.tripNo, code: 'assignment_blocked' },
        { tripNo: offered.tripNo, code: 'invalid_state_transition' },
      ]),
    );
    // ยกเว้นบล็อก (ผู้จัดการ/ผู้ดูแล) ด้วย key จากผล + เหตุผล → ส่งได้ และเหตุผลอยู่ใน audit
    const fix = await sendAll(
      {
        date: D,
        items: [
          { tripId: blocked.id, ruleKeys: by.get(blocked.id)!.problem!.blocks!.map((b) => b.key) },
        ],
        overrideReason: 'ผู้จัดการอนุมัติ ใบขับขี่กำลังต่ออายุ',
      },
      admin,
    ).expect(207);
    expect(fix.body.results[0]).toMatchObject({ status: 200, outcome: 'DISPATCHED' });
    expect(fix.body.day).toMatchObject({ trips: 4, sent: 2, complete: false });
    const au2 = (await sentAudits()).at(-1)!;
    expect(au2).toMatchObject({ reason: 'ผู้จัดการอนุมัติ ใบขับขี่กำลังต่ออายุ' });
    expect(au2.after).toMatchObject({ scope: 'SELECTED', requested: 1 });
  });

  it('เลือกบางเที่ยว: version ไม่ตรง → 412 ต่อรายการ · เที่ยววันอื่น → 422 not_on_date · ซ้ำ/วันไม่จริง → 422 · สิทธิ์ (planner/viewer 403) · บริษัทอื่น 404 ต่อรายการ', async () => {
    const D = addDays(today, 4);
    const a = await planned(D);
    const b = await planned(D);
    const x = await planned(addDays(D, 1));
    for (const tok of [planner, viewer]) expect((await sendAll({ date: D }, tok)).status).toBe(403);
    expect((await sendAll({ date: '2026-02-30' })).body).toMatchObject({
      status: 422,
      errors: [{ field: 'date', code: 'invalid_date' }],
    });
    expect(
      (await sendAll({ date: D, items: [{ tripId: a.t.id }, { tripId: a.t.id }] })).status,
    ).toBe(422);
    const off = await sendAll({ date: D, items: [{ tripId: a.t.id }, { tripId: x.t.id }] });
    expect(off.status).toBe(422);
    expect(off.body.errors).toEqual([
      expect.objectContaining({ field: 'items[1].tripId', code: 'not_on_date' }),
    ]);
    // บริษัทอื่น: เห็นเป็น 404 ต่อรายการ · ส่งทั้งวัน = ไม่มีเที่ยวของตัวเอง
    const xo = await sendAll({ date: D, items: [{ tripId: a.t.id }] }, other).expect(207);
    expect(xo.body.results[0]).toMatchObject({ status: 404, problem: { code: 'not_found' } });
    const xd = await sendAll({ date: D }, other).expect(207);
    expect(xd.body).toMatchObject({ results: [], day: { trips: 0, complete: false } });
    expect((await api(app, admin).get(`/v1/trips/${a.t.id}`).expect(200)).body.status).toBe(
      'PLANNING',
    );
    // เลือกเฉพาะ a (version เก่า → 412) + b (ปล่อย)
    const r = await sendAll({
      date: D,
      items: [
        { tripId: a.t.id, version: a.t.version + 3 },
        { tripId: b.t.id, version: b.t.version },
      ],
    }).expect(207);
    expect(r.body.results.map((i: { status: number }) => i.status)).toEqual([412, 200]);
    expect(r.body.day).toMatchObject({ trips: 2, sent: 1, complete: false });
    expect((await api(app, admin).get(`/v1/trips/${a.t.id}`).expect(200)).body.status).toBe(
      'PLANNING',
    );
  });

  it('เที่ยวที่ส่งแล้ว = UNCHANGED (ตรวจก่อน version) ไม่ใช่ 409 · dryRun ตรวจล่วงหน้า: ผลที่คาดตรงกับกฎ T14 แต่ไม่เปลี่ยนข้อมูล/ไม่ลง audit/event', async () => {
    const D = addDays(today, 6);
    const sent = await planned(D);
    const d1 = await act(sent.t.id, 'assign', { vehicleId: sent.v.id, dispatch: true }).expect(200);
    const p = await planned(D);
    const v6 = await newVehicle();
    await newDriver({ defaultVehicleId: v6.id, licenceExpiresOn: '2020-01-01' });
    const blocked = (
      await createTrip([(await newDo()).id], { vehicleId: v6.id, tripDate: D }).expect(201)
    ).body;
    const audits = (await sentAudits()).length;

    const dry = await sendAll({
      date: D,
      dryRun: true,
      items: [{ tripId: p.t.id, version: p.t.version }, { tripId: blocked.id }],
    }).expect(207);
    expect(dry.body.results.map((x: { outcome: string }) => x.outcome)).toEqual([
      'DISPATCHED',
      'FAILED',
    ]);
    expect(dry.body.results[1].problem.code).toBe('assignment_blocked');
    expect(dry.body.day).toMatchObject({ trips: 3, sent: 1, complete: false });
    const still = (await api(app, admin).get(`/v1/trips/${p.t.id}`).expect(200)).body;
    expect(still).toMatchObject({ status: 'PLANNING', version: p.t.version, driver: null });
    expect((await doRow(p.a.uuid)).status).toBe('DRAFT');
    expect((await sentAudits()).length).toBe(audits);
    expect(
      await db.domainEvent.count({
        where: { localId: uuid('trip', p.t.id), type: { not: 'trip.created' } },
      }),
    ).toBe(0);

    // ส่งจริง: เที่ยวที่ส่งแล้ว (version เก่า) = UNCHANGED 200 · นับเป็นส่งแล้ว
    const r = await sendAll({
      date: D,
      items: [
        { tripId: sent.t.id, version: d1.body.version - 1 },
        { tripId: p.t.id, version: p.t.version },
      ],
    }).expect(207);
    expect(
      r.body.results.map((x: { status: number; outcome: string }) => [x.status, x.outcome]),
    ).toEqual([
      [200, 'UNCHANGED'],
      [200, 'DISPATCHED'],
    ]);
    expect(r.body).toMatchObject({ succeeded: 1, unchanged: 1, failed: 0 });
    expect(r.body.day).toMatchObject({ trips: 3, sent: 2 });
    expect((await sentAudits()).at(-1)!.after).toMatchObject({ alreadySent: [sent.t.tripNo] });
  });
});
