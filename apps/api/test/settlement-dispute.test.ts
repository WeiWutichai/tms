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
import request from 'supertest';
import { resetLinkWriteRate } from '../src/http/link-rate-limit';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST6-T06 Dispute ใบสำคัญจ่ายรถร่วม — เกณฑ์ตรวจรับ: settlement ที่มีรายการ DISPUTED กด approve ไม่ได้ (409) จนแก้/เคลียร์ ·
 * สถานะรายการ OPEN / DISPUTED / APPROVED · หัวใบ DISPUTED · บัญชีติด dispute · ยืนยันยอดเดิมพร้อมเหตุผล (SoD) · หน้าเทียบ + POD · DB guard
 */
describe('settlement dispute (ST6-T06)', () => {
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
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท dispute' })).id;
    otherId = (await createTenantWithDefaults(db, { name: 'บริษัท อื่น' })).id;
    for (const tid of [tenantId, otherId]) {
      const c = await db.company.create({
        data: {
          tenantId: tid,
          legalName: `บริษัท ผู้ออกบิล ${++seed}`,
          taxId: validTaxId(1800 + seed),
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
        .send({ legalName: `ลูกค้า ${++seed}`, taxId: validTaxId(19800 + seed) })
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
  const RECALL = { reason: 'รถร่วมโต้แย้งค่ารอ ต้องแก้รายการ' };
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  let accounting: string;
  let approver: string;
  beforeAll(async () => {
    accounting = await tokenFor(tenantId, SYSTEM_ROLES.accounting.permissions.join(' '), 'u-acc');
    approver = await tokenFor(tenantId, SYSTEM_ROLES.approver.permissions.join(' '), 'u-appr');
  });
  const pub = () => request(app.getHttpServer());
  const pathOf = (url: string) => new URL(url).pathname + new URL(url).search;
  const tokenOf = (url: string) => url.split('/link/settlement/')[1]!;
  const version = async (id: string) =>
    (await db.carrierSettlement.findUniqueOrThrow({ where: { id: uuid('settlement', id) } }))
      .version;
  /** If-Match = version ปัจจุบันของใบ · ใช้ `.expect(status)` แบบ supertest */
  const withVersion = (id: string, call: (v: number) => request.Test) => ({
    expect: async (status: number) => {
      const r = await call(await version(id));
      expect(r.status, JSON.stringify(r.body)).toBe(status);
      return r;
    },
  });
  const send = (id: string, token = accounting) =>
    withVersion(id, (v) =>
      api(app, token).post(`/v1/settlements/${id}/send-to-carrier`).set('If-Match', `"${v}"`),
    );
  const approve = (id: string, token = approver) =>
    withVersion(id, (v) =>
      api(app, token).post(`/v1/settlements/${id}/approve`).set('If-Match', `"${v}"`).send(APPROVE),
    );
  const recall = (id: string, token = accounting) =>
    withVersion(id, (v) =>
      api(app, token).post(`/v1/settlements/${id}/recall`).set('If-Match', `"${v}"`).send(RECALL),
    );
  const view = (t: string) => pub().get(`/v1/public/settlements/${t}`);
  const respond = (t: string, lineId: string, body: object) =>
    pub().post(`/v1/public/settlements/${t}/lines/${lineId}/review`).send(body);
  const photo = async (t: string, lineId: string) => {
    const r = await pub()
      .post(`/v1/public/settlements/${t}/files`)
      .send({ lineId, mime: 'image/png', bytes: PNG.length, filename: 'ค่ารอ.png' })
      .expect(201);
    await pub()
      .put(pathOf(r.body.uploadUrl))
      .set('Content-Type', 'application/octet-stream')
      .send(PNG)
      .expect(200);
    return r.body.id as string;
  };
  /** ใบร่าง (บัญชีสร้าง) n เที่ยว + หักเงินเบิก แล้วส่งให้รถร่วมตรวจ */
  const sent = async (n = 2, rate = '4500') => {
    const { C, trips } = await setup(n, rate);
    const s = (
      await create(
        { carrierId: C.id, tripIds: trips.map((t) => t.id), deductions: [ADV] },
        accounting,
      ).expect(201)
    ).body as { id: string; lines: Line[] };
    const r = await send(s.id).expect(200);
    return { C, trips, s, r, token: tokenOf(r.body.link.url as string) };
  };
  const DISPUTE = { reason: 'ยอดค่ารอไม่ตรงกับบันทึกเวลา' };
  const RESOLVE = { reason: 'ตรวจใบชั่งและเวลาแล้ว ยอดตามสัญญาเดิม' };
  const flag = (id: string, lineId: string, token = accounting) =>
    withVersion(id, (v) =>
      api(app, token)
        .post(`/v1/settlements/${id}/lines/${lineId}/dispute`)
        .set('If-Match', `"${v}"`)
        .send(DISPUTE),
    );
  const resolve = (id: string, lineId: string, token = accounting) =>
    withVersion(id, (v) =>
      api(app, token)
        .post(`/v1/settlements/${id}/lines/${lineId}/resolve`)
        .set('If-Match', `"${v}"`)
        .send(RESOLVE),
    );
  const get = async (id: string, token = admin) =>
    (await api(app, token).get(`/v1/settlements/${id}`).expect(200)).body as {
      status: string;
      version: number;
      dispute: { disputed: number; approved: number; open: number };
      lines: (Line & {
        status: string | null;
        carrierReview: unknown;
        companyReview: { action: string } | null;
      })[];
    };

  let accUser: string;
  beforeAll(async () => {
    // ผู้ใช้จริง role บัญชี — ผู้รับแจ้งเตือน dispute
    const role = await db.role.findFirstOrThrow({ where: { tenantId, code: 'accounting' } });
    const u = await db.appUser.create({
      data: { tenantId, email: 'acc-dispute@t06.test', name: 'บัญชี', status: 'ACTIVE' },
    });
    await db.userRole.create({ data: { tenantId, userId: u.id, roleId: role.id } });
    accUser = u.id;
  });

  it('เกณฑ์ตรวจรับ: รถร่วมโต้แย้ง → หัวใบ DISPUTED + รายการ DISPUTED → อนุมัติ 409 → ยืนยันยอดเดิมพร้อมเหตุผล → อนุมัติได้ (ผู้เคลียร์อนุมัติไม่ได้)', async () => {
    await resetLinkWriteRate();
    const { s, token } = await sent(2, '4500');
    const [l0, l1, l2] = s.lines.map((l) => l.id);
    let g = await get(s.id);
    expect(g.lines.map((l) => l.status)).toEqual(['OPEN', 'OPEN', 'OPEN']);
    expect(g.dispute).toEqual({ disputed: 0, approved: 0, open: 3 });

    const d = await respond(token, l0!, {
      response: 'DISPUTED',
      reason: 'ค่ารอไม่ตรง รอ 3 ชม.',
      claimedAmount: '5200.00',
    }).expect(201);
    expect(d.body.status).toBe('DISPUTED');
    await respond(token, l1!, { response: 'ACCEPTED' }).expect(201);
    // ยอดที่เรียกใส่ได้เฉพาะโต้แย้ง · รูปแบบเงินผิด → 422
    await respond(token, l2!, { response: 'ACCEPTED', claimedAmount: '1.00' }).expect(422);
    await respond(token, l2!, { response: 'DISPUTED', reason: 'x', claimedAmount: '-1' }).expect(
      422,
    );
    g = await get(s.id);
    expect(g.status).toBe('DISPUTED');
    expect(g.lines.map((l) => l.status)).toEqual(['DISPUTED', 'APPROVED', 'OPEN']);
    expect(g.dispute).toEqual({ disputed: 1, approved: 1, open: 1 });
    expect(g.lines[0]!.carrierReview).toMatchObject({ buyClaimedAmount: '5200.00' });
    const audit = await db.auditLog.findFirstOrThrow({
      where: { entityId: uuid('settlement', s.id), action: 'settlement.disputed' },
    });
    expect(audit.actorId).toMatch(/^link:/);
    // แจ้งเตือน dispute (docs/04 I) → ผู้เตรียมใบ (`settlements:create`) — ไม่มียอดเงินในข้อความ
    const note = await db.notification.findFirst({
      where: {
        tenantId,
        recipientId: accUser,
        templateCode: 'settlement.disputed',
        relatedEntityId: s.id,
      },
    });
    expect(note?.title).toBe('ใบสำคัญจ่ายรถร่วมมีรายการโต้แย้ง');
    expect(note?.body).toContain('โต้แย้ง 1 รายการ');
    expect(note?.body).not.toMatch(/4,?500|5,?200/);
    // ลิงก์ยังเปิด/ตอบได้ระหว่าง DISPUTED · ป้ายหัว DISPUTED
    expect((await view(token).expect(200)).body).toMatchObject({
      status: 'DISPUTED',
      canRespond: true,
    });

    // เกณฑ์ตรวจรับ: มีรายการ DISPUTED → อนุมัติไม่ได้ 409
    const blocked = await approve(s.id).expect(409);
    expect(blocked.body).toMatchObject({ code: 'settlement_disputed', disputedCount: 1 });

    // เคลียร์บรรทัดที่ไม่ได้โต้แย้ง → 409 · เหตุผลสั้น → 422 · ไม่มี If-Match → 422 · If-Match เก่า → 412
    await resolve(s.id, l1!).expect(409);
    await api(app, accounting)
      .post(`/v1/settlements/${s.id}/lines/${l0}/resolve`)
      .set('If-Match', `"${await version(s.id)}"`)
      .send({ reason: 'สั้น' })
      .expect(422);
    const noIf = await api(app, accounting)
      .post(`/v1/settlements/${s.id}/lines/${l0}/resolve`)
      .send(RESOLVE)
      .expect(422);
    expect(noIf.body.errors[0].code).toBe('if_match_required');
    await api(app, accounting)
      .post(`/v1/settlements/${s.id}/lines/${l0}/resolve`)
      .set('If-Match', '"1"')
      .send(RESOLVE)
      .expect(412);
    // สิทธิ์: viewer/approver (ไม่มี settlements:create) 403 · บริษัทอื่น 404
    await resolve(s.id, l0!, viewer).expect(403);
    await resolve(s.id, l0!, approver).expect(403);
    await resolve(s.id, l0!, other).expect(404);

    // ยืนยันยอดเดิม (ผู้เคลียร์คนใหม่) → APPROVED + หัวใบกลับ SENT_TO_CARRIER
    const resolver = await tokenFor(
      tenantId,
      SYSTEM_ROLES.accounting.permissions.join(' '),
      'u-res',
    );
    const r = await resolve(s.id, l0!, resolver).expect(200);
    expect(r.body.status).toBe('SENT_TO_CARRIER');
    expect(r.body.lines[0]).toMatchObject({
      status: 'APPROVED',
      companyReview: { action: 'RESOLVED', reason: RESOLVE.reason, by: 'u-res', round: 1 },
    });
    expect(r.body.dispute).toEqual({ disputed: 0, approved: 2, open: 1 });
    const ra = await db.auditLog.findFirstOrThrow({
      where: { entityId: uuid('settlement', s.id), action: 'settlement.line_resolved' },
    });
    expect(ra.reason).toBe(RESOLVE.reason);
    expect(ra.actorId).toBe('u-res');
    expect(ra.before).toMatchObject({
      lineStatus: 'DISPUTED',
      carrier: { response: 'DISPUTED', buyClaimedAmount: '5200.00' },
    });
    // รถร่วมเห็นเหตุผลบนลิงก์ · ตอบบรรทัดที่เคลียร์แล้วไม่ได้ (409)
    const v = (await view(token).expect(200)).body;
    expect(v.status).toBe('SENT_TO_CARRIER');
    expect(v.lines[0]).toMatchObject({
      resolution: { reason: RESOLVE.reason },
      canRespond: false,
    });
    expect(v.lines[1]).toMatchObject({ resolution: null, canRespond: true });
    const again = await respond(token, l0!, { response: 'DISPUTED', reason: 'ยังไม่ตรง' }).expect(
      409,
    );
    expect(again.body.code).toBe('settlement_line_resolved');

    // SoD: ผู้เคลียร์ = ผู้เตรียมใบ → อนุมัติไม่ได้ · ผู้อนุมัติอื่นอนุมัติได้
    const resolverOwner = await tokenFor(tenantId, '*', 'u-res');
    expect((await approve(s.id, resolverOwner).expect(403)).body.code).toBe(
      'settlement_self_approval',
    );
    const ok = await approve(s.id).expect(200);
    expect(ok.body.status).toBe('APPROVED');
  });

  it('บัญชีติด dispute เอง: SENT → DISPUTED · รถร่วมยอมรับไม่ลบธงของบัญชี · ติดซ้ำ 409 · ไม่แสดงบนลิงก์ · เคลียร์แล้วอนุมัติได้', async () => {
    await resetLinkWriteRate();
    const { s, token } = await sent(1);
    const l0 = s.lines[0]!.id;
    // ใบร่าง (ยังไม่ส่ง) ติด dispute ไม่ได้ → 409
    const { C, trips } = await setup(1);
    const draft = (
      await create({ carrierId: C.id, tripIds: [trips[0]!.id] }, accounting).expect(201)
    ).body;
    await flag(draft.id, draft.lines[0].id).expect(409);
    // ไม่มี If-Match → 422 · viewer 403 · บริษัทอื่น 404 · บรรทัดของใบอื่น 404
    const noIf = await api(app, accounting)
      .post(`/v1/settlements/${s.id}/lines/${l0}/dispute`)
      .send(DISPUTE)
      .expect(422);
    expect(noIf.body.errors[0].code).toBe('if_match_required');
    await flag(s.id, l0, viewer).expect(403);
    await flag(s.id, l0, other).expect(404);
    await flag(s.id, draft.lines[0].id).expect(404);

    const f = await flag(s.id, l0).expect(200);
    expect(f.body.status).toBe('DISPUTED');
    expect(f.body.lines[0]).toMatchObject({
      status: 'DISPUTED',
      companyReview: { action: 'DISPUTED', reason: DISPUTE.reason, by: 'u-acc' },
    });
    await flag(s.id, l0).expect(409);
    // รถร่วมยอมรับ → ธงของบัญชียังอยู่
    const acc = await respond(token, l0, { response: 'ACCEPTED' }).expect(201);
    // ลิงก์ไม่เปิดเผยธงภายใน (review M2) — หัวใบจริงยัง DISPUTED
    expect(acc.body.status).toBe('SENT_TO_CARRIER');
    expect((await get(s.id)).status).toBe('DISPUTED');
    const raw = JSON.stringify((await view(token).expect(200)).body);
    expect(raw).not.toContain(DISPUTE.reason);
    expect((await approve(s.id).expect(409)).body.code).toBe('settlement_disputed');
    const fa = await db.auditLog.findFirstOrThrow({
      where: { entityId: uuid('settlement', s.id), action: 'settlement.line_flagged' },
    });
    expect(fa.reason).toBe(DISPUTE.reason);
    // ผู้ติด dispute ไม่ใช่ผู้เตรียม — ผู้เคลียร์คนอื่น แล้วอนุมัติ
    const resolver = await tokenFor(
      tenantId,
      SYSTEM_ROLES.accounting.permissions.join(' '),
      'u-r2',
    );
    await resolve(s.id, l0, resolver).expect(200);
    expect((await get(s.id)).status).toBe('SENT_TO_CARRIER');
    await approve(s.id).expect(200);
    // ใบอนุมัติแล้ว → ติด dispute/เคลียร์ไม่ได้
    await flag(s.id, l0).expect(409);
    await resolve(s.id, l0).expect(409);
  });

  it('DISPUTED → DRAFT (เรียกกลับมาแก้): ร่างยังบล็อกอนุมัติ → ยืนยันยอดเดิมในร่างได้ → อนุมัติร่างตรงได้ · หรือนำบรรทัดออก', async () => {
    await resetLinkWriteRate();
    const { s, token } = await sent(2);
    const [l0, l1] = [s.lines[0]!.id, s.lines[1]!.id];
    await respond(token, l0, { response: 'DISPUTED', reason: 'ค่ารอไม่ตรง' }).expect(201);
    await respond(token, l1, { response: 'DISPUTED', reason: 'เที่ยวนี้ซ้ำ' }).expect(201);
    expect((await get(s.id)).status).toBe('DISPUTED');
    // DISPUTED แก้หัว/ยกเลิก/ส่งซ้ำไม่ได้
    await api(app, accounting).patch(`/v1/settlements/${s.id}`).send({ note: 'x' }).expect(409);
    await api(app, accounting)
      .post(`/v1/settlements/${s.id}/cancel`)
      .send({ reason: 'ยกเลิกระหว่างโต้แย้ง' })
      .expect(409);
    const rc = await recall(s.id).expect(200);
    expect(rc.body).toMatchObject({ status: 'DRAFT', dispute: { disputed: 2 } });
    expect((await approve(s.id).expect(409)).body).toMatchObject({
      code: 'settlement_disputed',
      disputedCount: 2,
    });
    // ร่าง: ติด dispute ใหม่ไม่ได้ (ต้องส่งตรวจก่อน) · เคลียร์ได้
    await flag(s.id, l0).expect(409);
    const resolver = await tokenFor(
      tenantId,
      SYSTEM_ROLES.accounting.permissions.join(' '),
      'u-r3',
    );
    const r = await resolve(s.id, l0, resolver).expect(200);
    expect(r.body).toMatchObject({ status: 'DRAFT', dispute: { disputed: 1 } });
    // อีกบรรทัด: นำออก (แก้รายการ) → ไม่มีโต้แย้งค้าง → อนุมัติร่างตรงได้
    await api(app, accounting)
      .post(`/v1/settlements/${s.id}/lines/${l1}/remove`)
      .set('If-Match', `"${await version(s.id)}"`)
      .send({ reason: 'รถร่วมโต้แย้งเที่ยวซ้ำ นำออก' })
      .expect(200);
    expect((await get(s.id)).dispute.disputed).toBe(0);
    await approve(s.id).expect(200);
  });

  it('หน้าเทียบ planned / executed / claimed + POD · ยอดตัดเมื่อไม่มีสิทธิ์ราคาซื้อ · แยก tenant', async () => {
    await resetLinkWriteRate();
    const { s, token, trips } = await sent(1, '4500');
    const l0 = s.lines[0]!.id;
    await respond(token, l0, {
      response: 'DISPUTED',
      reason: 'ค่ารอไม่ตรง',
      claimedAmount: '5200',
    }).expect(201);
    const c = (await api(app, admin).get(`/v1/settlements/${s.id}/comparison`).expect(200)).body;
    expect(c).toMatchObject({ status: 'DISPUTED', round: 1, dispute: { disputed: 1 } });
    const fr = c.lines.find((l: { lineType: string }) => l.lineType === 'FREIGHT');
    expect(fr).toMatchObject({
      id: l0,
      status: 'DISPUTED',
      plannedSource: 'SUBCON_OFFER',
      buyPlannedAmount: '4500.00',
      buyExecutedAmount: '4500.00',
      buyClaimedAmount: '5200.00',
      buyClaimedDifference: '700.00',
      claim: { response: 'DISPUTED', reason: 'ค่ารอไม่ตรง' },
    });
    const de = c.lines.find((l: { lineType: string }) => l.lineType === 'DEDUCTION');
    expect(de).toMatchObject({
      status: 'OPEN',
      plannedSource: null,
      buyPlannedAmount: null,
      buyExecutedAmount: '-2000.00',
      buyClaimedAmount: null,
    });
    expect(c.trips).toHaveLength(1);
    expect(c.trips[0]).toMatchObject({ id: trips[0]!.id, podComplete: true });
    expect(c.trips[0].deliveryOrders[0]).toMatchObject({
      deliveryOrderId: encodeId('deliveryOrder', trips[0]!.doId),
      status: 'UNBILLED',
      podStatus: 'COMPLETE',
      passed: true,
    });
    // viewer (ไม่มี prices.buy:read) เห็นโครงแต่ไม่เห็นยอด
    const cv = (await api(app, viewer).get(`/v1/settlements/${s.id}/comparison`).expect(200)).body;
    expect(JSON.stringify(cv)).not.toMatch(/buy[A-Z]/);
    expect(cv.lines[0].status).toBe('DISPUTED');
    await api(app, other).get(`/v1/settlements/${s.id}/comparison`).expect(404);
    await api(app, planner).get(`/v1/settlements/${s.id}/comparison`).expect(403);
  });

  it('กติการะดับ DB (role แอป): การตัดสินของบริษัทเพิ่มอย่างเดียว · ผู้บันทึกต้องเป็นคน · เคลียร์เฉพาะบรรทัดที่โต้แย้งค้าง · DISPUTED ต้องมีโต้แย้งค้าง · DISPUTED → APPROVED/CANCELLED ไม่ได้ · ตอบหลังเคลียร์ไม่ได้', async () => {
    await resetLinkWriteRate();
    const { s, token } = await sent(2);
    const sid = uuid('settlement', s.id);
    const [a, b] = [uuid('settlementLine', s.lines[0]!.id), uuid('settlementLine', s.lines[1]!.id)];
    const fails = (fn: (tx: Tx) => Promise<unknown>, re: RegExp) =>
      expect(run(fn)).rejects.toThrow(re);
    const base = { tenantId, settlementId: sid, round: 1, reason: 'เหตุผลทดสอบระดับฐานข้อมูล' };
    // SENT_TO_CARRIER ไม่มีโต้แย้ง → ตั้ง DISPUTED ตรงไม่ได้ · เคลียร์บรรทัดที่ไม่โต้แย้งไม่ได้
    await fails(
      (tx) => tx.carrierSettlement.update({ where: { id: sid }, data: { status: 'DISPUTED' } }),
      /carrier_settlement_dispute_state/,
    );
    await fails(
      (tx) =>
        tx.settlementLineDispute.create({
          data: { ...base, lineId: a, action: 'RESOLVED', createdBy: 'u-acc' },
        }),
      /settlement_line_dispute_state/,
    );
    // ผู้บันทึกเป็นลิงก์ / เหตุผลสั้น / รอบผิด
    await fails(
      (tx) =>
        tx.settlementLineDispute.create({
          data: { ...base, lineId: a, action: 'DISPUTED', createdBy: 'link:x' },
        }),
      /settlement_line_dispute_actor_check/,
    );
    await fails(
      (tx) =>
        tx.settlementLineDispute.create({
          data: { ...base, lineId: a, action: 'DISPUTED', createdBy: 'u-acc', reason: 'สั้น' },
        }),
      /settlement_line_dispute_reason_check/,
    );
    await fails(
      (tx) =>
        tx.settlementLineDispute.create({
          data: { ...base, round: 2, lineId: a, action: 'DISPUTED', createdBy: 'u-acc' },
        }),
      /settlement_line_dispute_state/,
    );
    await respond(token, s.lines[0]!.id, { response: 'DISPUTED', reason: 'ไม่ตรง' }).expect(201);
    expect((await get(s.id)).status).toBe('DISPUTED');
    // DISPUTED → APPROVED / CANCELLED / SENT (ยังมีโต้แย้ง) ไม่ได้ · หัวใบแข็ง
    await fails(
      (tx) =>
        tx.carrierSettlement.update({
          where: { id: sid },
          data: {
            status: 'APPROVED',
            settlementNo: 'SA-9999-0301',
            approvedAt: new Date(),
            approvedBy: 'u-appr',
          },
        }),
      // trigger SoD/dispute ทำงานก่อน trigger ทางเปลี่ยนสถานะ (ชื่อเรียงตามตัวอักษร) — ทั้งคู่ปฏิเสธ
      /carrier_settlement_disputed|carrier_settlement_transition/,
    );
    await fails(
      (tx) => tx.carrierSettlement.update({ where: { id: sid }, data: { status: 'CANCELLED' } }),
      /carrier_settlement_transition/,
    );
    await fails(
      (tx) =>
        tx.carrierSettlement.update({ where: { id: sid }, data: { status: 'SENT_TO_CARRIER' } }),
      /carrier_settlement_dispute_state/,
    );
    await fails(
      (tx) =>
        tx.carrierSettlement.update({ where: { id: sid }, data: { note: 'แก้ระหว่างโต้แย้ง' } }),
      /carrier_settlement_sent_frozen/,
    );
    // เพิ่มอย่างเดียว
    const id = randomUUID();
    await run((tx) =>
      tx.settlementLineDispute.create({
        data: { ...base, id, lineId: b, action: 'DISPUTED', createdBy: 'u-acc' },
      }),
    );
    await fails(
      (tx) =>
        tx.settlementLineDispute.update({ where: { id }, data: { reason: 'แก้เหตุผลย้อนหลัง' } }),
      /settlement_line_dispute_append_only|permission denied/,
    );
    await fails(
      (tx) => tx.settlementLineDispute.delete({ where: { id } }),
      /settlement_line_dispute_append_only|permission denied/,
    );
    // เคลียร์ → รถร่วมตอบบรรทัดนั้นในรอบนี้ไม่ได้ (DB)
    await run((tx) =>
      tx.settlementLineDispute.create({
        data: { ...base, lineId: a, action: 'RESOLVED', createdBy: 'u-acc' },
      }),
    );
    const rv = await db.settlementLineReview.findFirstOrThrow({ where: { settlementId: sid } });
    await fails(
      (tx) =>
        tx.settlementLineReview.create({
          data: {
            tenantId,
            settlementId: sid,
            lineId: a,
            round: 1,
            response: 'ACCEPTED',
            linkId: rv.linkId,
            createdBy: `link:${rv.linkId}`,
          },
        }),
      /settlement_line_review_resolved/,
    );
    // ยอดที่เรียก: เฉพาะโต้แย้ง ≥ 0
    await fails(
      (tx) =>
        tx.settlementLineReview.create({
          data: {
            tenantId,
            settlementId: sid,
            lineId: b,
            round: 1,
            response: 'ACCEPTED',
            claimedAmount: '10.00',
            linkId: rv.linkId,
            createdBy: `link:${rv.linkId}`,
          },
        }),
      /settlement_line_review_claimed_check/,
    );
    // ธงของบัญชีที่บรรทัด b ยังค้าง → อนุมัติ (ข้ามบริการ) ไม่ได้แม้เปลี่ยนเป็น SENT ไม่ได้
    expect((await approve(s.id).expect(409)).body).toMatchObject({
      code: 'settlement_disputed',
      disputedCount: 1,
    });
  });

  it('review M1/M2: เคลียร์แค่ธงภายในของบัญชี → รถร่วมยังตอบได้ ไม่เห็นเหตุผล · ลิงก์ไม่แสดง DISPUTED จากธงภายใน', async () => {
    await resetLinkWriteRate();
    const { s, token } = await sent(2);
    const [l0, l1] = [s.lines[0]!.id, s.lines[1]!.id];
    await flag(s.id, l0).expect(200);
    expect((await get(s.id)).status).toBe('DISPUTED');
    // M2: ลิงก์เห็นสถานะรอตรวจ (ธงภายในไม่เปิดเผย)
    let v = (await view(token).expect(200)).body;
    expect(v.status).toBe('SENT_TO_CARRIER');
    expect(JSON.stringify(v)).not.toContain(DISPUTE.reason);
    // ตอบบรรทัดอื่นระหว่างนั้น — ผลตอบก็ไม่บอก DISPUTED
    const a = await respond(token, l1, { response: 'ACCEPTED' }).expect(201);
    expect(a.body.status).toBe('SENT_TO_CARRIER');
    // M1: เคลียร์ธงภายใน → รถร่วมยังตอบบรรทัดนั้นได้ และไม่เห็นเหตุผลการเคลียร์
    const resolver = await tokenFor(
      tenantId,
      SYSTEM_ROLES.accounting.permissions.join(' '),
      'u-r4',
    );
    await resolve(s.id, l0, resolver).expect(200);
    v = (await view(token).expect(200)).body;
    expect(v.lines[0]).toMatchObject({ resolution: null, canRespond: true });
    expect(JSON.stringify(v)).not.toContain(RESOLVE.reason);
    const d = await respond(token, l0, { response: 'DISPUTED', reason: 'ค่ารอไม่ตรง' }).expect(201);
    expect(d.body.status).toBe('DISPUTED');
    expect((await view(token).expect(200)).body.status).toBe('DISPUTED');
    expect((await get(s.id)).lines[0]!.status).toBe('DISPUTED');
  });

  it('review L3/L5: ใบเก่า SENT_TO_CARRIER ที่มีโต้แย้งค้าง (ก่อน T06) เคลียร์ได้ · ผู้เคลียร์ (จากตาราง) อนุมัติไม่ได้ใน DB แม้ไม่อยู่ใน preparers', async () => {
    await resetLinkWriteRate();
    const { s, token } = await sent(1);
    const sid = uuid('settlement', s.id);
    const lid = uuid('settlementLine', s.lines[0]!.id);
    const link = await db.magicLink.findFirstOrThrow({
      where: { entityId: sid, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    // จำลองข้อมูลก่อน T06: คำตอบโต้แย้งโดยไม่ปรับหัวใบ
    await run((tx) =>
      tx.settlementLineReview.create({
        data: {
          tenantId,
          settlementId: sid,
          lineId: lid,
          round: 1,
          response: 'DISPUTED',
          reason: 'ข้อมูลเก่า',
          linkId: link.id,
          createdBy: `link:${link.id}`,
        },
      }),
    );
    expect((await get(s.id)).status).toBe('SENT_TO_CARRIER');
    expect((await approve(s.id).expect(409)).body.code).toBe('settlement_disputed');
    const resolver = await tokenFor(
      tenantId,
      SYSTEM_ROLES.accounting.permissions.join(' '),
      'u-r5',
    );
    const r = await resolve(s.id, s.lines[0]!.id, resolver).expect(200);
    expect(r.body).toMatchObject({ status: 'SENT_TO_CARRIER', dispute: { disputed: 0 } });
    expect((await view(token).expect(200)).body.lines[0]).toMatchObject({
      resolution: { reason: RESOLVE.reason },
      canRespond: false,
    });
    // L5: ผู้เคลียร์อยู่ใน settlement_line_dispute — DB ปฏิเสธเป็นผู้อนุมัติ (แม้ preparers ไม่มีชื่อ เช่น บันทึกตรง)
    await run((tx) =>
      tx.settlementLineDispute.create({
        data: {
          tenantId,
          settlementId: sid,
          lineId: lid,
          round: 1,
          action: 'DISPUTED',
          reason: 'ธงภายในเพื่อทดสอบผู้เคลียร์',
          createdBy: 'u-acc',
        },
      }),
    );
    await run((tx) =>
      tx.settlementLineDispute.create({
        data: {
          tenantId,
          settlementId: sid,
          lineId: lid,
          round: 1,
          action: 'RESOLVED',
          reason: 'เคลียร์ตรงในฐานข้อมูลเพื่อทดสอบ',
          createdBy: 'u-dbres',
        },
      }),
    );
    await expect(
      run((tx) =>
        tx.carrierSettlement.update({
          where: { id: sid },
          data: {
            status: 'APPROVED',
            settlementNo: 'SA-9999-0401',
            approvedAt: new Date(),
            approvedBy: 'u-dbres',
          },
        }),
      ),
    ).rejects.toThrow(/carrier_settlement_sod/);
    await approve(s.id).expect(200);
  });

  it('review L6 concurrency: รถร่วมตอบ ∥ บริษัทเคลียร์ และ รถร่วมโต้แย้ง ∥ อนุมัติ — สำเร็จได้ทางเดียว สถานะสอดคล้อง', async () => {
    await resetLinkWriteRate();
    // (ก) respond ACCEPTED ∥ resolve บรรทัดเดียวกันที่รถร่วมโต้แย้งไว้
    const A = await sent(1);
    const a0 = A.s.lines[0]!.id;
    await respond(A.token, a0, { response: 'DISPUTED', reason: 'ค่ารอไม่ตรง' }).expect(201);
    const v = await version(A.s.id);
    const [rr, rs] = await Promise.all([
      respond(A.token, a0, { response: 'ACCEPTED' }),
      api(app, accounting)
        .post(`/v1/settlements/${A.s.id}/lines/${a0}/resolve`)
        .set('If-Match', `"${v}"`)
        .send(RESOLVE),
    ]);
    const ok1 = [rr.status === 201, rs.status === 200].filter(Boolean).length;
    expect(ok1, `${rr.status} ${rs.status}`).toBe(1);
    expect([409, 412]).toContain(rr.status === 201 ? rs.status : rr.status);
    const ga = await get(A.s.id);
    expect(ga.status).toBe('SENT_TO_CARRIER');
    expect(ga.dispute.disputed).toBe(0);

    // (ข) respond DISPUTED ∥ approve (ใบไม่มีโต้แย้ง)
    const B = await sent(1);
    const b0 = B.s.lines[0]!.id;
    const vb = await version(B.s.id);
    const [dr, ap] = await Promise.all([
      respond(B.token, b0, { response: 'DISPUTED', reason: 'ยอดไม่ตรง' }),
      api(app, approver)
        .post(`/v1/settlements/${B.s.id}/approve`)
        .set('If-Match', `"${vb}"`)
        .send(APPROVE),
    ]);
    const gb = await get(B.s.id);
    if (ap.status === 200) {
      expect(dr.status).toBe(409);
      expect(gb.status).toBe('APPROVED');
    } else {
      expect(dr.status).toBe(201);
      expect([409, 412]).toContain(ap.status);
      expect(gb.status).toBe('DISPUTED');
    }
    // DB สอดคล้อง: ใบที่อนุมัติไม่มีโต้แย้งค้าง
    const [n] = await db.$queryRaw<{ n: number }[]>`
      SELECT tms_settlement_disputed_count(${uuid('settlement', B.s.id)}::uuid, 1) AS n`;
    if (gb.status === 'APPROVED') expect(Number(n!.n)).toBe(0);
  });
});
