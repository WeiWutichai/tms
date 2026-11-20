import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SYSTEM_ROLES } from '@tms/domain';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Clock } from '../src/common/clock';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { requestContext } from '../src/common/request-context';
import { DbService, type Tx } from '../src/db/db.service';
import { resetPublicRateLimit } from '../src/http/public-rate-limit.middleware';
import { DeliveryOrderService } from '../src/modules/delivery-orders/delivery-order.service';
import {
  OrderIntakeService,
  type UpsertOrderInput,
} from '../src/modules/orders/order-intake.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { bangkokToday } from '../src/modules/vehicle-documents/expiry';
import {
  api,
  bootApp,
  platform,
  settleTripCostsForTest,
  tokenFor,
  truncateAll,
  validTaxId,
} from './helpers';

/**
 * ST3-T25 เปลี่ยนผู้รับเหมา (docs/04 D3 "เปลี่ยน carrier — ยกเลิกการจ้างเดิมแล้วจ้างใหม่ (ประวัติคงอยู่)", plan/11 #13)
 * เกณฑ์ตรวจรับ: เปลี่ยน carrier แล้ว history มีทั้งรายเดิม (ยกเลิก) และรายใหม่; `trip_cost` เดิมถูกกลับรายการ
 */
describe('subcon change carrier (ST3-T25)', () => {
  let app: NestExpressApplication;
  let clock: Clock;
  const db = platform();
  let tenantId: string;
  let tenantB: string;
  let admin: string;
  let dispatcherId: string;
  let dispatcher: string;
  let viewerId: string;
  let seed = 0;
  let unitTon: string;
  let vt6: string;
  const today = bangkokToday();
  const day = (n: number) =>
    new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const uuid = (kind: Parameters<typeof tryDecodeId>[0], id: string) => tryDecodeId(kind, id)!;
  const ADDR = { line1: '99/9', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };
  const jur = (n: number) => {
    const base = `0105${String(70_000 + n).padStart(8, '0')}`;
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
    return base + String((11 - (sum % 11)) % 10);
  };

  async function member(tid: string, role: string) {
    const r = await db.role.findFirstOrThrow({ where: { tenantId: tid, code: role } });
    const u = await db.appUser.create({
      data: {
        tenantId: tid,
        email: `${role}-${++seed}@change.test`,
        name: `${role} ${seed}`,
        status: 'ACTIVE',
        locale: 'th',
      },
    });
    await db.userRole.create({ data: { tenantId: tid, userId: u.id, roleId: r.id } });
    return u.id;
  }

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    clock = app.get(Clock);
    tenantId = (await createTenantWithDefaults(db, { name: 'ศรีไทยขนส่ง' })).id;
    tenantB = (await createTenantWithDefaults(db, { name: 'บริษัทอื่น' })).id;
    const c = await db.company.create({
      data: { tenantId, legalName: 'บริษัท ศรีไทยขนส่ง จำกัด', taxId: validTaxId(911) },
    });
    await db.branch.create({
      data: {
        tenantId,
        companyId: c.id,
        branchCode: '00000',
        branchLabel: 'สำนักงานใหญ่',
        address: ADDR,
        isDefaultIssuer: true,
      },
    });
    admin = await tokenFor(tenantId);
    dispatcherId = await member(tenantId, 'dispatcher');
    viewerId = await member(tenantId, 'viewer');
    await member(tenantB, 'dispatcher');
    dispatcher = await tokenFor(
      tenantId,
      SYSTEM_ROLES.dispatcher.permissions.join(' '),
      dispatcherId,
    );
    const us = (await api(app, admin).get('/v1/units?limit=50').expect(200)).body.data as {
      id: string;
      code: string;
    }[];
    unitTon = uuid('unit', us.find((u) => u.code === 'TON')!.id);
    const types = (await api(app, admin).get('/v1/vehicle-types?limit=50').expect(200)).body
      .data as { id: string; code: string }[];
    vt6 = types.find((t) => t.code === '6W')!.id;
  });
  beforeEach(() => resetPublicRateLimit());
  afterEach(() => clock.set(null));
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  const pub = () => request(app.getHttpServer());
  const run = <T>(fn: (tx: Tx) => Promise<T>) =>
    app
      .get(DbService)
      .withTenant(tenantId, (tx) =>
        requestContext.run(
          { requestId: randomUUID(), tenantId, actorId: 'user-test', locale: 'th', tx },
          () => fn(tx),
        ),
      );
  const newSite = async (name: string) =>
    (
      await api(app, admin)
        .post('/v1/customer-sites')
        .send({ name: `${name} ${++seed}`, kind: 'DROPOFF', address: ADDR })
        .expect(201)
    ).body.id as string;
  /** รถร่วม + รถ 6 ล้อที่เอกสารบังคับครบ (จ้างได้จริง — นับในการเทียบถูกสุด) */
  const newCarrier = async () => {
    const C = (
      await api(app, admin)
        .post('/v1/carriers')
        .send({
          legalName: `หจก. รถร่วมเปลี่ยนราย ${++seed}`,
          entityType: 'JURISTIC',
          taxId: jur(seed),
          phone: '0812345678',
        })
        .expect(201)
    ).body as { id: string; legalName: string };
    const plate = `75-${String(5000 + ++seed)}`;
    const v = (
      await api(app, admin)
        .post('/v1/vehicles')
        .send({
          plate,
          plateProvince: 'TH-20',
          vehicleTypeId: vt6,
          ownership: 'SUBCONTRACT',
          carrierId: C.id,
        })
        .expect(201)
    ).body as { id: string };
    for (const docType of ['INSURANCE', 'COMPULSORY_ACT'] as const)
      await db.vehicleDocument.create({
        data: {
          tenantId,
          vehicleId: uuid('vehicle', v.id),
          docType,
          startsOn: new Date(`${day(-200)}T00:00:00Z`),
          expiresOn: new Date(`${day(200)}T00:00:00Z`),
          isRequiredForDispatch: true,
        },
      });
    const phone = `08${String(20_000_000 + ++seed).slice(-8)}`;
    await api(app, admin)
      .post('/v1/drivers')
      .send({
        name: `สมศักดิ์ ขับดี ${seed}`,
        phone,
        employmentType: 'CARRIER_DRIVER',
        carrierId: C.id,
        licenceClass: 'T2',
        licenceExpiresOn: day(300),
      })
      .expect(201);
    return { ...C, plate, phone };
  };
  const buyRate = async (carrierId: string, a: string, b: string, rate: string) => {
    const r = await api(app, admin)
      .post('/v1/rate-cards')
      .send({
        side: 'BUY',
        carrierId,
        originId: a,
        destinationId: b,
        vehicleTypeId: vt6,
        pricingModel: 'PER_TRIP',
        buyRate: rate,
        validFrom: today,
      })
      .expect(201);
    await api(app, admin)
      .post(`/v1/rate-cards/${r.body.id}/approve`)
      .send({ reason: 'อนุมัติตามราคาที่ตกลง' })
      .expect(200);
  };
  const newTrip = async () => {
    const [a, b] = [await newSite('คลังบางปู'), await newSite('ท่าเรือแหลมฉบัง')];
    const cust = (
      await api(app, admin)
        .post('/v1/customers')
        .send({ legalName: `บจก. ลูกค้าเปลี่ยนราย ${++seed}`, taxId: validTaxId(8000 + seed) })
        .expect(201)
    ).body.id as string;
    const input: UpsertOrderInput = {
      source: 'MANUAL',
      customer: { id: uuid('customer', cust) },
      requestedDate: today,
      vehicleTypeId: uuid('vehicleType', vt6),
      stops: [
        { type: 'PICKUP', siteId: uuid('site', a) },
        { type: 'DELIVERY', siteId: uuid('site', b) },
      ],
      lines: [{ description: 'ปูนซีเมนต์', qty: '5', unitId: unitTon, weightKg: '8600' }],
    };
    const { order: so } = await run((tx) => app.get(OrderIntakeService).upsertOrder(input, tx));
    const [d] = await run((tx) => app.get(DeliveryOrderService).listForOrder(so.id, {}, tx));
    const t = (
      await api(app, admin)
        .post('/v1/trips')
        .send({ tripDate: today, deliveryOrderIds: [encodeId('deliveryOrder', d!.id)] })
        .expect(201)
    ).body as { id: string; tripNo: string; version: number };
    return { ...t, soId: so.id, a, b };
  };
  /** ผู้จ่ายงานจ้างรถร่วม (ราคากรอกเอง + เหตุผล) → OFFERED + ลิงก์ */
  const hire = async (tripId: string, carrierId: string, token = dispatcher) => {
    await api(app, token)
      .post(`/v1/trips/${tripId}/offer`)
      .send({ carrierId, cost: '5600', selectionReason: 'ตกลงราคาทางโทรศัพท์แล้ว' })
      .expect(200);
    const l = (await api(app, admin).get(`/v1/trips/${tripId}/offer-link`).expect(200)).body
      .link as { url: string; offerId: string };
    const offer = await db.subconOffer.findUniqueOrThrow({
      where: { id: uuid('subconOffer', l.offerId) },
    });
    return { offer, token: new URL(l.url).pathname.split('/').pop()! };
  };
  const offered = async () => {
    const C = await newCarrier();
    const t = await newTrip();
    return { C, t, ...(await hire(t.id, C.id)) };
  };
  const trip = (id: string) => api(app, admin).get(`/v1/trips/${id}`).expect(200);
  const so = (id: string) =>
    db.salesOrder.findUniqueOrThrow({
      where: { id },
      include: { holdReasonCode: { select: { code: true } } },
    });

  const costs = async (tripId: string) =>
    (
      await db.tripCost.findMany({
        where: { tripId: uuid('trip', tripId) },
        orderBy: [{ createdAt: 'asc' }, { amount: 'desc' }],
      })
    ).map((c) => c.amount.toFixed(2));
  const history = async (tripId: string) =>
    (await api(app, admin).get(`/v1/trips/${tripId}/offers`).expect(200)).body.data as {
      carrierId: string;
      status: string;
      closedReason: string | null;
      acceptedPlate: string | null;
    }[];
  const change = (tripId: string, version: number, body: object, token = dispatcher) =>
    api(app, token).post(`/v1/trips/${tripId}/offer`).set('If-Match', `"${version}"`).send(body);
  const REASON = 'รถของผู้รับเหมาเดิมเสียก่อนเข้ารับสินค้า';

  it('เกณฑ์ตรวจรับ (รอตอบ): เปลี่ยนได้ทันทีไม่ต้องรอครบ N ชม. → ประวัติมีรายเดิม (ยกเลิก) + รายใหม่ · ค่าจ้างเดิมกลับรายการ · ลิงก์เดิมใช้ไม่ได้', async () => {
    const A = await newCarrier();
    const B = await newCarrier();
    const t = await newTrip();
    const a = await hire(t.id, A.id);
    // ตัวเลือกสำหรับเปลี่ยน: ไม่มีรายเดิม
    const opts = (
      await api(app, admin).get(`/v1/trips/${t.id}/hire-options?change=true`).expect(200)
    ).body.options as { carrier: { id: string } }[];
    expect(opts.some((o) => o.carrier.id === A.id)).toBe(false);
    expect(opts.some((o) => o.carrier.id === B.id)).toBe(true);
    const v = (await trip(t.id)).body.version as number;
    const r = await change(t.id, v, {
      carrierId: B.id,
      cost: '5900',
      selectionReason: 'ตกลงราคาทางโทรศัพท์แล้ว',
      changeReason: REASON,
    }).expect(200);
    expect(r.body).toMatchObject({ status: 'OFFERED', carrier: { id: B.id } });
    expect(r.headers.etag).toBe(`"${r.body.version}"`);
    const h = await history(t.id);
    expect(h.map((x) => [x.carrierId, x.status])).toEqual([
      [B.id, 'OFFERED'],
      [A.id, 'WITHDRAWN'],
    ]);
    expect(h[1]!.closedReason).toBe(`เปลี่ยนผู้รับเหมา (${A.legalName}): ${REASON}`);
    expect(await costs(t.id)).toEqual(['5600.00', '-5600.00', '5900.00']);
    await pub().get(`/v1/public/offers/${a.token}`).expect(404);
    expect((await so(t.soId)).status).toBe('PLANNED');
    expect(
      await db.docStatusHistory.count({ where: { docId: uuid('trip', t.id), event: 'withdraw' } }),
    ).toBe(1);
    const au = await db.auditLog.findFirstOrThrow({
      where: { action: 'subcon_offer.cancelled', entityId: uuid('trip', t.id) },
    });
    expect(au.reason).toBe(`เปลี่ยนผู้รับเหมา (${A.legalName}): ${REASON}`);
    expect(au.after).toMatchObject({ cause: 'CARRIER_CHANGED', reversedCarrierFees: 1 });
    const off = await db.auditLog.findFirstOrThrow({
      where: { action: 'trip.offered', entityId: uuid('trip', t.id) },
      orderBy: { at: 'desc' },
    });
    expect(off.after).toMatchObject({ changedFrom: A.legalName, changedFromStatus: 'OFFERED' });
    expect(
      await db.auditLog.count({
        where: { action: 'subcon_offer.links_revoked', entityId: uuid('trip', t.id) },
      }),
    ).toBe(1);
    expect(
      await db.domainEvent.count({
        where: { type: 'subcon_offer.withdrawn', localId: a.offer.id },
      }),
    ).toBe(1);
  });

  it('เกณฑ์ตรวจรับ (รับงานแล้ว): ASSIGNED → ยกเลิกการจ้าง + ล้างรถ/คนขับรายเดิม + DO กลับ DRAFT ในเที่ยว → จ้างรายใหม่ (OFFERED) · กลับรายการครั้งเดียว', async () => {
    const A = await newCarrier();
    const B = await newCarrier();
    const C = await newCarrier();
    const t = await newTrip();
    const a = await hire(t.id, A.id);
    await pub()
      .post(`/v1/public/offers/${a.token}/accept`)
      .send({ vehiclePlate: A.plate, driverName: 'สมชาย', driverPhone: A.phone })
      .expect(200);
    let tr = (await trip(t.id)).body;
    expect(tr).toMatchObject({ status: 'ASSIGNED', vehicle: { plate: A.plate } });
    const doId = uuid('deliveryOrder', tr.deliveryOrders[0].id);
    expect((await db.deliveryOrder.findUniqueOrThrow({ where: { id: doId } })).status).toBe(
      'PLANNED',
    );
    const r = await change(t.id, tr.version, {
      carrierId: B.id,
      cost: '6100',
      selectionReason: 'รายนี้มีรถว่างช่วงเช้า',
      changeReason: REASON,
    }).expect(200);
    expect(r.body).toMatchObject({
      status: 'OFFERED',
      carrier: { id: B.id },
      vehicle: null,
      driver: null,
      hire: { status: 'OFFERED' },
    });
    const d = await db.deliveryOrder.findUniqueOrThrow({ where: { id: doId } });
    expect(d.status).toBe('DRAFT');
    expect(d.tripId).toBe(uuid('trip', t.id));
    expect((await so(t.soId)).status).toBe('PLANNED');
    const h = await history(t.id);
    expect(h.map((x) => [x.carrierId, x.status])).toEqual([
      [B.id, 'OFFERED'],
      [A.id, 'WITHDRAWN'],
    ]);
    expect(h[1]!.acceptedPlate).toBe(A.plate);
    expect(await costs(t.id)).toEqual(['5600.00', '-5600.00', '6100.00']);
    await pub().get(`/v1/public/offers/${a.token}`).expect(404);
    expect(
      await db.docStatusHistory.count({
        where: { docId: uuid('trip', t.id), event: 'cancel_hire' },
      }),
    ).toBe(1);
    expect(
      await db.domainEvent.count({
        where: { type: 'subcon_offer.cancelled', localId: a.offer.id },
      }),
    ).toBe(1);
    // เปลี่ยนอีกครั้ง (B → C): ค่าจ้างของ A ไม่ถูกกลับซ้ำ · ของ B กลับ 1 ครั้ง
    tr = (await trip(t.id)).body;
    await change(t.id, tr.version, {
      carrierId: C.id,
      cost: '6200',
      selectionReason: 'รายนี้มีรถว่างช่วงเช้า',
      changeReason: 'ผู้รับเหมา B แจ้งว่ารถไม่ว่างแล้ว',
    }).expect(200);
    expect(await costs(t.id)).toEqual(['5600.00', '-5600.00', '6100.00', '-6100.00', '6200.00']);
    expect((await history(t.id)).map((x) => x.status)).toEqual([
      'OFFERED',
      'WITHDRAWN',
      'WITHDRAWN',
    ]);
  });

  it('ค่าจ้างที่จ่ายแล้วไม่กลับรายการ แต่ธงไว้ใน audit (paidCarrierFees)', async () => {
    const A = await newCarrier();
    const B = await newCarrier();
    const t = await newTrip();
    const a = await hire(t.id, A.id);
    await settleTripCostsForTest(db, { subconOfferId: a.offer.id });
    const v = (await trip(t.id)).body.version as number;
    await change(t.id, v, {
      carrierId: B.id,
      cost: '5000',
      selectionReason: 'ตกลงราคาทางโทรศัพท์แล้ว',
      changeReason: REASON,
    }).expect(200);
    expect(await costs(t.id)).toEqual(['5600.00', '5000.00']);
    const au = await db.auditLog.findFirstOrThrow({
      where: { action: 'subcon_offer.cancelled', entityId: uuid('trip', t.id) },
    });
    expect(au.after).toMatchObject({ paidCarrierFees: 1 });
    expect((au.after as Record<string, unknown>).reversedCarrierFees).toBeUndefined();
  });

  it('ตรวจ: เหตุผลสั้น/ไม่มี → 422 · รายเดิม → 422 same_carrier (ย้อนกลับทั้งหมด) · If-Match เก่า → 412 · ไม่มีการจ้าง/ปล่อยรถแล้ว → 409 · viewer 403 · ข้าม tenant 404', async () => {
    const A = await newCarrier();
    const B = await newCarrier();
    const t = await newTrip();
    await hire(t.id, A.id);
    const v = (await trip(t.id)).body.version as number;
    const body = { carrierId: B.id, cost: '5000', selectionReason: 'ตกลงราคาทางโทรศัพท์แล้ว' };
    const short = await change(t.id, v, { ...body, changeReason: 'สั้นไป' }).expect(422);
    expect(short.body.errors[0]).toMatchObject({ field: 'changeReason', code: 'too_short' });
    await change(t.id, v, { ...body, changeReason: '   ' }).expect(422);
    const same = await change(t.id, v, {
      ...body,
      carrierId: A.id,
      changeReason: REASON,
    }).expect(422);
    expect(same.body.errors[0]).toMatchObject({ field: 'carrierId', code: 'same_carrier' });
    await change(t.id, v - 1, { ...body, changeReason: REASON }).expect(412);
    const viewer = await tokenFor(tenantId, SYSTEM_ROLES.viewer.permissions.join(' '), viewerId);
    await change(t.id, v, { ...body, changeReason: REASON }, viewer).expect(403);
    const other = await tokenFor(tenantB);
    await change(t.id, v, { ...body, changeReason: REASON }, other).expect(404);
    // ไม่มีอะไรเปลี่ยน
    expect((await trip(t.id)).body).toMatchObject({
      version: v,
      status: 'OFFERED',
      carrier: { id: A.id },
    });
    expect(await costs(t.id)).toEqual(['5600.00']);
    expect((await history(t.id)).map((x) => x.status)).toEqual(['OFFERED']);
    // เที่ยวที่ยังไม่จ้าง → 409
    const t2 = await newTrip();
    const none = await change(t2.id, t2.version, { ...body, changeReason: REASON }).expect(409);
    expect(none.body.code).toBe('carrier_change_not_allowed');
    // ปล่อยรถแล้ว → 409 (docs/01 §4.2 หลัง DISPATCHED ห้ามแก้ snapshot)
    const C = await newCarrier();
    const t3 = await newTrip();
    const c = await hire(t3.id, C.id);
    await pub()
      .post(`/v1/public/offers/${c.token}/accept`)
      .send({ vehiclePlate: C.plate, driverName: 'สมชาย', driverPhone: C.phone })
      .expect(200);
    await db.trip.update({ where: { id: uuid('trip', t3.id) }, data: { status: 'DISPATCHED' } });
    const v3 = (await trip(t3.id)).body.version as number;
    const disp = await change(t3.id, v3, { ...body, changeReason: REASON }).expect(409);
    expect(disp.body).toMatchObject({ code: 'carrier_change_not_allowed', from: 'DISPATCHED' });
    expect(await costs(t3.id)).toEqual(['5600.00']);
  });

  it('รายที่ถูกเปลี่ยนออก (QA M1): ไม่นับถูกสุด · ไม่เป็นค่าเริ่มต้น · อยู่ท้าย ป้าย CHANGED · เลือกซ้ำต้องมีเหตุผล · 1 คำขอ = 1 version', async () => {
    const A = await newCarrier();
    const B = await newCarrier();
    const C = await newCarrier();
    const t = await newTrip();
    await buyRate(A.id, t.a, t.b, '5000');
    await buyRate(B.id, t.a, t.b, '5400');
    await buyRate(C.id, t.a, t.b, '5600');
    await api(app, dispatcher)
      .post(`/v1/trips/${t.id}/offer`)
      .send({ carrierId: A.id })
      .expect(200);
    const v = (await trip(t.id)).body.version as number;
    // A → B (B ถูกสุดเมื่อไม่นับ A — ไม่ต้องใส่เหตุผลเลือก)
    const r = await change(t.id, v, { carrierId: B.id, changeReason: REASON }).expect(200);
    expect(r.body.version).toBe(v + 1);
    expect(r.body.hire.buySelectionKind).toBe('CHEAPEST');
    // เปลี่ยนอีกครั้ง (B ออก): A ถูกเปลี่ยนออกแล้ว → ไม่ใช่ถูกสุด/ไม่อยู่ต้นรายการ · C = ถูกสุด
    const opts = (
      await api(app, admin).get(`/v1/trips/${t.id}/hire-options?change=true`).expect(200)
    ).body;
    const ids = opts.options.map((o: { carrier: { id: string } }) => o.carrier.id);
    expect(ids).not.toContain(B.id);
    expect(ids.indexOf(A.id)).toBeGreaterThan(ids.indexOf(C.id));
    expect(opts.options[0]).toMatchObject({ carrier: { id: C.id }, cheapest: true });
    expect(
      opts.options.find((o: { carrier: { id: string } }) => o.carrier.id === A.id),
    ).toMatchObject({ priorOutcome: 'CHANGED', cheapest: false });
    expect(opts.buyCheapestAmount).toBe('5600.00');
    const v2 = r.body.version as number;
    const again = await change(t.id, v2, { carrierId: A.id, changeReason: REASON }).expect(422);
    expect(again.body.errors[0]).toMatchObject({
      field: 'selectionReason',
      code: 'selection_reason_required',
    });
    const ok = await change(t.id, v2, {
      carrierId: A.id,
      changeReason: REASON,
      selectionReason: 'ผู้รับเหมา A ซ่อมรถเสร็จแล้วและพร้อมรับงาน',
    }).expect(200);
    expect(ok.body).toMatchObject({ version: v2 + 1, carrier: { id: A.id } });
    expect(ok.body.hire.buySelectionKind).toBe('OVERRIDE');
  });

  it('ST3-T24 คงเดิม: replaceOffer ไม่มี changeReason ยังต้องครบ N ชม. (409 offer_not_timed_out)', async () => {
    const A = await newCarrier();
    const B = await newCarrier();
    const t = await newTrip();
    await hire(t.id, A.id);
    const v = (await trip(t.id)).body.version as number;
    const r = await change(t.id, v, {
      carrierId: B.id,
      cost: '5000',
      selectionReason: 'ตกลงราคาทางโทรศัพท์แล้ว',
      replaceOffer: true,
    }).expect(409);
    expect(r.body.code).toBe('offer_not_timed_out');
  });
});
