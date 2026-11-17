import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SYSTEM_ROLES } from '@tms/domain';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { requestContext } from '../src/common/request-context';
import { DbService, type Tx } from '../src/db/db.service';
import { resetPublicRateLimit } from '../src/http/public-rate-limit.middleware';
import { DeliveryOrderService } from '../src/modules/delivery-orders/delivery-order.service';
import { encodeLinkToken } from '../src/modules/links/magic-link.service';
import {
  OrderIntakeService,
  type UpsertOrderInput,
} from '../src/modules/orders/order-intake.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { parseOfferPlate } from '../src/modules/trips/subcon-offer.service';
import { bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST3-T23 ลิงก์ข้อเสนองาน (docs/04 D3 "ส่งลิงก์ LINE/SMS ไม่ต้อง login", M10; docs/01 §4.2/§5.5):
 * เกณฑ์ตรวจรับ — เปิดลิงก์โดยไม่ login กดรับ → trip ASSIGNED พร้อมทะเบียน/คนขับ; ปฏิเสธ → SO ค้าง `CARRIER_REJECTED`
 * + ซ่อนราคาขาย/ที่อยู่ลูกค้า, กฎ ST3-T14 (บล็อก → 409 ทันที), กดซ้ำ, เพิกถอน/ออกใหม่, ส่งทาง SMS, ประวัติ, สิทธิ์
 */
describe('subcon offer link (ST3-T23)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let admin: string;
  let viewer: string;
  let seed = 0;
  let unitTon: string;
  let vt6: string;
  const today = bangkokToday();
  const day = (n: number) =>
    new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const uuid = (kind: Parameters<typeof tryDecodeId>[0], id: string) => tryDecodeId(kind, id)!;
  const ADDR = {
    line1: '99/9 ถ.ลับเฉพาะ ซอยไม่เปิดเผย',
    district: 'เมือง',
    province: 'ชลบุรี',
    postcode: '20000',
  };
  const jur = (n: number) => {
    const base = `0105${String(80_000 + n).padStart(8, '0')}`;
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
    return base + String((11 - (sum % 11)) % 10);
  };

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'ศรีไทยขนส่ง' })).id;
    const c = await db.company.create({
      data: { tenantId, legalName: 'บริษัท ศรีไทยขนส่ง จำกัด', taxId: validTaxId(901) },
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
    viewer = await tokenFor(tenantId, SYSTEM_ROLES.viewer.permissions.join(' '), 'u-view');
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
  const newCarrier = async (phone?: string) =>
    (
      await api(app, admin)
        .post('/v1/carriers')
        .send({
          legalName: `หจก. ศรีราชาโลจิสติกส์ ${++seed}`,
          entityType: 'JURISTIC',
          taxId: jur(seed),
          ...(phone ? { phone } : {}),
        })
        .expect(201)
    ).body as { id: string; legalName: string };
  /** รถ 6 ล้อของรถร่วม + ประกัน/พ.ร.บ. (หมดอายุ `docUntil` วัน) */
  const vehicle = async (carrierId: string, plate: string, docUntil = 200, province = 'TH-20') => {
    const v = (
      await api(app, admin)
        .post('/v1/vehicles')
        .send({
          plate,
          plateProvince: province,
          vehicleTypeId: vt6,
          ownership: 'SUBCONTRACT',
          carrierId,
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
          expiresOn: new Date(`${day(docUntil)}T00:00:00Z`),
          isRequiredForDispatch: true,
        },
      });
    return v;
  };
  const driver = async (carrierId: string, phone: string, licenceExpiresOn = day(300)) =>
    (
      await api(app, admin)
        .post('/v1/drivers')
        .send({
          name: `สมชาย ใจดี ${++seed}`,
          phone,
          employmentType: 'CARRIER_DRIVER',
          carrierId,
          licenceClass: 'T2',
          licenceExpiresOn,
        })
        .expect(201)
    ).body as { id: string; name: string };
  const newTrip = async (opts: { split?: boolean } = {}) => {
    const [a, b] = [await newSite('คลังบางปู'), await newSite('ท่าเรือแหลมฉบัง ประตู 3')];
    const cust = (
      await api(app, admin)
        .post('/v1/customers')
        .send({ legalName: `บจก. เอ็นเอสเอฟ อินดัสทรี ${++seed}`, taxId: validTaxId(7000 + seed) })
        .expect(201)
    ).body.id as string;
    // ราคาขาย 7,800 (rate card ขาขาย) — ต้องไม่ปรากฏในหน้าลิงก์
    const rc = (
      await api(app, admin)
        .post('/v1/rate-cards')
        .send({
          customerId: cust,
          originId: a,
          destinationId: b,
          vehicleTypeId: vt6,
          validFrom: day(-30),
          pricingModel: 'PER_TRIP',
          sellRate: '7800',
        })
        .expect(201)
    ).body;
    await api(app, admin)
      .post(`/v1/rate-cards/${rc.id}/approve`)
      .send({ reason: 'อนุมัติตามใบเสนอราคา' })
      .expect(200);
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
    let [d] = await run((tx) => app.get(DeliveryOrderService).listForOrder(so.id, {}, tx));
    let extraDo: string | null = null;
    if (opts.split) {
      // SO เดียวแยกเป็น 2 DO (ใบที่สองไปอยู่อีกเที่ยว)
      const [line] = await db.salesOrderLine.findMany({ where: { salesOrderId: so.id } });
      const kids = await run((tx) =>
        app
          .get(DeliveryOrderService)
          .split(
            d!.id,
            [
              [{ salesOrderLineId: line!.id, qty: '2' }],
              [{ salesOrderLineId: line!.id, qty: '3' }],
            ],
            tx,
          ),
      );
      d = kids[0]!;
      extraDo = encodeId('deliveryOrder', kids[1]!.id);
    }
    const t = (
      await api(app, admin)
        .post('/v1/trips')
        .send({ tripDate: today, deliveryOrderIds: [encodeId('deliveryOrder', d!.id)] })
        .expect(201)
    ).body as { id: string; tripNo: string; version: number };
    return { ...t, soId: so.id, extraDo };
  };
  /** จ้างรถร่วม (ราคากรอกเอง + เหตุผล) → OFFERED + ลิงก์ */
  const hire = async (tripId: string, carrierId: string, cost = '5600') => {
    await api(app, admin)
      .post(`/v1/trips/${tripId}/offer`)
      .send({ carrierId, cost, selectionReason: 'ตกลงราคาทางโทรศัพท์แล้ว' })
      .expect(200);
    const l = (await api(app, admin).get(`/v1/trips/${tripId}/offer-link`).expect(200)).body
      .link as { url: string; offerId: string; linkId: string; expiresAt: string };
    return { ...l, token: new URL(l.url).pathname.split('/').pop()! };
  };
  /** รถร่วมพร้อมรถ + คนขับ + เที่ยวที่เสนองานแล้ว */
  async function offered(opts: { docUntil?: number; licence?: string } = {}) {
    const C = await newCarrier('0812345678');
    const plate = `74-${String(5000 + ++seed)}`;
    const v = await vehicle(C.id, plate, opts.docUntil ?? 200);
    const phone = `08${String(10_000_000 + ++seed).slice(-8)}`;
    const d = await driver(C.id, phone, opts.licence);
    const t = await newTrip();
    const link = await hire(t.id, C.id);
    return { C, v, d, t, plate, phone, link };
  }
  const trip = (id: string) => api(app, admin).get(`/v1/trips/${id}`).expect(200);
  const so = (id: string) =>
    db.salesOrder.findUniqueOrThrow({
      where: { id },
      include: { holdReasonCode: { select: { code: true } } },
    });

  it('parseOfferPlate: ตัดจังหวัดต่อท้าย (ย่อ/เต็ม/เลขไทย) · ไม่ตัดอักษรหมวด', () => {
    expect(parseOfferPlate('74-5521 ชบ.')).toEqual({ norm: '745521', province: 'TH-20' });
    expect(parseOfferPlate('๗๔-๕๕๒๑ ชลบุรี')).toEqual({ norm: '745521', province: 'TH-20' });
    expect(parseOfferPlate('74-5521')).toEqual({ norm: '745521', province: null });
    expect(parseOfferPlate('1กข 1234 กทม.')).toEqual({ norm: '1กข1234', province: 'TH-10' });
    expect(parseOfferPlate('กท 1234')).toEqual({ norm: 'กท1234', province: null });
    expect(parseOfferPlate('74-5521 จ.ชลบุรี')).toEqual({ norm: '745521', province: 'TH-20' });
    expect(parseOfferPlate('74-5521 จังหวัดชลบุรี')).toEqual({ norm: '745521', province: 'TH-20' });
    expect(parseOfferPlate('74-5521 จ. ชบ.')).toEqual({ norm: '745521', province: 'TH-20' });
  });

  it('จ้าง → ลิงก์ 48 ชม. · เปิดโดยไม่ login เห็นใบสั่งงาน + ราคาจ้าง แต่ไม่มีราคาขาย/ที่อยู่ลูกค้า · no-store · viewedAt ครั้งเดียว', async () => {
    const { C, t, link } = await offered();
    const row = await db.magicLink.findUniqueOrThrow({
      where: { id: uuid('magicLink', link.linkId) },
    });
    expect(row).toMatchObject({
      purpose: 'trip_offer',
      entityType: 'subcon_offer',
      entityId: uuid('subconOffer', link.offerId),
      actions: ['offer.view', 'offer.respond'],
      scopes: ['prices.buy:read'],
    });
    const offer = await db.subconOffer.findUniqueOrThrow({ where: { id: row.entityId } });
    const tr = (await trip(t.id)).body;
    // ลิงก์ ข้อเสนอ และเที่ยว หมดเวลาพร้อมกัน ≈ 48 ชม.
    expect(Math.abs(row.expiresAt.getTime() - offer.expiresAt!.getTime())).toBeLessThan(2000);
    expect(Math.abs(Date.parse(tr.offerExpiresAt) - offer.expiresAt!.getTime())).toBeLessThan(2);
    expect(offer.expiresAt!.getTime() - offer.offeredAt.getTime()).toBeGreaterThan(
      48 * 3600_000 - 5000,
    );
    expect(link.url).toMatch(/\/link\/offer\/ml1\./);

    const r = await pub().get(`/v1/public/offers/${link.token}`).expect(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toMatchObject({
      company: 'ศรีไทยขนส่ง',
      carrierName: C.legalName,
      status: 'OFFERED',
      tripNo: t.tripNo,
      vehicleTypeName: expect.any(String),
      weightKg: '8600',
      buyAmount: '5600.00',
      terms: { whtRate: null, paymentTermDays: expect.any(Number), requirePodToPay: true },
      accepted: null,
      rejectReason: null,
    });
    expect(r.body.origin).toMatch(/^คลังบางปู/);
    expect(r.body.destination).toMatch(/^ท่าเรือแหลมฉบัง ประตู 3/);
    expect(r.body.customerName).toMatch(/^บจก\. เอ็นเอสเอฟ อินดัสทรี/);
    expect(r.body.rejectReasons).toHaveLength(4);
    // ไม่มีราคาขาย (7,800) · กำไร · ที่อยู่ลูกค้า · เหตุผลการเลือก/รายอื่น
    const raw = JSON.stringify(r.body);
    for (const bad of ['7800', 'sell', 'margin', 'ลับเฉพาะ', '20000', 'ตกลงราคา', 'selection'])
      expect(raw).not.toContain(bad);
    // เปิดครั้งแรกบันทึก viewedAt + audit ครั้งเดียว
    await pub().get(`/v1/public/offers/${link.token}`).expect(200);
    const viewed = await db.subconOffer.findUniqueOrThrow({ where: { id: row.entityId } });
    expect(viewed.viewedAt).not.toBeNull();
    expect(
      await db.auditLog.count({
        where: { action: 'subcon_offer.viewed', entityId: uuid('trip', t.id) },
      }),
    ).toBe(1);
  });

  it('เกณฑ์ตรวจรับ: กดรับ (ทะเบียน + จังหวัด, เบอร์ +66) → ASSIGNED พร้อมทะเบียน/คนขับ · กดซ้ำ = ผลเดิม · ค่าอื่น → 409', async () => {
    const { t, v, d, plate, phone, link } = await offered();
    const body = {
      vehiclePlate: `${plate} ชบ.`,
      driverName: 'สมชาย',
      driverPhone: `+66 ${phone.slice(1)}`,
    };
    const r = await pub().post(`/v1/public/offers/${link.token}/accept`).send(body).expect(200);
    expect(r.body).toMatchObject({ status: 'ACCEPTED', accepted: { plate, driverName: d.name } });
    const tr = (await trip(t.id)).body;
    expect(tr).toMatchObject({
      status: 'ASSIGNED',
      assignmentStatus: 'ACCEPTED',
      vehicle: { id: v.id, plate },
      driver: { id: d.id, name: d.name },
      hire: { status: 'ACCEPTED' },
    });
    const offer = await db.subconOffer.findUniqueOrThrow({
      where: { id: uuid('subconOffer', link.offerId) },
    });
    expect(offer).toMatchObject({
      status: 'ACCEPTED',
      respondedVia: 'LINK',
      acceptedPlate: plate,
      acceptedVehicleId: uuid('vehicle', v.id),
      acceptedDriverId: uuid('driver', d.id),
    });
    expect((await so(t.soId)).status).toBe('PLANNED');
    const dos = await db.deliveryOrder.findMany({ where: { tripId: uuid('trip', t.id) } });
    expect(dos.map((x) => x.status)).toEqual(['PLANNED']);
    expect(
      await db.domainEvent.count({ where: { type: 'subcon_offer.accepted', localId: offer.id } }),
    ).toBe(1);
    const audit = await db.auditLog.findFirst({
      where: { action: 'trip.assigned', entityId: uuid('trip', t.id) },
    });
    expect(audit?.actorId).toBe(`link:${uuid('magicLink', link.linkId)}`);
    // กดซ้ำ (double-tap / refresh) ค่าเดิม = 200 ผลเดิม ไม่เปลี่ยน version
    const v1 = tr.version;
    await pub().post(`/v1/public/offers/${link.token}/accept`).send(body).expect(200);
    expect((await trip(t.id)).body.version).toBe(v1);
    // ปฏิเสธหลังรับ / รับด้วยรถอื่น → 409 offer_closed
    const r2 = await pub()
      .post(`/v1/public/offers/${link.token}/reject`)
      .send({ reason: 'PRICE_TOO_LOW' })
      .expect(409);
    expect(r2.body.code).toBe('offer_closed');
    // เปิดดูได้ — สถานะรับงานแล้ว
    expect((await pub().get(`/v1/public/offers/${link.token}`).expect(200)).body.status).toBe(
      'ACCEPTED',
    );
    // ลิงก์ยังคัดลอกได้หลังรับงาน (ต้นแบบ "คัดลอกลิงก์") · ออกใหม่ไม่ได้ (ไม่รอตอบแล้ว)
    expect(
      (await api(app, admin).get(`/v1/trips/${t.id}/offer-link`).expect(200)).body.link,
    ).not.toBeNull();
    expect((await api(app, admin).post(`/v1/trips/${t.id}/offer-link`).expect(409)).body.code).toBe(
      'offer_closed',
    );
  });

  it('สองเครื่องกดรับพร้อมกัน → เที่ยวรับงานครั้งเดียว (อีกคำขอได้ผลเดิมหรือ 409)', async () => {
    const { t, plate, phone, link } = await offered();
    const body = { vehiclePlate: plate, driverName: 'สมชาย', driverPhone: phone };
    const rs = await Promise.all(
      [0, 1].map(() => pub().post(`/v1/public/offers/${link.token}/accept`).send(body)),
    );
    expect(rs.map((x) => x.status).sort()).toEqual([200, 200]);
    const hist = await db.docStatusHistory.findMany({
      where: { docType: 'trip', docId: uuid('trip', t.id), event: 'accept' },
    });
    expect(hist).toHaveLength(1);
  });

  it('รับงานไม่ได้: ทะเบียน/คนขับไม่ได้ลงทะเบียนกับรายนี้ → 422 · เอกสารรถหมด/ใบขับขี่หมด → 409 assignment_blocked (ข้อความไทย) ไม่มีอะไรเปลี่ยน', async () => {
    const { C, t, plate, phone, link } = await offered();
    const other = await newCarrier();
    const otherPlate = `75-${String(6000 + ++seed)}`;
    await vehicle(other.id, otherPlate);
    const acc = (body: object) => pub().post(`/v1/public/offers/${link.token}/accept`).send(body);
    const err = async (body: object, status: number) =>
      (await acc(body).expect(status)).body as {
        code: string;
        detail?: string;
        errors?: { field: string; code: string }[];
      };
    expect(
      (await err({ vehiclePlate: '99-9999', driverName: 'ก', driverPhone: phone }, 422)).errors,
    ).toBeTruthy();
    // ทะเบียน/คนขับไม่ตรง → 422 แบบเดียว (ไม่บอกว่าช่องไหนผิด — review L3) · เหตุจริงอยู่ใน audit
    const GENERIC = {
      field: 'vehiclePlate',
      code: 'registration_mismatch',
    };
    for (const [body, cause] of [
      [
        { vehiclePlate: '99-9999', driverName: 'สมชาย', driverPhone: phone },
        'vehicle_not_registered',
      ],
      [
        { vehiclePlate: otherPlate, driverName: 'สมชาย', driverPhone: phone },
        'vehicle_not_registered',
      ],
      [
        { vehiclePlate: `${plate} กทม.`, driverName: 'สมชาย', driverPhone: phone },
        'vehicle_not_registered',
      ],
      [
        { vehiclePlate: plate, driverName: 'สมชาย', driverPhone: '0899999999' },
        'driver_not_registered',
      ],
    ] as const) {
      const e = await err(body, 422);
      expect(e.errors?.[0]).toMatchObject(GENERIC);
      expect(e.detail).toBe('ทะเบียนหรือเบอร์คนขับไม่ตรงกับข้อมูลที่ลงทะเบียนไว้กับบริษัท');
      const a = await db.auditLog.findFirst({
        where: { action: 'subcon_offer.accept_failed', entityId: uuid('trip', t.id) },
        orderBy: { seq: 'desc' },
      });
      expect((a?.after as { cause: string }).cause).toBe(cause);
    }
    expect(
      (await err({ vehiclePlate: plate, driverName: 'สมชาย', driverPhone: '12345' }, 422))
        .errors?.[0]?.field,
    ).toBe('driverPhone');

    // รถอีกคันของรายนี้ พ.ร.บ./ประกัน หมดก่อนวันเที่ยว → บล็อก (PLN-152 แบบเข้ม)
    const oldPlate = `76-${String(7000 + ++seed)}`;
    await vehicle(C.id, oldPlate, -1);
    const b = await err({ vehiclePlate: oldPlate, driverName: 'สมชาย', driverPhone: phone }, 409);
    expect(b.code).toBe('assignment_blocked');
    expect(b.detail).toMatch(/^รถ\/คนขับนี้รับงานไม่ได้: .+ กรุณาเลือกคันอื่น$/);
    // คนขับใบขับขี่หมด
    const lateDriver = `08${String(20_000_000 + ++seed).slice(-8)}`;
    await driver(C.id, lateDriver, day(-3));
    const b2 = await err(
      { vehiclePlate: plate, driverName: 'สมชาย', driverPhone: lateDriver },
      409,
    );
    expect(b2.code).toBe('assignment_blocked');
    const tr = (await trip(t.id)).body;
    expect(tr).toMatchObject({ status: 'OFFERED', vehicle: null, driver: null });
    expect(
      (
        await db.subconOffer.findUniqueOrThrow({
          where: { id: uuid('subconOffer', link.offerId) },
        })
      ).status,
    ).toBe('OFFERED');
  });

  it('เกณฑ์ตรวจรับ: ปฏิเสธ + เหตุผล → เที่ยว PLANNING, SO ค้าง CARRIER_REJECTED, ค่าจ้างกลับรายการ · กดซ้ำ = ผลเดิม · จ้างรายใหม่ → SO กลับวางแผน', async () => {
    const { t, link, plate, phone } = await offered();
    const bad = await pub()
      .post(`/v1/public/offers/${link.token}/reject`)
      .send({ reason: 'OTHER' })
      .expect(422);
    expect(bad.body.code).toBe('validation_failed');
    const r = await pub()
      .post(`/v1/public/offers/${link.token}/reject`)
      .send({ reason: 'VEHICLE_UNAVAILABLE', note: 'รถเข้าศูนย์' })
      .expect(200);
    expect(r.body).toMatchObject({ status: 'REJECTED', rejectReason: 'VEHICLE_UNAVAILABLE' });
    const tr = (await trip(t.id)).body;
    expect(tr).toMatchObject({
      status: 'PLANNING',
      assignmentStatus: 'REJECTED',
      carrier: null,
      hire: null,
    });
    const s = await so(t.soId);
    expect(s.status).toBe('ON_HOLD');
    expect(s.holdReasonCode?.code).toBe('CARRIER_REJECTED');
    expect(s.holdNote).toBe('รถร่วมปฏิเสธ: รถไม่ว่างวันที่รับงาน — รถเข้าศูนย์');
    const offer = await db.subconOffer.findUniqueOrThrow({
      where: { id: uuid('subconOffer', link.offerId) },
    });
    expect(offer).toMatchObject({
      status: 'REJECTED',
      respondedVia: 'LINK',
      rejectReasonCode: 'VEHICLE_UNAVAILABLE',
      rejectNote: 'รถเข้าศูนย์',
    });
    const costs = await db.tripCost.findMany({
      where: { tripId: uuid('trip', t.id) },
      orderBy: { createdAt: 'asc' },
    });
    expect(costs.map((c) => c.amount.toFixed(2))).toEqual(['5600.00', '-5600.00']);
    expect(
      await db.domainEvent.count({ where: { type: 'subcon_offer.rejected', localId: offer.id } }),
    ).toBe(1);
    expect(
      await db.auditLog.count({
        where: { action: 'trip.offer_rejected', entityId: uuid('trip', t.id) },
      }),
    ).toBe(1);
    // ใบค้างแสดงรหัส CARRIER_REJECTED
    const held = await api(app, admin).get('/v1/orders?held=true&limit=50').expect(200);
    expect(
      (held.body.data as { id: string; holdReason: { code: string } | null }[]).find(
        (o) => o.id === encodeId('salesOrder', t.soId),
      )?.holdReason,
    ).toMatchObject({ code: 'CARRIER_REJECTED', label: 'รถร่วมปฏิเสธงาน' });
    // กดซ้ำเหตุผลเดิม = ผลเดิม · รับงานหลังปฏิเสธ → 409
    await pub()
      .post(`/v1/public/offers/${link.token}/reject`)
      .send({ reason: 'VEHICLE_UNAVAILABLE' })
      .expect(200);
    const acc = await pub()
      .post(`/v1/public/offers/${link.token}/accept`)
      .send({ vehiclePlate: plate, driverName: 'สมชาย', driverPhone: phone })
      .expect(409);
    expect(acc.body.code).toBe('offer_closed');
    // ไม่มีลิงก์ที่ใช้ได้ของการจ้างปัจจุบัน
    expect((await api(app, admin).get(`/v1/trips/${t.id}/offer-link`).expect(200)).body.link).toBe(
      null,
    );
    // จ้างรายถัดไป → SO กลับวางแผนแล้ว (เคลียร์เหตุค้าง) + ลิงก์ใหม่ของรายใหม่
    const C2 = await newCarrier();
    const l2 = await hire(t.id, C2.id, '5900');
    expect((await so(t.soId)).status).toBe('PLANNED');
    expect(l2.offerId).not.toBe(link.offerId);
    const hist = (await api(app, admin).get(`/v1/trips/${t.id}/offers`).expect(200)).body.data;
    expect(hist.map((h: { status: string }) => h.status)).toEqual(['OFFERED', 'REJECTED']);
    expect(hist[1]).toMatchObject({
      rejectReason: 'VEHICLE_UNAVAILABLE',
      rejectNote: 'รถเข้าศูนย์',
      respondedVia: 'LINK',
    });
  });

  it('ลิงก์: ผิด/ปลอม/หมดอายุ/purpose อื่น → 404 · ยกเลิกเที่ยวและออกลิงก์ใหม่ → ลิงก์เดิมใช้ไม่ได้', async () => {
    const { t, link } = await offered();
    await pub()
      .get(`/v1/public/offers/${link.token.slice(0, -3)}AAA`)
      .expect(404);
    await pub().get('/v1/public/offers/nonsense').expect(404);
    // ลิงก์ของชนิดอื่น (เอกสารรถร่วม) ใช้กับข้อเสนอไม่ได้
    const C = await newCarrier();
    const docs = (
      await api(app, admin).post(`/v1/carriers/${C.id}/upload-links`).send({}).expect(201)
    ).body as { token: string };
    await pub().get(`/v1/public/offers/${docs.token}`).expect(404);
    // ลิงก์ trip_offer ที่ชี้ชนิดอื่น (ไม่ใช่ subcon_offer) → 404
    const exp = new Date(Math.floor(Date.now() / 1000 + 3600) * 1000);
    const forged = await db.magicLink.create({
      data: {
        tenantId,
        purpose: 'trip_offer',
        entityType: 'trip',
        entityId: uuid('trip', t.id),
        actions: ['offer.view', 'offer.respond'],
        scopes: [],
        expiresAt: exp,
      },
    });
    await pub()
      .get(`/v1/public/offers/${encodeLinkToken(forged.id, exp.getTime() / 1000)}`)
      .expect(404);
    // หมดอายุ
    const old = await db.magicLink.create({
      data: {
        tenantId,
        purpose: 'trip_offer',
        entityType: 'subcon_offer',
        entityId: uuid('subconOffer', link.offerId),
        actions: ['offer.view'],
        scopes: [],
        expiresAt: new Date(Math.floor(Date.now() / 1000 - 10) * 1000),
      },
    });
    await pub()
      .get(
        `/v1/public/offers/${encodeLinkToken(old.id, Math.floor(old.expiresAt.getTime() / 1000))}`,
      )
      .expect(404);
    // ลิงก์ดูอย่างเดียว (ไม่มี offer.respond) กดรับ/ปฏิเสธไม่ได้
    const viewOnly = await db.magicLink.create({
      data: {
        tenantId,
        purpose: 'trip_offer',
        entityType: 'subcon_offer',
        entityId: old.entityId,
        actions: ['offer.view'],
        scopes: [],
        expiresAt: exp,
      },
    });
    const vt = encodeLinkToken(viewOnly.id, exp.getTime() / 1000);
    await pub().get(`/v1/public/offers/${vt}`).expect(200);
    await pub()
      .post(`/v1/public/offers/${vt}/reject`)
      .send({ reason: 'PRICE_TOO_LOW' })
      .expect(404);

    // ออกลิงก์ใหม่ → ลิงก์เดิม 404 · อายุเท่าเดิม
    const n = (await api(app, admin).post(`/v1/trips/${t.id}/offer-link`).expect(201)).body;
    expect(n.url).not.toBe(link.url);
    expect(Math.abs(Date.parse(n.expiresAt) - Date.parse(link.expiresAt))).toBeLessThan(2000);
    await pub().get(`/v1/public/offers/${link.token}`).expect(404);
    const nt = new URL(n.url).pathname.split('/').pop()!;
    await pub().get(`/v1/public/offers/${nt}`).expect(200);
    expect(
      await db.auditLog.count({
        where: { action: 'subcon_offer.links_revoked', entityId: uuid('trip', t.id) },
      }),
    ).toBe(1);
    // ยกเลิกเที่ยว → ลิงก์ถูกเพิกถอน
    const cur = (await trip(t.id)).body;
    await api(app, admin)
      .post(`/v1/trips/${t.id}/cancel`)
      .set('If-Match', `"${cur.version}"`)
      .send({ reason: 'ลูกค้ายกเลิกงานทั้งเที่ยว' })
      .expect(200);
    await pub().get(`/v1/public/offers/${nt}`).expect(404);
    expect((await api(app, admin).get(`/v1/trips/${t.id}/offer-link`).expect(200)).body.link).toBe(
      null,
    );
  });

  it('ส่งลิงก์ทาง SMS (ST3-T21) → ผู้รับ = รถร่วมของการจ้าง + เลขเที่ยวในข้อความ · ประวัติแสดงการส่ง · ข้อเสนอปิดแล้วส่งไม่ได้', async () => {
    await api(app, admin).patch('/v1/settings/messaging').send({ smsEnabled: true }).expect(200);
    const { t, link } = await offered();
    const m = await api(app, admin)
      .post('/v1/messages/send-link')
      .send({ channel: 'sms', url: link.url })
      .expect(202);
    expect(m.body).toMatchObject({
      channel: 'sms',
      template: 'job_offer_link',
      entityType: 'subcon_offer',
      entityId: link.offerId,
      linkId: link.linkId,
    });
    const row = await db.messageDelivery.findUniqueOrThrow({
      where: { id: uuid('messageDelivery', m.body.id) },
    });
    expect((row.vars as { ref?: string }).ref).toBe(t.tripNo);
    const hist = (await api(app, admin).get(`/v1/trips/${t.id}/offers`).expect(200)).body.data;
    expect(hist[0].messages).toEqual([
      expect.objectContaining({ id: m.body.id, channel: 'sms', recipient: expect.any(String) }),
    ]);
    await pub()
      .post(`/v1/public/offers/${link.token}/reject`)
      .send({ reason: 'ROUTE_INCONVENIENT' })
      .expect(200);
    const closed = await api(app, admin)
      .post('/v1/messages/send-link')
      .send({ channel: 'sms', url: link.url })
      .expect(422);
    expect(closed.body.errors[0].code).toBe('offer_closed');
  });

  it('ผู้จัดรถรับงานแทน (/assign) → ACCEPTED ทาง USER · สิทธิ์: viewer ดูลิงก์/ออกใหม่ไม่ได้ (403) และไม่เห็นราคาซื้อในประวัติ', async () => {
    const { t, v, d, link } = await offered();
    await api(app, viewer).get(`/v1/trips/${t.id}/offer-link`).expect(403);
    await api(app, viewer).post(`/v1/trips/${t.id}/offer-link`).expect(403);
    const h = (await api(app, viewer).get(`/v1/trips/${t.id}/offers`).expect(200)).body.data;
    expect(h[0].buyAmount).toBeUndefined();
    expect(h[0].status).toBe('OFFERED');
    const cur = (await trip(t.id)).body;
    await api(app, admin)
      .post(`/v1/trips/${t.id}/assign`)
      .set('If-Match', `"${cur.version}"`)
      .send({ vehicleId: v.id, driverId: d.id })
      .expect(200);
    const o = await db.subconOffer.findUniqueOrThrow({
      where: { id: uuid('subconOffer', link.offerId) },
    });
    expect(o).toMatchObject({
      status: 'ACCEPTED',
      respondedVia: 'USER',
      acceptedDriverName: d.name,
    });
    // รถร่วมเปิดลิงก์เห็นรับงานแล้ว · กดรับซ้ำด้วยคันเดิม = ผลเดิม
    const view = (await pub().get(`/v1/public/offers/${link.token}`).expect(200)).body;
    expect(view).toMatchObject({ status: 'ACCEPTED', accepted: { driverName: d.name } });
  });

  it('constraint: ปฏิเสธผ่านลิงก์ต้องมีรหัสเหตุผล · ทะเบียนที่รับมีได้เฉพาะที่รับแล้ว', async () => {
    const { link } = await offered();
    const id = uuid('subconOffer', link.offerId);
    await expect(
      db.subconOffer.update({
        where: { id },
        data: {
          status: 'REJECTED',
          closedAt: new Date(),
          respondedAt: new Date(),
          respondedVia: 'LINK',
        },
      }),
    ).rejects.toThrow(/subcon_offer_response/);
    await expect(
      db.subconOffer.update({ where: { id }, data: { acceptedPlate: '70-1234' } }),
    ).rejects.toThrow(/subcon_offer_response/);
    await expect(
      db.subconOffer.update({ where: { id }, data: { respondedVia: 'LINK' } }),
    ).rejects.toThrow(/subcon_offer_response/);
  });

  it('ค้าง CARRIER_REJECTED คงอยู่เมื่อ attach/assign/detach เที่ยวอื่นของ SO เดียวกัน · เคลียร์เมื่อจัดรถเที่ยวที่ถูกปฏิเสธ (review M1)', async () => {
    const C = await newCarrier();
    const t = await newTrip({ split: true });
    const link = await hire(t.id, C.id);
    await pub()
      .post(`/v1/public/offers/${link.token}/reject`)
      .send({ reason: 'PRICE_TOO_LOW' })
      .expect(200);
    const held = async () => {
      const x = await so(t.soId);
      expect([x.status, x.holdReasonCode?.code]).toEqual(['ON_HOLD', 'CARRIER_REJECTED']);
    };
    await held();
    // DO ที่สองของ SO เดียวกัน → เที่ยวใหม่ (attach) → ยังค้าง
    const b = (
      await api(app, admin)
        .post('/v1/trips')
        .send({ tripDate: today, deliveryOrderIds: [t.extraDo] })
        .expect(201)
    ).body as { id: string; version: number };
    await held();
    // จัดรถบริษัทให้เที่ยวอื่น (assign) → ยังค้าง
    const own = (
      await api(app, admin)
        .post('/v1/vehicles')
        .send({
          plate: `79-${String(9000 + ++seed)}`,
          plateProvince: 'TH-10',
          vehicleTypeId: vt6,
          ownership: 'OWN',
        })
        .expect(201)
    ).body as { id: string };
    const drv = (
      await api(app, admin)
        .post('/v1/drivers')
        .send({
          name: `คนขับบริษัท ${++seed}`,
          phone: `09${String(10_000_000 + seed).slice(-8)}`,
          employmentType: 'EMPLOYEE_SALARIED',
          licenceClass: 'T2',
          licenceExpiresOn: day(300),
        })
        .expect(201)
    ).body as { id: string };
    const assign = async (id: string) => {
      const cur = (await trip(id)).body;
      const body = { vehicleId: own.id, driverId: drv.id };
      const r = await api(app, admin)
        .post(`/v1/trips/${id}/assign`)
        .set('If-Match', `"${cur.version}"`)
        .send(body);
      if (r.status === 409 && r.body.code === 'assignment_blocked')
        await api(app, admin)
          .post(`/v1/trips/${id}/assign`)
          .set('If-Match', `"${cur.version}"`)
          .send({
            ...body,
            ruleKeys: (r.body.blocks as { key: string }[]).map((x) => x.key),
            overrideReason: 'ทดสอบยกเว้นเอกสารรถ',
          })
          .expect(200);
      else expect(r.status, JSON.stringify(r.body)).toBe(200);
    };
    await assign(b.id);
    await held();
    // ถอด DO ออกจากเที่ยวอื่น (detach) → ยังค้าง
    const bt = (await trip(b.id)).body;
    await api(app, admin)
      .post(`/v1/trips/${b.id}/detach`)
      .set('If-Match', `"${bt.version}"`)
      .send({ deliveryOrderIds: [t.extraDo] })
      .expect(200);
    await held();
    // จัดรถให้เที่ยวที่ถูกปฏิเสธ → เคลียร์
    await assign(t.id);
    expect((await so(t.soId)).status).toBe('PLANNED');
  });

  it('ถอด DO ออกจากเที่ยวที่ถูกปฏิเสธ → ยังค้าง · จัดลงเที่ยวใหม่ → เคลียร์', async () => {
    const C = await newCarrier();
    const t = await newTrip();
    const link = await hire(t.id, C.id);
    await pub()
      .post(`/v1/public/offers/${link.token}/reject`)
      .send({ reason: 'ROUTE_INCONVENIENT' })
      .expect(200);
    const tr = (await trip(t.id)).body;
    const doId = tr.deliveryOrders[0].id as string;
    await api(app, admin)
      .post(`/v1/trips/${t.id}/detach`)
      .set('If-Match', `"${tr.version}"`)
      .send({ deliveryOrderIds: [doId] })
      .expect(200);
    expect((await so(t.soId)).holdReasonCode?.code).toBe('CARRIER_REJECTED');
    await api(app, admin)
      .post('/v1/trips')
      .send({ tripDate: today, deliveryOrderIds: [doId] })
      .expect(201);
    expect((await so(t.soId)).status).toBe('PLANNED');
  });

  it('สองเครื่อง: รับงาน ∥ ปฏิเสธ พร้อมกัน → ชนะหนึ่งเดียว สถานะสอดคล้อง', async () => {
    const { t, plate, phone, link } = await offered();
    const [a, r] = await Promise.all([
      pub()
        .post(`/v1/public/offers/${link.token}/accept`)
        .send({ vehiclePlate: plate, driverName: 'สมชาย', driverPhone: phone }),
      pub().post(`/v1/public/offers/${link.token}/reject`).send({ reason: 'PRICE_TOO_LOW' }),
    ]);
    expect([a.status, r.status].sort()).toEqual([200, 409]);
    const tr = (await trip(t.id)).body;
    const o = await db.subconOffer.findUniqueOrThrow({
      where: { id: uuid('subconOffer', link.offerId) },
    });
    if (a.status === 200) {
      expect(tr.status).toBe('ASSIGNED');
      expect(o.status).toBe('ACCEPTED');
      expect((await so(t.soId)).status).toBe('PLANNED');
    } else {
      expect(tr.status).toBe('PLANNING');
      expect(o.status).toBe('REJECTED');
      expect((await so(t.soId)).holdReasonCode?.code).toBe('CARRIER_REJECTED');
    }
    expect((a.status === 409 ? a : r).body.code).toBe('offer_closed');
  });

  it('จ้างรายใหม่หลังถูกปฏิเสธ → ลิงก์ของรายเดิมถูกเพิกถอน (review L5) · ก่อนจ้างใหม่ยังเปิดดูผลได้', async () => {
    const { t, link } = await offered();
    await pub()
      .post(`/v1/public/offers/${link.token}/reject`)
      .send({ reason: 'PRICE_TOO_LOW' })
      .expect(200);
    await pub().get(`/v1/public/offers/${link.token}`).expect(200);
    const C2 = await newCarrier();
    await hire(t.id, C2.id);
    await pub().get(`/v1/public/offers/${link.token}`).expect(404);
  });

  it('เวลาหมดระหว่างรอ (หลังล็อก) → 409 offer_closed · offer-link บอกช่องทางที่ส่งได้ · เจ้าของเห็นราคาขายของเที่ยวที่รอตอบ', async () => {
    const { t, plate, phone, link } = await offered();
    const l = (await api(app, admin).get(`/v1/trips/${t.id}/offer-link`).expect(200)).body;
    expect(l.channels).toEqual({ line: false, sms: expect.any(Boolean) });
    // ราคาขาย/กำไรของ drawer รอตอบ (hire-options) ไม่ถูกตัดสำหรับเจ้าของ (review: ต้นแบบ)
    // รายได้ DO (ST6 จะเขียน — ตอนนี้ตั้งตรงในฐาน)
    await db.deliveryOrder.updateMany({
      where: { tripId: uuid('trip', t.id) },
      data: { revenueAmount: '7800.00' },
    });
    const h = (await api(app, admin).get(`/v1/trips/${t.id}/hire-options`).expect(200)).body;
    expect(h.sellAmount).toBe('7800.00');
    // ไม่มี prices.sell:read → ตัดราคาขาย (ไม่ใช่ตัดผิดฝั่ง)
    const buyOnly = await tokenFor(tenantId, 'trips:read trips:assign prices.buy:read', 'u-buy');
    const hb = (await api(app, buyOnly).get(`/v1/trips/${t.id}/hire-options`).expect(200)).body;
    expect(hb.sellAmount).toBeUndefined();
    expect(hb.options.length).toBeGreaterThan(0);
    await db.subconOffer.update({
      where: { id: uuid('subconOffer', link.offerId) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const r = await pub()
      .post(`/v1/public/offers/${link.token}/accept`)
      .send({ vehiclePlate: plate, driverName: 'สมชาย', driverPhone: phone })
      .expect(409);
    expect(r.body.code).toBe('offer_closed');
    expect((await trip(t.id)).body.status).toBe('OFFERED');
  });
});
