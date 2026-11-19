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
    // ปิดต้นทุนปิดไว้โดยค่าเริ่มต้น (รอวิธีปันลง DO) — ชุดนี้ทดสอบ logic เมื่อเปิดใช้
    process.env.TRIP_COSTING_ENABLED = '1';
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
    expect(au.after).toEqual({ status: 'COSTED', costLines: 2 });
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

  it('ค่าเริ่มต้น (ยังไม่ตัดสินวิธีปันลง DO — docs/01 §4.2): ปิดต้นทุนไม่ได้ → 409 trip_costing_unavailable · เที่ยวไม่เปลี่ยน', async () => {
    const L = await lane();
    const own = await newTrip(L.a, L.b);
    await complete(own.id);
    delete process.env.TRIP_COSTING_ENABLED;
    try {
      const r = await api(app, admin).post(`/v1/trips/${own.id}/cost`).expect(409);
      expect(r.body.code).toBe('trip_costing_unavailable');
      // อ่านต้นทุนยังได้ตามปกติ
      await costs(own.id).expect(200);
    } finally {
      process.env.TRIP_COSTING_ENABLED = '1';
    }
    expect((await api(app, admin).get(`/v1/trips/${own.id}`).expect(200)).body.status).toBe(
      'COMPLETED',
    );
  });
});
