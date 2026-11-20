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
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST6-T03 ติ๊กเที่ยว → ใบสำคัญจ่าย (ร่าง) — เกณฑ์ตรวจรับ: ใส่ `trip_cost` เดียวกันใน 2 ใบ → ใบที่สองได้ 409;
 * ยอดสุทธิ = รวม − หัก · กันจ่ายซ้ำระดับ DB (partial unique) + คำขอพร้อมกัน · นำบรรทัดออก/ยกเลิกใบ (เหตุผล + audit) → กลับคิว ·
 * If-Match · สิทธิ์ · แยก tenant
 */
describe('settlements (ST6-T03)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let otherId: string;
  let admin: string;
  let viewer: string;
  let planner: string;
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
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท ใบสำคัญจ่าย' })).id;
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
  const newCarrier = async (body: object = {}) =>
    (
      await api(app, admin)
        .post('/v1/carriers')
        .send({
          legalName: `หจก. รถร่วมจ่าย ${++seed}`,
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
  const queue = (query: Record<string, string> = {}) =>
    api(app, admin).get('/v1/settlements/queue').query(query).expect(200);
  const queued = async (carrierId: string) =>
    ((await queue({ carrierId })).body.data as { id: string }[]).map((r) => r.id).sort();
  /** รถร่วม + เที่ยวที่ปิดต้นทุนแล้ว (POD ครบ) n เที่ยว ราคาซื้อ rate ต่อเที่ยว */
  const setup = async (n: number, rate = '4500', carrier: object = {}) => {
    const [a, b] = [await newSite(), await newSite()];
    const C = await newCarrier(carrier);
    await buyRate(C.id, a, b, rate);
    const trips: { id: string; doId: string }[] = [];
    for (let i = 0; i < n; i++) {
      const t = await newTrip(a, b);
      await hire(t.id, { carrierId: C.id });
      await setDo(t.doId, 'UNBILLED', 'COMPLETE');
      await finish(t.id, C.id);
      trips.push(t);
    }
    return { C, trips, a, b };
  };
  const feeOf = async (tripId: string) =>
    encodeId(
      'tripCost',
      (
        await db.tripCost.findFirstOrThrow({
          where: { tripId: uuid('trip', tripId), costType: 'CARRIER_FEE' },
        })
      ).id,
    );
  const ADV = {
    deductionType: 'CASH_ADVANCE',
    description: 'เงินเบิกล่วงหน้าค่าน้ำมัน',
    amount: '-2000.00',
    reference: 'ADV-2611-0007',
  };
  const FINE = {
    deductionType: 'FINE',
    description: 'ค่าปรับจราจร ขับเร็วเกินกำหนด',
    amount: '-500',
    reference: 'ใบสั่ง 6611-889',
  };
  const create = (body: object, token = admin) =>
    api(app, token).post('/v1/settlements').send(body);
  type Line = {
    id: string;
    lineType: string;
    tripCostId: string | null;
    buyAmount?: string;
    active: boolean;
    whtRate: string | null;
  };

  it('เกณฑ์ตรวจรับ: ติ๊ก 3 เที่ยว + หัก 2 รายการ → ยอดสุทธิ = รวม − หัก · ร่างไม่มีเลข · เที่ยวออกจากคิว · audit', async () => {
    const { C, trips } = await setup(3);
    const r = await create({
      carrierId: C.id,
      tripIds: trips.map((t) => t.id),
      deductions: [ADV, FINE],
      carrierInvoiceNo: 'INV-SUB-0042',
      carrierInvoiceDate: today,
    }).expect(201);
    expect(r.headers.etag).toBe('"1"');
    expect(r.body).toMatchObject({
      settlementNo: null,
      status: 'DRAFT',
      carrier: { id: C.id, code: C.code, entityType: 'JURISTIC' },
      periodFrom: today,
      periodTo: today,
      carrierInvoiceNo: 'INV-SUB-0042',
      carrierInvoiceDate: today,
      tripCount: 3,
      buyGrossAmount: '13500.00',
      buyDeductionAmount: '2500.00',
      buyNetPayable: '11000.00',
    });
    const lines = r.body.lines as Line[];
    expect(lines.map((l) => l.lineType)).toEqual([
      'FREIGHT',
      'FREIGHT',
      'FREIGHT',
      'DEDUCTION',
      'DEDUCTION',
    ]);
    expect(lines.map((l) => l.buyAmount)).toEqual([
      '4500.00',
      '4500.00',
      '4500.00',
      '-2000.00',
      '-500.00',
    ]);
    // ธงภาษีคัดลอกจากบรรทัดต้นทุน (ข้อมูลเท่านั้น — ไม่คำนวณ WHT)
    expect(lines[0]!.whtRate).toBe('1.00');
    expect(lines[3]).toMatchObject({ deductionType: 'CASH_ADVANCE', reference: 'ADV-2611-0007' });
    // บรรทัดต้นทุนผูกกับบรรทัดใบ → ไม่ขึ้นคิว
    expect(await queued(C.id)).toEqual([]);
    const fee = await db.tripCost.findFirstOrThrow({
      where: { tripId: uuid('trip', trips[0]!.id), costType: 'CARRIER_FEE' },
    });
    expect(fee.settlementLineId).toBe(uuid('settlementLine', lines[0]!.id));
    const costs = (await api(app, admin).get(`/v1/trips/${trips[0]!.id}/costs`).expect(200)).body;
    expect(costs.data[0].settled).toBe(true);
    const audit = await db.auditLog.findFirstOrThrow({
      where: { entityId: uuid('settlement', r.body.id), action: 'settlement.created' },
    });
    expect(audit.after).toMatchObject({ buyNetPayable: '11000.00' });
    // GET + รายการ
    const g = await api(app, admin).get(`/v1/settlements/${r.body.id}`).expect(200);
    expect(g.headers.etag).toBe('"1"');
    expect(g.body.buyNetPayable).toBe('11000.00');
    const list = await api(app, admin)
      .get('/v1/settlements')
      .query({ carrierId: C.id })
      .expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({
      id: r.body.id,
      tripCount: 3,
      buyNetPayable: '11000.00',
    });
    expect(
      (
        await api(app, admin)
          .get('/v1/settlements')
          .query({ status: 'CANCELLED', carrierId: C.id })
          .expect(200)
      ).body.data,
    ).toEqual([]);
  });

  it('เกณฑ์ตรวจรับ: trip_cost เดียวกันใน 2 ใบ → ใบที่สอง 409 trip_cost_already_settled (ทั้งรายบรรทัดและติ๊กเที่ยว)', async () => {
    const { C, trips } = await setup(2, '3000');
    const first = await create({ carrierId: C.id, tripIds: [trips[0]!.id] }).expect(201);
    const fee = await feeOf(trips[0]!.id);
    const byCost = await create({ carrierId: C.id, tripCostIds: [fee] }).expect(409);
    expect(byCost.body).toMatchObject({
      code: 'trip_cost_already_settled',
      tripCostIds: [fee],
      settlementIds: [first.body.id],
    });
    const byTrip = await create({ carrierId: C.id, tripIds: [trips[1]!.id, trips[0]!.id] }).expect(
      409,
    );
    expect(byTrip.body.code).toBe('trip_cost_already_settled');
    // เพิ่มเข้าใบเดิมซ้ำก็ไม่ได้
    await api(app, admin)
      .post(`/v1/settlements/${first.body.id}/lines`)
      .send({ tripCostIds: [fee] })
      .expect(409);
    // ไม่มีอะไรถูกสร้างจากคำขอที่ล้ม — t2 ยังอยู่ในคิว
    expect(await queued(C.id)).toEqual([trips[1]!.id]);
  });

  it('กันจ่ายซ้ำ: สองคำขอพร้อมกัน → 201 หนึ่งใบ + 409 · partial unique index ใน DB ปฏิเสธบรรทัดที่ยังใช้ซ้ำ', async () => {
    const { C, trips } = await setup(1, '2500');
    const results = await Promise.all(
      [0, 1, 2].map(() => create({ carrierId: C.id, tripIds: [trips[0]!.id] })),
    );
    const codes = results.map((x) => x.status).sort();
    expect(codes).toEqual([201, 409, 409]);
    for (const x of results.filter((y) => y.status === 409))
      expect(x.body.code).toBe('trip_cost_already_settled');
    const won = results.find((x) => x.status === 201)!.body;
    expect(await db.carrierSettlement.count({ where: { carrierId: uuid('carrier', C.id) } })).toBe(
      1,
    );

    // ชั้น DB: แทรกบรรทัดที่ยังใช้ของ trip_cost เดียวกันตรง ๆ (ข้าม service) → unique violation
    const fee = uuid('tripCost', await feeOf(trips[0]!.id));
    const other = await db.carrierSettlement.create({
      data: {
        tenantId,
        carrierId: uuid('carrier', C.id),
        carrierSnapshot: {},
        periodFrom: new Date(`${today}T00:00:00Z`),
        periodTo: new Date(`${today}T00:00:00Z`),
      },
    });
    const dup = {
      tenantId,
      settlementId: other.id,
      lineNo: 1,
      lineType: 'FREIGHT',
      tripCostId: fee,
      tripId: uuid('trip', trips[0]!.id),
      description: 'ซ้ำ',
      amount: '2500',
    };
    await expect(db.settlementLine.create({ data: dup })).rejects.toThrow(/Unique constraint/i);
    // บรรทัดหักติดลบเท่านั้น + ต้องมีเอกสารอ้างอิง (CHECK)
    await expect(
      db.settlementLine.create({
        data: {
          tenantId,
          settlementId: other.id,
          lineNo: 3,
          lineType: 'DEDUCTION',
          deductionType: 'FINE',
          description: 'ค่าปรับ',
          amount: '500',
          reference: 'X',
        },
      }),
    ).rejects.toThrow(/settlement_line_ref_check/);
    expect(won.lines).toHaveLength(1);
  });

  it('นำบรรทัดออก (เหตุผล + If-Match + audit) → บรรทัดต้นทุนกลับคิว ยอดคิดใหม่ · เพิ่มกลับได้', async () => {
    const { C, trips } = await setup(2, '1000.10');
    const s = (
      await create({ carrierId: C.id, tripIds: trips.map((t) => t.id), deductions: [FINE] }).expect(
        201,
      )
    ).body;
    expect(s.buyNetPayable).toBe('1500.20');
    const line = (s.lines as Line[])[1]!;
    const url = `/v1/settlements/${s.id}/lines/${line.id}/remove`;
    await api(app, admin).post(url).send({ reason: 'สั้น' }).expect(422);
    await api(app, admin)
      .post(url)
      .set('If-Match', '"9"')
      .send({ reason: 'รถร่วมขอแยกวางบิลงวดหน้า' })
      .expect(412);
    const r = await api(app, admin)
      .post(url)
      .set('If-Match', '"1"')
      .send({ reason: 'รถร่วมขอแยกวางบิลงวดหน้า' })
      .expect(200);
    expect(r.headers.etag).toBe('"2"');
    expect(r.body).toMatchObject({
      tripCount: 1,
      buyGrossAmount: '1000.10',
      buyNetPayable: '500.10',
    });
    const removed = (r.body.lines as Line[]).find((l) => l.id === line.id)!;
    expect(removed).toMatchObject({ active: false, voidReason: 'รถร่วมขอแยกวางบิลงวดหน้า' });
    expect(await queued(C.id)).toEqual([trips[1]!.id]);
    expect(
      await db.auditLog.count({
        where: {
          entityId: uuid('settlement', s.id),
          action: 'settlement.line_removed',
          reason: 'รถร่วมขอแยกวางบิลงวดหน้า',
        },
      }),
    ).toBe(1);
    // นำออกซ้ำ → 409
    await api(app, admin).post(url).send({ reason: 'รถร่วมขอแยกวางบิลงวดหน้า' }).expect(409);
    // เพิ่มกลับ (บรรทัดใหม่ เลขบรรทัดต่อท้าย)
    const back = await api(app, admin)
      .post(`/v1/settlements/${s.id}/lines`)
      .set('If-Match', '"2"')
      .send({ tripIds: [trips[1]!.id], deductions: [ADV] })
      .expect(200);
    expect(back.body).toMatchObject({
      tripCount: 2,
      buyGrossAmount: '2000.20',
      buyDeductionAmount: '2500.00',
      buyNetPayable: '-499.80',
    });
    expect((back.body.lines as { lineNo: number }[]).map((l) => l.lineNo)).toEqual([1, 2, 3, 4, 5]);
    expect(await queued(C.id)).toEqual([]);
  });

  it('ยกเลิกใบร่าง (เหตุผล + audit) → ทุกบรรทัดกลับคิว · ใบใหม่ใส่ trip_cost เดิมได้ · ใบที่ยกเลิกแก้ไม่ได้', async () => {
    const { C, trips } = await setup(1, '800');
    const s = (
      await create({ carrierId: C.id, tripIds: [trips[0]!.id], deductions: [FINE] }).expect(201)
    ).body;
    await api(app, admin).post(`/v1/settlements/${s.id}/cancel`).send({}).expect(422);
    const c = await api(app, admin)
      .post(`/v1/settlements/${s.id}/cancel`)
      .set('If-Match', '"1"')
      .send({ reason: 'สร้างผิดรถร่วม ต้องออกใหม่' })
      .expect(200);
    expect(c.body).toMatchObject({
      status: 'CANCELLED',
      cancelReason: 'สร้างผิดรถร่วม ต้องออกใหม่',
    });
    expect((c.body.lines as Line[]).every((l) => !l.active)).toBe(true);
    expect(await queued(C.id)).toEqual([trips[0]!.id]);
    const audit = await db.auditLog.findFirstOrThrow({
      where: { entityId: uuid('settlement', s.id), action: 'settlement.cancelled' },
    });
    expect(audit.reason).toBe('สร้างผิดรถร่วม ต้องออกใหม่');
    // ใบที่ยกเลิก: แก้/เพิ่ม/ยกเลิกซ้ำไม่ได้
    await api(app, admin).patch(`/v1/settlements/${s.id}`).send({ note: 'x' }).expect(409);
    await api(app, admin)
      .post(`/v1/settlements/${s.id}/cancel`)
      .send({ reason: 'สร้างผิดรถร่วม ต้องออกใหม่' })
      .expect(409);
    // ใบใหม่ใช้ trip_cost เดิมได้ (unique เฉพาะบรรทัดที่ยังใช้)
    const again = await create({ carrierId: C.id, tripIds: [trips[0]!.id] }).expect(201);
    expect(again.body.buyNetPayable).toBe('800.00');
  });

  it('แก้หัวใบร่าง: เลขใบแจ้งหนี้/ใบเสร็จของรถร่วม งวด หมายเหตุ · If-Match · audit เฉพาะช่องที่เปลี่ยน', async () => {
    const { C, trips } = await setup(1, '1200');
    const s = (await create({ carrierId: C.id, tripIds: [trips[0]!.id] }).expect(201)).body;
    await api(app, admin)
      .patch(`/v1/settlements/${s.id}`)
      .set('If-Match', '"5"')
      .send({ note: 'x' })
      .expect(412);
    await api(app, admin)
      .patch(`/v1/settlements/${s.id}`)
      .send({ periodFrom: '2026-11-31' })
      .expect(422);
    await api(app, admin)
      .patch(`/v1/settlements/${s.id}`)
      .send({ periodFrom: '2099-01-01' })
      .expect(422);
    const r = await api(app, admin)
      .patch(`/v1/settlements/${s.id}`)
      .set('If-Match', '"1"')
      .send({
        carrierInvoiceNo: 'IV-77',
        carrierReceiptNo: 'RC-12',
        periodFrom: '2026-11-01',
        note: 'งวดต้นเดือน',
      })
      .expect(200);
    expect(r.headers.etag).toBe('"2"');
    expect(r.body).toMatchObject({
      carrierInvoiceNo: 'IV-77',
      carrierReceiptNo: 'RC-12',
      periodFrom: '2026-11-01',
      periodTo: today,
      note: 'งวดต้นเดือน',
    });
    const a = await db.auditLog.findFirstOrThrow({
      where: { entityId: uuid('settlement', s.id), action: 'settlement.updated' },
    });
    expect(a.after).toEqual({
      carrierInvoiceNo: 'IV-77',
      carrierReceiptNo: 'RC-12',
      periodFrom: '2026-11-01',
      note: 'งวดต้นเดือน',
    });
  });

  it('เที่ยวที่ไม่อยู่ในคิวจ่าย → 409 trip_cost_not_payable (ยังไม่ปิดต้นทุน / POD ไม่ครบ / รถร่วมอื่น) · ข้อมูลผิด 422', async () => {
    const { C, a, b } = await setup(0);
    const D = await newCarrier();
    await buyRate(D.id, a, b, '999');
    const notCosted = await newTrip(a, b);
    await hire(notCosted.id, { carrierId: C.id });
    await setDo(notCosted.doId, 'UNBILLED', 'COMPLETE');
    await finish(notCosted.id, C.id, { cost: false });
    const podPending = await newTrip(a, b);
    await hire(podPending.id, { carrierId: C.id });
    await setDo(podPending.doId, 'POD_PENDING', 'PARTIAL');
    await finish(podPending.id, C.id);
    const ofD = await newTrip(a, b);
    await hire(ofD.id, { carrierId: D.id });
    await setDo(ofD.doId, 'UNBILLED', 'COMPLETE');
    await finish(ofD.id, D.id);
    for (const t of [notCosted, podPending, ofD]) {
      const r = await create({ carrierId: C.id, tripIds: [t.id] }).expect(409);
      expect(r.body).toMatchObject({ code: 'trip_cost_not_payable', tripIds: [t.id] });
    }
    const r = await create({ carrierId: C.id, tripCostIds: [await feeOf(ofD.id)] }).expect(409);
    expect(r.body.code).toBe('trip_cost_not_payable');
    // ข้อมูลผิด
    const bad = (body: object) =>
      create({ carrierId: D.id, tripIds: [ofD.id], ...body }).expect(422);
    await bad({ deductions: [{ ...ADV, amount: '2000' }] });
    await bad({ deductions: [{ ...ADV, reference: ' ' }] });
    await bad({ deductions: [{ ...ADV, deductionType: 'OTHER' }] });
    await bad({ deductions: [{ ...ADV, tripId: notCosted.id }] }); // เที่ยวของรถร่วมอื่น
    await bad({ periodFrom: '2026-11-20', periodTo: '2026-11-01' });
    await create({ carrierId: D.id }).expect(422);
    await create({ carrierId: D.id, tripIds: ['trp_00000000000040008000000000000999'] }).expect(
      422,
    );
    await create({ carrierId: 'car_00000000000040008000000000000999', tripIds: [ofD.id] }).expect(
      422,
    );
    expect(await queued(D.id)).toEqual([ofD.id]);
  });

  it('สิทธิ์: สร้าง/แก้ = settlements:create (ผู้จ่ายงานได้ · viewer/ผู้จัดการ 403) · อ่าน settlements:read · ยอดตัดเมื่อไม่มี prices.buy:read · แยก tenant', async () => {
    const { C, trips } = await setup(2, '700');
    const manager = await tokenFor(tenantId, SYSTEM_ROLES.manager.permissions.join(' '), 'u-mgr');
    await create({ carrierId: C.id, tripIds: [trips[0]!.id] }, viewer).expect(403);
    await create({ carrierId: C.id, tripIds: [trips[0]!.id] }, manager).expect(403);
    const s = (
      await create(
        { carrierId: C.id, tripIds: [trips[0]!.id], deductions: [FINE] },
        dispatcher,
      ).expect(201)
    ).body;
    expect(s.createdBy).toBe('u-disp');
    await api(app, planner).get(`/v1/settlements/${s.id}`).expect(403);
    await api(app, planner).get('/v1/settlements').expect(403);
    const v = (await api(app, viewer).get(`/v1/settlements/${s.id}`).expect(200)).body;
    expect(v.buyNetPayable).toBeUndefined();
    expect(v.lines[0].buyAmount).toBeUndefined();
    await api(app, viewer)
      .post(`/v1/settlements/${s.id}/cancel`)
      .send({ reason: 'ไม่มีสิทธิ์ยกเลิกใบนี้' })
      .expect(403);
    // tenant อื่น: ไม่เห็นใบ · ใส่เที่ยวของ tenant นี้ไม่ได้
    await api(app, other).get(`/v1/settlements/${s.id}`).expect(404);
    expect((await api(app, other).get('/v1/settlements').expect(200)).body.data).toEqual([]);
    await api(app, other)
      .post('/v1/settlements')
      .send({ carrierId: C.id, tripIds: [trips[1]!.id] })
      .expect(422);
  });
  it('กติการะดับ DB (role แอป): บรรทัดแก้/ย้าย/ลบไม่ได้ · เพิ่มได้เฉพาะร่าง · นำออกทางเดียว · ใบยกเลิกแก้ไม่ได้ · ยอดหัวใบ = บรรทัด · ผูก trip_cost สองทาง', async () => {
    const { C, trips } = await setup(2, '1500');
    const s = (
      await create({ carrierId: C.id, tripIds: [trips[0]!.id], deductions: [FINE] }).expect(201)
    ).body;
    const sid = uuid('settlement', s.id);
    const [fl, dl] = (s.lines as Line[]).map((l) => uuid('settlementLine', l.id));
    const fee0 = uuid('tripCost', await feeOf(trips[0]!.id));
    const fee1 = uuid('tripCost', await feeOf(trips[1]!.id));
    const tripId = uuid('trip', trips[0]!.id);
    const fails = (fn: (tx: Tx) => Promise<unknown>, re: RegExp) =>
      expect(run(fn)).rejects.toThrow(re);

    // (1) คอลัมน์อ้างอิง/ยอดของบรรทัดแก้ไม่ได้
    for (const data of [
      { amount: '1.00' },
      { tripCostId: fee1 },
      { lineType: 'SURCHARGE' },
      { lineNo: 99 },
    ])
      await fails(
        (tx) => tx.settlementLine.update({ where: { id: fl! }, data }),
        /settlement_line_immutable/,
      );
    const otherS = await run((tx) =>
      tx.carrierSettlement.create({
        data: {
          tenantId,
          carrierId: uuid('carrier', C.id),
          carrierSnapshot: {},
          periodFrom: new Date(`${today}T00:00:00Z`),
          periodTo: new Date(`${today}T00:00:00Z`),
        },
      }),
    );
    await fails(
      (tx) => tx.settlementLine.update({ where: { id: fl! }, data: { settlementId: otherS.id } }),
      /settlement_line_immutable/,
    );
    // (2) ไม่มีการลบ
    await fails((tx) => tx.settlementLine.delete({ where: { id: dl! } }), /permission denied/i);
    await fails((tx) => tx.carrierSettlement.delete({ where: { id: sid } }), /permission denied/i);
    // (3) เพิ่มบรรทัดที่นำออกแล้วไม่ได้ · ยอดหัวใบต้องตรงบรรทัด (ตรวจตอน commit)
    const ded = {
      tenantId,
      settlementId: sid,
      lineNo: 50,
      lineType: 'DEDUCTION',
      deductionType: 'DAMAGE',
      description: 'ค่าเสียหายสินค้า',
      amount: '-100',
      reference: 'DMG-1',
    };
    await fails(
      (tx) =>
        tx.settlementLine.create({
          data: { ...ded, voidedAt: new Date(), voidedBy: 'u', voidReason: 'นำออกตั้งแต่เพิ่ม' },
        }),
      /settlement_line_draft_only/,
    );
    await fails((tx) => tx.settlementLine.create({ data: ded }), /carrier_settlement_totals/);
    await fails(
      (tx) =>
        tx.carrierSettlement.update({
          where: { id: sid },
          data: { grossAmount: '1.00', netPayable: '-499.00' },
        }),
      /carrier_settlement_totals/,
    );
    // (4) ผูก trip_cost ↔ บรรทัดที่ยังใช้
    await fails(
      (tx) => tx.tripCost.update({ where: { id: fee0 }, data: { settlementLineId: null } }),
      /settlement_line_trip_cost_link/,
    );
    await fails(
      (tx) => tx.tripCost.update({ where: { id: fee1 }, data: { settlementLineId: dl! } }),
      /settlement_line_trip_cost_link/,
    );
    await fails(
      (tx) => tx.tripCost.update({ where: { id: fee1 }, data: { settlementLineId: randomUUID() } }),
      /settlement_line_trip_cost_link/,
    );
    await fails(async (tx) => {
      await tx.settlementLine.update({
        where: { id: fl! },
        data: { voidedAt: new Date(), voidedBy: 'u', voidReason: 'นำออกแต่ไม่ปลด trip_cost' },
      });
      await tx.$executeRaw`UPDATE carrier_settlement SET gross_amount = 0, net_payable = -500 WHERE id = ${sid}::uuid`;
    }, /settlement_line_trip_cost_link/);
    // (5) ยกเลิกผ่าน API แล้ว: ใบเป็นสถานะสิ้นสุด · บรรทัดที่นำออกกลับมาใช้ไม่ได้ · เพิ่มบรรทัดไม่ได้
    await api(app, admin)
      .post(`/v1/settlements/${s.id}/cancel`)
      .send({ reason: 'ทดสอบกติการะดับฐานข้อมูล' })
      .expect(200);
    await fails(
      (tx) => tx.carrierSettlement.update({ where: { id: sid }, data: { note: 'แก้หลังยกเลิก' } }),
      /carrier_settlement_terminal/,
    );
    await fails(
      (tx) => tx.carrierSettlement.update({ where: { id: sid }, data: { status: 'DRAFT' } }),
      /carrier_settlement_terminal/,
    );
    await fails(
      (tx) =>
        tx.settlementLine.update({
          where: { id: dl! },
          data: { voidedAt: null, voidedBy: null, voidReason: null },
        }),
      /settlement_line_void_one_way|settlement_line_void_check/,
    );
    await fails(
      (tx) =>
        tx.settlementLine.update({
          where: { id: dl! },
          data: { voidReason: 'เปลี่ยนเหตุผลภายหลัง' },
        }),
      /settlement_line_void_one_way/,
    );
    await fails(
      (tx) => tx.settlementLine.create({ data: { ...ded, lineNo: 51 } }),
      /settlement_line_draft_only/,
    );
    // ทางปกติของ service ผ่านทุก trigger
    await create({ carrierId: C.id, tripIds: trips.map((t) => t.id) }).expect(201);
  });

  it('ยอดหัก "-0" / "-0.00" / "-00.00" → 422 · ยอดรวมเกิน numeric(14,2) → 422 (ไม่ใช่ 500)', async () => {
    const { C, trips } = await setup(1, '100');
    for (const amount of ['-0', '-0.00', '-00.00', '-0.0'])
      await create({
        carrierId: C.id,
        tripIds: [trips[0]!.id],
        deductions: [{ ...ADV, amount }],
      }).expect(422);
    const huge = { ...ADV, amount: '-999999999999.99' };
    const r = await create({
      carrierId: C.id,
      tripIds: [trips[0]!.id],
      deductions: [huge, huge],
    }).expect(422);
    expect(r.body.errors[0].code).toBe('amount_out_of_range');
    // ไม่มีอะไรค้าง — เที่ยวยังอยู่ในคิว
    expect(await queued(C.id)).toEqual([trips[0]!.id]);
    const ok = await create({
      carrierId: C.id,
      tripIds: [trips[0]!.id],
      deductions: [{ ...ADV, amount: '-0.01' }],
    }).expect(201);
    expect(ok.body.buyNetPayable).toBe('99.99');
  });

  it('แยก tenant: นำบรรทัดออกด้วย id จริงของบริษัทอื่น → 404 (ทั้งใบ+บรรทัดของ A และใบของ B + บรรทัดของ A)', async () => {
    const { C, trips } = await setup(1, '600');
    const s = (await create({ carrierId: C.id, tripIds: [trips[0]!.id] }).expect(201)).body;
    const lineId = (s.lines as Line[])[0]!.id;
    const body = { reason: 'ทดสอบข้ามบริษัทด้วย id จริง' };
    const r = await api(app, other)
      .post(`/v1/settlements/${s.id}/lines/${lineId}/remove`)
      .send(body)
      .expect(404);
    expect(r.body.code).toBe('not_found');
    const bCarrier = await db.carrier.create({
      data: {
        tenantId: otherId,
        code: 'B-STL-1',
        legalName: 'รถร่วมของบริษัทอื่น',
        entityType: 'JURISTIC',
      },
    });
    const bS = await db.carrierSettlement.create({
      data: {
        tenantId: otherId,
        carrierId: bCarrier.id,
        carrierSnapshot: {},
        periodFrom: new Date(`${today}T00:00:00Z`),
        periodTo: new Date(`${today}T00:00:00Z`),
      },
    });
    await api(app, other)
      .post(`/v1/settlements/${encodeId('settlement', bS.id)}/lines/${lineId}/remove`)
      .send(body)
      .expect(404);
    // บรรทัดของ A ไม่ถูกแตะ
    const a = (await api(app, admin).get(`/v1/settlements/${s.id}`).expect(200)).body;
    expect((a.lines as Line[])[0]!.active).toBe(true);
  });
});
