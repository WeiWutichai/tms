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

/**
 * ST6-T01 Cost line (`trip_cost`) — เกณฑ์ตรวจรับ: เที่ยวรถร่วมมีบรรทัด CARRIER_FEE ตั้งแต่จ้าง; แก้ rate card ภายหลังแล้ว
 * snapshot ไม่เปลี่ยน · วงจรชีวิต (เปลี่ยนรถร่วม/ยกเลิก = กลับรายการ ไม่ลบ) · สิทธิ์ราคาซื้อ · ปิดต้นทุน COMPLETED → COSTED
 */
describe('trip costs (ST6-T01)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let otherId: string;
  let admin: string;
  let viewer: string;
  let dispatcher: string;
  let other: string;
  let seed = 0;
  let unitTon: string;
  let vt6: string;
  const today = bangkokToday();
  const uuid = (kind: Parameters<typeof tryDecodeId>[0], id: string) => tryDecodeId(kind, id)!;
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };
  const REASON = 'รายเดิมแจ้งว่ารถเสียกะทันหัน';
  const jur = (n: number) => {
    const base = `0105${String(80_000 + n).padStart(8, '0')}`;
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
    return base + String((11 - (sum % 11)) % 10);
  };

  beforeAll(async () => {
    // ST6-T01c: ปิดต้นทุนเปิดโดยค่าเริ่มต้น (ไม่ตั้ง env)
    delete process.env.TRIP_COSTING_ENABLED;
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท ต้นทุนเที่ยว' })).id;
    otherId = (await createTenantWithDefaults(db, { name: 'บริษัท อื่น' })).id;
    for (const tid of [tenantId, otherId]) {
      const c = await db.company.create({
        data: {
          tenantId: tid,
          legalName: `บริษัท ผู้ออกบิล ${++seed}`,
          taxId: validTaxId(700 + seed),
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
    admin = await tokenFor(tenantId);
    viewer = await tokenFor(tenantId, SYSTEM_ROLES.viewer.permissions.join(' '), 'u-view');
    dispatcher = await tokenFor(tenantId, SYSTEM_ROLES.dispatcher.permissions.join(' '), 'u-disp');
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
    delete process.env.TRIP_COSTING_ENABLED;
    await app.close();
    await db.$disconnect();
  });

  const run = <T>(fn: (tx: Tx) => Promise<T>) =>
    app
      .get(DbService)
      .withTenant(tenantId, (tx) =>
        requestContext.run(
          { requestId: randomUUID(), tenantId, actorId: 'user-test', locale: 'th', tx },
          () => fn(tx),
        ),
      );
  const newSite = async () =>
    (
      await api(app, admin)
        .post('/v1/customer-sites')
        .send({ name: `จุดรับส่ง ${++seed}`, kind: 'DROPOFF', address: ADDR })
        .expect(201)
    ).body.id as string;
  const newCarrier = async () =>
    (
      await api(app, admin)
        .post('/v1/carriers')
        .send({ legalName: `หจก. รถร่วม ${++seed}`, entityType: 'JURISTIC', taxId: jur(seed) })
        .expect(201)
    ).body as { id: string };
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
    return r.body as { id: string };
  };
  const newOrderDo = async (a: string, b: string) => {
    const customer = (
      await api(app, admin)
        .post('/v1/customers')
        .send({ legalName: `ลูกค้า ${++seed}`, taxId: validTaxId(9700 + seed) })
        .expect(201)
    ).body.id as string;
    const input: UpsertOrderInput = {
      source: 'MANUAL',
      customer: { id: uuid('customer', customer) },
      requestedDate: today,
      vehicleTypeId: uuid('vehicleType', vt6),
      stops: [
        { type: 'PICKUP', siteId: uuid('site', a) },
        { type: 'DELIVERY', siteId: uuid('site', b) },
      ],
      lines: [{ description: 'ปูนซีเมนต์', qty: '5', unitId: unitTon, weightKg: '5000' }],
    };
    const { order: so } = await run((tx) => app.get(OrderIntakeService).upsertOrder(input, tx));
    const [d] = await run((tx) => app.get(DeliveryOrderService).listForOrder(so.id, {}, tx));
    return {
      soPub: encodeId('salesOrder', so.id),
      doId: d!.id,
      doPub: encodeId('deliveryOrder', d!.id),
    };
  };
  const newTrip = async (a: string, b: string) => {
    const customer = (
      await api(app, admin)
        .post('/v1/customers')
        .send({ legalName: `ลูกค้า ${++seed}`, taxId: validTaxId(9700 + seed) })
        .expect(201)
    ).body.id as string;
    const input: UpsertOrderInput = {
      source: 'MANUAL',
      customer: { id: uuid('customer', customer) },
      requestedDate: today,
      vehicleTypeId: uuid('vehicleType', vt6),
      stops: [
        { type: 'PICKUP', siteId: uuid('site', a) },
        { type: 'DELIVERY', siteId: uuid('site', b) },
      ],
      lines: [{ description: 'ปูนซีเมนต์', qty: '5', unitId: unitTon, weightKg: '5000' }],
    };
    const { order: so } = await run((tx) => app.get(OrderIntakeService).upsertOrder(input, tx));
    const [d] = await run((tx) => app.get(DeliveryOrderService).listForOrder(so.id, {}, tx));
    return (
      await api(app, admin)
        .post('/v1/trips')
        .send({ tripDate: today, deliveryOrderIds: [encodeId('deliveryOrder', d!.id)] })
        .expect(201)
    ).body as { id: string; version: number };
  };
  /** รถร่วมในชุดนี้ไม่มีรถที่เอกสารบังคับผ่าน (ติดกฎ — ST3-T14) → ต้องมีเหตุผลการเลือกเสมอ */
  const hire = (id: string, body: object) =>
    api(app, admin)
      .post(`/v1/trips/${id}/offer`)
      .send({ selectionReason: 'รายนี้มีรถว่างช่วงเช้า', ...body });
  const costs = (id: string, token = admin) => api(app, token).get(`/v1/trips/${id}/costs`);
  const vehicle = async (carrierId?: string) =>
    uuid(
      'vehicle',
      (
        await api(app, admin)
          .post('/v1/vehicles')
          .send({
            plate: `7${seed % 10}-${String(4000 + ++seed)}`,
            plateProvince: 'TH-10',
            vehicleTypeId: vt6,
            ...(carrierId ? { ownership: 'SUBCONTRACT', carrierId } : { ownership: 'OWN' }),
          })
          .expect(201)
      ).body.id as string,
    );
  /** จำลองเที่ยววิ่งจบ (flow จริงทดสอบใน ST3/ST4 แล้ว) — `accept` = รถร่วมรับงาน (ข้อเสนอ ACCEPTED) */
  const complete = async (tripId: string, o: { carrierId?: string; accept?: boolean } = {}) => {
    const tid = uuid('trip', tripId);
    if (o.accept)
      await db.subconOffer.updateMany({
        where: { tripId: tid, status: 'OFFERED' },
        data: { status: 'ACCEPTED', respondedAt: new Date(), respondedVia: 'USER' },
      });
    await db.trip.update({
      where: { id: tid },
      data: {
        status: 'COMPLETED',
        vehicleId: await vehicle(o.carrierId),
        vehiclePlateSnapshot: 'ทดสอบ',
        vehicleTypeId: uuid('vehicleType', vt6),
        assignmentStatus: o.carrierId ? 'ACCEPTED' : null,
        completedAt: new Date(),
        version: { increment: 1 },
      },
    });
  };
  async function lane() {
    const [a, b] = [await newSite(), await newSite()];
    const A = await newCarrier();
    const B = await newCarrier();
    const ra = await buyRate(A.id, a, b, '5200');
    await buyRate(B.id, a, b, '4800.50');
    return { a, b, A, B, ra };
  }

  it('เกณฑ์ตรวจรับ: จ้างรถร่วม → บรรทัด CARRIER_FEE ทันที · แก้ rate card ภายหลัง snapshot ไม่เปลี่ยน (เที่ยวใหม่ได้ราคาใหม่)', async () => {
    const L = await lane();
    const t = await newTrip(L.a, L.b);
    // ก่อนจ้าง: ไม่มีบรรทัด
    const r0 = await costs(t.id).expect(200);
    expect(r0.body).toMatchObject({
      data: [],
      summary: { tripStatus: 'PLANNING', buyTotal: '0.00', blockers: ['TRIP_NOT_COMPLETED'] },
    });
    await hire(t.id, { carrierId: L.A.id, selectionReason: 'รายนี้มีรถว่างช่วงเช้า' }).expect(200);
    const r1 = await costs(t.id).expect(200);
    expect(r1.body.data).toHaveLength(1);
    const offer = await db.subconOffer.findFirstOrThrow({ where: { tripId: uuid('trip', t.id) } });
    expect(r1.body.data[0]).toMatchObject({
      costType: 'CARRIER_FEE',
      source: 'RATE_CARD',
      sourceType: 'SUBCON_OFFER',
      sourceId: encodeId('subconOffer', offer.id),
      status: 'CONFIRMED',
      carrierId: L.A.id,
      buyAmount: '5200.00',
      buyVatAmount: '0.00',
      vatType: 'EXEMPT_TRANSPORT',
      whtRate: '1.00',
      reversalOfId: null,
      reversedById: null,
      settled: false,
    });
    expect(r1.body.summary).toMatchObject({ buyTotal: '5200.00', pendingCount: 0 });

    // แก้ราคาใน rate card (ฉบับที่ใช้ตอนจ้าง) → บรรทัดของเที่ยวเดิมไม่เปลี่ยน
    await db.rateCard.update({
      where: { id: uuid('rateCard', L.ra.id) },
      data: { unitPrice: '9999.00' },
    });
    const r2 = await costs(t.id).expect(200);
    expect(r2.body.data).toEqual(r1.body.data);
    // เที่ยวใหม่ของเส้นทางเดียวกันคิดจากราคาใหม่
    const t2 = await newTrip(L.a, L.b);
    await hire(t2.id, { carrierId: L.A.id, selectionReason: 'รายนี้มีรถว่างช่วงเช้า' }).expect(200);
    expect((await costs(t2.id).expect(200)).body.data[0].buyAmount).toBe('9999.00');
  });

  it('เปลี่ยนรถร่วม → บรรทัดเดิมกลับรายการ (ไม่ลบ) + บรรทัดใหม่จาก snapshot ของรายใหม่ · ยกเลิกเที่ยว → กลับรายการ', async () => {
    const L = await lane();
    const t = await newTrip(L.a, L.b);
    await hire(t.id, { carrierId: L.B.id }).expect(200);
    await hire(t.id, {
      carrierId: L.A.id,
      selectionReason: 'รายนี้มีรถว่างช่วงเช้า',
      changeReason: REASON,
    }).expect(200);
    const r = await costs(t.id).expect(200);
    const rows = r.body.data as {
      id: string;
      buyAmount: string;
      carrierId: string;
      reversalOfId: string | null;
      reversedById: string | null;
    }[];
    const orig = rows.find((x) => x.buyAmount === '4800.50')!;
    const rev = rows.find((x) => x.buyAmount === '-4800.50')!;
    const neu = rows.find((x) => x.buyAmount === '5200.00')!;
    expect(rows).toHaveLength(3);
    expect(orig).toMatchObject({ carrierId: L.B.id, reversedById: rev.id });
    expect(rev).toMatchObject({ carrierId: L.B.id, reversalOfId: orig.id });
    expect(neu).toMatchObject({ carrierId: L.A.id, reversalOfId: null, reversedById: null });
    expect(r.body.summary.buyTotal).toBe('5200.00');

    await api(app, admin)
      .post(`/v1/trips/${t.id}/cancel`)
      .send({ reason: 'ลูกค้ายกเลิกการส่งทั้งเที่ยว' })
      .expect(200);
    const c = await costs(t.id).expect(200);
    expect(c.body.data).toHaveLength(4);
    expect(c.body.summary).toMatchObject({
      tripStatus: 'CANCELLED',
      buyTotal: '0.00',
      blockers: ['TRIP_NOT_COMPLETED'],
    });
    expect(
      c.body.data.find((x: { reversalOfId: string }) => x.reversalOfId === neu.id),
    ).toMatchObject({ buyAmount: '-5200.00' });
  });

  it('สิทธิ์ราคาซื้อ: ไม่มี prices.buy:read → เห็นบรรทัดแต่ไม่เห็นยอด · ข้ามบริษัท → 404', async () => {
    const L = await lane();
    const t = await newTrip(L.a, L.b);
    await hire(t.id, { carrierId: L.B.id }).expect(200);
    const v = await costs(t.id, viewer).expect(200);
    expect(v.body.data).toHaveLength(1);
    expect(v.body.data[0].costType).toBe('CARRIER_FEE');
    expect(v.body.data[0]).not.toHaveProperty('buyAmount');
    expect(v.body.data[0]).not.toHaveProperty('buyVatAmount');
    expect(v.body.summary).not.toHaveProperty('buyTotal');
    expect(v.body.summary).not.toHaveProperty('buyCarrierFee');
    expect(JSON.stringify(v.body)).not.toContain('4800');
    await costs(t.id, other).expect(404);
    await api(app, other).post(`/v1/trips/${t.id}/cost`).expect(404);
  });

  it('ปิดต้นทุน: ยังไม่จบ → 409 · ค่าใช้จ่ายหน้างานรอยืนยัน → 409 blockers · ครบ → COSTED + audit · If-Match/สิทธิ์', async () => {
    const L = await lane();
    const t = await newTrip(L.a, L.b);
    await hire(t.id, { carrierId: L.B.id }).expect(200);
    const s1 = await api(app, admin).post(`/v1/trips/${t.id}/cost`).expect(409);
    expect(s1.body).toMatchObject({ code: 'invalid_state_transition', from: 'OFFERED' });

    await complete(t.id, { carrierId: L.B.id, accept: true });
    const tid = uuid('trip', t.id);
    const field = await db.tripCost.create({
      data: {
        tenantId,
        tripId: tid,
        costType: 'TOLL',
        amount: '180.00',
        source: 'MANUAL',
        sourceType: 'FIELD',
        status: 'PENDING_CONFIRM',
        carrierId: uuid('carrier', L.B.id),
        description: 'ค่าทางด่วน',
        createdBy: 'u-disp',
      },
    });
    const g = await costs(t.id).expect(200);
    expect(g.body.summary).toMatchObject({
      tripStatus: 'COMPLETED',
      pendingCount: 1,
      blockers: ['PENDING_FIELD_CHARGES'],
      buyTotal: '4800.50',
      buyCarrierFee: '4800.50',
    });
    const s2 = await api(app, admin).post(`/v1/trips/${t.id}/cost`).expect(409);
    expect(s2.body).toMatchObject({
      code: 'trip_costs_incomplete',
      blockers: ['PENDING_FIELD_CHARGES'],
      pendingCount: 1,
    });
    // ไม่มีราคาใน problem body
    expect(JSON.stringify(s2.body)).not.toContain('4800');
    await db.tripCost.update({
      where: { id: field.id },
      data: { status: 'CONFIRMED', decidedBy: 'u-acc', decidedAt: new Date() },
    });

    // สิทธิ์: viewer ไม่มี trips:close → 403 · If-Match เก่า → 412
    await api(app, viewer).post(`/v1/trips/${t.id}/cost`).expect(403);
    const cur = await api(app, admin).get(`/v1/trips/${t.id}`).expect(200);
    await api(app, admin)
      .post(`/v1/trips/${t.id}/cost`)
      .set('If-Match', `"${cur.body.version - 1}"`)
      .expect(412);
    const ok = await api(app, dispatcher)
      .post(`/v1/trips/${t.id}/cost`)
      .set('If-Match', `"${cur.body.version}"`)
      .expect(200);
    expect(ok.body).toMatchObject({ status: 'COSTED', version: cur.body.version + 1 });
    expect(ok.headers.etag).toBe(`"${ok.body.version}"`);
    const after = await costs(t.id).expect(200);
    expect(after.body.summary).toMatchObject({
      tripStatus: 'COSTED',
      buyTotal: '4980.50',
      blockers: [],
      costedBy: 'u-disp',
    });
    expect(after.body.summary.costedAt).toBeTruthy();
    const au = await db.auditLog.findFirstOrThrow({
      where: { action: 'trip.costed', entityId: tid },
    });
    expect(au.after).toEqual({
      status: 'COSTED',
      costLines: 2,
      allocatedTo: [expect.stringMatching(/^do_/)],
    });
    const ev = await db.domainEvent.findFirst({
      where: { type: 'trip.costed', localId: tid },
    });
    expect(ev).not.toBeNull();
    // ซ้ำ → 409 (COSTED ไม่มีเส้น cost)
    await api(app, admin).post(`/v1/trips/${t.id}/cost`).expect(409);
  });

  it('เที่ยวรถร่วมไม่มีค่าจ้างของการจ้างที่รับแล้ว → 409 CARRIER_FEE_MISSING · รถบริษัท (ไม่มีบรรทัด) ปิดต้นทุนได้', async () => {
    const L = await lane();
    const t = await newTrip(L.a, L.b);
    await hire(t.id, { carrierId: L.B.id }).expect(200);
    // ข้อเสนอยังไม่ถูกรับ (ข้อมูลผิดปกติ) แต่เที่ยวจบแล้ว → ไม่มีค่าจ้างที่ใช้งาน
    await complete(t.id, { carrierId: L.B.id });
    const r = await api(app, admin).post(`/v1/trips/${t.id}/cost`).expect(409);
    expect(r.body).toMatchObject({
      code: 'trip_costs_incomplete',
      blockers: ['CARRIER_FEE_MISSING'],
    });

    const own = await newTrip(L.a, L.b);
    await complete(own.id);
    expect((await costs(own.id).expect(200)).body.summary.blockers).toEqual([]);
    await api(app, admin).post(`/v1/trips/${own.id}/cost`).expect(200);
  });

  it('kill switch TRIP_COSTING_ENABLED=0 → 409 trip_costing_unavailable · เที่ยวไม่เปลี่ยน · ไม่ตั้ง = เปิด (ค่าเริ่มต้น)', async () => {
    const L = await lane();
    const own = await newTrip(L.a, L.b);
    await complete(own.id);
    for (const off of ['0', 'false']) {
      process.env.TRIP_COSTING_ENABLED = off;
      try {
        const r = await api(app, admin).post(`/v1/trips/${own.id}/cost`).expect(409);
        expect(r.body.code).toBe('trip_costing_unavailable');
        // อ่านต้นทุนยังได้ตามปกติ
        await costs(own.id).expect(200);
      } finally {
        delete process.env.TRIP_COSTING_ENABLED;
      }
    }
    expect((await api(app, admin).get(`/v1/trips/${own.id}`).expect(200)).body.status).toBe(
      'COMPLETED',
    );
    await api(app, admin).post(`/v1/trips/${own.id}/cost`).expect(200);
  });

  // ---------- ST6-T01c ปันต้นทุนลง DO ตามสัดส่วนรายได้ (PO ตัดสิน 19 พ.ย. 2569) ----------

  let waitSvc = '';
  /** เที่ยวหลาย DO — `revenues[i]` = รายได้ของ DO ที่ i (บรรทัดที่คนเพิ่มผูก DO) · null = ไม่มีบรรทัดรายได้ */
  async function multiTrip(L: Awaited<ReturnType<typeof lane>>, revenues: (string | null)[]) {
    if (!waitSvc)
      waitSvc = encodeId(
        'serviceItem',
        (await db.serviceItem.findFirstOrThrow({ where: { tenantId, code: 'WAIT' } })).id,
      );
    const dos = [];
    for (const rev of revenues) {
      const o = await newOrderDo(L.a, L.b);
      if (rev)
        await api(app, admin)
          .post(`/v1/orders/${o.soPub}/revenue-lines`)
          .send({
            serviceItemId: waitSvc,
            qty: '1',
            sellUnitPrice: rev,
            deliveryOrderId: o.doPub,
            reason: 'รายได้ของใบส่งของสำหรับทดสอบการปัน',
          })
          .expect(201);
      dos.push(o);
    }
    const t = (
      await api(app, admin)
        .post('/v1/trips')
        .send({ tripDate: today, deliveryOrderIds: dos.map((d) => d.doPub) })
        .expect(201)
    ).body as { id: string; version: number };
    return { t, dos };
  }
  const confirmedCharge = (tripId: string, amount: string, carrierId?: string) =>
    db.tripCost.create({
      data: {
        tenantId,
        tripId: uuid('trip', tripId),
        costType: 'TOLL',
        amount,
        source: 'MANUAL',
        sourceType: 'FIELD',
        status: 'CONFIRMED',
        carrierId: carrierId ? uuid('carrier', carrierId) : null,
        description: 'ค่าทางด่วน',
        createdBy: 'u-disp',
        decidedBy: 'u-acc',
        decidedAt: new Date(),
      },
    });
  type Alloc = { deliveryOrderId: string; doNo: string; buyAllocatedCost?: string };
  const allocOf = async (tripId: string, token = admin) =>
    (await costs(tripId, token).expect(200)).body.allocations as Alloc[];
  const byDo = (a: Alloc[]) =>
    Object.fromEntries(a.map((x) => [x.deliveryOrderId, x.buyAllocatedCost]));
  /** ผลรวมต่อบรรทัดเท่ายอดบรรทัด (สตางค์) ทุกบรรทัด CONFIRMED */
  const assertLinesExact = async (tripId: string) => {
    const rows = await db.tripCost.findMany({ where: { tripId: uuid('trip', tripId) } });
    for (const r of rows) {
      const a = r.allocated as Record<string, string>;
      if (r.status !== 'CONFIRMED') {
        expect(a).toEqual({});
        continue;
      }
      const total = Object.values(a).reduce((x, v) => x + Math.round(Number(v) * 100), 0);
      expect(total).toBe(Math.round(Number(r.amount.toFixed(2)) * 100));
    }
    return rows;
  };

  it('ปันตามสัดส่วนรายได้ · เศษสตางค์ → DO รายได้สูงสุด · DO รายได้ 0 ได้ 0 · ผลรวมเท่าต้นทุนพอดี · DO endpoint เห็นต้นทุนที่ปันมา', async () => {
    const L = await lane();
    const { t, dos } = await multiTrip(L, ['100', '200', null]);
    await hire(t.id, { carrierId: L.B.id }).expect(200); // 4800.50
    await complete(t.id, { carrierId: L.B.id, accept: true });
    await confirmedCharge(t.id, '180.01', L.B.id);
    // ก่อนปิดต้นทุน: allocations ว่าง · DO endpoint = null
    expect(await allocOf(t.id)).toEqual([]);
    const pre = await api(app, admin)
      .get(`/v1/delivery-orders/${dos[0]!.doPub}/revenue-lines`)
      .expect(200);
    expect(pre.body.buyAllocatedCost).toBeNull();

    await api(app, admin).post(`/v1/trips/${t.id}/cost`).expect(200);
    const a = await allocOf(t.id);
    // ค่าจ้าง 4800.50: 1600.16 / 3200.33 + เศษ 0.01 → DO2 · ทางด่วน 180.01: 60.00 / 120.00 + เศษ 0.01 → DO2
    expect(byDo(a)).toEqual({
      [dos[0]!.doPub]: '1660.16',
      [dos[1]!.doPub]: '3320.35',
      [dos[2]!.doPub]: '0.00',
    });
    expect(a.map((x) => x.doNo)).toEqual([...a.map((x) => x.doNo)].sort());
    const summary = (await costs(t.id).expect(200)).body.summary;
    expect(summary.buyTotal).toBe('4980.51');
    await assertLinesExact(t.id);

    // DO endpoint: ต้นทุนที่ปันมา + รายได้ (กำไร = ผู้เรียกคำนวณ)
    const d2 = await api(app, admin)
      .get(`/v1/delivery-orders/${dos[1]!.doPub}/revenue-lines`)
      .expect(200);
    expect(d2.body).toMatchObject({ sellRevenueTotal: '200.00', buyAllocatedCost: '3320.35' });
    // สิทธิ์แยกกัน: ไม่มี prices.buy:read → ไม่เห็นต้นทุน (เห็นรายได้) · trips viewer ไม่เห็นยอดปัน
    const sellOnly = await tokenFor(tenantId, 'orders:read prices.sell:read', 'u-sell');
    const s = await api(app, sellOnly)
      .get(`/v1/delivery-orders/${dos[1]!.doPub}/revenue-lines`)
      .expect(200);
    expect(s.body).toHaveProperty('sellRevenueTotal', '200.00');
    expect(s.body).not.toHaveProperty('buyAllocatedCost');
    const buyOnly = await tokenFor(tenantId, 'orders:read prices.buy:read', 'u-buy');
    const b = await api(app, buyOnly)
      .get(`/v1/delivery-orders/${dos[1]!.doPub}/revenue-lines`)
      .expect(200);
    expect(b.body).toHaveProperty('buyAllocatedCost', '3320.35');
    expect(b.body).not.toHaveProperty('sellRevenueTotal');
    const v = await allocOf(t.id, viewer);
    expect(v).toHaveLength(3);
    expect(v[0]).not.toHaveProperty('buyAllocatedCost');
    expect(JSON.stringify(v)).not.toContain('3320');
    // audit ไม่มียอดเงิน
    const au = await db.auditLog.findFirstOrThrow({
      where: { action: 'trip.costed', entityId: uuid('trip', t.id) },
    });
    expect(au.after).toMatchObject({ status: 'COSTED', allocatedTo: expect.any(Array) });
    expect(JSON.stringify(au.after)).not.toContain('1660');
  });

  it('รายได้เท่ากัน → เศษไป DO เลขน้อยสุด · บรรทัดกลับรายการหักล้างกันพอดีต่อ DO', async () => {
    const L = await lane();
    const { t, dos } = await multiTrip(L, ['100', '100', '100']);
    await hire(t.id, { carrierId: L.B.id }).expect(200); // 4800.50 → กลับรายการ
    await hire(t.id, { carrierId: L.A.id, changeReason: REASON }).expect(200); // 5200.00
    await complete(t.id, { carrierId: L.A.id, accept: true });
    await confirmedCharge(t.id, '0.02', L.A.id);
    await api(app, admin).post(`/v1/trips/${t.id}/cost`).expect(200);
    const nos = await db.deliveryOrder.findMany({
      where: { id: { in: dos.map((d) => d.doId) } },
      select: { id: true, doNo: true },
    });
    const first = nos.sort((x, y) => x.doNo!.localeCompare(y.doNo!, 'en', { numeric: true }))[0]!;
    // 5200.00 / 3 = 1733.33 ×3 + เศษ 0.01 → ใบแรก · 0.02 / 3 = 0 ×3 + เศษ 0.02 → ใบแรก
    const a = byDo(await allocOf(t.id));
    for (const d of dos) expect(a[d.doPub]).toBe(d.doId === first.id ? '1733.36' : '1733.33');
    const rows = await assertLinesExact(t.id);
    const orig = rows.find((r) => r.amount.toFixed(2) === '4800.50')!;
    const rev = rows.find((r) => r.reversalOfId === orig.id)!;
    const oa = orig.allocated as Record<string, string>;
    const ra = rev.allocated as Record<string, string>;
    for (const k of Object.keys(oa)) expect(Number(oa[k]) + Number(ra[k])).toBe(0);
    expect(oa[first.id]).toBe('1600.18'); // 1600.16 + เศษ 0.02
  });

  it('DO ที่ยกเลิกไม่รับส่วนแบ่ง · เที่ยวไม่มี DO (ทุกใบยกเลิก) = ไม่ปัน (ปิดได้) · DO เดียวรายได้ 0 = ทั้งยอด', async () => {
    const L = await lane();
    const { t, dos } = await multiTrip(L, ['300', '100']);
    await hire(t.id, { carrierId: L.B.id }).expect(200);
    await complete(t.id, { carrierId: L.B.id, accept: true });
    // DO ใบแรก (รายได้สูงสุด) ถูกยกเลิก — บรรทัดรายได้ยังอยู่ แต่ไม่นับเพราะสถานะ
    await db.deliveryOrder.update({ where: { id: dos[0]!.doId }, data: { status: 'CANCELLED' } });
    await api(app, admin).post(`/v1/trips/${t.id}/cost`).expect(200);
    expect(byDo(await allocOf(t.id))).toEqual({ [dos[1]!.doPub]: '4800.50' });

    const own = await newTrip(L.a, L.b);
    await complete(own.id);
    await confirmedCharge(own.id, '99.99');
    await db.deliveryOrder.updateMany({
      where: { tripId: uuid('trip', own.id) },
      data: { status: 'CANCELLED' },
    });
    await api(app, admin).post(`/v1/trips/${own.id}/cost`).expect(200);
    expect(await allocOf(own.id)).toEqual([]);
    const r = await db.tripCost.findFirstOrThrow({ where: { tripId: uuid('trip', own.id) } });
    expect(r.allocated).toEqual({});

    const single = await multiTrip(L, [null]);
    await hire(single.t.id, { carrierId: L.B.id }).expect(200);
    await complete(single.t.id, { carrierId: L.B.id, accept: true });
    await api(app, admin).post(`/v1/trips/${single.t.id}/cost`).expect(200);
    expect(byDo(await allocOf(single.t.id))).toEqual({ [single.dos[0]!.doPub]: '4800.50' });
  });

  it('หลาย DO รายได้รวม 0 → 409 REVENUE_MISSING · รายได้ยังไม่ยืนยัน → 409 REVENUE_PROVISIONAL · ไม่เขียนการปัน', async () => {
    const L = await lane();
    const z = await multiTrip(L, [null, null]);
    await hire(z.t.id, { carrierId: L.B.id }).expect(200);
    await complete(z.t.id, { carrierId: L.B.id, accept: true });
    expect((await costs(z.t.id).expect(200)).body.summary.blockers).toEqual(['REVENUE_MISSING']);
    const r1 = await api(app, admin).post(`/v1/trips/${z.t.id}/cost`).expect(409);
    expect(r1.body).toMatchObject({ code: 'trip_costs_incomplete', blockers: ['REVENUE_MISSING'] });

    const p = await multiTrip(L, ['100', '50']);
    await hire(p.t.id, { carrierId: L.B.id }).expect(200);
    await complete(p.t.id, { carrierId: L.B.id, accept: true });
    await db.revenueLine.updateMany({
      where: { deliveryOrderId: p.dos[1]!.doId },
      data: { provisional: true },
    });
    const r2 = await api(app, admin).post(`/v1/trips/${p.t.id}/cost`).expect(409);
    expect(r2.body.blockers).toEqual(['REVENUE_PROVISIONAL']);
    const rows = await db.tripCost.findMany({ where: { tripId: uuid('trip', p.t.id) } });
    for (const row of rows) expect(row.allocated).toEqual({});
    expect((await api(app, admin).get(`/v1/trips/${p.t.id}`).expect(200)).body.status).toBe(
      'COMPLETED',
    );
    // ยืนยันยอดแล้ว → ปิดได้
    await db.revenueLine.updateMany({
      where: { deliveryOrderId: p.dos[1]!.doId },
      data: { provisional: false },
    });
    await api(app, admin).post(`/v1/trips/${p.t.id}/cost`).expect(200);
    expect(byDo(await allocOf(p.t.id))).toEqual({
      [p.dos[0]!.doPub]: '3200.34',
      [p.dos[1]!.doPub]: '1600.16',
    });
  });

  it('พร้อมกัน: ปิดต้นทุนซ้อน 2 ครั้ง + เพิ่มรายได้ระหว่างปิด → สำเร็จครั้งเดียว · การปันตรงกับรายได้ที่เห็นและรวมเท่าต้นทุน', async () => {
    const L = await lane();
    const { t, dos } = await multiTrip(L, ['100', '100']);
    await hire(t.id, { carrierId: L.B.id }).expect(200);
    await complete(t.id, { carrierId: L.B.id, accept: true });
    const [c1, c2, add] = await Promise.all([
      api(app, admin).post(`/v1/trips/${t.id}/cost`),
      api(app, dispatcher).post(`/v1/trips/${t.id}/cost`),
      api(app, admin).post(`/v1/orders/${dos[1]!.soPub}/revenue-lines`).send({
        serviceItemId: waitSvc,
        qty: '1',
        sellUnitPrice: '100',
        deliveryOrderId: dos[1]!.doPub,
        reason: 'รายได้ของใบส่งของสำหรับทดสอบการปัน',
      }),
    ]);
    expect([c1.status, c2.status].sort()).toEqual([200, 409]);
    expect(add.status).toBe(201);
    const a = byDo(await allocOf(t.id));
    const sum = Object.values(a).reduce((x, v) => x + Math.round(Number(v) * 100), 0);
    expect(sum).toBe(480050);
    // ปันตามรายได้ 100:100 (2400.25 ×2) หรือ 100:200 (1600.16 / 3200.34) แล้วแต่ลำดับ — ไม่มีแบบอื่น
    expect([
      JSON.stringify({ [dos[0]!.doPub]: '2400.25', [dos[1]!.doPub]: '2400.25' }),
      JSON.stringify({ [dos[0]!.doPub]: '1600.16', [dos[1]!.doPub]: '3200.34' }),
    ]).toContain(
      JSON.stringify({ [dos[0]!.doPub]: a[dos[0]!.doPub], [dos[1]!.doPub]: a[dos[1]!.doPub] }),
    );
    await assertLinesExact(t.id);
  });
});
