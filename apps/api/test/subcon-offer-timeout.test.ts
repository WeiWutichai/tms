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
import { JobQueue } from '../src/jobs/job-queue.service';
import { DeliveryOrderService } from '../src/modules/delivery-orders/delivery-order.service';
import {
  OrderIntakeService,
  type UpsertOrderInput,
} from '../src/modules/orders/order-intake.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import {
  OFFER_TIMEOUT_JOB,
  SubconTimeoutService,
} from '../src/modules/trips/subcon-timeout.service';
import { bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

const H = 3600_000;

/**
 * ST3-T24 หมดเวลาข้อเสนองานรถร่วม (docs/04 D3 "ไม่ตอบใน N ชม. → แจ้งเตือน + ปุ่มส่งรายถัดไป"; docs/01 §4.2 OFFERED → PLANNING
 * "ปฏิเสธ/หมดอายุ → SO กลับ ON_HOLD(CARRIER_REJECTED)"; spec/03 PLN-154)
 * เกณฑ์ตรวจรับ: test เลื่อนเวลา — ครบ N ชม. ผู้จัดรถได้แจ้งเตือน 1 ครั้ง (รันซ้ำ/พร้อมกันก็ 1)
 */
describe('subcon offer timeout (ST3-T24)', () => {
  let app: NestExpressApplication;
  let svc: SubconTimeoutService;
  let clock: Clock;
  const db = platform();
  let tenantId: string;
  let tenantB: string;
  let admin: string;
  let dispatcherId: string;
  let dispatcher: string;
  let plannerId: string;
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
        email: `${role}-${++seed}@timeout.test`,
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
    svc = app.get(SubconTimeoutService);
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
    plannerId = await member(tenantId, 'planner');
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
          legalName: `หจก. รถร่วมหมดเวลา ${++seed}`,
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
        .send({ legalName: `บจก. ลูกค้าหมดเวลา ${++seed}`, taxId: validTaxId(8000 + seed) })
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
  const inApp = (template: string, entityTripId: string, recipientId?: string) =>
    db.notification.count({
      where: {
        tenantId,
        channel: 'in_app',
        templateCode: template,
        relatedEntityId: entityTripId,
        ...(recipientId ? { recipientId } : {}),
      },
    });
  const trip = (id: string) => api(app, admin).get(`/v1/trips/${id}`).expect(200);
  const so = (id: string) =>
    db.salesOrder.findUniqueOrThrow({
      where: { id },
      include: { holdReasonCode: { select: { code: true } } },
    });

  it('จ้าง → ครบเวลาตอบ = เวลาเสนอ + N ชม. (ค่าเริ่มต้น 2) · ตั้ง N = 5 ใช้กับข้อเสนอใหม่ · N นอกช่วง 1–47 → 422', async () => {
    const { offer, t } = await offered();
    expect(offer.responseDueAt!.getTime() - offer.offeredAt.getTime()).toBe(2 * H);
    expect((await trip(t.id)).body.hire.responseDueAt).toBe(offer.responseDueAt!.toISOString());
    await api(app, admin)
      .patch('/v1/settings')
      .send({ values: { 'dispatch.subconResponseHours': 48 } })
      .expect(422);
    await api(app, admin)
      .patch('/v1/settings')
      .send({ values: { 'dispatch.subconResponseHours': 5 } })
      .expect(200);
    try {
      const x = await offered();
      expect(x.offer.responseDueAt!.getTime() - x.offer.offeredAt.getTime()).toBe(5 * H);
      // ข้อเสนอเดิมไม่เปลี่ยน
      const before = await db.subconOffer.findUniqueOrThrow({ where: { id: offer.id } });
      expect(before.responseDueAt!.getTime() - before.offeredAt.getTime()).toBe(2 * H);
    } finally {
      await api(app, admin)
        .patch('/v1/settings')
        .send({ values: { 'dispatch.subconResponseHours': 2 } })
        .expect(200);
    }
  });

  it('เกณฑ์ตรวจรับ: เลื่อนเวลา — ก่อน N ชม. ไม่แจ้ง · ครบ N ชม. ผู้จ่ายงานที่จ้างได้แจ้ง 1 ครั้ง (รันซ้ำ + พร้อมกัน 3 ชุด ก็ 1) · ลิงก์ยังใช้ได้', async () => {
    const { offer, t, token } = await offered();
    const tid = encodeId('trip', offer.tripId);
    const t0 = offer.offeredAt.getTime();
    expect(await svc.runForTenant(tenantId, new Date(t0 + 2 * H - 60_000))).toMatchObject({
      notified: 0,
      expired: 0,
    });
    expect(await inApp('subcon_offer.no_response', tid)).toBe(0);

    const at = new Date(t0 + 2 * H + 60_000);
    const results = await Promise.all([
      svc.runForTenant(tenantId, at),
      svc.runForTenant(tenantId, at),
      svc.runForTenant(tenantId, at),
    ]);
    // ข้อเสนอของ test ก่อนหน้าที่ถึงเวลาด้วยถูกนับรวม — ตรวจผลต่อเที่ยวด้านล่าง
    expect(results.reduce((a, r) => a + r.notified, 0)).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.failed === 0)).toBe(true);
    await svc.runForTenant(tenantId, new Date(t0 + 10 * H));
    // ผู้จ้างได้ 1 ครั้ง (in-app 1 + อีเมล 1) · ผู้วางแผน/viewer ไม่ได้ (ผู้จ้างยังใช้งานอยู่)
    expect(await inApp('subcon_offer.no_response', tid, dispatcherId)).toBe(1);
    expect(await inApp('subcon_offer.no_response', tid)).toBe(1);
    expect(
      await db.notification.count({
        where: {
          tenantId,
          channel: 'email',
          templateCode: 'subcon_offer.no_response',
          relatedEntityId: tid,
        },
      }),
    ).toBe(1);
    const n = await db.notification.findFirstOrThrow({
      where: {
        tenantId,
        channel: 'in_app',
        templateCode: 'subcon_offer.no_response',
        relatedEntityId: tid,
      },
    });
    expect(n.title).toBe('รถร่วมยังไม่ตอบรับงาน');
    expect(n.body).toBe(
      `${t.tripNo} · ${offer.carrierNameSnapshot} ไม่ตอบรับใน 2 ชม. — ส่งรายถัดไปได้ที่เที่ยวรถ`,
    );
    expect(n.link).toBe('/planning');
    const row = await db.subconOffer.findUniqueOrThrow({ where: { id: offer.id } });
    expect(row.status).toBe('OFFERED');
    expect(row.timeoutNotifiedAt!.getTime()).toBe(at.getTime());
    expect(
      await db.auditLog.count({
        where: { action: 'subcon_offer.no_response', entityId: offer.tripId },
      }),
    ).toBe(1);
    // ยังตอบได้จนลิงก์หมดอายุ (48 ชม.) — เที่ยวยังรอตอบ
    expect((await trip(t.id)).body.status).toBe('OFFERED');
    await pub().get(`/v1/public/offers/${token}`).expect(200);
  });

  it('ผ่าน job: worker สร้าง job ต่อ tenant ครั้งเดียว (มีค้าง = ไม่สร้างซ้ำ) → JobQueue รันด้วย Clock → แจ้ง 1 ครั้ง · tenant ที่ไม่ถึงเวลาไม่ได้ job', async () => {
    const { offer } = await offered();
    await db.job.deleteMany({ where: { type: OFFER_TIMEOUT_JOB } });
    const at = new Date(offer.offeredAt.getTime() + 3 * H);
    clock.set(at);
    expect(await svc.scheduleDue(new Date(offer.offeredAt.getTime() + H))).toBe(0);
    expect(await svc.scheduleDue(at)).toBe(1);
    expect(await svc.scheduleDue(at)).toBe(0);
    const jobs = await db.job.findMany({ where: { type: OFFER_TIMEOUT_JOB } });
    expect(jobs.map((j) => j.tenantId)).toEqual([tenantId]);
    const queue = app.get(JobQueue);
    while (await queue.runOnce()) {
      /* รันจนหมดคิว */
    }
    const done = await db.job.findUniqueOrThrow({ where: { id: jobs[0]!.id } });
    expect(done.status).toBe('SUCCEEDED');
    expect(
      await inApp('subcon_offer.no_response', encodeId('trip', offer.tripId), dispatcherId),
    ).toBe(1);
    // แจ้งแล้ว → รอบถัดไปไม่มีอะไรให้ทำ
    expect(await svc.scheduleDue(at)).toBe(0);
  });

  it('ลิงก์หมดอายุ (48 ชม.) → การจ้าง EXPIRED, เที่ยว PLANNING, SO ค้าง CARRIER_REJECTED, ค่าจ้างกลับรายการ, ลิงก์ใช้ไม่ได้, แจ้ง 1 ครั้ง · รันซ้ำไม่ซ้ำ', async () => {
    const { offer, t, token } = await offered();
    const tid = encodeId('trip', offer.tripId);
    const at = new Date(offer.expiresAt!.getTime() + 60_000);
    const rs = await Promise.all([svc.runForTenant(tenantId, at), svc.runForTenant(tenantId, at)]);
    expect(rs.reduce((a, r) => a + r.expired, 0)).toBeGreaterThanOrEqual(1);
    expect(rs.every((r) => r.failed === 0)).toBe(true);
    await svc.runForTenant(tenantId, new Date(at.getTime() + H));
    const tr = (await trip(t.id)).body;
    expect(tr).toMatchObject({
      status: 'PLANNING',
      assignmentStatus: 'EXPIRED',
      carrier: null,
      hire: null,
    });
    const o = await db.subconOffer.findUniqueOrThrow({ where: { id: offer.id } });
    expect(o).toMatchObject({ status: 'EXPIRED', respondedAt: null });
    expect(o.closedReason).toMatch(/ไม่ตอบรับภายในเวลา/);
    const s = await so(t.soId);
    expect(s.status).toBe('ON_HOLD');
    expect(s.holdReasonCode?.code).toBe('CARRIER_REJECTED');
    const costs = await db.tripCost.findMany({
      where: { tripId: offer.tripId },
      orderBy: { createdAt: 'asc' },
    });
    expect(costs.map((c) => c.amount.toFixed(2))).toEqual(['5600.00', '-5600.00']);
    // ลิงก์เพิกถอนแล้ว → 404 (หน้า "ลิงก์นี้ใช้ไม่ได้")
    await pub().get(`/v1/public/offers/${token}`).expect(404);
    expect(await inApp('subcon_offer.expired', tid, dispatcherId)).toBe(1);
    expect(await inApp('subcon_offer.expired', tid)).toBe(1);
    expect(
      await db.domainEvent.count({ where: { type: 'subcon_offer.expired', localId: offer.id } }),
    ).toBe(1);
    expect(
      await db.domainEvent.count({ where: { type: 'trip.offer_expired', localId: offer.tripId } }),
    ).toBe(1);
    expect(
      await db.auditLog.count({ where: { action: 'trip.offer_expired', entityId: offer.tripId } }),
    ).toBe(1);
    // ประวัติ: หมดเวลา · ตัวเลือกจ้าง: รายเดิม = EXPIRED (ท้ายรายการ ไม่นับถูกสุด)
    const hist = (await api(app, admin).get(`/v1/trips/${t.id}/offers`).expect(200)).body.data;
    expect(hist[0].status).toBe('EXPIRED');
    const opts = (await api(app, admin).get(`/v1/trips/${t.id}/hire-options`).expect(200)).body;
    const mine = opts.options.find(
      (x: { carrier: { id: string } }) => x.carrier.id === encodeId('carrier', offer.carrierId),
    );
    expect(mine.priorOutcome).toBe('EXPIRED');
  });

  it('แข่งกัน: รถร่วมกดรับ ∥ job ปิดหมดเวลา → ชนะหนึ่งเดียว สถานะสอดคล้อง · ปฏิเสธก่อนครบ N ชม. → ไม่แจ้ง "ไม่ตอบ"', async () => {
    const { offer, t, token, C } = await offered();
    const at = new Date(offer.expiresAt!.getTime() + 1000);
    const [acc, job] = await Promise.all([
      pub()
        .post(`/v1/public/offers/${token}/accept`)
        .send({ vehiclePlate: C.plate, driverName: 'สมศักดิ์', driverPhone: C.phone }),
      svc.runForTenant(tenantId, at),
    ]);
    const o = await db.subconOffer.findUniqueOrThrow({ where: { id: offer.id } });
    const tr = (await trip(t.id)).body;
    if (acc.status === 200) {
      expect(o.status).toBe('ACCEPTED');
      expect(tr.status).toBe('ASSIGNED');
      expect(await inApp('subcon_offer.expired', encodeId('trip', offer.tripId))).toBe(0);
    } else {
      expect(acc.status).toBe(409);
      expect(o.status).toBe('EXPIRED');
      expect(tr.status).toBe('PLANNING');
    }
    expect(job.failed).toBe(0);

    // ปฏิเสธแล้ว → ครบ N ชม. ไม่แจ้ง · หมดอายุ ไม่ทำอะไร
    const x = await offered();
    await pub()
      .post(`/v1/public/offers/${x.token}/reject`)
      .send({ reason: 'PRICE_TOO_LOW' })
      .expect(200);
    const r = await svc.runForTenant(tenantId, new Date(x.offer.expiresAt!.getTime() + H));
    expect(r.failed).toBe(0);
    const tid = encodeId('trip', x.offer.tripId);
    expect(await inApp('subcon_offer.no_response', tid)).toBe(0);
    expect(await inApp('subcon_offer.expired', tid)).toBe(0);
    expect((await db.subconOffer.findUniqueOrThrow({ where: { id: x.offer.id } })).status).toBe(
      'REJECTED',
    );
  });

  it('"ส่งรายถัดไป" ระหว่างรอตอบ: ยังไม่ครบ N ชม. → 409 · ครบแล้ว → ถอนรายเดิม + จ้างรายถัดไปที่ถูกสุด (ไม่ต้องใส่เหตุผล) ในคำขอเดียว', async () => {
    const A = await newCarrier();
    const B = await newCarrier();
    const t = await newTrip();
    await buyRate(A.id, t.a, t.b, '5000');
    await buyRate(B.id, t.a, t.b, '5400');
    // A ถูกสุด → จ้าง A ตาม rate card (ไม่ต้องมีเหตุผล)
    await api(app, dispatcher)
      .post(`/v1/trips/${t.id}/offer`)
      .send({ carrierId: A.id })
      .expect(200);
    const l = (await api(app, admin).get(`/v1/trips/${t.id}/offer-link`).expect(200)).body.link;
    const oldToken = new URL(l.url).pathname.split('/').pop()!;
    const oa = uuid('subconOffer', l.offerId);
    const v = (await trip(t.id)).body.version as number;
    const early = await api(app, dispatcher)
      .post(`/v1/trips/${t.id}/offer`)
      .set('If-Match', `"${v}"`)
      .send({ carrierId: B.id, replaceOffer: true })
      .expect(409);
    expect(early.body.code).toBe('offer_not_timed_out');
    // ยังไม่ครบ → B ยังไม่ใช่ถูกสุด (A ยังรอตอบอยู่ ไม่ถูกตัด)
    let opts = (await api(app, admin).get(`/v1/trips/${t.id}/hire-options`).expect(200)).body;
    expect(opts.buyCheapestAmount).toBe('5000.00');

    // เลื่อนเวลา: ครบเวลาตอบของ A
    await db.subconOffer.update({
      where: { id: oa },
      data: {
        offeredAt: new Date(Date.now() - 2 * H - 60_000),
        responseDueAt: new Date(Date.now() - 60_000),
      },
    });
    opts = (await api(app, admin).get(`/v1/trips/${t.id}/hire-options`).expect(200)).body;
    expect(opts.buyCheapestAmount).toBe('5400.00');
    expect(opts.options[0]).toMatchObject({
      carrier: { id: B.id },
      cheapest: true,
      priorOutcome: null,
    });
    expect(
      opts.options.find((x: { carrier: { id: string } }) => x.carrier.id === A.id).priorOutcome,
    ).toBe('NO_RESPONSE');
    // If-Match เก่า → 412 ไม่มีอะไรเปลี่ยน
    await api(app, dispatcher)
      .post(`/v1/trips/${t.id}/offer`)
      .set('If-Match', `"${v - 1}"`)
      .send({ carrierId: B.id, replaceOffer: true })
      .expect(412);
    const r = await api(app, dispatcher)
      .post(`/v1/trips/${t.id}/offer`)
      .set('If-Match', `"${v}"`)
      .send({ carrierId: B.id, replaceOffer: true })
      .expect(200);
    expect(r.body).toMatchObject({
      status: 'OFFERED',
      carrier: { id: B.id },
      hire: { buySelectionKind: 'CHEAPEST' },
    });
    expect(r.body.hire.selectionReason).toBe(
      'ราคาถูกสุดจาก 1 รายที่มี rate card ขาซื้อ (ไม่นับ 1 รายที่ไม่รับงานเที่ยวนี้)',
    );
    const old = await db.subconOffer.findUniqueOrThrow({ where: { id: oa } });
    expect(old.status).toBe('WITHDRAWN');
    expect(old.closedReason).toBe(`${A.legalName} ไม่ตอบรับใน 2 ชม. — ส่งรายถัดไป`);
    await pub().get(`/v1/public/offers/${oldToken}`).expect(404);
    const costs = await db.tripCost.findMany({
      where: { tripId: uuid('trip', t.id) },
      orderBy: { createdAt: 'asc' },
    });
    expect(costs.map((c) => `${c.amount.toFixed(2)}`)).toEqual(['5000.00', '-5000.00', '5400.00']);
    // SO ไม่ค้าง (จ้างต่อทันที)
    expect((await so(t.soId)).status).toBe('PLANNED');
    const hist = (await api(app, admin).get(`/v1/trips/${t.id}/offers`).expect(200)).body.data;
    expect(hist.map((h: { status: string }) => h.status)).toEqual(['OFFERED', 'WITHDRAWN']);
    expect(
      await db.auditLog.count({
        where: { action: 'subcon_offer.withdrawn', entityId: uuid('trip', t.id) },
      }),
    ).toBe(1);
    // รายใหม่รอตอบ ยังไม่ครบเวลา → ส่งรายถัดไปซ้ำไม่ได้ · เที่ยวที่ไม่ได้รอตอบ → 409 offer_closed
    const v2 = (await trip(t.id)).body.version as number;
    await api(app, dispatcher)
      .post(`/v1/trips/${t.id}/offer`)
      .set('If-Match', `"${v2}"`)
      .send({ carrierId: A.id, replaceOffer: true })
      .expect(409);
    const t2 = await newTrip();
    const c2 = await api(app, dispatcher)
      .post(`/v1/trips/${t2.id}/offer`)
      .send({ carrierId: A.id, replaceOffer: true })
      .expect(409);
    expect(c2.body.code).toBe('offer_closed');
  });

  it('ผู้รับ: ผู้จ้างไม่ใช่ผู้ใช้ (API/dev token) หรือถูกปิดใช้งาน → ทุกคนที่มีสิทธิ์ trips:assign (ไม่รวม viewer) · ไม่ข้าม tenant', async () => {
    const C = await newCarrier();
    const t = await newTrip();
    const { offer } = await hire(t.id, C.id, admin); // offeredBy = 'user-test' (ไม่ใช่ผู้ใช้)
    await svc.runForTenant(tenantId, new Date(offer.offeredAt.getTime() + 2 * H + 1000));
    const tid = encodeId('trip', offer.tripId);
    const got = await db.notification.findMany({
      where: { channel: 'in_app', templateCode: 'subcon_offer.no_response', relatedEntityId: tid },
      select: { recipientId: true, tenantId: true },
    });
    const ids = got.map((g) => g.recipientId);
    expect(ids).toEqual(expect.arrayContaining([dispatcherId, plannerId]));
    expect(ids).not.toContain(viewerId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(got.every((g) => g.tenantId === tenantId)).toBe(true);

    // ผู้จ้างถูกปิดใช้งาน → กลุ่มผู้มีสิทธิ์
    const x = await offered();
    await db.appUser.update({ where: { id: dispatcherId }, data: { status: 'DISABLED' } });
    try {
      await svc.runForTenant(tenantId, new Date(x.offer.offeredAt.getTime() + 2 * H + 1000));
      const xs = await db.notification.findMany({
        where: {
          channel: 'in_app',
          templateCode: 'subcon_offer.no_response',
          relatedEntityId: encodeId('trip', x.offer.tripId),
        },
        select: { recipientId: true },
      });
      expect(xs.map((g) => g.recipientId)).toContain(plannerId);
      expect(xs.map((g) => g.recipientId)).not.toContain(dispatcherId);
    } finally {
      await db.appUser.update({ where: { id: dispatcherId }, data: { status: 'ACTIVE' } });
    }
  });

  it('แยก tenant: งานของ tenant B ไม่เห็น/ไม่ปิดข้อเสนอของ tenant A · ไม่มีแจ้งเตือนข้าม tenant', async () => {
    const { offer } = await offered();
    const far = new Date(offer.expiresAt!.getTime() + H);
    const r = await svc.runForTenant(tenantB, far);
    expect(r).toEqual({ notified: 0, expired: 0, failed: 0 });
    expect((await db.subconOffer.findUniqueOrThrow({ where: { id: offer.id } })).status).toBe(
      'OFFERED',
    );
    expect(await db.notification.count({ where: { tenantId: tenantB } })).toBe(0);
    // ปิดด้วย tenant ของตัวเอง (จบเพื่อไม่ค้างต่อ test อื่น)
    await svc.runForTenant(tenantId, far);
    expect((await db.subconOffer.findUniqueOrThrow({ where: { id: offer.id } })).status).toBe(
      'EXPIRED',
    );
  });
});
