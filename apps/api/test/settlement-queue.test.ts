import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
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
 * ST6-T02 คิวจ่ายรถร่วม — เกณฑ์ตรวจรับ: เที่ยวที่ POD ไม่ครบไม่ขึ้นคิวเมื่อรถร่วมตั้ง `require_pod_to_pay`;
 * เที่ยวที่อยู่ใน settlement แล้วไม่ขึ้น · เฉพาะเที่ยว COSTED (DECISION PO 19 พ.ย. 2569) · กรองรถร่วม/ช่วงวัน/POD ·
 * ยอดรวมต่อรถร่วม · สิทธิ์ (settlements:read, prices.buy:read) · แยก tenant · cursor
 */
describe('settlement queue (ST6-T02)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let otherId: string;
  let admin: string;
  let viewer: string;
  let planner: string;
  let other: string;
  let seed = 0;
  let unitTon: string;
  let vt6: string;
  const today = bangkokToday();
  const uuid = (kind: Parameters<typeof tryDecodeId>[0], id: string) => tryDecodeId(kind, id)!;
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };
  const REASON = 'รายเดิมแจ้งว่ารถเสียกะทันหัน';
  const jur = (n: number) => {
    const base = `0105${String(81_000 + n).padStart(8, '0')}`;
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
    return base + String((11 - (sum % 11)) % 10);
  };

  beforeAll(async () => {
    // ปิดต้นทุน (COMPLETED → COSTED) ปิดใช้โดยค่าเริ่มต้น (รอวิธีปันลง DO) — ชุดนี้เปิดเพื่อสร้างเที่ยว COSTED
    process.env.TRIP_COSTING_ENABLED = '1';
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท คิวจ่าย' })).id;
    otherId = (await createTenantWithDefaults(db, { name: 'บริษัท อื่น' })).id;
    for (const tid of [tenantId, otherId]) {
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
    admin = await tokenFor(tenantId);
    viewer = await tokenFor(tenantId, SYSTEM_ROLES.viewer.permissions.join(' '), 'u-view');
    planner = await tokenFor(tenantId, SYSTEM_ROLES.planner.permissions.join(' '), 'u-plan');
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
  const newCarrier = async (body: object = {}) =>
    (
      await api(app, admin)
        .post('/v1/carriers')
        .send({
          legalName: `หจก. รถร่วมคิว ${++seed}`,
          entityType: 'JURISTIC',
          taxId: jur(seed),
          ...body,
        })
        .expect(201)
    ).body as { id: string; code: string };
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
  const newTrip = async (a: string, b: string) => {
    const customer = (
      await api(app, admin)
        .post('/v1/customers')
        .send({ legalName: `ลูกค้า ${++seed}`, taxId: validTaxId(9800 + seed) })
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
    const t = (
      await api(app, admin)
        .post('/v1/trips')
        .send({ tripDate: today, deliveryOrderIds: [encodeId('deliveryOrder', d!.id)] })
        .expect(201)
    ).body as { id: string };
    return { id: t.id, doId: d!.id };
  };
  const hire = (id: string, body: object) =>
    api(app, admin)
      .post(`/v1/trips/${id}/offer`)
      .send({ selectionReason: 'รายนี้มีรถว่างช่วงเช้า', ...body })
      .expect(200);
  const vehicle = async (carrierId: string) =>
    uuid(
      'vehicle',
      (
        await api(app, admin)
          .post('/v1/vehicles')
          .send({
            plate: `8${seed % 10}-${String(5000 + ++seed)}`,
            plateProvince: 'TH-10',
            vehicleTypeId: vt6,
            ownership: 'SUBCONTRACT',
            carrierId,
          })
          .expect(201)
      ).body.id as string,
    );
  /** POD ของ DO: ส่งสำเร็จผ่านเกณฑ์ (UNBILLED) / รอหลักฐาน (POD_PENDING) / ส่งไม่สำเร็จ (FAILED + สถานะหลักฐาน) */
  const setDo = (doId: string, status: 'UNBILLED' | 'POD_PENDING' | 'FAILED', podStatus: string) =>
    db.deliveryOrder.update({ where: { id: doId }, data: { status, podStatus } });
  /** จำลองเที่ยววิ่งจบ (flow จริงทดสอบใน ST3/ST4) แล้วปิดต้นทุนผ่าน API (COSTED) */
  const finish = async (
    tripId: string,
    carrierId: string,
    o: { cost?: boolean; completedAt?: Date } = {},
  ) => {
    const tid = uuid('trip', tripId);
    await db.subconOffer.updateMany({
      where: { tripId: tid, status: 'OFFERED' },
      data: { status: 'ACCEPTED', respondedAt: new Date(), respondedVia: 'USER' },
    });
    await db.trip.update({
      where: { id: tid },
      data: {
        status: 'COMPLETED',
        vehicleId: await vehicle(carrierId),
        vehiclePlateSnapshot: 'ทดสอบ',
        vehicleTypeId: uuid('vehicleType', vt6),
        assignmentStatus: 'ACCEPTED',
        completedAt: o.completedAt ?? new Date(),
        version: { increment: 1 },
      },
    });
    if (o.cost !== false) await api(app, admin).post(`/v1/trips/${tripId}/cost`).expect(200);
  };
  const queue = (query: Record<string, string | number> = {}, token = admin) =>
    api(app, token).get('/v1/settlements/queue').query(query);
  type Row = {
    id: string;
    carrierId: string;
    buyTotal?: string;
    pod: { complete: boolean; deliveryOrders: number; completeCount: number };
    lines: { id: string; buyAmount?: string; carrierId: string; costType: string }[];
  };
  const ids = (body: { data: Row[] }) => body.data.map((r) => r.id).sort();

  it('เกณฑ์ตรวจรับ: "ไม่มี POD ไม่จ่าย" → เที่ยว POD ไม่ครบไม่ขึ้นคิว · ปิดค่าตั้ง → ขึ้นพร้อมธง · เฉพาะ COSTED', async () => {
    const [a, b] = [await newSite(), await newSite()];
    const A = await newCarrier(); // ค่าเริ่มต้น requirePodToPay = true
    const B = await newCarrier({ requirePodToPay: false });
    await buyRate(A.id, a, b, '5200');
    await buyRate(B.id, a, b, '4800.50');

    const ok = await newTrip(a, b); // A: POD ครบ
    const pending = await newTrip(a, b); // A: POD ไม่ครบ
    const notCosted = await newTrip(a, b); // A: จบแล้วแต่ยังไม่ปิดต้นทุน
    const bPending = await newTrip(a, b); // B: POD ไม่ครบ แต่ B ไม่บังคับ
    for (const t of [ok, pending, notCosted]) await hire(t.id, { carrierId: A.id });
    await hire(bPending.id, { carrierId: B.id });
    await setDo(ok.doId, 'UNBILLED', 'COMPLETE');
    await setDo(pending.doId, 'POD_PENDING', 'PARTIAL');
    await setDo(notCosted.doId, 'UNBILLED', 'COMPLETE');
    await setDo(bPending.doId, 'POD_PENDING', 'NONE');
    await finish(ok.id, A.id);
    await finish(pending.id, A.id);
    await finish(notCosted.id, A.id, { cost: false });
    await finish(bPending.id, B.id);

    const r = await queue().expect(200);
    expect(ids(r.body)).toEqual([ok.id, bPending.id].sort());
    const rowOk = r.body.data.find((x: Row) => x.id === ok.id) as Row;
    expect(rowOk).toMatchObject({
      carrierId: A.id,
      requirePodToPay: true,
      pod: { complete: true, deliveryOrders: 1, completeCount: 1 },
      buyTotal: '5200.00',
    });
    expect(rowOk.lines).toHaveLength(1);
    expect(rowOk.lines[0]).toMatchObject({
      costType: 'CARRIER_FEE',
      buyAmount: '5200.00',
      settled: false,
    });
    expect(r.body.data.find((x: Row) => x.id === bPending.id)).toMatchObject({
      requirePodToPay: false,
      pod: { complete: false, deliveryOrders: 1, completeCount: 0 },
    });
    // กรองตาม POD
    expect(ids((await queue({ podComplete: 'false' }).expect(200)).body)).toEqual([bPending.id]);
    expect(ids((await queue({ podComplete: 'true' }).expect(200)).body)).toEqual([ok.id]);

    // หลักฐานครบภายหลัง → ขึ้นคิว
    await setDo(pending.doId, 'UNBILLED', 'COMPLETE');
    expect(ids((await queue({ carrierId: A.id }).expect(200)).body)).toEqual(
      [ok.id, pending.id].sort(),
    );
    // หลักฐานฉบับล่าสุดถูกแก้จนไม่ครบ (DO ไม่ถอยสถานะ) → ไม่ขึ้นคิว
    await setDo(pending.doId, 'UNBILLED', 'PARTIAL');
    expect(ids((await queue({ carrierId: A.id }).expect(200)).body)).toEqual([ok.id]);
  });

  it('เกณฑ์ตรวจรับ: บรรทัดที่อยู่ในใบสำคัญจ่ายแล้วไม่ขึ้น · ค่าใช้จ่ายหน้างานยืนยันแล้วรวมในยอด · ยอดรวมต่อรถร่วม (Decimal)', async () => {
    const [a, b] = [await newSite(), await newSite()];
    const C = await newCarrier();
    await buyRate(C.id, a, b, '1000.10');
    const t1 = await newTrip(a, b);
    const t2 = await newTrip(a, b);
    for (const t of [t1, t2]) {
      await hire(t.id, { carrierId: C.id });
      await setDo(t.doId, 'UNBILLED', 'COMPLETE');
    }
    // ค่าทางด่วนที่ยืนยันแล้วของ t2 + บรรทัดที่ถูกปฏิเสธ (ไม่นับ)
    for (const [status, amount] of [
      ['CONFIRMED', '180.25'],
      ['REJECTED', '999.00'],
    ] as const)
      await db.tripCost.create({
        data: {
          tenantId,
          tripId: uuid('trip', t2.id),
          costType: 'TOLL',
          amount,
          source: 'MANUAL',
          sourceType: 'FIELD',
          status,
          carrierId: uuid('carrier', C.id),
          description: 'ค่าทางด่วน',
          createdBy: 'u-disp',
          decidedBy: 'u-acc',
          decidedAt: new Date(),
          decisionReason: 'ตรวจใบเสร็จค่าทางด่วนแล้ว',
        },
      });
    await finish(t1.id, C.id);
    await finish(t2.id, C.id);

    const r = await queue({ carrierId: C.id }).expect(200);
    expect(ids(r.body)).toEqual([t1.id, t2.id].sort());
    expect(r.body.data.find((x: Row) => x.id === t2.id).buyTotal).toBe('1180.35');
    expect(r.body.carriers).toEqual([
      {
        carrierId: C.id,
        carrierCode: C.code,
        carrierName: expect.stringContaining('หจก. รถร่วมคิว'),
        requirePodToPay: true,
        tripCount: 2,
        buyTotal: '2180.45',
      },
    ]);

    // ค่าจ้างของ t2 เข้าใบสำคัญจ่ายแล้ว (ST6-T03 เขียน settlement_line_id) → เหลือค่าทางด่วน
    const fee2 = await db.tripCost.findFirstOrThrow({
      where: { tripId: uuid('trip', t2.id), costType: 'CARRIER_FEE' },
    });
    await settleTripCostsForTest(db, { id: fee2.id });
    const r2 = await queue({ carrierId: C.id }).expect(200);
    const row2 = r2.body.data.find((x: Row) => x.id === t2.id) as Row;
    expect(row2.lines.map((l) => [l.costType, l.buyAmount])).toEqual([['TOLL', '180.25']]);
    expect(r2.body.carriers[0]).toMatchObject({ tripCount: 2, buyTotal: '1180.35' });

    // ทั้งเที่ยวอยู่ในใบสำคัญจ่ายแล้ว → ไม่ขึ้นคิว
    await settleTripCostsForTest(db, { tripId: uuid('trip', t2.id), status: 'CONFIRMED' });
    await settleTripCostsForTest(db, { tripId: uuid('trip', t1.id) });
    const r3 = await queue({ carrierId: C.id }).expect(200);
    expect(r3.body).toMatchObject({ data: [], hasMore: false, nextCursor: null, carriers: [] });
  });

  it('เปลี่ยนรถร่วม: คู่บรรทัด/กลับรายการของรายเดิมไม่ขึ้นคิว — แสดงเฉพาะค่าจ้างของรายปัจจุบัน', async () => {
    const [a, b] = [await newSite(), await newSite()];
    const D = await newCarrier();
    const E = await newCarrier();
    await buyRate(D.id, a, b, '3000');
    await buyRate(E.id, a, b, '3300');
    const t = await newTrip(a, b);
    await hire(t.id, { carrierId: D.id });
    await hire(t.id, { carrierId: E.id, changeReason: REASON });
    await setDo(t.doId, 'UNBILLED', 'COMPLETE');
    await finish(t.id, E.id);
    expect((await queue({ carrierId: D.id }).expect(200)).body.data).toEqual([]);
    const r = await queue({ carrierId: E.id }).expect(200);
    expect(r.body.data).toHaveLength(1);
    expect((r.body.data[0] as Row).lines.map((l) => [l.carrierId, l.buyAmount])).toEqual([
      [E.id, '3300.00'],
    ]);
    expect(r.body.carriers).toEqual([
      expect.objectContaining({ carrierId: E.id, buyTotal: '3300.00' }),
    ]);
  });

  it('POD ของ DO ส่งไม่สำเร็จ: ต้องมีหลักฐานชุดไม่สำเร็จครบ (COMPLETE) · กรองช่วงวันที่เที่ยวจบตามเวลาไทย · ext: · 422', async () => {
    const [a, b] = [await newSite(), await newSite()];
    const F = await newCarrier();
    await db.carrier.update({
      where: { id: uuid('carrier', F.id) },
      data: { externalId: 'AP-F-001' },
    });
    await buyRate(F.id, a, b, '2500');
    const t = await newTrip(a, b);
    await hire(t.id, { carrierId: F.id });
    await setDo(t.doId, 'FAILED', 'NONE');
    // จบ 2 พ.ย. 2569 00:30 เวลาไทย (= 1 พ.ย. 17:30 UTC)
    await finish(t.id, F.id, { completedAt: new Date('2026-11-01T17:30:00Z') });
    expect((await queue({ carrierId: F.id }).expect(200)).body.data).toEqual([]);
    await setDo(t.doId, 'FAILED', 'COMPLETE');
    expect(ids((await queue({ carrierId: 'ext:AP-F-001' }).expect(200)).body)).toEqual([t.id]);

    const range = async (q: Record<string, string>) =>
      ids((await queue({ carrierId: F.id, ...q }).expect(200)).body);
    expect(await range({ dateTo: '2026-11-01' })).toEqual([]);
    expect(await range({ dateFrom: '2026-11-02', dateTo: '2026-11-02' })).toEqual([t.id]);
    expect(await range({ dateFrom: '2026-11-03' })).toEqual([]);

    // รถร่วมที่ไม่พบ / ext ไม่พบ → รายการว่าง (ไม่ใช่ 404)
    expect((await queue({ carrierId: 'car_nope' }).expect(200)).body.data).toEqual([]);
    expect((await queue({ carrierId: 'ext:NOPE' }).expect(200)).body.data).toEqual([]);
    // ตัวกรองผิดรูปแบบ → 422
    const bad = await queue({ dateFrom: '2026-02-30' }).expect(422);
    expect(bad.body.errors[0]).toMatchObject({ field: 'dateFrom', code: 'invalid_date' });
    const rev = await queue({ dateFrom: '2026-11-05', dateTo: '2026-11-01' }).expect(422);
    expect(rev.body.errors[0]).toMatchObject({ field: 'dateTo' });
    await queue({ podComplete: 'yes' }).expect(422);
  });

  it('สิทธิ์: ไม่มี settlements:read → 403 · ไม่มี prices.buy:read → ไม่เห็นยอด · บริษัทอื่นไม่เห็น · cursor ทีละหน้า', async () => {
    const [a, b] = [await newSite(), await newSite()];
    const G = await newCarrier();
    await buyRate(G.id, a, b, '4321.99');
    const trips = [await newTrip(a, b), await newTrip(a, b), await newTrip(a, b)];
    for (const t of trips) {
      await hire(t.id, { carrierId: G.id });
      await setDo(t.doId, 'UNBILLED', 'COMPLETE');
      await finish(t.id, G.id);
    }
    await queue({}, planner).expect(403);
    const v = await queue({ carrierId: G.id }, viewer).expect(200);
    expect(v.body.data).toHaveLength(3);
    expect(v.body.data[0]).not.toHaveProperty('buyTotal');
    expect(v.body.data[0].lines[0]).not.toHaveProperty('buyAmount');
    expect(v.body.carriers[0]).not.toHaveProperty('buyTotal');
    expect(v.body.carriers[0].tripCount).toBe(3);
    expect(JSON.stringify(v.body)).not.toContain('4321');

    // บริษัทอื่น: ไม่เห็นเที่ยว/ยอด แม้ระบุรถร่วมของ A
    const o = await queue({ carrierId: G.id }, other).expect(200);
    expect(o.body).toEqual({ data: [], nextCursor: null, hasMore: false, carriers: [] });
    expect((await queue({}, other).expect(200)).body.data).toEqual([]);

    // cursor: เดินทีละ 1 แถวครบไม่ซ้ำ · ยอดรวมต่อรถร่วมไม่ขึ้นกับหน้า
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const qp: Record<string, string | number> = { carrierId: G.id, limit: 1 };
      if (cursor) qp.cursor = cursor;
      const p: { body: { data: Row[]; nextCursor: string | null; carriers: object[] } } =
        await queue(qp).expect(200);
      seen.push(...ids(p.body));
      expect(p.body.carriers[0]).toMatchObject({ tripCount: 3, buyTotal: '12965.97' });
      cursor = p.body.nextCursor;
      if (!cursor) break;
    }
    expect(seen.sort()).toEqual(trips.map((t) => t.id).sort());
    // fields= เลือกเฉพาะช่อง
    const f = await queue({ carrierId: G.id, fields: 'tripNo' }).expect(200);
    expect(Object.keys(f.body.data[0]).sort()).toEqual(['id', 'tripNo']);
  });

  it('ปริมาณมาก: 2,000 เที่ยวในคิว (updatedAt เท่ากันเป็นกลุ่ม) — เดินทุกหน้าทั้งสองทิศครบไม่ซ้ำ · ยอดรวมต่อรถร่วมจาก aggregate', async () => {
    const H = await newCarrier({ requirePodToPay: false });
    const hId = uuid('carrier', H.id);
    const veh = await vehicle(H.id);
    // seed ด้วย SQL: 2,000 เที่ยว COSTED + บรรทัดค่าจ้าง 1 บรรทัด (เที่ยวละ 100.01) · updated_at ซ้ำกันทีละ 50 เที่ยว
    await db.$executeRaw`
      WITH t AS (
        INSERT INTO trip (id, tenant_id, trip_no, trip_date, status, carrier_id, carrier_name_snapshot,
                          vehicle_id, vehicle_plate_snapshot, vehicle_type_id, completed_at, costed_at, updated_at)
        SELECT gen_random_uuid(), ${tenantId}::uuid, 'BULK-' || g, ${today}::date, 'COSTED', ${hId}::uuid,
               'หจก. รถร่วมจำนวนมาก', ${veh}::uuid, 'ทดสอบ', ${uuid('vehicleType', vt6)}::uuid,
               now(), now(), timestamp '2026-11-10 00:00:00' + (g / 50) * interval '1 millisecond'
          FROM generate_series(1, 2000) g
        RETURNING id
      )
      INSERT INTO trip_cost (id, tenant_id, trip_id, cost_type, amount, source, carrier_id, status)
      SELECT gen_random_uuid(), ${tenantId}::uuid, t.id, 'CARRIER_FEE', 100.01, 'MANUAL', ${hId}::uuid, 'CONFIRMED'
        FROM t`;
    // สถิติตารางหลัง seed (ฐานจริงมี autovacuum) — ANALYZE ต้องใช้เจ้าของตาราง
    const owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    await owner.$executeRawUnsafe('ANALYZE trip, trip_cost, delivery_order');
    await owner.$disconnect();
    const t0 = Date.now();
    for (const sort of ['updatedAt', '-updatedAt']) {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 20; i++) {
        const qp: Record<string, string | number> = { carrierId: H.id, limit: 200, sort };
        if (cursor) qp.cursor = cursor;
        const p: { body: { data: Row[]; nextCursor: string | null; carriers: object[] } } =
          await queue(qp).expect(200);
        seen.push(...(p.body.data as Row[]).map((r) => r.id));
        expect(p.body.carriers).toEqual([
          expect.objectContaining({ carrierId: H.id, tripCount: 2000, buyTotal: '200020.00' }),
        ]);
        cursor = p.body.nextCursor;
        if (!cursor) break;
      }
      expect(seen, sort).toHaveLength(2000);
      expect(new Set(seen).size, sort).toBe(2000);
    }
    // 22 หน้า (2 ทิศ) — แต่ละคำขอใช้ keyset + LIMIT ใน SQL
    expect(Date.now() - t0).toBeLessThan(30_000);
  }, 120_000);
});
