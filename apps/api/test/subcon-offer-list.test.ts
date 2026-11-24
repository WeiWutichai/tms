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
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

const H = 3600_000;

/**
 * หน้า "จ่ายงานรถร่วม" (`GET /v1/subcon-offers` + `/summary`) — การจ้างล่าสุดของแต่ละเที่ยว [DECISION — lead 24 พ.ย. 2569 เพื่อ UAT]
 * (ตั้งค่าแบบเดียวกับ subcon-offer-timeout.test.ts) — เดิม: ST3-T24 หมดเวลาข้อเสนองานรถร่วม (docs/04 D3 "ไม่ตอบใน N ชม. → แจ้งเตือน + ปุ่มส่งรายถัดไป"; docs/01 §4.2 OFFERED → PLANNING
 * "ปฏิเสธ/หมดอายุ → SO กลับ ON_HOLD(CARRIER_REJECTED)"; spec/03 PLN-154)
 * เกณฑ์ตรวจรับ: test เลื่อนเวลา — ครบ N ชม. ผู้จัดรถได้แจ้งเตือน 1 ครั้ง (รันซ้ำ/พร้อมกันก็ 1)
 */
describe('subcon offers list (/sub)', () => {
  let app: NestExpressApplication;
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
        email: `${role}-${++seed}@sublist.test`,
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

  const listOf = async (q = '', token = admin) =>
    (await api(app, token).get(`/v1/subcon-offers${q}`).expect(200)).body.data as {
      id: string;
      tripId: string;
      status: string;
      buyAmount?: string;
      sellAmount?: string | null;
      deliveryOrderNos: string[];
      origin: string | null;
      destination: string | null;
      carrierName: string;
      acceptedPlate: string | null;
    }[];
  const sum = async (token = admin) =>
    (await api(app, token).get('/v1/subcon-offers/summary').expect(200)).body as Record<
      string,
      unknown
    >;

  it('รอตอบ → แถวเดียวต่อเที่ยว (เส้นทาง/DO/ราคาซื้อ) · ปฏิเสธ → REJECTED · จ้างใหม่ → แถวเดิมถูกแทนด้วยการจ้างล่าสุด · summary นับตรงกับ status=', async () => {
    const before = await sum();
    const { C, t, token } = await offered();
    let rows = (await listOf()).filter((r) => r.tripId === t.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'OFFERED',
      buyAmount: '5600.00',
      carrierName: C.legalName,
      acceptedPlate: null,
    });
    expect(rows[0]!.origin).toContain('คลังบางปู');
    expect(rows[0]!.destination).toContain('ท่าเรือแหลมฉบัง');
    expect(rows[0]!.deliveryOrderNos).toHaveLength(1);
    expect((await sum()).offered).toBe((before.offered as number) + 1);

    await pub()
      .post(`/v1/public/offers/${token}/reject`)
      .send({ reason: 'PRICE_TOO_LOW' })
      .expect(200);
    rows = (await listOf('?status=REJECTED')).filter((r) => r.tripId === t.id);
    expect(rows.map((r) => r.status)).toEqual(['REJECTED']);
    expect((await listOf('?status=OFFERED')).some((r) => r.tripId === t.id)).toBe(false);
    expect((await sum()).rejected).toBe((before.rejected as number) + 1);

    const C2 = await newCarrier();
    await hire(t.id, C2.id);
    rows = (await listOf()).filter((r) => r.tripId === t.id);
    expect(rows.map((r) => [r.status, r.carrierName])).toEqual([['OFFERED', C2.legalName]]);
    const s = await sum();
    expect(s.rejected).toBe(before.rejected);
    expect(s.offered).toBe((before.offered as number) + 1);
  });

  it('รับงาน → ACCEPTED + ทะเบียน · ต้นทุนรถร่วมเดือนนี้ = Σ ราคาซื้อของงานรับแล้ว (Decimal string)', async () => {
    const before = await sum();
    const { C, t, token } = await offered();
    await pub()
      .post(`/v1/public/offers/${token}/accept`)
      .send({ vehiclePlate: C.plate, driverName: 'สมศักดิ์', driverPhone: C.phone })
      .expect(200);
    const r = (await listOf('?status=ACCEPTED')).find((x) => x.tripId === t.id)!;
    expect(r).toMatchObject({ status: 'ACCEPTED', acceptedPlate: C.plate });
    const s = await sum();
    expect(s.accepted).toBe((before.accepted as number) + 1);
    expect(s.buyAcceptedThisMonth).toBe((Number(before.buyAcceptedThisMonth) + 5600).toFixed(2));
  });

  it('ลิงก์หมดอายุ (job ยังไม่ปิด) → EXPIRED ทั้งรายการ/ตัวกรอง/summary ตามเวลา server (Clock)', async () => {
    const { offer, t } = await offered();
    clock.set(new Date(offer.expiresAt!.getTime() + 1000));
    const rows = (await listOf('?status=EXPIRED')).filter((r) => r.tripId === t.id);
    expect(rows.map((r) => r.status)).toEqual(['EXPIRED']);
    expect((await listOf('?status=OFFERED')).some((r) => r.tripId === t.id)).toBe(false);
    expect(((await sum()).expired as number) >= 1).toBe(true);
  });

  it('สิทธิ์: ไม่มี prices.buy:read → ไม่มีราคาซื้อ/ต้นทุนเดือนนี้ · ไม่มี trips:read → 403 · ตัวกรองผิด → 422 · cursor ใช้ได้', async () => {
    const { t } = await offered();
    const viewer = await tokenFor(tenantId, 'trips:read', viewerId);
    const r = (await listOf('', viewer)).find((x) => x.tripId === t.id)!;
    expect(r.buyAmount).toBeUndefined();
    expect(r.sellAmount).toBeUndefined();
    expect((await sum(viewer)).buyAcceptedThisMonth).toBeUndefined();
    const none = await tokenFor(tenantId, 'customers:read', viewerId);
    await api(app, none).get('/v1/subcon-offers').expect(403);
    await api(app, none).get('/v1/subcon-offers/summary').expect(403);
    await api(app, admin).get('/v1/subcon-offers?status=WITHDRAWN').expect(422);
    await api(app, admin).get('/v1/subcon-offers?carrierId=xx').expect(422);
    const p1 = (await api(app, admin).get('/v1/subcon-offers?limit=1').expect(200)).body;
    expect(p1.data).toHaveLength(1);
    expect(p1.hasMore).toBe(true);
    const p2 = (
      await api(app, admin).get(`/v1/subcon-offers?limit=1&cursor=${p1.nextCursor}`).expect(200)
    ).body;
    expect(p2.data[0].id).not.toBe(p1.data[0].id);
  });

  it('แยก tenant: tenant B ไม่เห็นการจ้างของ tenant A (รายการว่าง/นับ 0)', async () => {
    await offered();
    const b = await tokenFor(tenantB);
    expect((await api(app, b).get('/v1/subcon-offers').expect(200)).body.data).toEqual([]);
    expect(await sum(b)).toMatchObject({ offered: 0, accepted: 0, rejected: 0, expired: 0 });
  });
});
