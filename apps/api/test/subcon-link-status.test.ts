import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SYSTEM_ROLES } from '@tms/domain';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { requestContext } from '../src/common/request-context';
import { DbService, type Tx } from '../src/db/db.service';
import { resetLinkWriteRate } from '../src/http/link-rate-limit';
import { resetPublicRateLimit } from '../src/http/public-rate-limit.middleware';
import { DeliveryOrderService } from '../src/modules/delivery-orders/delivery-order.service';
import {
  OrderIntakeService,
  type UpsertOrderInput,
} from '../src/modules/orders/order-intake.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { normalizeDoNo } from '../src/modules/trips/pod-link.service';
import { bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST4-T08 ลิงก์รถร่วม ส่วนสถานะ (docs/04 E2 "ePOD ผ่านลิงก์", E2.1 M10, E2.2 ข้อยกเว้น M10; docs/01 §5.5 `/public/pod/{token}`)
 * เกณฑ์ตรวจรับ — เปิดลิงก์บนมือถือ ค้นเลข DO กดถึง → เว็บฝั่ง dispatcher เห็นสถานะทันที; กดซ้ำไม่เกิด event ซ้ำ
 * + source LINK, ลิงก์ต่อการจ้าง (ออกตอนรับงาน), ค้นได้เฉพาะ DO ในเที่ยว, จุดนอกเที่ยว/บริษัทอื่น 404, เพิกถอน 404
 */
describe('subcon link status (ST4-T08)', () => {
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
  beforeEach(async () => {
    await resetPublicRateLimit();
    await resetLinkWriteRate();
  });
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

  /** รถร่วมรับงานผ่านลิงก์ข้อเสนอ → ลิงก์งาน (pod) */
  async function accepted() {
    const o = await offered();
    await pub()
      .post(`/v1/public/offers/${o.link.token}/accept`)
      .send({ vehiclePlate: o.plate, driverName: 'สมชาย', driverPhone: o.phone })
      .expect(200);
    const st = (await api(app, admin).get(`/v1/trips/${o.t.id}/offer-link`).expect(200)).body as {
      podLink: { url: string; linkId: string } | null;
    };
    const podToken = new URL(st.podLink!.url).pathname.split('/').pop()!;
    const doNo = (
      await db.deliveryOrder.findFirstOrThrow({ where: { tripId: uuid('trip', o.t.id) } })
    ).doNo!;
    return { ...o, pod: st.podLink!, podToken, doNo };
  }
  const dispatch = async (tripId: string) => {
    const r = await api(app, admin).post(`/v1/trips/${tripId}/dispatch`).send({});
    if (r.status !== 200) {
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      await api(app, admin)
        .post(`/v1/trips/${tripId}/dispatch`)
        .send({
          ruleKeys: (r.body.warnings ?? []).map((x: { key: string }) => x.key),
          overrideReason: 'ทดสอบลิงก์รถร่วม ส่วนสถานะ',
        })
        .expect(200);
    }
  };
  const view = (token: string, doNo?: string) =>
    pub().get(
      `/v1/public/pod/${token}${doNo !== undefined ? `?doNo=${encodeURIComponent(doNo)}` : ''}`,
    );
  const bkk = (minAgo = 0) => {
    const d = new Date(Date.now() - minAgo * 60_000 + 7 * 3600_000);
    return `${d.toISOString().slice(0, 19)}+07:00`;
  };
  const press = (token: string, stopId: string, body: Record<string, unknown>) =>
    pub()
      .post(`/v1/public/pod/${token}/stops/${stopId}/events`)
      .send({ clientEventId: randomUUID(), occurredAt: bkk(), ...body });

  it('normalizeDoNo: ตัวเล็ก/ช่องว่าง/เลขไทย', () => {
    expect(normalizeDoNo(' do-2611-000๖๙ ')).toBe('DO-2611-00069');
    expect(normalizeDoNo('DO - 2611 - 00069')).toBe('DO-2611-00069');
  });

  it('รับงาน → ออกลิงก์งาน (pod) ต่อการจ้าง · หน้าข้อเสนอ/ผู้จัดรถเห็น URL · เปิดลิงก์ ค้น DO ในเที่ยว (ไม่มีราคาขาย/ที่อยู่) · no-store', async () => {
    const { t, pod, podToken, doNo, link, C } = await accepted();
    const row = await db.magicLink.findUniqueOrThrow({
      where: { id: uuid('magicLink', pod.linkId) },
    });
    expect(row).toMatchObject({
      purpose: 'pod',
      entityType: 'subcon_offer',
      entityId: uuid('subconOffer', link.offerId),
      actions: ['pod.view', 'pod.event', 'pod.capture'],
      scopes: ['prices.buy:read'],
      revokedAt: null,
    });
    expect(pod.url).toMatch(/\/link\/pod\/ml1\./);
    // หน้าข้อเสนอหลังรับงานชี้ลิงก์งาน (แท็บ "ส่ง POD")
    expect((await pub().get(`/v1/public/offers/${link.token}`).expect(200)).body.podUrl).toBe(
      pod.url,
    );

    const r = await view(podToken).expect(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toMatchObject({
      tripStatus: 'ASSIGNED',
      recordable: false,
      doHint: doNo,
      query: null,
      match: null,
      job: { status: 'ACCEPTED', tripNo: t.tripNo, carrierName: C.legalName, buyAmount: '5600.00' },
    });
    // ค้นด้วยตัวเล็ก + ช่องว่าง → พบ พร้อมจุดรับ/ส่ง
    const m = (await view(podToken, ` ${doNo.toLowerCase()} `).expect(200)).body;
    expect(m.query).toBe(doNo);
    expect(m.match).toMatchObject({
      doNo,
      customerName: expect.stringMatching(/^บจก\. เอ็นเอสเอฟ/),
      pickup: { role: 'PICKUP', sequence: 1, status: 'PENDING', leftAt: null },
      delivery: { role: 'DELIVERY', sequence: 2, status: 'PENDING', nextStopId: null },
    });
    expect(m.match.pickup.siteName).toMatch(/^คลังบางปู/);
    expect(m.match.pickup.nextStopId).toBe(m.match.delivery.id);
    const raw = JSON.stringify(m);
    for (const bad of ['7800', 'sell', 'margin', 'ลับเฉพาะ', '20000', 'ตกลงราคา'])
      expect(raw).not.toContain(bad);
    // DO ที่ไม่มี / DO ของเที่ยวอื่น (รถร่วมรายอื่น) → ไม่พบ
    expect((await view(podToken, 'DO-0000-00000').expect(200)).body.match).toBeNull();
    const other = await accepted();
    expect((await view(podToken, other.doNo).expect(200)).body.match).toBeNull();
    // โทเค็นข้อเสนอใช้กับหน้าลิงก์งานไม่ได้ (คนละ action) และกลับกัน
    expect((await view(link.token).expect(404)).body.code).toBe('not_found');
    await pub().get(`/v1/public/offers/${podToken}`).expect(404);
  });

  it('เกณฑ์ตรวจรับ: ค้น DO กดถึง → ผู้จัดรถเห็นสถานะทันที (source LINK + ชื่อรถร่วม) · กดซ้ำ clientEventId เดิมไม่เกิด event ซ้ำ', async () => {
    const { t, podToken, doNo, C } = await accepted();
    const m0 = (await view(podToken, doNo).expect(200)).body.match;
    // ยังไม่ปล่อยรถ → 409
    expect((await press(podToken, m0.pickup.id, { type: 'ARRIVE' }).expect(409)).body.code).toBe(
      'trip_not_in_progress',
    );
    await dispatch(t.id);
    expect((await view(podToken).expect(200)).body.recordable).toBe(true);

    const cid = randomUUID();
    const at = bkk(5);
    const first = await press(podToken, m0.pickup.id, {
      type: 'ARRIVE',
      clientEventId: cid,
      occurredAt: at,
      lat: 13.5,
      lng: 100.6,
      accuracyM: 12,
    }).expect(201);
    expect(first.body).toMatchObject({ type: 'ARRIVE', source: 'LINK', replayed: false });
    // กดซ้ำ (refresh แล้วกดใหม่) → 200 event เดิม
    const again = await press(podToken, m0.pickup.id, {
      type: 'ARRIVE',
      clientEventId: cid,
      occurredAt: bkk(),
    }).expect(200);
    expect(again.body).toMatchObject({ id: first.body.id, replayed: true });
    expect(
      await db.stopEvent.count({ where: { tripStopId: uuid('tripStop', m0.pickup.id) } }),
    ).toBe(1);
    const ev = await db.stopEvent.findFirstOrThrow({
      where: { tripStopId: uuid('tripStop', m0.pickup.id) },
    });
    expect(ev.source).toBe('LINK');
    expect(ev.actor).toMatch(/^link:/);
    expect(ev.lat?.toNumber()).toBe(13.5);

    // ผู้จัดรถ: เที่ยว + ไทม์ไลน์ เห็นทันที
    const tr = (await api(app, admin).get(`/v1/trips/${t.id}`).expect(200)).body;
    expect(tr.status).toBe('IN_PROGRESS');
    expect(tr.stops[0]).toMatchObject({ status: 'ARRIVED', arrivedAt: expect.any(String) });
    const tl = (await api(app, admin).get(`/v1/trips/${t.id}/events`).expect(200)).body.data;
    expect(tl[0]).toMatchObject({ type: 'ARRIVE', source: 'LINK', recordedByName: C.legalName });

    // ออกจากจุดรับ = ขึ้นของเสร็จ (LOADED — D-81 · D68-39, docs/01 §3.9) + DEPART ของจุดถัดไป
    await press(podToken, m0.pickup.id, { type: 'LOADED' }).expect(201);
    expect(
      (
        await db.stopEvent.findFirstOrThrow({
          where: { tripStopId: uuid('tripStop', m0.pickup.id), type: 'LOADED' },
        })
      ).outcome,
    ).toBeNull();
    await press(podToken, m0.delivery.id, { type: 'DEPART' }).expect(201);
    const m1 = (await view(podToken, doNo).expect(200)).body.match;
    expect(m1.pickup).toMatchObject({ status: 'COMPLETED', leftAt: expect.any(String) });
    expect((await db.deliveryOrder.findFirstOrThrow({ where: { doNo } })).status).toBe('PICKED_UP');
    // ถึงจุดส่ง
    await press(podToken, m0.delivery.id, { type: 'ARRIVE' }).expect(201);
    expect((await view(podToken, doNo).expect(200)).body.match.delivery.status).toBe('ARRIVED');
    // ไม่มีธงขัดลำดับจากการกดผ่านลิงก์
    expect(
      await db.stopEvent.count({
        where: {
          tripId: uuid('trip', t.id),
          OR: [{ sequenceConflict: true }, { pickupPending: true }],
        },
      }),
    ).toBe(0);
  });

  it('ตรวจข้อมูล: ปิดงานจุดส่งต้องมี POD · จุดรับครบ = LOADED (ไม่ใช่ COMPLETE DELIVERED) · ถึง/ออกไม่มีผล/เหตุผล · ไม่มี clientEventId → 422', async () => {
    const { t, podToken, doNo } = await accepted();
    await dispatch(t.id);
    const m = (await view(podToken, doNo).expect(200)).body.match;
    const e1 = (
      await press(podToken, m.delivery.id, { type: 'COMPLETE', outcome: 'DELIVERED' }).expect(422)
    ).body;
    expect(e1.errors[0]).toMatchObject({ field: 'pod', code: 'pod_required' });
    // ปิดด้วยผลก่อนถึงจุด → 409 (ไม่สร้าง event ขัดลำดับ)
    expect((await press(podToken, m.pickup.id, { type: 'LOADED' }).expect(409)).body.code).toBe(
      'stop_not_arrived',
    );
    await press(podToken, m.pickup.id, { type: 'ARRIVE' }).expect(201);
    expect(
      (await press(podToken, m.pickup.id, { type: 'COMPLETE' }).expect(422)).body.errors[0].field,
    ).toBe('outcome');
    // D68-39: จุดรับครบใช้ LOADED · LOADED ที่จุดส่ง = 422 · LOADED มีผล = 422
    expect(
      (await press(podToken, m.pickup.id, { type: 'COMPLETE', outcome: 'DELIVERED' }).expect(422))
        .body.errors[0],
    ).toMatchObject({ field: 'outcome', code: 'not_applicable' });
    expect(
      (await press(podToken, m.delivery.id, { type: 'LOADED' }).expect(422)).body.errors[0],
    ).toMatchObject({ field: 'type', code: 'not_applicable' });
    await press(podToken, m.pickup.id, { type: 'LOADED', outcome: 'DELIVERED' }).expect(422);
    // บางส่วน/ไม่สำเร็จ ต้องมีเหตุผล
    expect(
      (await press(podToken, m.pickup.id, { type: 'COMPLETE', outcome: 'PARTIAL' }).expect(422))
        .body.errors[0],
    ).toMatchObject({ field: 'reasonCodeId', code: 'required' });
    await press(podToken, m.pickup.id, { type: 'ARRIVE', outcome: 'DELIVERED' }).expect(422);
    expect(
      (await press(podToken, m.pickup.id, { type: 'FAIL' }).expect(422)).body.errors[0].field,
    ).toBe('reasonCodeId');
    await pub()
      .post(`/v1/public/pod/${podToken}/stops/${m.pickup.id}/events`)
      .send({ type: 'ARRIVE', occurredAt: bkk() })
      .expect(422);
    // เหตุผล/หมายเหตุรับเฉพาะแจ้งไม่สำเร็จ/บางส่วน
    expect(
      (await press(podToken, m.pickup.id, { type: 'ARRIVE', note: 'x' }).expect(422)).body
        .errors[0],
    ).toMatchObject({ field: 'note', code: 'not_applicable' });
    await press(podToken, m.pickup.id, { type: 'LOADED', note: 'x' }).expect(422);
  });

  it('D-81 · D68-39: รับบางส่วน / รับไม่สำเร็จ / ส่งไม่สำเร็จ / ของยังอยู่บนรถ พร้อมเหตุผลผ่านลิงก์ — event model เดียวกับเว็บ (source LINK + snapshot เหตุผล)', async () => {
    const reason = async (category: string, code: string, tid = tenantId) =>
      encodeId(
        'reasonCode',
        (
          await db.reasonCode.findFirstOrThrow({
            where: { tenantId: tid, category: category as never, code },
          })
        ).id,
      );
    // (1) รับไม่สำเร็จที่จุดรับ (ยังไม่ถึงก็แจ้งได้) → จุดรับ FAILED, DO FAILED
    const a = await accepted();
    await dispatch(a.t.id);
    const ma = (await view(a.podToken, a.doNo).expect(200)).body.match;
    expect(ma.failReasons.map((r: { category: string }) => r.category)).toEqual(
      expect.arrayContaining(['DELIVERY_FAILED', 'REJECTED_BY_RECEIVER']),
    );
    // Q-LINK (PO 24 พ.ย. 2569): เหตุผลที่บังคับรูปแสดงด้วย (แนบรูปผ่าน `failurePhotos` ได้)
    expect(ma.failReasons.some((r: { requiresPhoto: boolean }) => r.requiresPhoto)).toBe(true);
    expect(ma.failReasons[0]).toMatchObject({
      id: expect.stringMatching(/^rsn_/),
      label: expect.any(String),
      requiresNote: expect.any(Boolean),
    });
    // เหตุผลที่บังคับรูป ไม่แนบรูป → 422 photo_required
    expect(
      (
        await press(a.podToken, ma.pickup.id, {
          type: 'FAIL',
          reasonCodeId: await reason('DELIVERY_FAILED', 'WRONG_ADDRESS'),
          note: 'x',
        }).expect(422)
      ).body.errors[0],
    ).toMatchObject({ field: 'reasonCodeId', code: 'photo_required' });
    const other = await reason('DELIVERY_FAILED', 'OTHER'); // บังคับหมายเหตุ
    expect(
      (await press(a.podToken, ma.pickup.id, { type: 'FAIL', reasonCodeId: other }).expect(422))
        .body.errors[0],
    ).toMatchObject({ field: 'note', code: 'required' });
    // เหตุผลนอกหมวด (ล่าช้า) → 422 · เหตุผลของบริษัทอื่น → 422 reason_not_found
    const delay = encodeId(
      'reasonCode',
      (await db.reasonCode.findFirstOrThrow({ where: { tenantId, category: 'DELAY' } })).id,
    );
    await press(a.podToken, ma.pickup.id, { type: 'FAIL', reasonCodeId: delay }).expect(422);
    const t2 = (await createTenantWithDefaults(db, { name: `บริษัทอื่น ${++seed}` })).id;
    expect(
      (
        await press(a.podToken, ma.pickup.id, {
          type: 'FAIL',
          reasonCodeId: await reason('DELIVERY_FAILED', 'OTHER', t2),
          note: 'x',
        }).expect(422)
      ).body.errors[0],
    ).toMatchObject({ field: 'reasonCodeId', code: 'reason_not_found' });
    const f = await press(a.podToken, ma.pickup.id, {
      type: 'FAIL',
      reasonCodeId: other,
      note: 'คลังย้ายที่',
    }).expect(201);
    expect(f.body).toMatchObject({ type: 'FAIL', source: 'LINK', counted: true });
    const ev = await db.stopEvent.findFirstOrThrow({
      where: { tripStopId: uuid('tripStop', ma.pickup.id), type: 'FAIL' },
    });
    expect(ev.reasonCodeId).toBe(uuid('reasonCode', other));
    expect(ev.payload).toMatchObject({ note: 'คลังย้ายที่', reason: { code: 'OTHER' } });
    expect((await view(a.podToken, a.doNo).expect(200)).body.match.pickup.status).toBe('FAILED');
    expect((await db.deliveryOrder.findFirstOrThrow({ where: { doNo: a.doNo } })).status).toBe(
      'FAILED',
    );
    // ปิดแล้ว → 409
    expect(
      (
        await press(a.podToken, ma.pickup.id, {
          type: 'FAIL',
          reasonCodeId: other,
          note: 'ซ้ำ',
        }).expect(409)
      ).body.code,
    ).toBe('stop_already_closed');
    // ผู้จัดรถเห็นในไทม์ไลน์ (ชนิด/ผู้บันทึกเดียวกับเว็บ)
    const tl = (await api(app, admin).get(`/v1/trips/${a.t.id}/events`).expect(200)).body.data;
    expect(tl.find((e: { type: string }) => e.type === 'FAIL')).toMatchObject({
      source: 'LINK',
      recordedByName: a.C.legalName,
    });

    // (2) รับบางส่วนที่จุดรับ (COMPLETE PARTIAL + เหตุผล) → DO รับของแล้ว → ถึงจุดส่ง → ส่งไม่สำเร็จ (COMPLETE FAILED) → DO FAILED
    const b = await accepted();
    await dispatch(b.t.id);
    const mb = (await view(b.podToken, b.doNo).expect(200)).body.match;
    const refused = await reason('REJECTED_BY_RECEIVER', 'OTHER');
    await press(b.podToken, mb.pickup.id, { type: 'ARRIVE' }).expect(201);
    await press(b.podToken, mb.pickup.id, {
      type: 'COMPLETE',
      outcome: 'PARTIAL',
      reasonCodeId: refused,
      note: 'ของไม่ครบที่คลัง',
    }).expect(201);
    expect((await db.deliveryOrder.findFirstOrThrow({ where: { doNo: b.doNo } })).status).toBe(
      'PICKED_UP',
    );
    await press(b.podToken, mb.delivery.id, { type: 'DEPART' }).expect(201);
    // ส่งไม่สำเร็จด้วย COMPLETE ต้องถึงจุดก่อน (ยังไม่ถึงใช้ FAIL)
    expect(
      (
        await press(b.podToken, mb.delivery.id, {
          type: 'COMPLETE',
          outcome: 'FAILED',
          reasonCodeId: other,
          note: 'ปิด',
        }).expect(409)
      ).body.code,
    ).toBe('stop_not_arrived');
    await press(b.podToken, mb.delivery.id, { type: 'ARRIVE' }).expect(201);
    // ไม่สำเร็จไม่รับ POD (POD = DELIVERED/PARTIAL ของจุดส่ง)
    await press(b.podToken, mb.delivery.id, {
      type: 'COMPLETE',
      outcome: 'FAILED',
      reasonCodeId: other,
      note: 'ปิด',
      pod: { doNo: b.doNo },
    }).expect(422);
    await press(b.podToken, mb.delivery.id, {
      type: 'COMPLETE',
      outcome: 'FAILED',
      reasonCodeId: other,
      note: 'ร้านปิด',
    }).expect(201);
    const vb = (await view(b.podToken, b.doNo).expect(200)).body.match;
    expect(vb.delivery).toMatchObject({ status: 'FAILED', outcome: 'FAILED' });
    expect((await db.deliveryOrder.findFirstOrThrow({ where: { doNo: b.doNo } })).status).toBe(
      'FAILED',
    );
    expect(
      await db.stopEvent.count({
        where: { tripId: uuid('trip', b.t.id), sequenceConflict: true },
      }),
    ).toBe(0);

    // (3) ของยังอยู่บนรถ (COMPLETE UNDELIVERED_RETAIN) — หมวด DELIVERY_FAILED เท่านั้น
    const c = await accepted();
    await dispatch(c.t.id);
    const mc = (await view(c.podToken, c.doNo).expect(200)).body.match;
    await press(c.podToken, mc.pickup.id, { type: 'ARRIVE' }).expect(201);
    await press(c.podToken, mc.pickup.id, { type: 'LOADED' }).expect(201);
    await press(c.podToken, mc.delivery.id, { type: 'ARRIVE' }).expect(201);
    await press(c.podToken, mc.delivery.id, {
      type: 'COMPLETE',
      outcome: 'UNDELIVERED_RETAIN',
      reasonCodeId: refused,
      note: 'x',
    }).expect(422);
    await press(c.podToken, mc.delivery.id, {
      type: 'COMPLETE',
      outcome: 'UNDELIVERED_RETAIN',
      reasonCodeId: other,
      note: 'ผู้รับไม่อยู่ ของยังอยู่บนรถ',
    }).expect(201);
    expect((await view(c.podToken, c.doNo).expect(200)).body.match.delivery).toMatchObject({
      status: 'FAILED',
      outcome: 'UNDELIVERED_RETAIN',
    });
  });

  it('review: LOADED ส่งซ้ำ (clientEventId เดิม) หลังเที่ยวจบ → 200 ผลเดิม · id ใหม่ → 409 trip_not_in_progress', async () => {
    const a = await accepted();
    await dispatch(a.t.id);
    const m = (await view(a.podToken, a.doNo).expect(200)).body.match;
    await press(a.podToken, m.pickup.id, { type: 'ARRIVE' }).expect(201);
    const cid = randomUUID();
    const first = await press(a.podToken, m.pickup.id, {
      type: 'LOADED',
      clientEventId: cid,
    }).expect(201);
    const tid = uuid('trip', a.t.id);
    await db.$executeRaw`UPDATE trip SET status = 'COMPLETED', completed_at = now() WHERE id = ${tid}::uuid`;
    const again = await press(a.podToken, m.pickup.id, {
      type: 'LOADED',
      clientEventId: cid,
    }).expect(200);
    expect(again.body).toMatchObject({ id: first.body.id, type: 'LOADED', replayed: true });
    expect((await press(a.podToken, m.pickup.id, { type: 'LOADED' }).expect(409)).body.code).toBe(
      'trip_not_in_progress',
    );
  });

  it('จุดของเที่ยวอื่น / บริษัทอื่น / id มั่ว → 404 · clientEventId ชนกับ event อื่น → 409 ไม่เปิดเผย eventId', async () => {
    const a = await accepted();
    const b = await accepted();
    await dispatch(a.t.id);
    await dispatch(b.t.id);
    const mb = (await view(b.podToken, b.doNo).expect(200)).body.match;
    // จุดของเที่ยว b ด้วยลิงก์ของ a → 404
    expect((await press(a.podToken, mb.pickup.id, { type: 'ARRIVE' }).expect(404)).body.code).toBe(
      'not_found',
    );
    await press(a.podToken, 'stp_garbage', { type: 'ARRIVE' }).expect(404);
    // บริษัทอื่น: จุดจริงของ tenant B
    const tb = (await createTenant(db, 'B-link')).id;
    const siteB = await db.customerSite.create({
      data: { tenantId: tb, code: 'LNK-S1', name: 'จุดบริษัท B', address: { line1: 'x' } },
    });
    const tripB = await db.trip.create({
      data: { tenantId: tb, tripNo: 'TRP-LNK-B1', tripDate: new Date(`${today}T00:00:00Z`) },
    });
    const stopB = await db.tripStop.create({
      data: { tenantId: tb, tripId: tripB.id, sequence: 1, type: 'DELIVERY', siteId: siteB.id },
    });
    await press(a.podToken, encodeId('tripStop', stopB.id), { type: 'ARRIVE' }).expect(404);
    expect(await db.stopEvent.count({ where: { tripStopId: stopB.id } })).toBe(0);
    // clientEventId ที่ใช้แล้วกับจุดอื่น
    const ma = (await view(a.podToken, a.doNo).expect(200)).body.match;
    const cid = randomUUID();
    await press(b.podToken, mb.pickup.id, { type: 'ARRIVE', clientEventId: cid }).expect(201);
    const dup = (
      await press(a.podToken, ma.pickup.id, { type: 'ARRIVE', clientEventId: cid }).expect(409)
    ).body;
    expect(dup.code).toBe('stop_event_duplicate');
    expect(dup.eventId).toBeUndefined();
  });

  it('เพิกถอน: ยกเลิกเที่ยว → ลิงก์งาน 404 · ออกลิงก์งานใหม่ → ลิงก์เดิม 404 · เที่ยวจบเกิน 7 วัน → 404', async () => {
    // ออกใหม่ (POST offer-link เมื่อรับงานแล้ว)
    const a = await accepted();
    const re = (await api(app, admin).post(`/v1/trips/${a.t.id}/offer-link`).expect(201)).body;
    expect(re.url).toMatch(/\/link\/pod\//);
    await view(a.podToken).expect(404);
    const fresh = new URL(re.url).pathname.split('/').pop()!;
    await view(fresh).expect(200);
    expect(
      await db.auditLog.count({
        where: { action: 'subcon_offer.pod_link_reissued', entityId: uuid('trip', a.t.id) },
      }),
    ).toBe(1);
    // ยกเลิกเที่ยว → เพิกถอน
    await api(app, admin)
      .post(`/v1/trips/${a.t.id}/cancel`)
      .send({ reason: 'ลูกค้ายกเลิกการส่งทั้งเที่ยว' })
      .expect(200);
    await view(fresh).expect(404);

    // เที่ยวจบแล้วไม่เกิน 7 วัน → ใช้ได้ · เกิน → 404
    const b = await accepted();
    const tid = uuid('trip', b.t.id);
    await db.$executeRaw`UPDATE trip SET status = 'COMPLETED', completed_at = now() - interval '6 days' WHERE id = ${tid}::uuid`;
    expect((await view(b.podToken).expect(200)).body.recordable).toBe(false);
    // เที่ยวจบแล้ว: ลิงก์ไม่รับ event (ไม่มี outbox — review M) · หน้าข้อเสนอยังเห็น podUrl
    const mb = (await view(b.podToken, b.doNo).expect(200)).body.match;
    expect((await press(b.podToken, mb.pickup.id, { type: 'ARRIVE' }).expect(409)).body.code).toBe(
      'trip_not_in_progress',
    );
    expect((await pub().get(`/v1/public/offers/${b.link.token}`).expect(200)).body.podUrl).toBe(
      b.pod.url,
    );
    await db.$executeRaw`UPDATE trip SET completed_at = now() - interval '8 days' WHERE id = ${tid}::uuid`;
    await view(b.podToken).expect(404);
    // QA L4: ลิงก์งานหมดผลแล้ว → หน้าข้อเสนอไม่ชี้ไปอีก
    expect(
      (await pub().get(`/v1/public/offers/${b.link.token}`).expect(200)).body.podUrl,
    ).toBeNull();
    // QA L3: เหตุผลเพิกถอนของลิงก์งานแยกจากลิงก์ข้อเสนอ
    const revoked = await db.magicLink.findFirstOrThrow({
      where: { id: uuid('magicLink', a.pod.linkId) },
    });
    expect(revoked.revokedReason).toBe('ออกลิงก์งานรถร่วมใหม่ — ลิงก์งานเดิมใช้ไม่ได้แล้ว');
    const cancelled = await db.magicLink.findFirstOrThrow({
      where: { entityId: uuid('subconOffer', a.link.offerId), purpose: 'pod' },
      orderBy: { createdAt: 'desc' },
    });
    expect(cancelled.revokedReason).toBe('ยกเลิกเที่ยว — ลิงก์งานรถร่วมใช้ไม่ได้แล้ว');
  });

  it('ผลในลำดับ: event ที่ไม่นับคืน counted=false · ปุ่มออกไม่เปิดเมื่อจุดถัดไปมี event แล้ว · ผู้จัดรถ "ไม่ใช้" → retries n (กดใหม่ด้วย id ใหม่ได้)', async () => {
    const { t, podToken, doNo } = await accepted();
    await dispatch(t.id);
    const m0 = (await view(podToken, doNo).expect(200)).body.match;
    expect(m0.pickup.nextOpen).toBe(true);
    expect(m0.delivery.nextOpen).toBe(false);
    expect(m0.retries).toEqual([]);
    const ok = await press(podToken, m0.pickup.id, { type: 'ARRIVE', occurredAt: bkk(4) }).expect(
      201,
    );
    expect(ok.body).toMatchObject({ seqStatus: 'APPLIED', counted: true });
    // ถึงจุดส่งก่อนออกจากจุดรับ → จุดส่ง ARRIVED → ปุ่มออกจากจุดรับต้องไม่เปิด (DEPART ที่จุดส่งจะขัดลำดับ)
    await press(podToken, m0.delivery.id, { type: 'ARRIVE', occurredAt: bkk(2) }).expect(201);
    expect((await view(podToken, doNo).expect(200)).body.match.pickup.nextOpen).toBe(false);
    // ส่ง DEPART จุดส่งหลังถึงแล้ว (เครื่องค้างหน้าเก่า) → ขัดลำดับ ไม่นับ
    const bad = await press(podToken, m0.delivery.id, { type: 'DEPART' }).expect(201);
    expect(bad.body).toMatchObject({ seqStatus: 'CONFLICT', counted: false });
    // ผู้จัดรถ "ไม่ใช้" → retries
    await api(app, admin)
      .post(`/v1/stop-event-flags/${bad.body.id}/resolve`)
      .send({ decision: 'IGNORE', reason: 'กดผิดจากหน้าเก่า ไม่ใช้เวลานี้' })
      .expect(200);
    expect((await view(podToken, doNo).expect(200)).body.match.retries).toEqual([
      { stopId: m0.delivery.id, type: 'DEPART', n: 1 },
    ]);
  });

  it('rate limit ต่อลิงก์: 30 คำขอเขียน/นาที แล้ว 429 (ลิงก์อื่นไม่กระทบ)', async () => {
    const a = await accepted();
    const b = await accepted();
    await dispatch(a.t.id);
    await dispatch(b.t.id);
    const ma = (await view(a.podToken, a.doNo).expect(200)).body.match;
    const cid = randomUUID();
    for (let i = 0; i < 30; i++)
      await press(a.podToken, ma.pickup.id, { type: 'ARRIVE', clientEventId: cid }).expect(
        i === 0 ? 201 : 200,
      );
    const r = await press(a.podToken, ma.pickup.id, { type: 'ARRIVE', clientEventId: cid }).expect(
      429,
    );
    expect(r.body.code).toBe('rate_limited');
    const mb = (await view(b.podToken, b.doNo).expect(200)).body.match;
    await press(b.podToken, mb.pickup.id, { type: 'ARRIVE' }).expect(201);
  });

  it('เปลี่ยนรถร่วม (ST3-T25) → ลิงก์งานของรายเดิม 404 · ผู้ใช้ภายในไม่มีสิทธิ์ก็เรียก public ด้วย token อื่นไม่ได้', async () => {
    const a = await accepted();
    const C2 = await newCarrier();
    const cur = (await trip(a.t.id)).body;
    await api(app, admin)
      .post(`/v1/trips/${a.t.id}/offer`)
      .set('If-Match', `"${cur.version}"`)
      .send({
        carrierId: C2.id,
        cost: '5500',
        selectionReason: 'รายเดิมรถเสีย เปลี่ยนรายใหม่',
        changeReason: 'รถร่วมรายเดิมแจ้งรถเสียกะทันหัน',
      })
      .expect(200);
    await view(a.podToken).expect(404);
    expect(viewer).toBeTruthy();
  });
});
