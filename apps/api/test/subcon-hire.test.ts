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
 * ST3-T22 จ้างรถร่วม (docs/04 D3): ตัวเลือก + rate card ขาซื้อ + ราคา 5 ครั้งล่าสุด + รายที่ถูกสุด, จ้าง → `trip_cost`
 * CARRIER_FEE + `subcon_offer` + `selectionReason` · เกณฑ์ตรวจรับ: จ้างรายที่ไม่ใช่ถูกสุดต้องใส่เหตุผล; ทุกการจ้างมี
 * `selectionReason` ไม่ว่าง · สิทธิ์ (ราคาซื้อ) · แยก tenant · รับงาน/ยกเลิก/จ้างใหม่ (กลับรายการ) · constraint
 */
describe('subcon hire (ST3-T22)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let otherId: string;
  let admin: string;
  let dispatcher: string;
  let viewer: string;
  let noBuy: string;
  let other: string;
  let seed = 0;
  let unitTon: string;
  let vt6: string;
  const today = bangkokToday();
  const uuid = (kind: Parameters<typeof tryDecodeId>[0], id: string) => tryDecodeId(kind, id)!;
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };
  const REASON = 'รายที่ถูกกว่ารถไม่ว่างช่วงเช้า';
  const jur = (n: number) => {
    const base = `0105${String(70_000 + n).padStart(8, '0')}`;
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
    return base + String((11 - (sum % 11)) % 10);
  };

  async function company(tid: string) {
    const c = await db.company.create({
      data: {
        tenantId: tid,
        legalName: `บริษัท ผู้ออกบิล ${++seed}`,
        taxId: validTaxId(800 + seed),
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
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท จ้างรถร่วม' })).id;
    otherId = (await createTenantWithDefaults(db, { name: 'บริษัท อื่น' })).id;
    await company(tenantId);
    await company(otherId);
    admin = await tokenFor(tenantId);
    dispatcher = await tokenFor(tenantId, SYSTEM_ROLES.dispatcher.permissions.join(' '), 'u-disp');
    viewer = await tokenFor(tenantId, SYSTEM_ROLES.viewer.permissions.join(' '), 'u-view');
    noBuy = await tokenFor(tenantId, 'trips:read trips:assign', 'u-nobuy');
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
  const newSite = async () =>
    (
      await api(app, admin)
        .post('/v1/customer-sites')
        .send({ name: `จุดรับส่ง ${++seed}`, kind: 'DROPOFF', address: ADDR })
        .expect(201)
    ).body.id as string;
  const newCustomer = async () =>
    (
      await api(app, admin)
        .post('/v1/customers')
        .send({ legalName: `ลูกค้า ${++seed}`, taxId: validTaxId(9600 + seed) })
        .expect(201)
    ).body.id as string;
  const newCarrier = async (token = admin) =>
    (
      await api(app, token)
        .post('/v1/carriers')
        .send({ legalName: `หจก. รถร่วม ${++seed}`, entityType: 'JURISTIC', taxId: jur(seed) })
        .expect(201)
    ).body as { id: string; code: string; legalName: string; version: number };
  /** rate card ขาซื้อ (อนุมัติแล้ว) ของเส้นทาง a → b รถ 6 ล้อ */
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
    return r.body as { id: string; code: string };
  };
  /** SO (รถ 6 ล้อ) → DO → เที่ยว PLANNING */
  const newTrip = async (a: string, b: string, opts: { vt?: string | null; tid?: string } = {}) => {
    const tid = opts.tid ?? tenantId;
    const input: UpsertOrderInput = {
      source: 'MANUAL',
      customer: { id: uuid('customer', await newCustomer()) },
      requestedDate: today,
      ...(opts.vt === null ? {} : { vehicleTypeId: uuid('vehicleType', opts.vt ?? vt6) }),
      stops: [
        { type: 'PICKUP', siteId: uuid('site', a) },
        { type: 'DELIVERY', siteId: uuid('site', b) },
      ],
      lines: [{ description: 'ปูนซีเมนต์', qty: '5', unitId: unitTon, weightKg: '5000' }],
    };
    const { order: so } = await run(
      (tx) => app.get(OrderIntakeService).upsertOrder(input, tx),
      tid,
    );
    const [d] = await run((tx) => app.get(DeliveryOrderService).listForOrder(so.id, {}, tx), tid);
    return (
      await api(app, admin)
        .post('/v1/trips')
        .send({ tripDate: today, deliveryOrderIds: [encodeId('deliveryOrder', d!.id)] })
        .expect(201)
    ).body as { id: string; tripNo: string; version: number };
  };
  const options = (id: string, token = admin) =>
    api(app, token).get(`/v1/trips/${id}/hire-options`);
  const hire = (id: string, body: object, token = admin) =>
    api(app, token).post(`/v1/trips/${id}/offer`).send(body);
  const costs = (tripId: string) =>
    db.tripCost.findMany({
      where: { tripId: uuid('trip', tripId) },
      orderBy: { createdAt: 'asc' },
    });
  const offers = (tripId: string) =>
    db.subconOffer.findMany({
      where: { tripId: uuid('trip', tripId) },
      orderBy: { offeredAt: 'asc' },
    });

  /** เส้นทาง + รถร่วม 4 ราย: A 5,200 · B 4,800.50 · C ไม่มี rate · D ระงับ (ไม่อยู่ในตัวเลือก) */
  async function lane() {
    const [a, b] = [await newSite(), await newSite()];
    const A = await newCarrier();
    const B = await newCarrier();
    const C = await newCarrier();
    const D = await newCarrier();
    await buyRate(A.id, a, b, '5200');
    const rb = await buyRate(B.id, a, b, '4800.50');
    await buyRate(D.id, a, b, '100');
    const d = await api(app, admin).get(`/v1/carriers/${D.id}`).expect(200);
    await api(app, admin)
      .post(`/v1/carriers/${D.id}/deactivate`)
      .set('If-Match', `"${d.body.version}"`)
      .send({ reason: 'ระงับชั่วคราวทดสอบ' })
      .expect(200);
    return { a, b, A, B, C, D, rb };
  }

  it('ตัวเลือก: รายที่ใช้งาน + ราคา rate card ขาซื้อ (ถูกก่อน) + ถูกสุด + เส้นทาง/ประเภทรถ · รายระงับไม่อยู่', async () => {
    const L = await lane();
    const t = await newTrip(L.a, L.b);
    const r = await options(t.id).expect(200);
    expect(r.body).toMatchObject({
      tripId: t.id,
      tripNo: t.tripNo,
      origin: { id: L.a },
      destination: { id: L.b },
      vehicleTypeId: vt6,
      buyCheapestAmount: '4800.50',
    });
    const ids = (r.body.options as { carrier: { id: string } }[]).map((o) => o.carrier.id);
    expect(ids).not.toContain(L.D.id);
    const mine = ids.filter((x) => [L.A.id, L.B.id, L.C.id].includes(x));
    expect(mine).toEqual([L.B.id, L.A.id, L.C.id]);
    const by = (id: string) =>
      r.body.options.find((o: { carrier: { id: string } }) => o.carrier.id === id);
    expect(by(L.B.id)).toMatchObject({
      pricingStatus: 'AVAILABLE',
      buyRateAmount: '4800.50',
      rateCardCode: L.rb.code,
      cheapest: true,
      buyRecentAmounts: [],
      carrier: { whtRateDefault: '1.00', paymentTermDays: 30, requirePodToPay: true },
    });
    expect(by(L.A.id)).toMatchObject({ buyRateAmount: '5200.00', cheapest: false });
    expect(by(L.C.id)).toMatchObject({ pricingStatus: 'RATE_MISSING', buyRateAmount: null });
    expect(by(L.C.id).pricingReasons.length).toBeGreaterThan(0);
  });

  it('จ้างรายถูกสุดตาม rate card → OFFERED + trip_cost CARRIER_FEE + selectionReason ของระบบ (ไม่ว่าง) + snapshot + audit', async () => {
    const L = await lane();
    const t = await newTrip(L.a, L.b);
    const r = await hire(t.id, { carrierId: L.B.id }, dispatcher).expect(200);
    expect(r.body).toMatchObject({
      status: 'OFFERED',
      assignmentStatus: 'OFFERED',
      carrier: { id: L.B.id },
      hire: {
        carrierId: L.B.id,
        status: 'OFFERED',
        buyAmount: '4800.50',
        priceSource: 'RATE_CARD',
        rateCardCode: L.rb.code,
        selectionKind: 'CHEAPEST',
        offeredBy: 'u-disp',
      },
    });
    expect(r.body.hire.selectionReason).toMatch(/^ราคาถูกสุดจาก \d+ รายที่มี rate card ขาซื้อ$/);
    const [c, ...rest] = await costs(t.id);
    expect(rest).toEqual([]);
    expect(c).toMatchObject({
      costType: 'CARRIER_FEE',
      source: 'RATE_CARD',
      carrierId: uuid('carrier', L.B.id),
      settlementLineId: null,
      reversalOfId: null,
      createdBy: 'u-disp',
    });
    expect(c!.amount.toFixed(2)).toBe('4800.50');
    // ธงภาษีคัดลอกจากรายการบริการค่าขนส่งของ rate card (ค่าขนส่งในประเทศ = ยกเว้น VAT, หัก 1%)
    expect(c!.vatType).toBe('EXEMPT_TRANSPORT');
    expect(c!.whtRate!.toFixed(2)).toBe('1.00');
    expect(c!.vatAmount.toFixed(2)).toBe('0.00');
    const [o] = await offers(t.id);
    expect(c!.subconOfferId).toBe(o!.id);
    expect(o).toMatchObject({
      status: 'OFFERED',
      priceSource: 'RATE_CARD',
      selectionKind: 'CHEAPEST',
    });
    const row = await db.trip.findUniqueOrThrow({ where: { id: uuid('trip', t.id) } });
    expect(row.vehicleTypeId).toBe(uuid('vehicleType', vt6));
    expect(row.vehicleTypeSnapshot).toBeTruthy();
    expect(row.buyRateSnapshot).toMatchObject({
      rateCardCode: L.rb.code,
      buyAmount: '4800.50',
      priceSource: 'RATE_CARD',
    });
    const au = await db.auditLog.findFirstOrThrow({
      where: { action: 'trip.offered', entityId: uuid('trip', t.id) },
    });
    expect(au.reason).toBe(o!.selectionReason);
    expect(au.after).toMatchObject({ buyAmount: '4800.50', selectionKind: 'CHEAPEST' });
  });

  it('เกณฑ์ตรวจรับ: จ้างรายที่ไม่ใช่ถูกสุดต้องใส่เหตุผล (ไม่ใส่/สั้น → 422 ไม่มีอะไรถูกเขียน) · ใส่แล้ว OVERRIDE เก็บเหตุผล', async () => {
    const L = await lane();
    const t = await newTrip(L.a, L.b);
    const e = await hire(t.id, { carrierId: L.A.id }).expect(422);
    expect(e.body.errors[0]).toMatchObject({
      field: 'selectionReason',
      code: 'selection_reason_required',
    });
    expect(e.body.detail).toContain('ไม่ใช่ราคาถูกสุด');
    await hire(t.id, { carrierId: L.A.id, selectionReason: 'สั้นไป' }).expect(422);
    // ราคาเองที่แพงกว่าถูกสุด ก็ต้องให้เหตุผล (แม้เป็นรายที่ถูกสุด)
    await hire(t.id, { carrierId: L.B.id, cost: '5000' }).expect(422);
    expect(await costs(t.id)).toEqual([]);
    expect(await offers(t.id)).toEqual([]);
    expect((await api(app, admin).get(`/v1/trips/${t.id}`).expect(200)).body.status).toBe(
      'PLANNING',
    );
    const ok = await hire(t.id, { carrierId: L.A.id, selectionReason: `  ${REASON}  ` }).expect(
      200,
    );
    expect(ok.body.hire).toMatchObject({
      buyAmount: '5200.00',
      priceSource: 'RATE_CARD',
      selectionKind: 'OVERRIDE',
      selectionReason: REASON,
    });
    const [o] = await offers(t.id);
    expect(o!.comparison).toMatchObject({
      cheapestAmount: '4800.50',
      cheapestCarrierIds: [uuid('carrier', L.B.id)],
    });
  });

  it('ราคาเองต่ำกว่าถูกสุด = ถูกสุด (MANUAL) · รายไม่มี rate card: ไม่ส่งราคา 422 cost_required, ส่งราคา+เหตุผลได้ (ธงภาษีว่าง)', async () => {
    const L = await lane();
    const t1 = await newTrip(L.a, L.b);
    const r1 = await hire(t1.id, { carrierId: L.A.id, cost: '4500' }).expect(200);
    expect(r1.body.hire).toMatchObject({
      buyAmount: '4500.00',
      priceSource: 'MANUAL',
      selectionKind: 'CHEAPEST',
    });
    const [c1] = await costs(t1.id);
    expect(c1).toMatchObject({ source: 'MANUAL', vatType: 'EXEMPT_TRANSPORT' });

    const t2 = await newTrip(L.a, L.b);
    const e = await hire(t2.id, { carrierId: L.C.id }).expect(422);
    expect(e.body.errors[0]).toMatchObject({ field: 'cost', code: 'cost_required' });
    for (const bad of ['0', '-5', '12.345', 'abc'])
      await hire(t2.id, { carrierId: L.C.id, cost: bad, selectionReason: REASON }).expect(422);
    await hire(t2.id, { carrierId: L.C.id, cost: '4000' }).expect(200); // ถูกกว่าทุกราย = ถูกสุด
    const [c2] = await costs(t2.id);
    expect(c2).toMatchObject({
      source: 'MANUAL',
      vatType: null,
      whtRate: null,
      serviceItemId: null,
    });
  });

  it('ไม่มีราคาให้เทียบ (งานไม่ระบุประเภทรถ) → ทุกรายคิดราคาไม่ได้ · ต้องให้เหตุผลเสมอ · ระบุ vehicleTypeId แล้วเทียบได้', async () => {
    const L = await lane();
    const t = await newTrip(L.a, L.b, { vt: null });
    const r = await options(t.id).expect(200);
    expect(r.body).toMatchObject({ vehicleTypeId: null, buyCheapestAmount: null });
    expect(r.body.options.every((o: { buyRateAmount: null }) => o.buyRateAmount === null)).toBe(
      true,
    );
    const e = await hire(t.id, { carrierId: L.C.id, cost: '1000' }).expect(422);
    expect(e.body.detail).toContain('ไม่มีราคาจาก rate card ขาซื้อให้เทียบ');
    const withVt = await options(t.id).query({ vehicleTypeId: vt6 }).expect(200);
    expect(withVt.body.buyCheapestAmount).toBe('4800.50');
    await hire(t.id, { carrierId: L.B.id, vehicleTypeId: vt6 }).expect(200);
    await hire(t.id, { carrierId: L.B.id }).expect(409); // OFFERED แล้ว — จ้างซ้ำไม่ได้
  });

  it('สิทธิ์: ไม่มี prices.buy:read → 403 · viewer ไม่มี trips:assign → 403 และไม่เห็นราคาซื้อในเที่ยว แต่เห็นเหตุผล · รายระงับ → 422', async () => {
    const L = await lane();
    const t = await newTrip(L.a, L.b);
    await options(t.id, noBuy).expect(403);
    await hire(t.id, { carrierId: L.B.id }, noBuy).expect(403);
    await options(t.id, viewer).expect(403);
    await hire(t.id, { carrierId: L.B.id }, viewer).expect(403);
    expect(
      (await hire(t.id, { carrierId: L.D.id, cost: '100', selectionReason: REASON }).expect(422))
        .body.errors[0].code,
    ).toBe('carrier_inactive');
    await hire(t.id, { carrierId: L.B.id }).expect(200);
    const v = await api(app, viewer).get(`/v1/trips/${t.id}`).expect(200);
    expect(v.body.hire.buyAmount).toBeUndefined();
    expect(v.body.hire.selectionReason).toBeTruthy();
    expect(JSON.stringify(v.body)).not.toContain('4800');
  });

  it('แยก tenant: เที่ยว/รถร่วมของบริษัทอื่น → 404/422 · RLS subcon_offer มองไม่เห็นข้ามบริษัท', async () => {
    const L = await lane();
    const t = await newTrip(L.a, L.b);
    await options(t.id, other).expect(404);
    await hire(t.id, { carrierId: L.B.id }, other).expect(404);
    const foreign = await newCarrier(other);
    expect(
      (
        await hire(t.id, { carrierId: foreign.id, cost: '100', selectionReason: REASON }).expect(
          422,
        )
      ).body.errors[0],
    ).toMatchObject({ field: 'carrierId', code: 'invalid_reference' });
    await hire(t.id, { carrierId: L.B.id }).expect(200);
    expect(await run((tx) => tx.subconOffer.count())).toBeGreaterThan(0);
    expect(await run((tx) => tx.subconOffer.count(), otherId)).toBe(0);
    expect(await run((tx) => tx.tripCost.count(), otherId)).toBe(0);
  });

  it('รับงาน (/assign) → ACCEPTED + ราคา 5 ครั้งล่าสุดของรายนี้ขึ้นในตัวเลือกเที่ยวถัดไป · ยกเลิกเที่ยวที่รอตอบ → WITHDRAWN', async () => {
    const L = await lane();
    const t = await newTrip(L.a, L.b);
    await hire(t.id, { carrierId: L.A.id, cost: '4700' }).expect(200);
    const veh = (
      await api(app, admin)
        .post('/v1/vehicles')
        .send({
          plate: `8${seed % 10}-${String(2000 + ++seed)}`,
          plateProvince: 'TH-10',
          vehicleTypeId: vt6,
          ownership: 'SUBCONTRACT',
          carrierId: L.A.id,
        })
        .expect(201)
    ).body as { id: string };
    const blocked = await api(app, admin)
      .post(`/v1/trips/${t.id}/assign`)
      .send({ vehicleId: veh.id })
      .expect(409);
    await api(app, admin)
      .post(`/v1/trips/${t.id}/assign`)
      .send({
        vehicleId: veh.id,
        ruleKeys: (blocked.body.blocks as { key: string }[]).map((b) => b.key),
        overrideReason: 'ยืนยันตามแผนของลูกค้า',
      })
      .expect(200);
    const [o] = await offers(t.id);
    expect(o!.status).toBe('ACCEPTED');
    const t2 = await newTrip(L.a, L.b);
    const r = await options(t2.id).expect(200);
    const a = r.body.options.find((x: { carrier: { id: string } }) => x.carrier.id === L.A.id);
    expect(a.buyRecentAmounts).toEqual(['4700.00']);

    await hire(t2.id, { carrierId: L.B.id }).expect(200);
    await api(app, admin)
      .post(`/v1/trips/${t2.id}/cancel`)
      .send({ reason: 'ลูกค้ายกเลิกการส่งทั้งเที่ยว' })
      .expect(200);
    const [w] = await offers(t2.id);
    expect(w).toMatchObject({ status: 'WITHDRAWN' });
    expect(w!.closedAt).not.toBeNull();
    expect(w!.closedReason).toContain('ลูกค้ายกเลิก');
  });

  it('จ้างใหม่หลังข้อเสนอเดิมจบ (ปฏิเสธ — ST3-T23) → บรรทัดค่าจ้างเดิมกลับรายการ (ยอดติดลบ) ประวัติคงอยู่', async () => {
    const L = await lane();
    const t = await newTrip(L.a, L.b);
    await hire(t.id, { carrierId: L.B.id }).expect(200);
    // จำลองรถร่วมปฏิเสธ (ST3-T23): ข้อเสนอ REJECTED + เที่ยวกลับ PLANNING
    const tid = uuid('trip', t.id);
    await db.subconOffer.updateMany({
      where: { tripId: tid },
      data: { status: 'REJECTED', closedAt: new Date(), closedReason: 'รถไม่ว่าง' },
    });
    await db.trip.update({
      where: { id: tid },
      data: { status: 'PLANNING', assignmentStatus: 'REJECTED', version: { increment: 1 } },
    });
    await hire(t.id, { carrierId: L.A.id, selectionReason: REASON }).expect(200);
    const cs = await costs(t.id);
    expect(cs.map((c) => [c.amount.toFixed(2), c.carrierId])).toEqual([
      ['4800.50', uuid('carrier', L.B.id)],
      ['-4800.50', uuid('carrier', L.B.id)],
      ['5200.00', uuid('carrier', L.A.id)],
    ]);
    expect(cs[1]!.reversalOfId).toBe(cs[0]!.id);
    expect((await offers(t.id)).map((o) => o.status)).toEqual(['REJECTED', 'OFFERED']);
  });

  it('constraint: selection_reason ว่าง/ราคา ≤ 0 ถูกปฏิเสธ · ข้อเสนอที่ใช้งานได้ 1 ต่อเที่ยว · ลบไม่ได้ (app role)', async () => {
    const L = await lane();
    const t = await newTrip(L.a, L.b);
    const base = {
      tenantId,
      tripId: uuid('trip', t.id),
      carrierId: uuid('carrier', L.B.id),
      carrierNameSnapshot: 'x',
      buyAmount: '100.00',
      priceSource: 'MANUAL',
      rateQuote: {},
      comparison: {},
      selectionKind: 'OVERRIDE',
      selectionReason: 'เหตุผลทดสอบยาวพอ',
    };
    await expect(
      db.subconOffer.create({ data: { ...base, selectionReason: '   ' } }),
    ).rejects.toThrow();
    await expect(db.subconOffer.create({ data: { ...base, buyAmount: '0' } })).rejects.toThrow();
    await db.subconOffer.create({ data: base });
    await expect(db.subconOffer.create({ data: base })).rejects.toThrow();
    await expect(
      run((tx) => tx.subconOffer.deleteMany({ where: { tripId: base.tripId } })),
    ).rejects.toThrow();
  });
});
