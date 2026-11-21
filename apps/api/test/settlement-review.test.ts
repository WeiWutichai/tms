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
 * ST6-T05 รถร่วมตรวจใบสำคัญจ่ายผ่านลิงก์ — เกณฑ์ตรวจรับ: รถร่วมเปิดลิงก์เห็นเฉพาะเที่ยว/ราคาซื้อของตัวเอง · กดโต้แย้งแล้วรายการติดธง
 * + โต้แย้งบล็อกอนุมัติ · เรียกกลับ/ส่งรอบใหม่ · รูปประกอบ · ค่าตั้งบังคับให้ตรวจ · SoD (ผู้ส่ง = ผู้เตรียม, ลิงก์อนุมัติไม่ได้) · DB guard
 */
describe('settlement carrier review (ST6-T05)', () => {
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

  it('เกณฑ์ตรวจรับ: ส่งลิงก์ → รถร่วมเห็นเฉพาะเที่ยว/ราคาซื้อของตัวเอง → กดโต้แย้ง = รายการติดธง → อนุมัติไม่ได้ (409)', async () => {
    await resetLinkWriteRate();
    const { s, r, token } = await sent(2, '4500');
    // ใบของรถร่วมรายอื่น (อยู่ในบริษัทเดียวกัน) ต้องไม่โผล่ในลิงก์นี้
    const other = await sent(1, '7777');
    expect(r.headers.etag).toBe('"2"');
    expect(r.body.settlement).toMatchObject({
      status: 'SENT_TO_CARRIER',
      sentBy: 'u-acc',
      carrierReview: { round: 1, accepted: 0, disputed: 0, pending: 3 },
    });
    expect(r.body.link.url).toMatch(/\/link\/settlement\/ml1\./);
    const v = (await view(token).expect(200)).body;
    expect(r.headers['cache-control'] ?? '').not.toContain('public');
    expect(v).toMatchObject({
      status: 'SENT_TO_CARRIER',
      settlementNo: null,
      tripCount: 2,
      grossAmount: '9000.00',
      deductionAmount: '2000.00',
      netAmount: '7000.00',
      canRespond: true,
    });
    expect(v.carrierName).toMatch(/รถร่วมจ่าย/);
    const lines = v.lines as {
      id: string;
      lineType: string;
      amount: string;
      tripNo: string | null;
      origin: string | null;
      review: unknown;
    }[];
    expect(lines.map((l) => [l.lineType, l.amount])).toEqual([
      ['FREIGHT', '4500.00'],
      ['FREIGHT', '4500.00'],
      ['DEDUCTION', '-2000.00'],
    ]);
    expect(lines.map((l) => l.id)).toEqual(s.lines.map((l) => l.id));
    expect(lines[0]!.tripNo).toBeTruthy();
    expect(lines[0]!.origin).toMatch(/จุดรับส่ง/);
    // ไม่มีราคาซื้อของรถร่วมอื่น/ราคาขาย/ข้อมูลภายใน
    const raw = JSON.stringify(v);
    expect(raw).not.toContain('7777');
    expect(raw).not.toMatch(/sell|customer|createdBy|u-acc/i);
    // ลิงก์ของใบหนึ่งตอบบรรทัดของอีกใบไม่ได้ (404)
    await respond(token, (other.s.lines[0] as Line).id, { response: 'ACCEPTED' }).expect(404);

    // โต้แย้งบรรทัดแรกพร้อมเหตุผล → ติดธง · ยอมรับบรรทัดอื่น
    const d = await respond(token, lines[0]!.id, {
      response: 'DISPUTED',
      reason: 'ค่ารอไม่ตรง รอ 3 ชม.',
    }).expect(201);
    expect(d.body.line.review).toMatchObject({
      response: 'DISPUTED',
      reason: 'ค่ารอไม่ตรง รอ 3 ชม.',
      photoCount: 0,
    });
    await respond(token, lines[1]!.id, { response: 'ACCEPTED' }).expect(201);
    await respond(token, lines[2]!.id, { response: 'ACCEPTED' }).expect(201);
    const g = (await api(app, admin).get(`/v1/settlements/${s.id}`).expect(200)).body;
    expect(g.carrierReview).toEqual({ round: 1, accepted: 2, disputed: 1, pending: 0 });
    expect(g.lines[0].carrierReview).toMatchObject({
      response: 'DISPUTED',
      reason: 'ค่ารอไม่ตรง รอ 3 ชม.',
      round: 1,
    });
    // ST6-T06: โต้แย้ง → หัวใบ DISPUTED (version +1) · ยอมรับอย่างเดียวไม่เปลี่ยน version
    expect(g.status).toBe('DISPUTED');
    expect(g.version).toBe(3);
    const audit = await db.auditLog.findFirstOrThrow({
      where: { entityId: uuid('settlement', s.id), action: 'settlement.line_disputed' },
    });
    expect(audit.actorId).toMatch(/^link:/);
    expect(audit.reason).toBe('ค่ารอไม่ตรง รอ 3 ชม.');

    const blocked = await approve(s.id).expect(409);
    expect(blocked.body).toMatchObject({ code: 'settlement_disputed', disputedCount: 1 });
    // รถร่วมเปลี่ยนใจ (ยอมรับ) → ธงหลุด → อนุมัติได้ (ผู้อนุมัติไม่ใช่ผู้สร้าง/ผู้ส่ง)
    await respond(token, lines[0]!.id, { response: 'ACCEPTED' }).expect(201);
    const ok = await approve(s.id).expect(200);
    expect(ok.body).toMatchObject({ status: 'APPROVED', approvedBy: 'u-appr' });
    expect(ok.body.settlementNo).toMatch(/^SA-/);
    // ประวัติคำตอบเก็บครบ (เพิ่มอย่างเดียว)
    expect(
      await db.settlementLineReview.count({ where: { settlementId: uuid('settlement', s.id) } }),
    ).toBe(4);
    // หลังอนุมัติ: ลิงก์ดูได้ (ตอบไม่ได้)
    const after = (await view(token).expect(200)).body;
    expect(after).toMatchObject({ status: 'APPROVED', canRespond: false });
    expect(after.settlementNo).toBe(ok.body.settlementNo);
    expect(
      (await respond(token, lines[0]!.id, { response: 'DISPUTED', reason: 'ไม่ตรง' }).expect(409))
        .body.code,
    ).toBe('invalid_state_transition');
  });

  it('เรียกกลับ (เหตุผล + If-Match) → DRAFT แก้ได้ · ลิงก์เดิม 404 · ส่งใหม่ = รอบใหม่ (ธงเดิมไม่นับ) · ระหว่างส่งแก้/ยกเลิกไม่ได้', async () => {
    await resetLinkWriteRate();
    const { s, token } = await sent(2);
    // ระหว่างรอรถร่วมตรวจ: แก้หัว/เพิ่ม/นำบรรทัดออก/ยกเลิก/ส่งซ้ำ = 409
    await api(app, accounting).patch(`/v1/settlements/${s.id}`).send({ note: 'x' }).expect(409);
    await api(app, accounting)
      .post(`/v1/settlements/${s.id}/lines`)
      .send({ deductions: [FINE] })
      .expect(409);
    await api(app, accounting)
      .post(`/v1/settlements/${s.id}/lines/${s.lines[0]!.id}/remove`)
      .send({ reason: 'นำออกระหว่างรอตรวจ' })
      .expect(409);
    await api(app, accounting)
      .post(`/v1/settlements/${s.id}/cancel`)
      .send({ reason: 'ยกเลิกระหว่างรอตรวจ' })
      .expect(409);
    await send(s.id).expect(409);
    // QA L1: If-Match บังคับ (ไม่ส่ง → 422 if_match_required)
    const noIfMatch = await api(app, accounting)
      .post(`/v1/settlements/${s.id}/recall`)
      .send(RECALL)
      .expect(422);
    expect(noIfMatch.body.errors[0].code).toBe('if_match_required');
    await respond(token, s.lines[1]!.id, {
      response: 'DISPUTED',
      reason: 'เที่ยวนี้วิ่งไม่ครบ',
    }).expect(201);

    // เหตุผลสั้น → 422 · If-Match ไม่ตรง → 412
    await api(app, accounting)
      .post(`/v1/settlements/${s.id}/recall`)
      .send({ reason: 'สั้น' })
      .expect(422);
    await api(app, accounting)
      .post(`/v1/settlements/${s.id}/recall`)
      .set('If-Match', '"1"')
      .send(RECALL)
      .expect(412);
    const rc = await recall(s.id).expect(200);
    expect(rc.body).toMatchObject({
      status: 'DRAFT',
      carrierReview: { round: 1, disputed: 1 },
    });
    await view(token).expect(404);
    const audit = await db.auditLog.findFirstOrThrow({
      where: { entityId: uuid('settlement', s.id), action: 'settlement.recalled' },
    });
    expect(audit.reason).toBe(RECALL.reason);
    // แก้ร่าง: นำบรรทัดที่โต้แย้งออก แล้วส่งรอบใหม่
    await api(app, accounting)
      .post(`/v1/settlements/${s.id}/lines/${s.lines[1]!.id}/remove`)
      .set('If-Match', `"${await version(s.id)}"`)
      .send({ reason: 'รถร่วมโต้แย้ง ยกไปงวดหน้า' })
      .expect(200);
    const r2 = await send(s.id).expect(200);
    expect(r2.body.settlement.carrierReview).toEqual({
      round: 2,
      accepted: 0,
      disputed: 0,
      pending: 2,
    });
    const t2 = tokenOf(r2.body.link.url as string);
    expect((await view(t2).expect(200)).body.lines).toHaveLength(2);
    // บรรทัดที่นำออกแล้ว → 404
    await respond(t2, s.lines[1]!.id, { response: 'ACCEPTED' }).expect(404);
  });

  it('รูปประกอบ: จอง + อัปโหลดผ่านลิงก์ → โต้แย้งด้วยรูปอย่างเดียวได้ · รูปของบรรทัดอื่น/ยังไม่อัปโหลด/ยอมรับพร้อมรูป/ไม่มีเหตุผลและรูป → 422', async () => {
    await resetLinkWriteRate();
    const { s, token } = await sent(2);
    const [l0, l1] = [s.lines[0]!.id, s.lines[1]!.id];
    const p0 = await photo(token, l0);
    const p1 = await photo(token, l1);
    const pending = (
      await pub()
        .post(`/v1/public/settlements/${token}/files`)
        .send({ lineId: l0, mime: 'image/png', bytes: PNG.length })
        .expect(201)
    ).body.id as string;
    const bad = async (body: object, field: string) => {
      const r = await respond(token, l0, body).expect(422);
      expect((r.body.errors as { field: string }[]).map((e) => e.field)).toContain(field);
    };
    await bad({ response: 'DISPUTED' }, 'reason');
    await bad({ response: 'DISPUTED', reason: '   ' }, 'reason');
    await bad({ response: 'DISPUTED', photoDocumentIds: [p1] }, 'photoDocumentIds.0');
    await bad({ response: 'DISPUTED', photoDocumentIds: [pending] }, 'photoDocumentIds.0');
    await bad({ response: 'DISPUTED', photoDocumentIds: [p0, p0] }, 'photoDocumentIds.1');
    await bad({ response: 'ACCEPTED', photoDocumentIds: [p0] }, 'photoDocumentIds');
    await respond(token, l0, { response: 'MAYBE' }).expect(422);
    // ชนิดไฟล์ไม่ใช่รูป → 422 · บรรทัดของบริษัท/ใบอื่น → 404
    await pub()
      .post(`/v1/public/settlements/${token}/files`)
      .send({ lineId: l0, mime: 'application/pdf', bytes: 10 })
      .expect(422);
    await pub()
      .post(`/v1/public/settlements/${token}/files`)
      .send({ lineId: `stln_${'0'.repeat(32)}`, mime: 'image/png', bytes: 10 })
      .expect(404);
    const r = await respond(token, l0, { response: 'DISPUTED', photoDocumentIds: [p0] }).expect(
      201,
    );
    expect(r.body.line.review).toMatchObject({ response: 'DISPUTED', reason: null, photoCount: 1 });
    // บริษัทเปิดรูปได้ผ่าน /v1/documents
    const g = (await api(app, admin).get(`/v1/settlements/${s.id}`).expect(200)).body;
    expect(g.lines[0].carrierReview.photoIds).toEqual([p0]);
    await api(app, admin).get(`/v1/documents/${p0}`).expect(200);
    // ลิงก์ผิดรูปแบบ/ปลอม → 404
    await view('ml1.' + '0'.repeat(32) + '.1.' + 'x'.repeat(43)).expect(404);
  });

  it('ค่าตั้ง settlement.carrierReviewRequired: เปิด → อนุมัติร่างตรง 409 settlement_review_required · ปิดจากที่เปิด = ต้อง step-up', async () => {
    const { C, trips } = await setup(1);
    const d = (await create({ carrierId: C.id, tripIds: [trips[0]!.id] }, accounting).expect(201))
      .body;
    await api(app, admin)
      .patch('/v1/settings')
      .send({ values: { 'settlement.carrierReviewRequired': true } })
      .expect(200);
    expect((await approve(d.id).expect(409)).body.code).toBe('settlement_review_required');
    // ส่งตรวจ → รถร่วมยอมรับ → อนุมัติได้
    const r = await send(d.id).expect(200);
    const t = tokenOf(r.body.link.url as string);
    for (const l of r.body.settlement.lines as Line[])
      await respond(t, l.id, { response: 'ACCEPTED' }).expect(201);
    await approve(d.id).expect(200);
    const off = await api(app, admin)
      .patch('/v1/settings')
      .send({ values: { 'settlement.carrierReviewRequired': false } });
    expect(off.status).toBe(403);
    expect(off.body.code).toBe('step_up_required');
    await db.tenantSetting.deleteMany({
      where: { tenantId, key: 'settlement.carrierReviewRequired' },
    });
  });

  it('SoD: ผู้ส่งให้รถร่วมตรวจอนุมัติไม่ได้ (403) · ยังไม่ตอบครบก็อนุมัติได้ (ไม่มีโต้แย้ง) · ส่งตรวจต้องมีเที่ยว/ยอดไม่ติดลบ · สิทธิ์ · แยก tenant', async () => {
    await resetLinkWriteRate();
    const { C, trips } = await setup(3, '1000');
    // ผู้อนุมัติเป็นผู้ส่ง (ไม่ได้สร้าง) → อนุมัติไม่ได้
    const s = (await create({ carrierId: C.id, tripIds: [trips[0]!.id] }, accounting).expect(201))
      .body;
    await send(s.id, approver).expect(403); // approver ไม่มี settlements:create
    const owner2 = await tokenFor(tenantId, '*', 'u-owner2');
    await send(s.id, owner2).expect(200);
    const self = await approve(s.id, owner2).expect(403);
    expect(self.body.code).toBe('settlement_self_approval');
    await approve(s.id).expect(200);
    // ยอดสุทธิติดลบ → ส่งไม่ได้
    const neg = (
      await create(
        {
          carrierId: C.id,
          tripIds: [trips[1]!.id],
          deductions: [{ ...ADV, amount: '-5000.00' }],
        },
        accounting,
      ).expect(201)
    ).body;
    expect((await send(neg.id).expect(409)).body.code).toBe('settlement_net_negative');
    // QA L1: ส่งตรวจต้องมี If-Match
    const noIfMatch = await api(app, accounting)
      .post(`/v1/settlements/${neg.id}/send-to-carrier`)
      .expect(422);
    expect(noIfMatch.body.errors[0].code).toBe('if_match_required');
    // viewer ส่งไม่ได้ · บริษัทอื่น 404 · ออกลิงก์ใหม่เฉพาะใบที่รอตรวจ
    const s3 = (await create({ carrierId: C.id, tripIds: [trips[2]!.id] }, accounting).expect(201))
      .body;
    await send(s3.id, viewer).expect(403);
    await send(s3.id, other).expect(404);
    await api(app, accounting).post(`/v1/settlements/${s3.id}/review-link`).expect(409);
    const r = await send(s3.id).expect(200);
    const t1 = tokenOf(r.body.link.url as string);
    const re = await api(app, accounting).post(`/v1/settlements/${s3.id}/review-link`).expect(201);
    await view(t1).expect(404);
    await view(tokenOf(re.body.url as string)).expect(200);
    await api(app, other).post(`/v1/settlements/${s3.id}/review-link`).expect(404);
    await api(app, other).post(`/v1/settlements/${s3.id}/recall`).send(RECALL).expect(404);
  });

  it('ส่งลิงก์ทาง SMS (ST3-T21) ได้เฉพาะใบที่รอรถร่วมตรวจ — ผู้รับ = รถร่วมของใบ', async () => {
    await db.messagingSetting.upsert({
      where: { tenantId },
      create: { tenantId, lineEnabled: true, smsEnabled: true },
      update: { smsEnabled: true },
    });
    const { C, trips } = await setup(1);
    await db.carrier.update({
      where: { id: uuid('carrier', C.id) },
      data: { phone: '0812345678' },
    });
    const s = (await create({ carrierId: C.id, tripIds: [trips[0]!.id] }, accounting).expect(201))
      .body;
    const r = await send(s.id).expect(200);
    const m = await api(app, accounting)
      .post('/v1/messages/send-link')
      .set('Idempotency-Key', `stl-${s.id}`)
      .send({ channel: 'sms', url: r.body.link.url })
      .expect(202);
    expect(m.body).toMatchObject({
      channel: 'sms',
      template: 'settlement_review_link',
      status: 'queued',
      carrierId: C.id,
    });
    await recall(s.id).expect(200);
    // เรียกกลับแล้ว = ลิงก์ถูกเพิกถอน → ส่งไม่ได้
    await api(app, accounting)
      .post('/v1/messages/send-link')
      .set('Idempotency-Key', `stl2-${s.id}`)
      .send({ channel: 'sms', url: r.body.link.url })
      .expect(422);
  });

  it('กติการะดับ DB (role แอป): คำตอบเพิ่มอย่างเดียว · ตอบได้เฉพาะใบรอตรวจรอบปัจจุบัน · ผู้ตอบ = ลิงก์ · ลิงก์อนุมัติไม่ได้ · SENT → CANCELLED ไม่ได้', async () => {
    await resetLinkWriteRate();
    const { s, token } = await sent(1);
    const sid = uuid('settlement', s.id);
    const lid = uuid('settlementLine', s.lines[0]!.id);
    await respond(token, s.lines[0]!.id, { response: 'DISPUTED', reason: 'ไม่ตรง' }).expect(201);
    const rv = await db.settlementLineReview.findFirstOrThrow({ where: { settlementId: sid } });
    const fails = (fn: (tx: Tx) => Promise<unknown>, re: RegExp) =>
      expect(run(fn)).rejects.toThrow(re);
    await fails(
      (tx) => tx.settlementLineReview.update({ where: { id: rv.id }, data: { reason: 'แก้' } }),
      /settlement_line_review_append_only|permission denied/,
    );
    await fails(
      (tx) => tx.settlementLineReview.delete({ where: { id: rv.id } }),
      /settlement_line_review_append_only|permission denied/,
    );
    const base = {
      tenantId,
      settlementId: sid,
      lineId: lid,
      response: 'ACCEPTED',
      linkId: rv.linkId,
      createdBy: `link:${rv.linkId}`,
    };
    // รอบเก่า / ผู้ตอบไม่ใช่ลิงก์ / โต้แย้งไม่มีเหตุผล
    await fails(
      (tx) => tx.settlementLineReview.create({ data: { ...base, round: 9 } }),
      /settlement_line_review_state/,
    );
    await fails(
      (tx) => tx.settlementLineReview.create({ data: { ...base, round: 1, createdBy: 'u-acc' } }),
      /settlement_line_review_actor_check/,
    );
    await fails(
      (tx) => tx.settlementLineReview.create({ data: { ...base, round: 1, response: 'DISPUTED' } }),
      /settlement_line_review_dispute_check/,
    );
    // ลิงก์ (actor สังเคราะห์) อนุมัติไม่ได้ · SENT → CANCELLED ไม่ได้
    await run((tx) =>
      tx.settlementLineReview.create({ data: { ...base, round: 1, id: randomUUID() } }),
    );
    await fails(
      (tx) =>
        tx.carrierSettlement.update({
          where: { id: sid },
          data: {
            status: 'APPROVED',
            settlementNo: 'SA-9999-0101',
            approvedAt: new Date(),
            approvedBy: `link:${rv.linkId}`,
          },
        }),
      /carrier_settlement_sod/,
    );
    await fails(
      (tx) => tx.carrierSettlement.update({ where: { id: sid }, data: { status: 'CANCELLED' } }),
      /carrier_settlement_transition/,
    );
    await fails(
      (tx) => tx.carrierSettlement.update({ where: { id: sid }, data: { reviewRound: 5 } }),
      /carrier_settlement_sent_frozen|carrier_settlement_review_round/,
    );
    // บรรทัดของใบที่ส่งตรวจแข็ง
    await fails(
      (tx) => tx.settlementLine.update({ where: { id: lid }, data: { description: 'แก้' } }),
      /settlement_line_frozen/,
    );
  });
  it('review M1: เรียกกลับแล้วอนุมัติร่างตรงไม่ข้ามการโต้แย้ง (409) · ผู้เรียกกลับอนุมัติไม่ได้ · นำบรรทัดที่โต้แย้งออก = เคลียร์', async () => {
    await resetLinkWriteRate();
    const { s, token } = await sent(2);
    await respond(token, s.lines[0]!.id, { response: 'DISPUTED', reason: 'ค่ารอไม่ตรง' }).expect(
      201,
    );
    const owner2 = await tokenFor(tenantId, '*', 'u-recall');
    await recall(s.id, owner2).expect(200);
    const blocked = await approve(s.id).expect(409);
    expect(blocked.body).toMatchObject({ code: 'settlement_disputed', disputedCount: 1 });
    // ผู้เรียกกลับ = ผู้เตรียมใบ
    expect((await approve(s.id, owner2).expect(403)).body.code).toBe('settlement_self_approval');
    // DB: ข้ามบริการไป APPROVED ตรงไม่ได้
    await expect(
      run((tx) =>
        tx.carrierSettlement.update({
          where: { id: uuid('settlement', s.id) },
          data: {
            status: 'APPROVED',
            settlementNo: 'SA-9999-0201',
            approvedAt: new Date(),
            approvedBy: 'u-appr',
          },
        }),
      ),
    ).rejects.toThrow(/carrier_settlement_disputed/);
    await api(app, accounting)
      .post(`/v1/settlements/${s.id}/lines/${s.lines[0]!.id}/remove`)
      .set('If-Match', `"${await version(s.id)}"`)
      .send({ reason: 'รถร่วมโต้แย้ง ยกไปงวดหน้า' })
      .expect(200);
    await approve(s.id).expect(200);
  });

  it('review L3: ผู้ส่งรอบก่อน / ผู้ออกลิงก์ใหม่ ยังนับเป็นผู้เตรียม (ไม่ถูกเขียนทับ) · หัวใบแข็งระหว่างรอตรวจ (DB)', async () => {
    const { C, trips } = await setup(1);
    const d = (await create({ carrierId: C.id, tripIds: [trips[0]!.id] }, accounting).expect(201))
      .body;
    const first = await tokenFor(tenantId, '*', 'u-first-sender');
    const reissuer = await tokenFor(tenantId, '*', 'u-reissuer');
    await send(d.id, first).expect(200);
    await recall(d.id).expect(200);
    await send(d.id).expect(200); // ส่งรอบ 2 โดยผู้สร้าง — sent_by เปลี่ยน แต่ผู้ส่งรอบแรกยังอยู่
    await api(app, reissuer).post(`/v1/settlements/${d.id}/review-link`).expect(201);
    expect((await approve(d.id, first).expect(403)).body.code).toBe('settlement_self_approval');
    expect((await approve(d.id, reissuer).expect(403)).body.code).toBe('settlement_self_approval');
    const sid = uuid('settlement', d.id);
    const fails = (fn: (tx: Tx) => Promise<unknown>, re: RegExp) =>
      expect(run(fn)).rejects.toThrow(re);
    await fails(
      (tx) => tx.carrierSettlement.update({ where: { id: sid }, data: { note: 'แก้ระหว่างรอ' } }),
      /carrier_settlement_sent_frozen/,
    );
    await fails(
      (tx) => tx.carrierSettlement.update({ where: { id: sid }, data: { preparers: [] } }),
      /carrier_settlement_preparers/,
    );
    // DB: ผู้ส่งรอบแรกอนุมัติตรงไม่ได้
    await fails(
      (tx) =>
        tx.carrierSettlement.update({
          where: { id: sid },
          data: {
            status: 'APPROVED',
            settlementNo: 'SA-9999-0202',
            approvedAt: new Date(),
            approvedBy: 'u-first-sender',
          },
        }),
      /carrier_settlement_sod/,
    );
    await approve(d.id).expect(200);
  });

  it('ลิงก์หมดอายุ → 404 · รูปที่จองด้วยลิงก์เดิมใช้กับลิงก์ใหม่ไม่ได้ (422) · ลิงก์เดิมจอง/อัปโหลดไม่ได้หลังออกใหม่', async () => {
    await resetLinkWriteRate();
    const { s, token } = await sent(1);
    const lid = s.lines[0]!.id;
    const old = await photo(token, lid);
    const pending = (
      await pub()
        .post(`/v1/public/settlements/${token}/files`)
        .send({ lineId: lid, mime: 'image/png', bytes: PNG.length })
        .expect(201)
    ).body.uploadUrl as string;
    const re = await api(app, accounting).post(`/v1/settlements/${s.id}/review-link`).expect(201);
    const t2 = tokenOf(re.body.url as string);
    const r = await respond(t2, lid, { response: 'DISPUTED', photoDocumentIds: [old] }).expect(422);
    expect((r.body.errors as { field: string }[])[0]!.field).toBe('photoDocumentIds.0');
    await pub()
      .post(`/v1/public/settlements/${token}/files`)
      .send({ lineId: lid, mime: 'image/png', bytes: PNG.length })
      .expect(404);
    await pub()
      .put(pathOf(pending))
      .set('Content-Type', 'application/octet-stream')
      .send(PNG)
      .expect(404);
    // หมดอายุ: token ลายเซ็นถูกต้องแต่เวลาหมดอายุผ่านไปแล้ว (อายุในแถวแก้ไม่ได้ — trigger) → 404
    const expired = encodeLinkToken(
      tryDecodeId('magicLink', re.body.id as string)!,
      Math.floor(Date.now() / 1000) - 60,
    );
    await view(expired).expect(404);
    await respond(expired, lid, { response: 'ACCEPTED' }).expect(404);
    await view(t2).expect(200);
  });

  it('rate limit ต่อลิงก์: 30 คำขอเขียน/นาที แล้ว 429', async () => {
    await resetLinkWriteRate();
    const { s, token } = await sent(1);
    for (let i = 0; i < 30; i++)
      await respond(token, s.lines[0]!.id, { response: 'ACCEPTED' }).expect(201);
    const r = await respond(token, s.lines[0]!.id, { response: 'ACCEPTED' }).expect(429);
    expect(r.body.code).toBe('rate_limited');
    await resetLinkWriteRate();
  });

  it('ST6-T04 ลิงก์รถร่วม: "ใบจ่ายเงิน" (PDF) เฉพาะงวดที่จ่ายแล้ว — รอตรวจ/อนุมัติแล้ว 409 · จ่ายแล้ว 200 PDF · ลิงก์ผิด 404', async () => {
    await resetLinkWriteRate();
    const { s, r, token } = await sent(1, '3000');
    const pdf = (t: string) =>
      pub()
        .get(`/v1/public/settlements/${t}/pdf`)
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        });
    expect((await pdf(token)).status).toBe(409);
    for (const l of r.body.settlement.lines as Line[])
      await respond(token, l.id, { response: 'ACCEPTED' }).expect(201);
    await approve(s.id).expect(200);
    expect((await pdf(token)).status).toBe(409);
    await withVersion(s.id, (v) =>
      api(app, accounting)
        .post(`/v1/settlements/${s.id}/mark-paid`)
        .set('If-Match', `"${v}"`)
        .send({ paidDate: today, method: 'CASH' }),
    ).expect(200);
    // review M1: ใบ PAID render ครั้งเดียวแล้วใช้ไฟล์ซ้ำ (คำขอพร้อมกันด้วย) · เพดาน 10 ครั้ง/นาที ต่อลิงก์ → 429
    await resetLinkWriteRate();
    const spy = vi.spyOn(app.get(PdfRenderer), 'pdf');
    const burst = await Promise.all(Array.from({ length: 5 }, () => pdf(token)));
    expect(burst.map((x) => x.status)).toEqual([200, 200, 200, 200, 200]);
    for (let k = 0; k < 4; k++) expect((await pdf(token)).status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    const ok = await pdf(token);
    expect(ok.status).toBe(200);
    expect((ok.body as Buffer).equals(burst[0]!.body as Buffer)).toBe(true);
    const limited = await pdf(token);
    expect(limited.status).toBe(429);
    expect(JSON.parse((limited.body as Buffer).toString()).code).toBe('rate_limited');
    await resetLinkWriteRate();
    expect(ok.headers['content-type']).toContain('application/pdf');
    expect(ok.headers['cache-control']).toContain('no-store');
    expect((ok.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    expect((await pdf(`${token}x`)).status).toBe(404);
    await resetLinkWriteRate();
  }, 90_000);

  it('D-59 ออกลิงก์ใหม่ให้ใบ APPROVED/PAID: ลิงก์ดูอย่างเดียว (ตอบ/จองรูป 404) · เพิกถอนลิงก์เดิม · audit · ไม่เพิ่มผู้เตรียม · DRAFT/CANCELLED 409', async () => {
    await resetLinkWriteRate();
    const { s, r, token } = await sent(1, '2000');
    const lines = r.body.settlement.lines as Line[];
    for (const l of lines) await respond(token, l.id, { response: 'ACCEPTED' }).expect(201);
    await approve(s.id).expect(200);
    const sid = uuid('settlement', s.id);
    const before = await db.carrierSettlement.findUniqueOrThrow({ where: { id: sid } });
    // สิทธิ์เดิม (settlements:create) — approver ไม่มี → 403 · บริษัทอื่น 404
    await api(app, approver).post(`/v1/settlements/${s.id}/review-link`).expect(403);
    await api(app, other).post(`/v1/settlements/${s.id}/review-link`).expect(404);
    const a1 = await api(app, accounting).post(`/v1/settlements/${s.id}/review-link`).expect(201);
    const t1 = tokenOf(a1.body.url as string);
    await view(token).expect(404); // ลิงก์ตรวจเดิมถูกเพิกถอน
    const v1 = await view(t1).expect(200);
    expect(v1.body).toMatchObject({ status: 'APPROVED', canRespond: false });
    expect((v1.body.lines as { canRespond: boolean }[]).every((l) => !l.canRespond)).toBe(true);
    // ดูอย่างเดียว: ลิงก์ไม่มี action respond → ตอบ/จองรูป = 404 (ไม่ใช่แค่ 409 ตามสถานะ)
    await respond(t1, lines[0]!.id, {
      response: 'DISPUTED',
      reason: 'ลองโต้แย้งหลังอนุมัติ',
    }).expect(404);
    await pub()
      .post(`/v1/public/settlements/${t1}/files`)
      .send({ lineId: lines[0]!.id, mime: 'image/png', bytes: PNG.length, filename: 'x.png' })
      .expect(404);
    const ml = await db.magicLink.findUniqueOrThrow({
      where: { id: tryDecodeId('magicLink', a1.body.id as string)! },
    });
    expect(ml.actions).toEqual(['settlement.view']);
    const audit = await db.auditLog.findFirstOrThrow({
      where: { entityId: sid, action: 'settlement.review_link_reissued' },
      orderBy: { seq: 'desc' },
    });
    expect(audit.after).toMatchObject({ status: 'APPROVED', viewOnly: true });
    // ผู้ออกลิงก์ใหม่หลังอนุมัติไม่ถูกเพิ่มเป็นผู้เตรียม · หัวใบไม่เปลี่ยน (version/ผู้อนุมัติเดิม)
    const after = await db.carrierSettlement.findUniqueOrThrow({ where: { id: sid } });
    expect(after.preparers).toEqual(before.preparers);
    expect(after.version).toBe(before.version);
    expect(after.approvedBy).toBe('u-appr');
    // จ่ายแล้ว → ออกใหม่อีกครั้งได้ · ลิงก์ก่อนหน้าใช้ไม่ได้ · เห็นสถานะจ่ายแล้ว + PDF ใบจ่ายเงิน
    await withVersion(s.id, (v) =>
      api(app, accounting)
        .post(`/v1/settlements/${s.id}/mark-paid`)
        .set('If-Match', `"${v}"`)
        .send({ paidDate: today, method: 'CASH' }),
    ).expect(200);
    const a2 = await api(app, accounting).post(`/v1/settlements/${s.id}/review-link`).expect(201);
    const t2 = tokenOf(a2.body.url as string);
    await view(t1).expect(404);
    expect((await view(t2).expect(200)).body).toMatchObject({ status: 'PAID', canRespond: false });
    await respond(t2, lines[0]!.id, { response: 'ACCEPTED' }).expect(404);
    const pdf = await pub().get(`/v1/public/settlements/${t2}/pdf`);
    expect(pdf.status).toBe(200);
    // DRAFT / CANCELLED ยังออกไม่ได้ (คงเดิม)
    const { C, trips } = await setup(1, '1000');
    const d = (await create({ carrierId: C.id, tripIds: [trips[0]!.id] }, accounting).expect(201))
      .body;
    await api(app, accounting).post(`/v1/settlements/${d.id}/review-link`).expect(409);
    await withVersion(d.id, (v) =>
      api(app, accounting)
        .post(`/v1/settlements/${d.id}/cancel`)
        .set('If-Match', `"${v}"`)
        .send({ reason: 'ยกเลิกใบทดสอบลิงก์ใหม่' }),
    ).expect(200);
    await api(app, accounting).post(`/v1/settlements/${d.id}/review-link`).expect(409);
    await resetLinkWriteRate();
  }, 90_000);
});
