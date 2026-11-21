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
import { signStepUpToken } from '../src/auth/tokens';
import { SettlementPdfService } from '../src/modules/settlements/settlement-pdf.service';
import { settlementVoucherDocument } from '../src/modules/settlements/settlement-pdf.template';
import { bahtFormat } from '../src/pdf/finance-document';
import { PdfRenderer } from '../src/pdf/pdf-renderer';
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
  // ---------------- ST6-T07 อนุมัติ (separation of duties) ----------------
  describe('หัก ณ ที่จ่ายประมาณการ (ST6-T08)', () => {
    const setMin = (value: number) =>
      db.tenantSetting.upsert({
        where: { tenantId_key: { tenantId, key: 'tax.whtMinimumAmount' } },
        create: { tenantId, key: 'tax.whtMinimumAmount', value: value as never },
        update: { value: value as never },
      });
    const idCard = (n: number) => {
      const base = `1${String(10_000_000_000 + n).slice(-11)}`;
      let sum = 0;
      for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
      return base + String((11 - (sum % 11)) % 10);
    };
    type WhtLine = Line & {
      whtRateApplied: string | null;
      whtRateSource: string | null;
      buyWhtAmount?: string | null;
    };
    afterAll(() => setMin(0));

    it('เกณฑ์: ยอดก่อนหัก × อัตราบรรทัด (1%) · บรรทัดหักไม่ใช่ฐาน · ภ.ง.ด.53 · ติดธงยังไม่ผ่านนักบัญชี · รายการมียอด', async () => {
      const { C, trips } = await setup(3, '1234.56');
      const r = await create({
        carrierId: C.id,
        tripIds: trips.map((t) => t.id),
        deductions: [ADV, FINE],
      }).expect(201);
      // ฐาน 3,703.68 × 1% = 37.0368 → 37.04 (ปัดครั้งเดียวทั้งกลุ่ม) · สุทธิ = 3,703.68 − 37.04 − 2,500
      expect(r.body).toMatchObject({
        buyGrossAmount: '3703.68',
        buyDeductionAmount: '2500.00',
        buyNetPayable: '1203.68',
        buyWhtAmount: '37.04',
        buyNetAfterWht: '1166.64',
        whtEstimate: {
          review: 'NOT_REVIEWED_BY_ACCOUNTANT',
          form: 'PND53',
          frozen: false,
          minimumAmount: '0.00',
          belowMinimum: false,
          byRate: [{ whtRate: '1.00', buyBaseAmount: '3703.68', buyWhtAmount: '37.04' }],
        },
      });
      const lines = r.body.lines as WhtLine[];
      expect(lines.map((l) => [l.whtRateApplied, l.whtRateSource, l.buyWhtAmount])).toEqual([
        ['1.00', 'LINE', '12.35'],
        ['1.00', 'LINE', '12.35'],
        ['1.00', 'LINE', '12.34'], // เศษไปบรรทัดสุดท้ายของกลุ่ม (ผลรวม = ยอดใบ)
        [null, null, null],
        [null, null, null],
      ]);
      const row = (
        (await api(app, admin).get('/v1/settlements').query({ carrierId: C.id }).expect(200)).body
          .data as Record<string, unknown>[]
      )[0];
      expect(row).toMatchObject({
        buyWhtAmount: '37.04',
        buyNetAfterWht: '1166.64',
        whtForm: 'PND53',
        tripCount: 3,
      });
      // นำบรรทัดเที่ยวออก → คิดใหม่จากบรรทัดที่ยังใช้
      const removed = await api(app, admin)
        .post(`/v1/settlements/${r.body.id}/lines/${lines[0]!.id}/remove`)
        .set('If-Match', '"1"')
        .send({ reason: 'เที่ยวนี้จ่ายรอบหน้าแทน' })
        .expect(200);
      expect(removed.body).toMatchObject({
        buyWhtAmount: '24.69',
        whtEstimate: { byRate: [{ buyBaseAmount: '2469.12', buyWhtAmount: '24.69' }] },
      });
      expect((removed.body.lines as WhtLine[])[0]).toMatchObject({
        active: false,
        whtRateApplied: null,
        buyWhtAmount: null,
      });
    });

    it('บรรทัดไม่มีธงอัตรา (ราคากรอกเอง) → ค่าตั้งต้นรถร่วม (3%) · บรรทัด 3% ปน 1% · บุคคลธรรมดา = ภ.ง.ด.3', async () => {
      const { C, trips } = await setup(2, '5000', {
        entityType: 'INDIVIDUAL',
        taxId: idCard(++seed),
        whtRate: '3.00',
      });
      // เที่ยวแรก: ราคากรอกเอง (ไม่มีธง) · เที่ยวสอง: ธงของบรรทัด 1% ชนะค่าตั้งต้นรถร่วม
      await db.tripCost.updateMany({
        where: { tripId: uuid('trip', trips[0]!.id), costType: 'CARRIER_FEE' },
        data: { whtRate: null },
      });
      await db.tripCost.updateMany({
        where: { tripId: uuid('trip', trips[1]!.id), costType: 'CARRIER_FEE' },
        data: { whtRate: 1 },
      });
      const r = await create({ carrierId: C.id, tripIds: trips.map((t) => t.id) }).expect(201);
      expect(r.body.carrier.entityType).toBe('INDIVIDUAL');
      expect(r.body).toMatchObject({
        buyWhtAmount: '200.00', // 5,000 × 3% + 5,000 × 1%
        buyNetAfterWht: '9800.00',
        whtEstimate: {
          form: 'PND3',
          byRate: [
            { whtRate: '3.00', buyBaseAmount: '5000.00', buyWhtAmount: '150.00' },
            { whtRate: '1.00', buyBaseAmount: '5000.00', buyWhtAmount: '50.00' },
          ],
        },
      });
      expect(
        (r.body.lines as WhtLine[]).map((l) => [l.whtRate, l.whtRateApplied, l.whtRateSource]),
      ).toEqual([
        [null, '3.00', 'CARRIER_DEFAULT'],
        ['1.00', '1.00', 'LINE'],
      ]);
      // ค่าตั้งต้นของรถร่วม = snapshot ตอนสร้างใบ — แก้รถร่วมทีหลังไม่เปลี่ยนใบ
      await db.carrier.update({
        where: { id: uuid('carrier', C.id) },
        data: { whtRateDefault: 1 },
      });
      const again = (await api(app, admin).get(`/v1/settlements/${r.body.id}`).expect(200)).body;
      expect(again.buyWhtAmount).toBe('200.00');
    });

    it('ขั้นต่ำตั้งได้ต่อ tenant (tax.whtMinimumAmount): ต่ำกว่า → ไม่หัก · เท่ากับ → หัก · ค่าเริ่ม 0 หักทุกยอด', async () => {
      const { C, trips } = await setup(2, '999.99');
      const one = (await create({ carrierId: C.id, tripIds: [trips[0]!.id] }).expect(201)).body;
      expect(one).toMatchObject({ buyWhtAmount: '10.00', whtEstimate: { minimumAmount: '0.00' } });
      await setMin(1000);
      const below = (await api(app, admin).get(`/v1/settlements/${one.id}`).expect(200)).body;
      expect(below).toMatchObject({
        buyWhtAmount: '0.00',
        buyNetAfterWht: '999.99',
        whtEstimate: {
          minimumAmount: '1000.00',
          belowMinimum: true,
          byRate: [{ whtRate: '1.00', buyBaseAmount: '999.99', buyWhtAmount: '0.00' }],
        },
      });
      // สองเที่ยว 1,999.98 ≥ 1,000 → หัก 20.00
      const two = await api(app, admin)
        .post(`/v1/settlements/${one.id}/lines`)
        .set('If-Match', `"${one.version}"`)
        .send({ tripIds: [trips[1]!.id] })
        .expect(200);
      expect(two.body).toMatchObject({
        buyWhtAmount: '20.00',
        whtEstimate: { belowMinimum: false },
      });
      await setMin(0);
    });

    it('อนุมัติ → ตรึงยอด WHT + ขั้นต่ำ (ค่าตั้งเปลี่ยนทีหลังไม่กระทบ) · audit + webhook ไม่มียอดเงิน · ไม่มีสิทธิ์ราคา = ไม่เห็นยอด', async () => {
      const approver = await tokenFor(
        tenantId,
        SYSTEM_ROLES.approver.permissions.join(' '),
        'u-appr-wht',
      );
      const { C, trips } = await setup(2, '4500');
      const s = (
        await create({
          carrierId: C.id,
          tripIds: trips.map((t) => t.id),
          deductions: [ADV],
        }).expect(201)
      ).body;
      const ok = await api(app, approver)
        .post(`/v1/settlements/${s.id}/approve`)
        .set('If-Match', `"${s.version}"`)
        .send({ reason: 'ตรวจยอดตรงใบแจ้งหนี้รถร่วมแล้ว' })
        .expect(200);
      expect(ok.body).toMatchObject({
        status: 'APPROVED',
        buyWhtAmount: '90.00',
        buyNetAfterWht: '6910.00',
        whtEstimate: { frozen: true, minimumAmount: '0.00' },
      });
      const sid = uuid('settlement', s.id);
      const row = await db.carrierSettlement.findUniqueOrThrow({ where: { id: sid } });
      expect([row.whtAmount?.toFixed(2), row.whtMinimumAmount?.toFixed(2)]).toEqual([
        '90.00',
        '0.00',
      ]);
      expect(row.whtRateDefault?.toFixed(2)).toBe('1.00');
      expect(row.status).toBe('APPROVED');
      const audit = await db.auditLog.findFirstOrThrow({
        where: { entityId: sid, action: 'settlement.approved' },
      });
      expect(audit.after).toMatchObject({
        buyWhtAmount: '90.00',
        whtMinimumAmount: '0.00',
        whtForm: 'PND53',
      });
      const ev = await db.domainEvent.findFirstOrThrow({
        where: { localId: sid, type: 'settlement.approved' },
      });
      const snap = ev.snapshot as Record<string, unknown>;
      expect(snap.buyWhtAmount).toBeUndefined();
      expect(snap.whtEstimate).toBeUndefined(); // ดูผ่าน REST (สิทธิ์ราคา)
      expect(JSON.stringify(snap)).not.toContain('buy');

      // ตั้งขั้นต่ำสูงทีหลัง → ใบที่อนุมัติแล้วคงยอด · ใบร่างคิดตามค่าตั้งใหม่
      await setMin(1_000_000);
      const frozen = (await api(app, admin).get(`/v1/settlements/${s.id}`).expect(200)).body;
      expect(frozen).toMatchObject({ buyWhtAmount: '90.00', whtEstimate: { belowMinimum: false } });
      await setMin(0);

      // ไม่มี prices.buy:read → ไม่เห็นยอดทุกระดับ แต่เห็นแบบยื่น/ธง
      const v = (await api(app, viewer).get(`/v1/settlements/${s.id}`).expect(200)).body;
      expect(v.buyWhtAmount).toBeUndefined();
      expect(v.buyNetAfterWht).toBeUndefined();
      expect(v.whtEstimate.byRate[0]).toEqual({ whtRate: '1.00' });
      expect(v.lines[0].buyWhtAmount).toBeUndefined();
      expect(v.lines[0].whtRateApplied).toBe('1.00');
      expect(v.whtEstimate.review).toBe('NOT_REVIEWED_BY_ACCOUNTANT');
      const vl = (
        await api(app, viewer).get('/v1/settlements').query({ carrierId: C.id }).expect(200)
      ).body.data[0];
      expect(vl.buyWhtAmount).toBeUndefined();
      expect(vl.whtForm).toBe('PND53');
    });

    it('review M: ใบเก่า (ไม่มีค่าตั้งต้นอัตราในใบ) + บรรทัดไม่มีธง → อนุมัติตรึง · เปลี่ยนค่าตั้งต้นรถร่วมเป็น 3% ทีหลัง = ทุกตัวเลขคงเดิม (รายละเอียด/แยกอัตรา/รายบรรทัด/รายการ)', async () => {
      const approver = await tokenFor(
        tenantId,
        SYSTEM_ROLES.approver.permissions.join(' '),
        'u-appr-wht2',
      );
      const { C, trips } = await setup(1, '4000');
      await db.tripCost.updateMany({
        where: { tripId: uuid('trip', trips[0]!.id), costType: 'CARRIER_FEE' },
        data: { whtRate: null },
      });
      const s = (await create({ carrierId: C.id, tripIds: [trips[0]!.id] }).expect(201)).body;
      const sid = uuid('settlement', s.id);
      // จำลองใบที่สร้างก่อน ST6-T08 (ยังไม่มีค่าตั้งต้นอัตราในใบ) — ร่างแก้ได้ด้วย role แอป
      await run((tx) =>
        tx.carrierSettlement.update({ where: { id: sid }, data: { whtRateDefault: null } }),
      );
      const ok = await api(app, approver)
        .post(`/v1/settlements/${s.id}/approve`)
        .set('If-Match', `"${s.version}"`)
        .send({ reason: 'ตรวจยอดตรงใบแจ้งหนี้รถร่วมแล้ว' })
        .expect(200);
      const expected = {
        buyWhtAmount: '40.00',
        buyNetAfterWht: '3960.00',
        whtEstimate: {
          frozen: true,
          byRate: [{ whtRate: '1.00', buyBaseAmount: '4000.00', buyWhtAmount: '40.00' }],
        },
      };
      expect(ok.body).toMatchObject(expected);
      expect(
        (
          await db.carrierSettlement.findUniqueOrThrow({ where: { id: sid } })
        ).whtRateDefault?.toFixed(2),
      ).toBe('1.00');
      // รถร่วมเปลี่ยนค่าตั้งต้นเป็น 3% หลังอนุมัติ
      await db.carrier.update({
        where: { id: uuid('carrier', C.id) },
        data: { whtRateDefault: 3 },
      });
      const after = (await api(app, admin).get(`/v1/settlements/${s.id}`).expect(200)).body;
      expect(after).toMatchObject(expected);
      expect((after.lines as WhtLine[])[0]).toMatchObject({
        whtRateApplied: '1.00',
        whtRateSource: 'CARRIER_DEFAULT',
        buyWhtAmount: '40.00',
      });
      const row = (
        (await api(app, admin).get('/v1/settlements').query({ carrierId: C.id }).expect(200)).body
          .data as Record<string, unknown>[]
      )[0];
      expect(row).toMatchObject({ buyWhtAmount: '40.00', buyNetAfterWht: '3960.00' });
      // ใบ APPROVED: ช่องที่ตรึงแก้ไม่ได้ (DB) — ST6-T09 ต้องคงไว้
      await expect(
        run((tx) =>
          tx.carrierSettlement.update({ where: { id: sid }, data: { whtRateDefault: 3 } }),
        ),
      ).rejects.toThrow(/carrier_settlement_terminal/);
    });

    it('กติกา DB (role แอป): ใบที่ยังไม่อนุมัติตรึง WHT ไม่ได้ · ยอดติดลบไม่ได้ · ต้องมีคู่ยอด/ขั้นต่ำ', async () => {
      const { C, trips } = await setup(1, '1000');
      const s = (await create({ carrierId: C.id, tripIds: [trips[0]!.id] }).expect(201)).body;
      const sid = uuid('settlement', s.id);
      for (const data of [
        { whtAmount: 10, whtMinimumAmount: 0 },
        { whtAmount: 10 },
        { whtAmount: -1, whtMinimumAmount: 0 },
      ])
        await expect(
          run((tx) => tx.carrierSettlement.update({ where: { id: sid }, data })),
        ).rejects.toThrow(/carrier_settlement_wht_check/);
    });
  });

  describe('อนุมัติ (ST6-T07)', () => {
    const APPROVE = { reason: 'ตรวจยอดตรงใบแจ้งหนี้รถร่วมแล้ว' };
    let approver: string;
    let accounting: string;
    beforeAll(async () => {
      approver = await tokenFor(tenantId, SYSTEM_ROLES.approver.permissions.join(' '), 'u-appr');
      accounting = await tokenFor(tenantId, SYSTEM_ROLES.accounting.permissions.join(' '), 'u-acc');
    });
    /** If-Match บังคับ (review L5) — ไม่ระบุ = ใช้ version ปัจจุบันของใบ · `null` = ไม่ส่ง · `.expect(status)` แบบ supertest */
    const approve = (id: string, token = approver, headers: Record<string, string | null> = {}) => {
      const send = async () => {
        const h: Record<string, string> = {};
        for (const [k, v] of Object.entries(headers)) if (v !== null) h[k] = v;
        if (!('If-Match' in headers)) {
          const sid = tryDecodeId('settlement', id);
          const row = sid ? await db.carrierSettlement.findUnique({ where: { id: sid } }) : null;
          h['If-Match'] = `"${row?.version ?? 1}"`;
        }
        return api(app, token).post(`/v1/settlements/${id}/approve`).set(h).send(APPROVE);
      };
      return {
        expect: async (status: number) => {
          const r = await send();
          expect(r.status, JSON.stringify(r.body)).toBe(status);
          return r;
        },
        run: send,
      };
    };
    const setLimit = (value: number | null) =>
      db.tenantSetting.upsert({
        where: { tenantId_key: { tenantId, key: 'settlement.approvalStepUpAmount' } },
        create: { tenantId, key: 'settlement.approvalStepUpAmount', value: value as never },
        update: { value: value as never },
      });
    const NO_RE = /^SA-\d{4}-(\d{4})$/;
    const seq = (no: string) => Number(NO_RE.exec(no)![1]);

    it('เกณฑ์ตรวจรับ: ผู้สร้างกดอนุมัติใบตัวเอง → 403 · ผู้อื่นอนุมัติ → APPROVED + เลข STL + audit · ใบที่อนุมัติแล้วแก้ไม่ได้', async () => {
      const { C, trips } = await setup(2, '4500');
      const s = (
        await create(
          { carrierId: C.id, tripIds: trips.map((t) => t.id), deductions: [ADV] },
          accounting,
        ).expect(201)
      ).body;
      // ผู้สร้าง (บัญชี — มีทั้งสิทธิ์สร้างและอนุมัติ) อนุมัติใบตัวเองไม่ได้
      const self = await approve(s.id, accounting).expect(403);
      expect(self.body.code).toBe('settlement_self_approval');
      // owner ที่ใช้ user เดียวกับผู้สร้างก็ไม่ได้ (ทุก role)
      const owner = await tokenFor(tenantId, '*', 'u-acc');
      expect((await approve(s.id, owner).expect(403)).body.code).toBe('settlement_self_approval');
      // ไม่มีอะไรเปลี่ยน — ยังเป็นร่าง ไม่กินเลข
      const still = (await api(app, admin).get(`/v1/settlements/${s.id}`).expect(200)).body;
      expect(still).toMatchObject({ status: 'DRAFT', settlementNo: null, version: 1 });

      const r = await approve(s.id, approver, { 'If-Match': '"1"' }).expect(200);
      expect(r.headers.etag).toBe('"2"');
      expect(r.body).toMatchObject({
        status: 'APPROVED',
        approvedBy: 'u-appr',
        createdBy: 'u-acc',
        buyNetPayable: '7000.00',
        version: 2,
      });
      expect(r.body.settlementNo).toMatch(NO_RE);
      expect(r.body.approvedAt).toBeTruthy();
      const audit = await db.auditLog.findFirstOrThrow({
        where: { entityId: uuid('settlement', s.id), action: 'settlement.approved' },
      });
      expect(audit.reason).toBe(APPROVE.reason);
      expect(audit.after).toMatchObject({
        status: 'APPROVED',
        settlementNo: r.body.settlementNo,
        stepUp: false,
      });
      const list = (
        await api(app, admin).get('/v1/settlements').query({ status: 'APPROVED' }).expect(200)
      ).body.data as { id: string; approvedAt: string | null }[];
      expect(list.find((x) => x.id === s.id)?.approvedAt).toBe(r.body.approvedAt);

      // ใบที่อนุมัติแล้ว: แก้หัว/เพิ่ม/นำบรรทัดออก/ยกเลิก/อนุมัติซ้ำ = 409 · บรรทัดต้นทุนยังผูกอยู่ (ไม่กลับคิว)
      await api(app, admin)
        .patch(`/v1/settlements/${s.id}`)
        .send({ note: 'แก้หลังอนุมัติ' })
        .expect(409);
      await api(app, admin)
        .post(`/v1/settlements/${s.id}/lines`)
        .send({ deductions: [FINE] })
        .expect(409);
      await api(app, admin)
        .post(`/v1/settlements/${s.id}/lines/${(s.lines as Line[])[0]!.id}/remove`)
        .send({ reason: 'นำออกหลังอนุมัติแล้ว' })
        .expect(409);
      await api(app, admin)
        .post(`/v1/settlements/${s.id}/cancel`)
        .send({ reason: 'ยกเลิกหลังอนุมัติแล้ว' })
        .expect(409);
      expect((await approve(s.id, admin).expect(409)).body.code).toBe('invalid_state_transition');
      expect(await queued(C.id)).toEqual([]);
      const after = (await api(app, admin).get(`/v1/settlements/${s.id}`).expect(200)).body;
      expect(after.settlementNo).toBe(r.body.settlementNo);
      expect(after.version).toBe(2);
    });

    it('เกินวงเงินที่ตั้ง → ต้องยืนยัน TOTP (X-Step-Up ของผู้อนุมัติเอง) · เท่ากับวงเงิน/ปิด (null) ไม่ต้อง · ไม่กินเลขเมื่อถูกปฏิเสธ', async () => {
      const { C, trips } = await setup(3, '5000');
      const mk = async (i: number) =>
        (await create({ carrierId: C.id, tripIds: [trips[i]!.id] }, accounting).expect(201)).body
          .id as string;
      const [a, b, c] = [await mk(0), await mk(1), await mk(2)];
      try {
        await setLimit(4999);
        const no = await approve(a).expect(403);
        expect(no.body.code).toBe('step_up_required');
        // token step-up ของคนอื่น / ของ tenant อื่น / token ปลอม = ไม่ผ่าน
        for (const t of [
          await signStepUpToken('u-acc', tenantId),
          await signStepUpToken('u-appr', otherId),
          'not-a-token',
        ])
          expect((await approve(a, approver, { 'X-Step-Up': t }).expect(403)).body.code).toBe(
            'step_up_required',
          );
        const okA = await approve(a, approver, {
          'X-Step-Up': await signStepUpToken('u-appr', tenantId),
        }).expect(200);
        const audit = await db.auditLog.findFirstOrThrow({
          where: { entityId: uuid('settlement', a), action: 'settlement.approved' },
        });
        expect(audit.after).toMatchObject({ stepUp: true });
        // ยอดเท่ากับวงเงิน = ไม่เกิน → ไม่ต้อง step-up · เลขต่อเนื่อง (คำขอที่ถูกปฏิเสธไม่กินเลข)
        await setLimit(5000);
        const okB = await approve(b).expect(200);
        expect(seq(okB.body.settlementNo)).toBe(seq(okA.body.settlementNo) + 1);
        // ปิด (null) = ไม่บังคับ
        await setLimit(0);
        expect((await approve(c).expect(403)).body.code).toBe('step_up_required');
        await setLimit(null);
        await approve(c).expect(200);
      } finally {
        await db.tenantSetting.deleteMany({
          where: { tenantId, key: 'settlement.approvalStepUpAmount' },
        });
      }
    });

    it('ยอดสุทธิติดลบ → 409 settlement_net_negative · ไม่มีบรรทัดเที่ยว → 409 settlement_empty · ไม่กินเลข', async () => {
      const { C, trips } = await setup(1, '1000');
      const neg = (
        await create(
          { carrierId: C.id, tripIds: [trips[0]!.id], deductions: [ADV] },
          accounting,
        ).expect(201)
      ).body;
      expect(neg.buyNetPayable).toBe('-1000.00');
      expect((await approve(neg.id).expect(409)).body.code).toBe('settlement_net_negative');
      // นำบรรทัดเที่ยวออก (เหลือแต่บรรทัดหัก) → ไม่มีรายการเที่ยว
      const fl = (neg.lines as Line[]).find((l) => l.lineType === 'FREIGHT')!;
      await api(app, accounting)
        .post(`/v1/settlements/${neg.id}/lines/${fl.id}/remove`)
        .send({ reason: 'แยกเที่ยวนี้ไปวางบิลงวดหน้า' })
        .expect(200);
      expect((await approve(neg.id).expect(409)).body.code).toBe('settlement_empty');
      const row = await db.carrierSettlement.findUniqueOrThrow({
        where: { id: uuid('settlement', neg.id) },
      });
      expect(row).toMatchObject({ status: 'DRAFT', settlementNo: null });
    });

    it('สิทธิ์ settlements:approve (ผู้จ่ายงาน/viewer 403) · เหตุผล < 10 → 422 · If-Match ไม่ตรง → 412 · แยก tenant 404 · พร้อมกัน → 200 + 409', async () => {
      const { C, trips } = await setup(1, '800');
      const s = (await create({ carrierId: C.id, tripIds: [trips[0]!.id] }, accounting).expect(201))
        .body;
      expect((await approve(s.id, dispatcher).expect(403)).body.code).toBe('permission_denied');
      expect((await approve(s.id, viewer).expect(403)).body.code).toBe('permission_denied');
      await api(app, approver)
        .post(`/v1/settlements/${s.id}/approve`)
        .send({ reason: 'สั้น' })
        .expect(422);
      await approve(s.id, approver, { 'If-Match': '"9"' }).expect(412);
      await approve(s.id, other).expect(404);
      const [x, y] = await Promise.all([approve(s.id, approver).run(), approve(s.id, admin).run()]);
      // ทั้งคู่อ้าง version เดียวกัน → รายที่สองได้ 412 (version เปลี่ยนแล้ว)
      expect([x.status, y.status].sort()).toEqual([200, 412]);
      const row = await db.carrierSettlement.findUniqueOrThrow({
        where: { id: uuid('settlement', s.id) },
      });
      expect(row.status).toBe('APPROVED');
      expect(
        await db.auditLog.count({
          where: { entityId: row.id, action: 'settlement.approved' },
        }),
      ).toBe(1);
    });

    it('ยกวงเงิน/ปิด step-up ผ่าน PATCH /v1/settings = ลดความปลอดภัย → ต้อง step-up · ลดวงเงินไม่ต้อง', async () => {
      try {
        await api(app, admin)
          .patch('/v1/settings')
          .send({ values: { 'settlement.approvalStepUpAmount': 50000 } })
          .expect(200);
        for (const v of [80000, null])
          expect(
            (
              await api(app, admin)
                .patch('/v1/settings')
                .send({ values: { 'settlement.approvalStepUpAmount': v } })
                .expect(403)
            ).body.code,
          ).toBe('step_up_required');
        await api(app, admin)
          .patch('/v1/settings')
          .set('X-Step-Up', await signStepUpToken('user-test', tenantId))
          .send({ values: { 'settlement.approvalStepUpAmount': null } })
          .expect(200);
        await api(app, admin)
          .patch('/v1/settings')
          .send({ values: { 'settlement.approvalStepUpAmount': -1 } })
          .expect(422);
      } finally {
        await db.tenantSetting.deleteMany({
          where: { tenantId, key: 'settlement.approvalStepUpAmount' },
        });
      }
    });

    it('review H1: API key — ให้ settlements:approve ไม่ได้ · key ที่ผู้อนุมัติออกสร้างร่าง → ผู้นั้นอนุมัติไม่ได้ · key อนุมัติไม่ได้แม้มี scope ค้างในแถว · ผู้สร้างระบุไม่ได้ → 403', async () => {
      const u = await db.appUser.create({
        data: { tenantId, email: `stl-key-${++seed}@a.test`, name: 'ผู้ออก key', status: 'ACTIVE' },
      });
      const owner = await tokenFor(tenantId, '*', u.id);
      const denied = await api(app, owner)
        .post('/v1/api-keys')
        .send({ name: 'อนุมัติแทน', scopes: ['settlements:approve'] });
      expect(denied.status).toBe(422);
      const keyName = `ERP สร้างใบ ${seed}`;
      const key = (
        await api(app, owner)
          .post('/v1/api-keys')
          .send({
            name: keyName,
            scopes: ['settlements:read', 'settlements:create', 'prices.buy:read'],
          })
          .expect(201)
      ).body as { id: string; secret: string };
      const { C, trips } = await setup(2, '700');
      const s = (await create({ carrierId: C.id, tripIds: [trips[0]!.id] }, key.secret).expect(201))
        .body;
      expect(s.createdBy).toMatch(/^apikey:/);
      // ผู้ออก key = ผู้สร้างใบ → อนุมัติไม่ได้ (แม้ token เป็นของผู้ใช้ไม่ใช่ key)
      expect((await approve(s.id, owner).expect(403)).body.code).toBe('settlement_self_approval');
      // key ที่มี settlements:approve ค้างในแถว (ก่อนห้าม) → scope ถูกกรองทิ้ง → 403
      const row = await db.apiKey.findFirstOrThrow({
        where: { tenantId, name: keyName },
      });
      await db.apiKey.update({
        where: { id: row.id },
        data: { scopes: [...row.scopes, 'settlements:approve'] },
      });
      expect((await approve(s.id, key.secret).expect(403)).body.code).toBe('permission_denied');
      // ผู้อื่นอนุมัติได้ · DB: approved_by ผ่านได้เพราะผู้ออก key ≠ ผู้อนุมัติ
      await approve(s.id, approver).expect(200);
      // ใบที่ไม่รู้ผู้สร้าง (created_by ว่าง) → ปฏิเสธ (fail closed) ทั้ง service และ DB
      await settleTripCostsForTest(db, { id: uuid('tripCost', await feeOf(trips[1]!.id)) });
      const anon = await db.carrierSettlement.findFirstOrThrow({
        where: { tenantId, carrierId: uuid('carrier', C.id), status: 'DRAFT' },
      });
      expect(anon.createdBy).toBeNull();
      expect((await approve(encodeId('settlement', anon.id)).expect(403)).body.code).toBe(
        'settlement_self_approval',
      );
      await expect(
        run((tx) =>
          tx.carrierSettlement.update({
            where: { id: anon.id },
            data: {
              status: 'APPROVED',
              settlementNo: 'SA-9999-0009',
              approvedAt: new Date(),
              approvedBy: 'u-appr',
            },
          }),
        ),
      ).rejects.toThrow(/carrier_settlement_sod/);
    });

    it('review M2: ผู้เพิ่มบรรทัด / ผู้นำบรรทัดออก อนุมัติใบนั้นไม่ได้ (service + DB) · ผู้ที่ไม่ได้แตะใบอนุมัติได้', async () => {
      const mix = await tokenFor(tenantId, '*', 'u-mix');
      const { C, trips } = await setup(3, '900');
      const a = (await create({ carrierId: C.id, tripIds: [trips[0]!.id] }, accounting).expect(201))
        .body;
      await api(app, mix)
        .post(`/v1/settlements/${a.id}/lines`)
        .send({ deductions: [FINE] })
        .expect(200);
      expect((await approve(a.id, mix).expect(403)).body.code).toBe('settlement_self_approval');
      const b = (
        await create({ carrierId: C.id, tripIds: [trips[1]!.id, trips[2]!.id] }, accounting).expect(
          201,
        )
      ).body;
      await api(app, mix)
        .post(`/v1/settlements/${b.id}/lines/${(b.lines as Line[])[1]!.id}/remove`)
        .send({ reason: 'แยกเที่ยวนี้ไปงวดหน้า' })
        .expect(200);
      expect((await approve(b.id, mix).expect(403)).body.code).toBe('settlement_self_approval');
      // DB ชั้นเดียวกัน: ผู้เพิ่มบรรทัดเป็นผู้อนุมัติไม่ได้
      await expect(
        run((tx) =>
          tx.carrierSettlement.update({
            where: { id: uuid('settlement', a.id) },
            data: {
              status: 'APPROVED',
              settlementNo: 'SA-9999-0010',
              approvedAt: new Date(),
              approvedBy: 'u-mix',
            },
          }),
        ),
      ).rejects.toThrow(/carrier_settlement_sod/);
      await approve(a.id, approver).expect(200);
      await approve(b.id, approver).expect(200);
    });

    it('re-review: ผู้แก้หัวใบ (PATCH) อนุมัติใบนั้นไม่ได้ (service + DB) · ผู้อื่นอนุมัติได้', async () => {
      const editor = await tokenFor(tenantId, '*', 'u-editor');
      const { C, trips } = await setup(1, '650');
      const s = (await create({ carrierId: C.id, tripIds: [trips[0]!.id] }, accounting).expect(201))
        .body;
      await api(app, editor)
        .patch(`/v1/settlements/${s.id}`)
        .send({ carrierInvoiceNo: 'INV-SUB-7788' })
        .expect(200);
      const row = await db.carrierSettlement.findUniqueOrThrow({
        where: { id: uuid('settlement', s.id) },
      });
      expect(row.updatedBy).toBe('u-editor');
      expect((await approve(s.id, editor).expect(403)).body.code).toBe('settlement_self_approval');
      await expect(
        run((tx) =>
          tx.carrierSettlement.update({
            where: { id: row.id },
            data: {
              status: 'APPROVED',
              settlementNo: 'SA-9999-0011',
              approvedAt: new Date(),
              approvedBy: 'u-editor',
            },
          }),
        ),
      ).rejects.toThrow(/carrier_settlement_sod/);
      await approve(s.id, approver).expect(200);
    });

    it('review L3/L4/L5: วงเงิน 0 → ยอด 0.00 ก็ต้อง step-up · ค่าใช้จ่ายเพิ่ม (SURCHARGE) อย่างเดียว = settlement_empty · ไม่ส่ง If-Match → 422', async () => {
      const { C, trips } = await setup(2, '1000');
      const zero = (
        await create(
          {
            carrierId: C.id,
            tripIds: [trips[0]!.id],
            deductions: [{ ...ADV, amount: '-1000' }],
          },
          accounting,
        ).expect(201)
      ).body;
      expect(zero.buyNetPayable).toBe('0.00');
      const miss = await approve(zero.id, approver, { 'If-Match': null }).expect(422);
      expect(miss.body.errors[0]).toMatchObject({ field: 'If-Match', code: 'if_match_required' });
      try {
        await setLimit(0);
        expect((await approve(zero.id).expect(403)).body.code).toBe('step_up_required');
        await approve(zero.id, approver, {
          'X-Step-Up': await signStepUpToken('u-appr', tenantId),
        }).expect(200);
      } finally {
        await db.tenantSetting.deleteMany({
          where: { tenantId, key: 'settlement.approvalStepUpAmount' },
        });
      }
      // เที่ยวที่มีค่าทางด่วน (SURCHARGE) — นำค่าขนส่ง (FREIGHT) ออก เหลือ SURCHARGE อย่างเดียว
      await db.tripCost.create({
        data: {
          tenantId,
          tripId: uuid('trip', trips[1]!.id),
          costType: 'TOLL',
          amount: '120.00',
          source: 'MANUAL',
          sourceType: 'FIELD',
          status: 'CONFIRMED',
          carrierId: uuid('carrier', C.id),
          description: 'ค่าทางด่วน',
          createdBy: 'u-disp',
          decidedBy: 'u-acc',
          decidedAt: new Date(),
          decisionReason: 'ตรวจใบเสร็จค่าทางด่วนแล้ว',
        },
      });
      const sur = (
        await create({ carrierId: C.id, tripIds: [trips[1]!.id] }, accounting).expect(201)
      ).body;
      const lines = sur.lines as Line[];
      expect(lines.map((l) => l.lineType).sort()).toEqual(['FREIGHT', 'SURCHARGE']);
      await api(app, accounting)
        .post(
          `/v1/settlements/${sur.id}/lines/${lines.find((l) => l.lineType === 'FREIGHT')!.id}/remove`,
        )
        .send({ reason: 'ค่าขนส่งไปวางบิลงวดหน้า' })
        .expect(200);
      expect((await approve(sur.id).expect(409)).body.code).toBe('settlement_empty');
    });

    it('review L7: สร้างใบในสถานะอื่นที่ไม่ใช่ DRAFT ไม่ได้ (DB)', async () => {
      const { C } = await setup(0);
      for (const status of ['APPROVED', 'CANCELLED'])
        await expect(
          run((tx) =>
            tx.carrierSettlement.create({
              data: {
                tenantId,
                carrierId: uuid('carrier', C.id),
                carrierSnapshot: {},
                periodFrom: new Date(`${today}T00:00:00Z`),
                periodTo: new Date(`${today}T00:00:00Z`),
                status,
                createdBy: 'u-acc',
              },
            }),
          ),
        ).rejects.toThrow(/carrier_settlement_insert_draft/);
    });

    it('กติการะดับ DB (role แอป): ใบ APPROVED แก้ไม่ได้ · บรรทัดแข็ง · เลขแก้ไม่ได้ · ผู้อนุมัติ ≠ ผู้สร้าง · ร่างมีเลขไม่ได้ · ข้ามสถานะไม่ได้', async () => {
      const { C, trips } = await setup(2, '900');
      const s = (await create({ carrierId: C.id, tripIds: [trips[0]!.id] }, accounting).expect(201))
        .body;
      await approve(s.id).expect(200);
      const sid = uuid('settlement', s.id);
      const lid = uuid('settlementLine', (s.lines as Line[])[0]!.id);
      const fails = (fn: (tx: Tx) => Promise<unknown>, re: RegExp) =>
        expect(run(fn)).rejects.toThrow(re);
      for (const data of [
        { note: 'แก้หลังอนุมัติ' },
        { settlementNo: 'SA-9999-0001' },
        { status: 'DRAFT' },
        { status: 'CANCELLED' },
      ])
        await fails(
          (tx) => tx.carrierSettlement.update({ where: { id: sid }, data }),
          /carrier_settlement_terminal/,
        );
      for (const data of [{ description: 'แก้คำอธิบาย' }, { reference: 'X' }, { whtRate: '3.00' }])
        await fails(
          (tx) => tx.settlementLine.update({ where: { id: lid }, data }),
          /settlement_line_frozen/,
        );
      // ร่างใหม่: ผู้อนุมัติ = ผู้สร้าง / ร่างมีเลข / DRAFT → PAID / แก้ผู้สร้าง = ไม่ได้
      const d = (await create({ carrierId: C.id, tripIds: [trips[1]!.id] }, accounting).expect(201))
        .body;
      const did = uuid('settlement', d.id);
      const approvedData = {
        status: 'APPROVED',
        settlementNo: 'SA-9999-0002',
        approvedAt: new Date(),
      };
      await fails(
        (tx) =>
          tx.carrierSettlement.update({
            where: { id: did },
            data: { ...approvedData, approvedBy: 'u-acc' },
          }),
        /carrier_settlement_sod/,
      );
      await fails(
        (tx) => tx.carrierSettlement.update({ where: { id: did }, data: { settlementNo: 'SA-1' } }),
        /carrier_settlement_draft_unnumbered_check/,
      );
      await fails(
        (tx) => tx.carrierSettlement.update({ where: { id: did }, data: { status: 'PAID' } }),
        /carrier_settlement_status_check|carrier_settlement_transition/,
      );
      await fails(
        (tx) => tx.carrierSettlement.update({ where: { id: did }, data: { createdBy: 'u-other' } }),
        /carrier_settlement_immutable/,
      );
      await fails(
        (tx) =>
          tx.carrierSettlement.update({
            where: { id: did },
            data: { ...approvedData, approvedBy: 'u-appr', settlementNo: null },
          }),
        /carrier_settlement_approved_check/,
      );
    });
  });

  describe('บันทึกจ่าย (ST6-T09)', () => {
    const APPROVE = { reason: 'ตรวจยอดตรงใบแจ้งหนี้รถร่วมแล้ว' };
    const PAY = {
      paidDate: today,
      method: 'TRANSFER',
      reference: 'KBANK-2611-0091',
      bank: 'กสิกรไทย',
    };
    let approver: string;
    let accounting: string;
    beforeAll(async () => {
      approver = await tokenFor(tenantId, SYSTEM_ROLES.approver.permissions.join(' '), 'u-appr');
      accounting = await tokenFor(tenantId, SYSTEM_ROLES.accounting.permissions.join(' '), 'u-acc');
    });
    const etag = async (id: string) =>
      `"${(await db.carrierSettlement.findUniqueOrThrow({ where: { id: uuid('settlement', id) } })).version}"`;
    const approve = async (id: string) =>
      api(app, approver)
        .post(`/v1/settlements/${id}/approve`)
        .set('If-Match', await etag(id))
        .send(APPROVE)
        .expect(200);
    const pay = async (
      id: string,
      body: object = PAY,
      token = accounting,
      ifMatch?: string | null,
    ) => {
      const r = api(app, token).post(`/v1/settlements/${id}/mark-paid`);
      if (ifMatch !== null) r.set('If-Match', ifMatch ?? (await etag(id).catch(() => '"1"')));
      return r.send(body);
    };
    const tripStatus = async (id: string) =>
      (await db.trip.findUniqueOrThrow({ where: { id: uuid('trip', id) } })).status;

    it('เกณฑ์ตรวจรับ: จ่ายได้เฉพาะใบ APPROVED → PAID + ข้อมูลการจ่าย · เที่ยวเป็น SETTLED ไม่กลับเข้าคิว · WHT ที่ตรึงคงเดิม · audit + event', async () => {
      const { C, trips } = await setup(2, '4500');
      const s = (
        await create(
          { carrierId: C.id, tripIds: trips.map((t) => t.id), deductions: [ADV] },
          accounting,
        ).expect(201)
      ).body;
      // ร่าง → 409 (ยังไม่อนุมัติ)
      const draft = await pay(s.id);
      expect(draft.status, JSON.stringify(draft.body)).toBe(409);
      expect(draft.body.code).toBe('invalid_state_transition');
      const ap = (await approve(s.id)).body;
      expect(ap).toMatchObject({
        status: 'APPROVED',
        buyWhtAmount: '90.00',
        paidDate: null,
        paymentMethod: null,
      });

      // ผู้สร้างใบ (บัญชี) บันทึกจ่ายได้ — แบ่งหน้าที่ของการจ่าย = ผู้บันทึกจ่าย ≠ ผู้อนุมัติ เท่านั้น (D-60)
      const r = await pay(s.id);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.headers.etag).toBe(`"${ap.version + 1}"`);
      expect(r.body).toMatchObject({
        status: 'PAID',
        settlementNo: ap.settlementNo,
        paidDate: today,
        paidBy: 'u-acc',
        paymentMethod: 'TRANSFER',
        paymentReference: 'KBANK-2611-0091',
        paymentBank: 'กสิกรไทย',
        buyNetPayable: '7000.00',
        buyWhtAmount: '90.00',
        buyNetAfterWht: '6910.00',
        approvedBy: 'u-appr',
      });
      expect(r.body.paidAt).toBeTruthy();
      expect(r.body.whtEstimate.frozen).toBe(true);
      const row = await db.carrierSettlement.findUniqueOrThrow({
        where: { id: uuid('settlement', s.id) },
      });
      expect(row.whtAmount!.toFixed(2)).toBe('90.00');

      // เที่ยว COSTED → SETTLED + ประวัติสถานะ · ไม่อยู่ในคิวจ่าย
      for (const t of trips) expect(await tripStatus(t.id)).toBe('SETTLED');
      expect(await queued(C.id)).toEqual([]);
      const hist = await db.docStatusHistory.findMany({
        where: { docType: 'trip', docId: uuid('trip', trips[0]!.id), toStatus: 'SETTLED' },
      });
      expect(hist).toHaveLength(1);
      expect(hist[0]).toMatchObject({ fromStatus: 'COSTED', event: 'settle', actorId: 'u-acc' });
      // บรรทัดต้นทุนยังผูกกับใบ (ใส่ใบใหม่ไม่ได้)
      const again = await create({ carrierId: C.id, tripCostIds: [await feeOf(trips[0]!.id)] });
      expect(again.status).toBe(409);

      // จ่ายซ้ำ → 409 · ใบ PAID แก้/ยกเลิกไม่ได้
      const twice = await pay(s.id);
      expect(twice.status).toBe(409);
      expect(twice.body).toMatchObject({ code: 'invalid_state_transition', status: 'PAID' });
      await api(app, admin)
        .post(`/v1/settlements/${s.id}/cancel`)
        .set('If-Match', await etag(s.id))
        .send({ reason: 'ยกเลิกหลังจ่ายแล้วไม่ได้' })
        .expect(409);

      // รายการ + กรองสถานะ PAID
      const list = (
        await api(app, admin).get('/v1/settlements').query({ status: 'PAID' }).expect(200)
      ).body.data as { id: string; paidDate: string | null }[];
      expect(list.find((x) => x.id === s.id)?.paidDate).toBe(today);

      // audit
      const audit = await db.auditLog.findFirstOrThrow({
        where: { entityId: uuid('settlement', s.id), action: 'settlement.paid' },
      });
      expect(audit.actorId).toBe('u-acc');
      expect(audit.before).toEqual({ status: 'APPROVED' });
      expect(audit.after).toMatchObject({
        status: 'PAID',
        paidDate: today,
        paymentMethod: 'TRANSFER',
        paymentReference: 'KBANK-2611-0091',
        buyNetAfterWht: '6910.00',
        whtFrozenNow: false,
        settledTripIds: trips.map((t) => t.id).sort(),
      });

      // event settlement.paid (webhook — ไม่มียอดเงิน/ไม่มี id ผู้ใช้) — ST8-T16 ใช้สร้าง AP ร่าง
      const ev = await db.domainEvent.findFirstOrThrow({
        where: { tenantId, type: 'settlement.paid', localId: uuid('settlement', s.id) },
      });
      expect(ev.snapshot).toMatchObject({
        id: s.id,
        status: 'PAID',
        settlementNo: ap.settlementNo,
        paidDate: today,
        paymentMethod: 'TRANSFER',
        paymentReference: 'KBANK-2611-0091',
        paymentBank: 'กสิกรไทย',
      });
      expect(JSON.stringify(ev.snapshot)).not.toMatch(/"buy|"paidBy"|"lines"/);
      expect(ev.previousAttributes).toMatchObject({ status: 'APPROVED', paidDate: null });
      const tripEv = await db.domainEvent.count({
        where: { tenantId, type: 'trip.settled', localId: uuid('trip', trips[0]!.id) },
      });
      expect(tripEv).toBe(1);
    });

    it('ตรวจข้อมูล: โอน/เช็คต้องมีเลขอ้างอิง · เงินสดไม่ต้อง · วันที่ในอนาคต/ไม่จริง 422 · If-Match บังคับ (422) / ไม่ตรง 412', async () => {
      const { C, trips } = await setup(1, '1000');
      const s = (await create({ carrierId: C.id, tripIds: [trips[0]!.id] }, accounting).expect(201))
        .body;
      await approve(s.id);
      const codes = async (body: object) => {
        const r = await pay(s.id, body);
        expect(r.status, JSON.stringify(r.body)).toBe(422);
        return (r.body.errors as { field: string; code: string }[]).map(
          (e) => `${e.field}:${e.code}`,
        );
      };
      expect(await codes({ paidDate: today, method: 'TRANSFER' })).toEqual(['reference:required']);
      expect(await codes({ paidDate: today, method: 'CHEQUE', reference: '   ' })).toEqual([
        'reference:required',
      ]);
      const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000)
        .toISOString()
        .slice(0, 10);
      expect(await codes({ paidDate: tomorrow, method: 'CASH' })).toEqual(['paidDate:future_date']);
      expect(await codes({ paidDate: '2026-02-30', method: 'CASH' })).toEqual([
        'paidDate:invalid_date',
      ]);
      // วันที่จ่าย = วันที่หักภาษี — ก่อนวันอนุมัติ (เวลาไทย) ไม่ได้ (review QA L2)
      const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000)
        .toISOString()
        .slice(0, 10);
      expect(await codes({ paidDate: yesterday, method: 'CASH' })).toEqual([
        'paidDate:before_approval',
      ]);
      expect((await pay(s.id, { paidDate: today, method: 'WIRE' })).status).toBe(422);
      expect((await pay(s.id, { method: 'CASH' })).status).toBe(422);
      const noIf = await pay(s.id, { paidDate: today, method: 'CASH' }, accounting, null);
      expect(noIf.status).toBe(422);
      expect(noIf.body.errors[0].code).toBe('if_match_required');
      expect((await pay(s.id, { paidDate: today, method: 'CASH' }, accounting, '"1"')).status).toBe(
        412,
      );
      // เงินสด: ไม่มีเลขอ้างอิง/ธนาคารได้
      const ok = await pay(s.id, { paidDate: today, method: 'CASH' });
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body).toMatchObject({
        status: 'PAID',
        paymentMethod: 'CASH',
        paymentReference: null,
        paymentBank: null,
      });
    });

    it('สิทธิ์ settlements:pay (บัญชี/ผู้ดูแล) — ผู้อนุมัติ/ผู้จัดการ/ผู้จ่ายงาน/viewer 403 · บริษัทอื่น 404', async () => {
      const { C, trips } = await setup(1, '1000');
      const s = (await create({ carrierId: C.id, tripIds: [trips[0]!.id] }, accounting).expect(201))
        .body;
      await approve(s.id);
      const manager = await tokenFor(tenantId, SYSTEM_ROLES.manager.permissions.join(' '), 'u-mgr');
      for (const t of [approver, manager, dispatcher, viewer]) {
        const r = await pay(s.id, PAY, t);
        expect(r.status).toBe(403);
      }
      expect((await pay(s.id, PAY, other)).status).toBe(404);
      expect(
        (await db.carrierSettlement.findUniqueOrThrow({ where: { id: uuid('settlement', s.id) } }))
          .status,
      ).toBe('APPROVED');
      expect((await pay(s.id, PAY, admin)).status).toBe(200);
    });

    it('D-60 แบ่งหน้าที่: ผู้อนุมัติบันทึกจ่ายใบนั้นเองไม่ได้ (403 settlement_self_payment) · คนอื่นได้ · owner ปิดกฎ (step-up) → ผู้อนุมัติจ่ายได้ + audit · ไม่ใช่ owner เปลี่ยนค่าไม่ได้', async () => {
      const key = 'settlement.allowApproverMarkPaid';
      // ผู้อนุมัติที่มีสิทธิ์จ่ายด้วย (ผู้ดูแล) — อนุมัติเองแล้วบันทึกจ่ายเอง
      const both = await tokenFor(tenantId, '*', 'u-appr-pay');
      const mk = async () => {
        const { C, trips } = await setup(1, '1200');
        const s = (
          await create({ carrierId: C.id, tripIds: [trips[0]!.id] }, accounting).expect(201)
        ).body;
        await api(app, both)
          .post(`/v1/settlements/${s.id}/approve`)
          .set('If-Match', await etag(s.id))
          .send(APPROVE)
          .expect(200);
        return s.id as string;
      };
      const a = await mk();
      const self = await pay(a, PAY, both);
      expect(self.status, JSON.stringify(self.body)).toBe(403);
      expect(self.body.code).toBe('settlement_self_payment');
      expect(
        (await db.carrierSettlement.findUniqueOrThrow({ where: { id: uuid('settlement', a) } }))
          .status,
      ).toBe('APPROVED');
      // คนอื่น (บัญชี) บันทึกจ่ายได้
      const ok = await pay(a, PAY, accounting);
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      expect(ok.body).toMatchObject({ status: 'PAID', paidBy: 'u-acc', approvedBy: 'u-appr-pay' });

      // ค่าตั้ง: ผู้ดูแล (ไม่ใช่ owner) เปลี่ยนไม่ได้ · owner ต้อง step-up
      const ownerRole = await db.role.findFirstOrThrow({ where: { tenantId, code: 'owner' } });
      const o = await db.appUser.create({
        data: {
          tenantId,
          email: `owner-${randomUUID().slice(0, 8)}@settlement.test`,
          name: 'เจ้าของ',
          status: 'ACTIVE',
        },
      });
      await db.userRole.create({ data: { tenantId, userId: o.id, roleId: ownerRole.id } });
      const ot = await tokenFor(tenantId, '*', o.id);
      const on = { values: { [key]: true } };
      const na = await api(app, admin)
        .patch('/v1/settings')
        .set('X-Step-Up', await signStepUpToken('user-test', tenantId))
        .send(on)
        .expect(403);
      expect(na.body.code).toBe('permission_denied');
      const ns = await api(app, ot).patch('/v1/settings').send(on).expect(403);
      expect(ns.body.code).toBe('step_up_required');
      await api(app, ot)
        .patch('/v1/settings')
        .set('X-Step-Up', await signStepUpToken(o.id, tenantId))
        .send(on)
        .expect(200);
      try {
        const setAudit = await db.auditLog.findFirstOrThrow({
          where: { tenantId, action: 'tenant_setting.updated', entityId: key },
          orderBy: { seq: 'desc' },
        });
        expect(setAudit.actorId).toBe(o.id);
        expect(setAudit.after).toEqual({ [key]: true });
        // ไม่ใช่ owner ปิดกลับก็ไม่ได้
        expect(
          (
            await api(app, admin)
              .patch('/v1/settings')
              .send({ values: { [key]: false } })
          ).status,
        ).toBe(403);

        // ปิดกฎแล้ว: ผู้อนุมัติบันทึกจ่ายใบตัวเองได้ + audit `sodWaived`
        const b = await mk();
        const waived = await pay(b, PAY, both);
        expect(waived.status, JSON.stringify(waived.body)).toBe(200);
        expect(waived.body).toMatchObject({ paidBy: 'u-appr-pay', approvedBy: 'u-appr-pay' });
        const audit = await db.auditLog.findFirstOrThrow({
          where: { entityId: uuid('settlement', b), action: 'settlement.paid' },
        });
        expect(audit.after).toMatchObject({ status: 'PAID', sodWaived: true });
        const normal = await db.auditLog.findFirstOrThrow({
          where: { entityId: uuid('settlement', a), action: 'settlement.paid' },
        });
        expect(normal.after).not.toHaveProperty('sodWaived');
      } finally {
        // owner ปิดกลับ (ไม่ต้อง step-up — เพิ่มการควบคุม)
        await api(app, ot)
          .patch('/v1/settings')
          .send({ values: { [key]: false } })
          .expect(200);
      }
      const c = await mk();
      expect((await pay(c, PAY, both)).body.code).toBe('settlement_self_payment');
    });

    it('D-60 review: key ที่ผู้อนุมัติออก บันทึกจ่ายไม่ได้ · ผู้จ่ายระบุตัวไม่ได้ → 403 แม้ปิดกฎ · ผู้ใช้จริงที่ไม่ใช่ owner เปลี่ยนค่าไม่ได้', async () => {
      const key = 'settlement.allowApproverMarkPaid';
      // ผู้ใช้จริง (uuid) role admin — ไม่ใช่ owner → ผ่าน guard uuid ไปถึงการตรวจ role แล้วถูกปฏิเสธ
      const adminRole = await db.role.findFirstOrThrow({ where: { tenantId, code: 'admin' } });
      const u = await db.appUser.create({
        data: {
          tenantId,
          email: `stl-paysod-${randomUUID().slice(0, 8)}@a.test`,
          name: 'ผู้ดูแลผู้อนุมัติ',
          status: 'ACTIVE',
        },
      });
      await db.userRole.create({ data: { tenantId, userId: u.id, roleId: adminRole.id } });
      const ut = await tokenFor(tenantId, '*', u.id);
      const denied = await api(app, ut)
        .patch('/v1/settings')
        .set('X-Step-Up', await signStepUpToken(u.id, tenantId))
        .send({ values: { [key]: true } })
        .expect(403);
      expect(denied.body).toMatchObject({ code: 'permission_denied', required: ['owner'] });

      // ผู้ใช้นี้อนุมัติใบ แล้วออก API key ที่มี settlements:pay → key = ผู้อนุมัติ → 403
      const { C, trips } = await setup(1, '1300');
      const s = (await create({ carrierId: C.id, tripIds: [trips[0]!.id] }, accounting).expect(201))
        .body;
      await api(app, ut)
        .post(`/v1/settlements/${s.id}/approve`)
        .set('If-Match', await etag(s.id))
        .send(APPROVE)
        .expect(200);
      const keyName = `ERP จ่าย ${randomUUID().slice(0, 8)}`;
      const k = (
        await api(app, ut)
          .post('/v1/api-keys')
          .send({ name: keyName, scopes: ['settlements:read', 'settlements:pay'] })
          .expect(201)
      ).body as { secret: string };
      const byKey = await pay(s.id, PAY, k.secret);
      expect(byKey.status, JSON.stringify(byKey.body)).toBe(403);
      expect(byKey.body.code).toBe('settlement_self_payment');

      // key ที่ไม่รู้ผู้ออก (created_by ว่าง) = ระบุตัวไม่ได้ → 403 แม้ tenant ปิดกฎ (fail closed)
      const row = await db.apiKey.findFirstOrThrow({ where: { tenantId, name: keyName } });
      await db.apiKey.update({ where: { id: row.id }, data: { createdBy: null } });
      await db.tenantSetting.upsert({
        where: { tenantId_key: { tenantId, key } },
        create: { tenantId, key, value: true },
        update: { value: true },
      });
      try {
        const anon = await pay(s.id, PAY, k.secret);
        expect(anon.status, JSON.stringify(anon.body)).toBe(403);
        expect(anon.body.code).toBe('settlement_self_payment');
      } finally {
        await db.tenantSetting.deleteMany({ where: { tenantId, key } });
      }
      expect(
        (await db.carrierSettlement.findUniqueOrThrow({ where: { id: uuid('settlement', s.id) } }))
          .status,
      ).toBe('APPROVED');
      // คนอื่นจ่ายได้
      expect((await pay(s.id, PAY, accounting)).status).toBe(200);
    });

    it('เที่ยวที่บรรทัดต้นทุนอยู่หลายใบ: SETTLED เมื่อจ่ายใบสุดท้าย · ระหว่างนั้นบรรทัดที่เหลือยังอยู่ในคิว', async () => {
      const { C, trips } = await setup(1, '2000');
      const t = trips[0]!;
      const toll = await db.tripCost.create({
        data: {
          tenantId,
          tripId: uuid('trip', t.id),
          costType: 'TOLL',
          amount: '150.00',
          source: 'MANUAL',
          sourceType: 'FIELD',
          status: 'CONFIRMED',
          carrierId: uuid('carrier', C.id),
          description: 'ค่าทางด่วน',
          createdBy: 'u-disp',
          decidedBy: 'u-acc',
          decidedAt: new Date(),
          decisionReason: 'ตรวจใบเสร็จค่าทางด่วนแล้ว',
        },
      });
      const a = (
        await create({ carrierId: C.id, tripCostIds: [await feeOf(t.id)] }, accounting).expect(201)
      ).body;
      await approve(a.id);
      expect((await pay(a.id)).status).toBe(200);
      // ค่าทางด่วนยังรอจ่าย → เที่ยวยัง COSTED และอยู่ในคิว
      expect(await tripStatus(t.id)).toBe('COSTED');
      expect(await queued(C.id)).toEqual([t.id]);
      const b = (
        await create(
          { carrierId: C.id, tripCostIds: [encodeId('tripCost', toll.id)] },
          accounting,
        ).expect(201)
      ).body;
      // ใบ b ยังไม่จ่าย → ยังไม่ SETTLED (ไม่อยู่ในคิวเพราะบรรทัดอยู่ในใบแล้ว)
      expect(await tripStatus(t.id)).toBe('COSTED');
      expect(await queued(C.id)).toEqual([]);
      // ใบ b ไม่มีค่าขนส่ง (FREIGHT) อนุมัติไม่ได้ (ST6-T07) → ยกเลิกใบ b แล้วจ่ายค่าทางด่วนพร้อมเที่ยวใหม่
      await api(app, accounting)
        .post(`/v1/settlements/${b.id}/cancel`)
        .set('If-Match', await etag(b.id))
        .send({ reason: 'รวมค่าทางด่วนกับงวดถัดไป' })
        .expect(200);
      const [x, y] = [await newSite(), await newSite()];
      await buyRate(C.id, x, y, '1500');
      const t2 = await newTrip(x, y);
      await hire(t2.id, { carrierId: C.id });
      await setDo(t2.doId, 'UNBILLED', 'COMPLETE');
      await finish(t2.id, C.id);
      const c = (
        await create(
          { carrierId: C.id, tripIds: [t2.id], tripCostIds: [encodeId('tripCost', toll.id)] },
          accounting,
        ).expect(201)
      ).body;
      await approve(c.id);
      const paid = await pay(c.id);
      expect(paid.status, JSON.stringify(paid.body)).toBe(200);
      expect(await tripStatus(t.id)).toBe('SETTLED');
      expect(await tripStatus(t2.id)).toBe('SETTLED');
      expect(await queued(C.id)).toEqual([]);
    });

    it('กติการะดับ DB (role แอป): APPROVED → PAID ต้องมีข้อมูลการจ่าย · เปลี่ยนได้เฉพาะช่องการจ่าย (WHT ที่ตรึง/ยอด/เลขคงเดิม) · PAID = สิ้นสุด', async () => {
      const { C, trips } = await setup(1, '900');
      const s = (await create({ carrierId: C.id, tripIds: [trips[0]!.id] }, accounting).expect(201))
        .body;
      await approve(s.id);
      const sid = uuid('settlement', s.id);
      const fails = (fn: (tx: Tx) => Promise<unknown>, re: RegExp) =>
        expect(run(fn)).rejects.toThrow(re);
      const paidData = {
        status: 'PAID',
        paidDate: new Date(`${today}T00:00:00Z`),
        paidAt: new Date(),
        paidBy: 'u-acc',
        paymentMethod: 'TRANSFER',
        paymentReference: 'REF-1',
      };
      // ไม่มีข้อมูลการจ่าย / โอนไม่มีเลขอ้างอิง / วิธีไม่รู้จัก
      await fails(
        (tx) => tx.carrierSettlement.update({ where: { id: sid }, data: { status: 'PAID' } }),
        /carrier_settlement_paid_check/,
      );
      await fails(
        (tx) =>
          tx.carrierSettlement.update({
            where: { id: sid },
            data: { ...paidData, paymentReference: null },
          }),
        /carrier_settlement_paid_check/,
      );
      await fails(
        (tx) =>
          tx.carrierSettlement.update({
            where: { id: sid },
            data: { ...paidData, paymentMethod: 'WIRE' },
          }),
        /carrier_settlement_paid_check/,
      );
      // ใบ APPROVED: ใส่ข้อมูลการจ่ายโดยไม่เปลี่ยนสถานะ = ไม่ได้
      await fails(
        (tx) => tx.carrierSettlement.update({ where: { id: sid }, data: { paymentBank: 'X' } }),
        /carrier_settlement_terminal/,
      );
      // คำสั่งที่บันทึกจ่ายแก้ WHT ที่ตรึง / ยอด / หมายเหตุ / ผู้อนุมัติ ไม่ได้
      for (const extra of [
        { whtAmount: '0.00' },
        { whtMinimumAmount: '5000.00' },
        { whtRateDefault: '3.00' },
        { note: 'แก้' },
        { approvedBy: 'u-x' },
      ])
        await fails(
          (tx) =>
            tx.carrierSettlement.update({ where: { id: sid }, data: { ...paidData, ...extra } }),
          /carrier_settlement_paid_frozen/,
        );
      // ผ่าน
      await run((tx) => tx.carrierSettlement.update({ where: { id: sid }, data: paidData }));
      // PAID = สิ้นสุด
      for (const data of [
        { paymentReference: 'REF-2' },
        { status: 'APPROVED' },
        { note: 'หลังจ่าย' },
        { status: 'CANCELLED' },
      ])
        await fails(
          (tx) => tx.carrierSettlement.update({ where: { id: sid }, data }),
          /carrier_settlement_terminal/,
        );
    });

    it('ยอดใน audit = ยอดจริง แม้ผู้บันทึกไม่มีสิทธิ์ดูราคาซื้อ (review QA L3)', async () => {
      const { C, trips } = await setup(1, '3000');
      const s = (await create({ carrierId: C.id, tripIds: [trips[0]!.id] }, accounting).expect(201))
        .body;
      await approve(s.id);
      const payOnly = await tokenFor(tenantId, 'settlements:read settlements:pay', 'u-payer');
      const r = await pay(s.id, PAY, payOnly);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.buyNetPayable).toBeUndefined();
      const audit = await db.auditLog.findFirstOrThrow({
        where: { entityId: uuid('settlement', s.id), action: 'settlement.paid' },
      });
      expect(audit.after).toMatchObject({
        buyNetPayable: '3000.00',
        buyWhtAmount: '30.00',
        buyNetAfterWht: '2970.00',
      });
    });

    it('พร้อมกัน: บันทึกจ่ายใบเดียวกันสองคำขอ → 200 หนึ่ง + 409 หนึ่ง · บันทึกจ่ายครั้งเดียว', async () => {
      const { C, trips } = await setup(1, '1200');
      const s = (await create({ carrierId: C.id, tripIds: [trips[0]!.id] }, accounting).expect(201))
        .body;
      await approve(s.id);
      const tag = await etag(s.id);
      const rs = await Promise.all([
        pay(s.id, PAY, accounting, tag),
        pay(s.id, { paidDate: today, method: 'CASH' }, admin, tag),
      ]);
      expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(rs.find((r) => r.status === 409)!.body.code).toBe('invalid_state_transition');
      expect(
        await db.auditLog.count({
          where: { entityId: uuid('settlement', s.id), action: 'settlement.paid' },
        }),
      ).toBe(1);
      expect(
        await db.domainEvent.count({
          where: { tenantId, type: 'settlement.paid', localId: uuid('settlement', s.id) },
        }),
      ).toBe(1);
      expect(await tripStatus(trips[0]!.id)).toBe('SETTLED');
    });

    it('พร้อมกัน: สองใบที่มีบรรทัดของเที่ยวเดียวกันจ่ายพร้อมกัน → เที่ยว SETTLED', async () => {
      const { C, trips } = await setup(2, '2500');
      const [t, t2] = [trips[0]!, trips[1]!];
      const toll = await db.tripCost.create({
        data: {
          tenantId,
          tripId: uuid('trip', t.id),
          costType: 'TOLL',
          amount: '80.00',
          source: 'MANUAL',
          sourceType: 'FIELD',
          status: 'CONFIRMED',
          carrierId: uuid('carrier', C.id),
          description: 'ค่าทางด่วน',
          createdBy: 'u-disp',
          decidedBy: 'u-acc',
          decidedAt: new Date(),
          decisionReason: 'ตรวจใบเสร็จค่าทางด่วนแล้ว',
        },
      });
      // ใบ A = ค่าจ้างของเที่ยว t · ใบ B = เที่ยว t2 + ค่าทางด่วนของเที่ยว t
      const A = (
        await create({ carrierId: C.id, tripCostIds: [await feeOf(t.id)] }, accounting).expect(201)
      ).body;
      const B = (
        await create(
          { carrierId: C.id, tripIds: [t2.id], tripCostIds: [encodeId('tripCost', toll.id)] },
          accounting,
        ).expect(201)
      ).body;
      await approve(A.id);
      await approve(B.id);
      expect(await tripStatus(t.id)).toBe('COSTED');
      const [ra, rb] = await Promise.all([pay(A.id), pay(B.id)]);
      expect(ra.status, JSON.stringify(ra.body)).toBe(200);
      expect(rb.status, JSON.stringify(rb.body)).toBe(200);
      expect(await tripStatus(t.id)).toBe('SETTLED');
      expect(await tripStatus(t2.id)).toBe('SETTLED');
      expect(await queued(C.id)).toEqual([]);
      expect(
        await db.docStatusHistory.count({
          where: { docType: 'trip', docId: uuid('trip', t.id), toStatus: 'SETTLED' },
        }),
      ).toBe(1);
    });

    // ---------- ST6-T04 PDF ใบสำคัญจ่าย ----------
    const pdfOf = (id: string, token = admin) =>
      api(app, token)
        .get(`/v1/settlements/${id}/pdf`)
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        });
    const fmt = (v: string) => bahtFormat(v);

    it('ST6-T04 เกณฑ์ตรวจรับ: PDF ใบสำคัญจ่าย — ยอดบน PDF ตรงกับ API (ร่าง → อนุมัติ → จ่าย) · ใช้ WHT ที่ตรึง · ข้อมูลการจ่าย', async () => {
      const { C, trips } = await setup(2, '4500');
      const s = (
        await create(
          { carrierId: C.id, tripIds: trips.map((t) => t.id), deductions: [ADV, FINE] },
          accounting,
        ).expect(201)
      ).body;
      const svc = app.get(SettlementPdfService);
      const renderer = app.get(PdfRenderer);
      const check = async (status: string) => {
        const res = await pdfOf(s.id);
        expect(res.status, String(res.body)).toBe(200);
        expect(res.headers['content-type']).toContain('application/pdf');
        expect(res.headers['cache-control']).toContain('no-store');
        expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
        const dto = (await api(app, admin).get(`/v1/settlements/${s.id}`).expect(200)).body;
        expect(dto.status).toBe(status);
        const { model } = await run((tx) => svc.loadModel(tx, uuid('settlement', s.id)));
        // ทุกตัวเลขบนใบ = ค่าจาก API
        expect(model.gross).toBe(dto.buyGrossAmount);
        expect(model.whtTotal).toBe(dto.buyWhtAmount);
        expect(model.net).toBe(dto.buyNetAfterWht);
        expect(model.settlementNo).toBe(dto.settlementNo);
        const tripSum = model.trips.reduce(
          (x, t) => x + Number(t.tripFee) * 100 + Number(t.siteExpenses) * 100,
          0,
        );
        expect(tripSum).toBe(Math.round(Number(dto.buyGrossAmount) * 100));
        expect(model.deductions).toEqual([
          { type: 'CASH_ADVANCE', amount: '2000.00' },
          { type: 'FINE', amount: '500.00' },
        ]);
        const text = (await renderer.withPage(settlementVoucherDocument(model), (p) =>
          p.evaluate('document.body.innerText'),
        )) as string;
        for (const v of [dto.buyGrossAmount, dto.buyWhtAmount, dto.buyNetAfterWht])
          expect(text).toContain(fmt(v));
        expect(text).toContain(`หัก ณ ที่จ่าย 1%* / WHT 1%*`);
        expect(text).toContain(dto.carrier.legalName);
        expect(model.trips.map((t) => t.tripNo).sort()).toEqual(
          dto.lines
            .filter((l: { lineType: string }) => l.lineType !== 'DEDUCTION')
            .map((l: { tripNo: string }) => l.tripNo)
            .sort(),
        );
        expect(model.trips[0]!.route).toMatch(/ – /);
        return { dto, model, text };
      };
      const d = await check('DRAFT');
      expect(d.model.settlementNo).toBeNull();
      expect(d.text).toContain('ร่าง · ยังไม่มีเลขที่');
      await approve(s.id);
      const ap = await check('APPROVED');
      expect(ap.dto.whtEstimate.frozen).toBe(true);
      expect(ap.text).toContain(ap.dto.settlementNo);
      // ค่าตั้งต้นรถร่วมเปลี่ยนหลังอนุมัติ → ยอดบนใบคงเดิม (ตรึง)
      await db.carrier.update({
        where: { id: uuid('carrier', C.id) },
        data: { whtRateDefault: '3.00' },
      });
      // review L1: ผู้จ่ายตรึงตอนอนุมัติ — เปลี่ยนชื่อบริษัททีหลัง ใบเดิมยังพิมพ์ชื่อเดิม
      const row = await db.carrierSettlement.findUniqueOrThrow({
        where: { id: uuid('settlement', s.id) },
      });
      const snap = row.payerSnapshot as { companyId: string; name: string; branchCode: string };
      expect(snap.name).toBe(ap.model.payer.name);
      expect(snap.branchCode).toBe('00000');
      const co = await db.company.findUniqueOrThrow({ where: { id: snap.companyId } });
      await db.company.update({
        where: { id: co.id },
        data: { legalName: 'บริษัท ชื่อใหม่ จำกัด' },
      });
      const after = await check('APPROVED');
      expect(after.model.whtTotal).toBe(ap.model.whtTotal);
      expect(after.model.payer.name).toBe(co.legalName);
      expect(after.text).not.toContain('บริษัท ชื่อใหม่ จำกัด');
      await db.company.update({ where: { id: co.id }, data: { legalName: co.legalName } });
      expect((await pay(s.id)).status).toBe(200);
      const paid = await check('PAID');
      expect(paid.model.docDate).toBe(today);
      expect(paid.model.paymentMethod).toBe('TRANSFER');
      expect(paid.text).toMatch(/จ่ายโดย\s*โอนเงิน/);
      expect(paid.text).toContain('KBANK-2611-0091');
      expect(paid.model.payer.name).toMatch(/^บริษัท ผู้ออกบิล/);
      expect(paid.model.payer.branchCode).toBe('00000');
    }, 120_000);

    it('ST6-T04 สิทธิ์: ไม่มี prices.buy:read → 403 · ไม่มี settlements:read → 403 · บริษัทอื่น 404 · ใบยกเลิก 409', async () => {
      const { C, trips } = await setup(1, '1000');
      const s = (await create({ carrierId: C.id, tripIds: [trips[0]!.id] }, accounting).expect(201))
        .body;
      const noBuy = await tokenFor(tenantId, 'settlements:read', 'u-nobuy');
      const r1 = await pdfOf(s.id, noBuy);
      expect(r1.status).toBe(403);
      const noRead = await tokenFor(tenantId, 'prices.buy:read', 'u-noread');
      expect((await pdfOf(s.id, noRead)).status).toBe(403);
      expect((await pdfOf(s.id, other)).status).toBe(404);
      expect((await pdfOf('stl_nope')).status).toBe(404);
      await api(app, accounting)
        .post(`/v1/settlements/${s.id}/cancel`)
        .set('If-Match', await etag(s.id))
        .send({ reason: 'ยกเลิกเพื่อทดสอบ PDF ใบสำคัญจ่าย' })
        .expect(200);
      const c = await pdfOf(s.id);
      expect(c.status).toBe(409);
      // review L1: ผู้จ่ายตรึงได้เฉพาะใบที่พ้นร่าง (CHECK) — ใบยกเลิก/ร่างไม่มี snapshot
      await expect(
        db.$executeRaw`UPDATE carrier_settlement SET payer_snapshot = '{}'::jsonb WHERE id = ${uuid('settlement', s.id)}::uuid`,
      ).rejects.toThrow();
    }, 60_000);
  });
});
