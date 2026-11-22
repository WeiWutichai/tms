import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SYSTEM_ROLES } from '@tms/domain';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PdfRenderer } from '../src/pdf/pdf-renderer';
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
import request from 'supertest';
import { resetLinkWriteRate } from '../src/http/link-rate-limit';
import { encodeLinkToken } from '../src/modules/links/magic-link.service';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST6-T11 ลิงก์ "ค่าเที่ยวของฉัน" ของรถร่วม — เกณฑ์ตรวจรับ: carrier เปิดลิงก์เห็นเฉพาะของตัวเอง (เที่ยวที่จบ ยอด สถานะจ่าย)
 * + แยกรถร่วม/แยก tenant · ลิงก์หมดอายุ/เพิกถอน 404 · เฉพาะเที่ยวที่จบ · สถานะจ่าย + PDF ใบจ่ายเงินเฉพาะงวดที่จ่ายแล้ว · audit · ส่ง SMS
 */
describe('carrier pay link (ST6-T11)', () => {
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
    const base = `0105${String(82_000 + n).padStart(8, '0')}`;
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
    return base + String((11 - (sum % 11)) % 10);
  };

  beforeAll(async () => {
    // ปิดต้นทุน (COMPLETED → COSTED) ปิดใช้โดยค่าเริ่มต้น (รอวิธีปันลง DO) — ชุดนี้เปิดเพื่อสร้างเที่ยว COSTED
    process.env.TRIP_COSTING_ENABLED = '1';
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท ค่าเที่ยวรถร่วม' })).id;
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

  const APPROVE = { reason: 'ตรวจยอดตรงใบแจ้งหนี้รถร่วมแล้ว' };
  let accounting: string;
  let approver: string;
  beforeAll(async () => {
    accounting = await tokenFor(tenantId, SYSTEM_ROLES.accounting.permissions.join(' '), 'u-acc');
    approver = await tokenFor(tenantId, SYSTEM_ROLES.approver.permissions.join(' '), 'u-appr');
  });
  const pub = () => request(app.getHttpServer());
  const tokenOf = (url: string) => url.split('/link/carrier-pay/')[1]!;
  const version = async (id: string) =>
    (await db.carrierSettlement.findUniqueOrThrow({ where: { id: uuid('settlement', id) } }))
      .version;
  const withVersion = (id: string, call: (v: number) => request.Test) => ({
    expect: async (status: number) => {
      const r = await call(await version(id));
      expect(r.status, JSON.stringify(r.body)).toBe(status);
      return r;
    },
  });
  const send = (id: string) =>
    withVersion(id, (v) =>
      api(app, accounting).post(`/v1/settlements/${id}/send-to-carrier`).set('If-Match', `"${v}"`),
    );
  const approve = (id: string) =>
    withVersion(id, (v) =>
      api(app, approver)
        .post(`/v1/settlements/${id}/approve`)
        .set('If-Match', `"${v}"`)
        .send(APPROVE),
    );
  const pay = (id: string) =>
    withVersion(id, (v) =>
      api(app, accounting)
        .post(`/v1/settlements/${id}/mark-paid`)
        .set('If-Match', `"${v}"`)
        .send({ paidDate: today, method: 'CASH' }),
    );
  const settle = async (tripIds: string[], carrierId: string, deductions: object[] = []) =>
    (await create({ carrierId, tripIds, deductions }, accounting).expect(201)).body as {
      id: string;
      lines: Line[];
    };
  const issue = (carrierId: string, token = accounting) =>
    api(app, token).post(`/v1/carriers/${carrierId}/pay-link`);
  const view = (t: string) => pub().get(`/v1/public/carrier-pay/${t}`);
  const pdf = (t: string, sid: string) =>
    pub()
      .get(`/v1/public/carrier-pay/${t}/settlements/${sid}/pdf`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
  type View = {
    company: string;
    carrierName: string;
    paymentTermDays: number;
    dueAmount: string;
    dueCount: number;
    settlements: {
      id: string;
      settlementNo: string | null;
      status: string;
      tripCount: number;
      amount: string | null;
      estimate: boolean;
      paidDate: string | null;
    }[];
    trips: { tripNo: string | null; amount: string; origin: string | null }[];
    expiresAt: string;
  };
  const tripNo = async (id: string) =>
    (await db.trip.findUniqueOrThrow({ where: { id: uuid('trip', id) } })).tripNo;

  it('เกณฑ์ตรวจรับ: รถร่วมเห็นเฉพาะของตัวเอง — งวดรอตรวจ/อนุมัติ/จ่ายแล้ว (ยอดหลังหัก ณ ที่จ่าย) + เที่ยวที่จบแต่ยังไม่เข้างวด · ร่าง/ยกเลิก/เที่ยวยังไม่จบไม่ขึ้น · ไม่มีราคาขาย', async () => {
    await resetLinkWriteRate();
    // รถร่วม A: 6 เที่ยวจบ ค่าจ้าง 5,000 — งวดจ่ายแล้ว (1) · งวดอนุมัติ (1) · งวดรอตรวจ (2 — หักเงินเบิก) · ร่าง (1) · ยังไม่เข้างวด (1)
    const { C, trips, a, b } = await setup(6, '5000');
    const paid = await settle([trips[0]!.id], C.id);
    await send(paid.id).expect(200);
    await approve(paid.id).expect(200);
    await pay(paid.id).expect(200);
    const appr = await settle([trips[1]!.id], C.id);
    await send(appr.id).expect(200);
    await approve(appr.id).expect(200);
    const rev = await settle([trips[2]!.id, trips[3]!.id], C.id, [ADV]);
    await send(rev.id).expect(200);
    const draft = await settle([trips[4]!.id], C.id); // ร่าง — รถร่วมไม่เห็นใบ แต่เห็นเที่ยวว่ายังไม่เข้างวด
    const cancelled = await settle([trips[5]!.id], C.id); // ยกเลิก — ไม่เห็นใบ เที่ยวกลับเป็นยังไม่เข้างวด
    await withVersion(cancelled.id, (v) =>
      api(app, accounting)
        .post(`/v1/settlements/${cancelled.id}/cancel`)
        .set('If-Match', `"${v}"`)
        .send({ reason: 'สร้างใบผิดงวด ยกเลิกเพื่อทำใหม่' }),
    ).expect(200);
    // เที่ยวที่ยังไม่จบ (รับงานแล้ว) — ไม่ขึ้น
    const running = await newTrip(a, b);
    await hire(running.id, { carrierId: C.id });
    // รถร่วมรายอื่นในบริษัทเดียวกัน + เที่ยวจบ + งวดจ่ายแล้ว — ต้องไม่โผล่
    const B = await setup(1, '7777');
    const bs = await settle([B.trips[0]!.id], B.C.id);
    await send(bs.id).expect(200);

    const l = await issue(C.id).expect(201);
    expect(l.body.url).toContain('/link/carrier-pay/');
    const days = (Date.parse(l.body.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
    const r = await view(tokenOf(l.body.url)).expect(200);
    expect(r.headers['cache-control']).toContain('no-store');
    const v = r.body as View;
    expect(v).toMatchObject({ company: 'บริษัท ค่าเที่ยวรถร่วม', paymentTermDays: 30 });
    expect(v.carrierName).toMatch(/^หจก\. รถร่วมจ่าย/);
    const by = new Map(v.settlements.map((s) => [s.id, s]));
    expect([...by.keys()].sort()).toEqual([paid.id, appr.id, rev.id].sort());
    expect(JSON.stringify(v)).not.toContain(draft.id);
    expect(JSON.stringify(v)).not.toContain(cancelled.id);
    // ยังไม่จ่ายก่อน แล้วจ่ายแล้ว
    expect(v.settlements.at(-1)!.id).toBe(paid.id);
    // นิติบุคคล หัก 1%: 5,000 → 4,950 (ตรึงตอนอนุมัติ) · รอตรวจ 2 เที่ยว − เงินเบิก 2,000 = 8,000 − 1% ของ 10,000 = 7,900 (ประมาณการ)
    expect(by.get(paid.id)).toMatchObject({
      status: 'PAID',
      amount: '4950.00',
      estimate: false,
      paidDate: today,
      tripCount: 1,
    });
    expect(by.get(paid.id)!.settlementNo).toBeTruthy();
    expect(by.get(appr.id)).toMatchObject({
      status: 'APPROVED',
      amount: '4950.00',
      estimate: false,
      paidDate: null,
    });
    expect(by.get(rev.id)).toMatchObject({
      status: 'SENT_TO_CARRIER',
      tripCount: 2,
      estimate: true,
    });
    const revDto = (await api(app, accounting).get(`/v1/settlements/${rev.id}`).expect(200)).body;
    expect(by.get(rev.id)!.amount).toBe(revDto.buyNetAfterWht);
    // รอรับเงิน = งวดที่ยังไม่จ่าย
    expect(v.dueCount).toBe(2);
    expect(v.dueAmount).toBe(
      (Number(by.get(appr.id)!.amount!) + Number(by.get(rev.id)!.amount!)).toFixed(2),
    );
    // เที่ยวที่จบแต่ยังไม่เข้างวดที่รถร่วมเห็น: เที่ยวในร่าง + เที่ยวที่ยังไม่ทำใบ (ล่าสุดก่อน) — ไม่มีเที่ยวที่ยังวิ่ง/ของรายอื่น
    expect(v.trips.map((t) => t.tripNo).sort()).toEqual(
      [await tripNo(trips[4]!.id), await tripNo(trips[5]!.id)].sort(),
    );
    expect(v.trips.every((t) => t.amount === '5000.00' && t.origin)).toBe(true);
    // ไม่มีข้อมูลรถร่วมรายอื่น / ราคาขาย / ลูกค้า
    const raw = JSON.stringify(v);
    expect(raw).not.toContain('7777');
    expect(raw).not.toContain(bs.id);
    expect(raw).not.toContain(await tripNo(B.trips[0]!.id));
    expect(raw).not.toContain(await tripNo(running.id));
    expect(raw).not.toMatch(/sell|customer|ลูกค้า/i);
    // ลิงก์ของรถร่วม B เห็นเฉพาะของ B
    const lb = await issue(B.C.id).expect(201);
    const vb = (await view(tokenOf(lb.body.url)).expect(200)).body as View;
    expect(vb.settlements.map((s) => s.id)).toEqual([bs.id]);
    expect(vb.trips).toEqual([]);
  });

  it('ใบจ่ายเงิน (PDF): เฉพาะงวดที่จ่ายแล้วของรถร่วมรายนี้ — ยังไม่จ่าย/ของรายอื่น/ลิงก์ผิด 404 · เพดาน 10 ครั้ง/นาที', async () => {
    await resetLinkWriteRate();
    const spy = vi
      .spyOn(app.get(PdfRenderer), 'pdf')
      .mockResolvedValue(Buffer.from('%PDF-1.4 test'));
    const { C, trips } = await setup(2, '3000');
    const p = await settle([trips[0]!.id], C.id);
    await send(p.id).expect(200);
    await approve(p.id).expect(200);
    await pay(p.id).expect(200);
    const u = await settle([trips[1]!.id], C.id);
    await send(u.id).expect(200);
    const O = await setup(1, '3000');
    const op = await settle([O.trips[0]!.id], O.C.id);
    await send(op.id).expect(200);
    await approve(op.id).expect(200);
    await pay(op.id).expect(200);
    const t = tokenOf((await issue(C.id).expect(201)).body.url);
    const ok = await pdf(t, p.id);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toContain('application/pdf');
    expect(ok.headers['cache-control']).toContain('no-store');
    expect((await pdf(t, u.id)).status).toBe(404);
    expect((await pdf(t, op.id)).status).toBe(404);
    expect((await pdf(t, 'stl_bogus')).status).toBe(404);
    expect((await pdf(`${t}x`, p.id)).status).toBe(404);
    await resetLinkWriteRate();
    for (let k = 0; k < 10; k++) expect((await pdf(t, p.id)).status).toBe(200);
    expect((await pdf(t, p.id)).status).toBe(429);
    spy.mockRestore();
    await resetLinkWriteRate();
  });

  it('ออกลิงก์: สิทธิ์ settlements:create · ออกใหม่เพิกถอนลิงก์เดิม (404) · หมดอายุ 404 · รถร่วมถูกลบ 404 · ลิงก์ตรวจใบใช้แทนไม่ได้ · audit · แยก tenant', async () => {
    await resetLinkWriteRate();
    const { C, trips } = await setup(1, '2500');
    await issue(C.id, viewer).expect(403);
    await issue(C.id, other).expect(404);
    const first = await issue(C.id).expect(201);
    const t1 = tokenOf(first.body.url);
    await view(t1).expect(200);
    const second = await issue(C.id).expect(201);
    const t2 = tokenOf(second.body.url);
    await view(t1).expect(404);
    await view(t2).expect(200);
    const revoked = await db.magicLink.findUniqueOrThrow({
      where: { id: tryDecodeId('magicLink', first.body.id as string)! },
    });
    expect(revoked.revokedAt).not.toBeNull();
    const logs = await db.auditLog.findMany({
      where: { tenantId, action: 'carrier.pay_link_issued', entityId: uuid('carrier', C.id) },
      orderBy: { seq: 'asc' },
    });
    expect(logs).toHaveLength(2);
    expect(logs[0]!.actorId).toBe('u-acc');
    expect((logs[1]!.after as { revokedLinkIds: string[] }).revokedLinkIds).toEqual([revoked.id]);
    // หมดอายุ: ลายเซ็นถูกแต่เวลาไม่ตรง/ผ่านไปแล้ว → 404
    const expired = encodeLinkToken(
      tryDecodeId('magicLink', second.body.id as string)!,
      Math.floor(Date.now() / 1000) - 60,
    );
    await view(expired).expect(404);
    // ลิงก์ตรวจใบสำคัญจ่าย (ST6-T05) ใช้เปิดหน้าค่าเที่ยวไม่ได้ (action ต่างกัน)
    const s = await settle([trips[0]!.id], C.id);
    const rv = await send(s.id).expect(200);
    const reviewToken = (rv.body.link.url as string).split('/link/settlement/')[1]!;
    await view(reviewToken).expect(404);
    // ลิงก์ค่าเที่ยวเปิดหน้าตรวจใบไม่ได้
    await pub().get(`/v1/public/settlements/${t2}`).expect(404);
    // รถร่วมถูกลบ → ลิงก์ใช้ไม่ได้
    await db.carrier.update({
      where: { id: uuid('carrier', C.id) },
      data: { deletedAt: new Date() },
    });
    await view(t2).expect(404);
  });

  it('ส่งลิงก์ทาง SMS (send-link) — template carrier_pay_link · ผู้รับ = รถร่วมของลิงก์ · approver ส่งไม่ได้ (403)', async () => {
    await db.messagingSetting.upsert({
      where: { tenantId },
      create: { tenantId, lineEnabled: true, smsEnabled: true },
      update: { smsEnabled: true },
    });
    const C = await newCarrier();
    await db.carrier.update({
      where: { id: uuid('carrier', C.id) },
      data: { phone: '0812345678' },
    });
    const l = await issue(C.id).expect(201);
    await api(app, approver)
      .post('/v1/messages/send-link')
      .set('Idempotency-Key', `cpl-a-${C.id}`)
      .send({ channel: 'sms', url: l.body.url })
      .expect(403);
    const m = await api(app, accounting)
      .post('/v1/messages/send-link')
      .set('Idempotency-Key', `cpl-${C.id}`)
      .send({ channel: 'sms', url: l.body.url })
      .expect(202);
    expect(m.body).toMatchObject({
      channel: 'sms',
      template: 'carrier_pay_link',
      status: 'queued',
      carrierId: C.id,
    });
  });

  it('review: DISPUTED แสดงเป็นรอตรวจ · ค่าใช้จ่ายเพิ่มของเที่ยวที่อยู่ในงวดแล้วขึ้นเฉพาะส่วนที่ยังไม่เข้างวด · ไม่รู้ประเภทรถร่วม = ไม่มียอด · ลิงก์ tenant อื่นเปิด PDF ไม่ได้ · 30 GET/นาที ต่อลิงก์', async () => {
    await resetLinkWriteRate();
    const { C, trips } = await setup(2, '4000');
    const s = await settle([trips[0]!.id], C.id);
    const rv = await send(s.id).expect(200);
    const rt = (rv.body.link.url as string).split('/link/settlement/')[1]!;
    const fl = s.lines.find((l) => l.lineType === 'FREIGHT')!;
    await pub()
      .post(`/v1/public/settlements/${rt}/lines/${fl.id}/review`)
      .send({ response: 'DISPUTED', reason: 'ค่ารอไม่ตรง รอ 3 ชม.' })
      .expect(201);
    expect(
      (await db.carrierSettlement.findUniqueOrThrow({ where: { id: uuid('settlement', s.id) } }))
        .status,
    ).toBe('DISPUTED');
    // ค่าทางด่วนที่ยืนยันแล้วของเที่ยวเดียวกัน (ยังไม่อยู่ในใบ) → เที่ยวขึ้นด้วยยอดเฉพาะส่วนนี้
    await db.tripCost.create({
      data: {
        tenantId,
        tripId: uuid('trip', trips[0]!.id),
        costType: 'TOLL',
        amount: '300',
        source: 'MANUAL',
        carrierId: uuid('carrier', C.id),
        status: 'CONFIRMED',
      },
    });
    const l = await issue(C.id).expect(201);
    const t = tokenOf(l.body.url);
    const v = (await view(t).expect(200)).body as View;
    expect(v.settlements).toHaveLength(1);
    expect(v.settlements[0]).toMatchObject({ id: s.id, status: 'SENT_TO_CARRIER', estimate: true });
    expect(v.settlements[0]!.amount).toBe('3960.00');
    expect(v.dueAmount).toBe('3960.00');
    const n0 = await tripNo(trips[0]!.id);
    const n1 = await tripNo(trips[1]!.id);
    expect(v.trips.map((x) => [x.tripNo, x.amount]).sort()).toEqual(
      [
        [n0, '300.00'],
        [n1, '4000.00'],
      ].sort(),
    );
    // snapshot รถร่วมไม่มีประเภท (ยังไม่ตรึง) → ยอด null (ไม่ใช้ยอดก่อนหัก) และไม่นับในรอรับเงิน
    const U = await setup(1, '1500');
    const us = await settle([U.trips[0]!.id], U.C.id);
    await db.$executeRaw`UPDATE carrier_settlement SET carrier_snapshot = carrier_snapshot - 'entityType' WHERE id = ${uuid('settlement', us.id)}::uuid`;
    await send(us.id).expect(200);
    const v2 = (await view(tokenOf((await issue(U.C.id).expect(201)).body.url)).expect(200))
      .body as View;
    expect(v2.settlements[0]!.amount).toBeNull();
    expect(v2).toMatchObject({ dueAmount: '0.00', dueCount: 1 });
    // ลิงก์ของบริษัทอื่นเปิด PDF ของใบบริษัทนี้ไม่ได้ (ใบจ่ายแล้ว — รถร่วมบริษัทอื่น)
    const P = await setup(1, '2000');
    const paid = await settle([P.trips[0]!.id], P.C.id);
    await send(paid.id).expect(200);
    await approve(paid.id).expect(200);
    await pay(paid.id).expect(200);
    const oc = await api(app, other)
      .post('/v1/carriers')
      .send({ legalName: 'หจก. บริษัทอื่น', entityType: 'JURISTIC', taxId: jur(++seed) })
      .expect(201);
    const ot = tokenOf((await issue(oc.body.id, other).expect(201)).body.url);
    expect((await pdf(ot, paid.id)).status).toBe(404);
    expect(((await view(ot).expect(200)).body as View).settlements).toEqual([]);
    // เพดานอ่านต่อลิงก์ 30 ครั้ง/นาที
    await resetLinkWriteRate();
    for (let k = 0; k < 30; k++) await view(t).expect(200);
    const r = await view(t).expect(429);
    expect(r.body.code).toBe('rate_limited');
    await resetLinkWriteRate();
  });
});
