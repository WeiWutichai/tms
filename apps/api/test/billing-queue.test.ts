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
 * ST5-T04 คิว "พร้อมวางบิล" + ขั้นส่งบัญชี (RELEASED) — เกณฑ์ตรวจรับ:
 * DO ที่ POD ไม่ครบไม่ขึ้นคิวเมื่อเปิด "ไม่มี POD ไม่วางบิล"; DO ที่ `RATE_MISSING` ไม่ขึ้นคิว
 * + บรรทัด provisional ไม่ขึ้น · ตัวกรอง/ยอดรวมต่อลูกค้า/cursor · ส่งบัญชี (ตรวจ POD กับ checklist ปัจจุบัน, If-Match, audit, bulk 207)
 * · สิทธิ์ (invoices:read / invoices:draft / prices.sell:read) · แยก tenant
 */
describe('ready-to-bill queue (ST5-T04)', { timeout: 300_000 }, () => {
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
  const NONE_REQ = { success: { fields: [] } };

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท คิววางบิล' })).id;
    otherId = (await createTenantWithDefaults(db, { name: 'บริษัท อื่น' })).id;
    const c = await db.company.create({
      data: { tenantId, legalName: 'บริษัท ผู้ออกบิล', taxId: validTaxId(941) },
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
        .send({ name: `จุด ${++seed}`, kind: 'DROPOFF', address: ADDR })
        .expect(201)
    ).body.id as string;
  const newVehicle = async () => {
    const v = (
      await api(app, admin)
        .post('/v1/vehicles')
        .send({
          plate: `8${++seed % 10}-${String(3000 + seed)}`,
          plateProvince: 'TH-10',
          vehicleTypeId: vt6,
          ownership: 'OWN',
        })
        .expect(201)
    ).body as { id: string };
    const n = ++seed;
    await api(app, admin)
      .post('/v1/drivers')
      .send({
        name: `คนขับ ${n}`,
        phone: `087-${String(n).padStart(3, '0')}-${String(n).padStart(4, '0')}`,
        employmentType: 'EMPLOYEE_SALARIED',
        licenceClass: 'T2',
        licenceExpiresOn: '2030-03-31',
        defaultVehicleId: v.id,
      })
      .expect(201);
    return v.id;
  };
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const post = (stop: string, action: string, min: number, extra: object = {}) =>
    api(app, admin)
      .post(`/v1/stops/${stop}/${action}`)
      .send({ clientEventId: randomUUID(), occurredAt: ago(min), ...extra });

  interface Opts {
    /** มี rate card ขาขาย (ราคา AVAILABLE) — ค่าเริ่มต้น true */
    rate?: boolean;
    /** checklist ชุดสำเร็จของลูกค้า — ไม่ส่ง = ค่าองค์กร (รูป + ลายเซ็นบังคับ) */
    podRequirements?: object;
    /** ค่าตั้ง "ไม่มี POD ไม่วางบิล" — ไม่ส่ง = ค่าเริ่มต้น (เปิด) */
    requirePodToBill?: boolean;
    billByActualQty?: boolean;
    /** จุดส่งไม่มีเวลาถึง/ออก (ล้างที่ฐานหลังส่ง) */
    noArrive?: boolean;
    customerId?: string;
    /** "กำหนดราคาเอง" (ORD-043 — POST /orders/{id}/manual-price) ก่อนวางแผน · ใช้คู่กับ `rate: false` */
    manualPrice?: string;
  }
  const newCustomer = async (o: Opts) => {
    const body = (
      await api(app, admin)
        .post('/v1/customers')
        .send({
          legalName: `ลูกค้าวางบิล ${++seed}`,
          taxId: validTaxId(9600 + seed),
          externalId: `CUS-EXT-${seed}`,
          ...(o.requirePodToBill !== undefined ? { requirePodToBill: o.requirePodToBill } : {}),
          ...(o.billByActualQty ? { billByActualQty: true } : {}),
        })
        .expect(201)
    ).body as { id: string; requirePodToBill: boolean };
    if (o.podRequirements)
      await db.customer.update({
        where: { id: uuid('customer', body.id) },
        data: { podRequirements: o.podRequirements },
      });
    return body.id;
  };

  /** ลูกค้า → (rate card) → SO 5 ตัน → DO → เที่ยวปล่อยรถ → ปิดจุดรับ + จุดส่ง (ส่งสำเร็จ) · คืน DO */
  const delivered = async (o: Opts = {}) => {
    const customer = o.customerId ?? (await newCustomer(o));
    const origin = await newSite();
    const dest = await newSite();
    if (o.rate !== false) {
      const r = (
        await api(app, admin)
          .post('/v1/rate-cards')
          .send({
            customerId: customer,
            originId: origin,
            destinationId: dest,
            vehicleTypeId: vt6,
            validFrom: today,
            pricingModel: 'PER_TON',
            sellRate: '350',
          })
          .expect(201)
      ).body;
      await api(app, admin)
        .post(`/v1/rate-cards/${r.id}/approve`)
        .send({ reason: 'อนุมัติตามใบเสนอราคา' })
        .expect(200);
    }
    const input: UpsertOrderInput = {
      source: 'MANUAL',
      customer: { id: uuid('customer', customer) },
      requestedDate: today,
      vehicleTypeId: uuid('vehicleType', vt6),
      stops: [
        { type: 'PICKUP', siteId: uuid('site', origin) },
        { type: 'DELIVERY', siteId: uuid('site', dest) },
      ],
      lines: [{ description: 'ปูนซีเมนต์', qty: '5', unitId: unitTon, weightKg: '5000' }],
    };
    const { order: so } = await run((tx) => app.get(OrderIntakeService).upsertOrder(input, tx));
    if (o.manualPrice)
      await api(app, admin)
        .post(`/v1/orders/${encodeId('salesOrder', so.id)}/manual-price`)
        .send({ sellAmount: o.manualPrice, reason: 'ลูกค้าตกลงราคาเหมาทางโทรศัพท์' })
        .expect(200);
    const [d] = await run((tx) => app.get(DeliveryOrderService).listForOrder(so.id, {}, tx));
    const doId = encodeId('deliveryOrder', d!.id);
    const vid = await newVehicle();
    const t = (
      await api(app, admin)
        .post('/v1/trips')
        .send({ tripDate: today, deliveryOrderIds: [doId], vehicleId: vid })
        .expect(201)
    ).body;
    const r = await api(app, admin)
      .post(`/v1/trips/${t.id}/assign`)
      .send({ vehicleId: vid, dispatch: true });
    if (r.status !== 200)
      await api(app, admin)
        .post(`/v1/trips/${t.id}/assign`)
        .send({
          vehicleId: vid,
          dispatch: true,
          ruleKeys: r.body.warnings.map((x: { key: string }) => x.key),
          overrideReason: 'ทดสอบคิววางบิล',
        })
        .expect(200);
    const full = (await api(app, admin).get(`/v1/trips/${t.id}`).expect(200)).body;
    const [pickup, drop] = [...full.stops].sort(
      (a: { sequence: number }, b: { sequence: number }) => a.sequence - b.sequence,
    );
    await post(pickup.id, 'arrive', 60).expect(201);
    await post(pickup.id, 'complete', 55, { outcome: 'DELIVERED' }).expect(201);
    await post(drop.id, 'arrive', 20).expect(201);
    await post(drop.id, 'complete', 10, { outcome: 'DELIVERED' }).expect(201);
    // ข้อมูลเก่า/นำเข้าที่จุดส่งไม่มีเวลาถึง-ออก (flow ปกติปิดงานได้หลังถึงจุดเท่านั้น) — ล้าง projection ตรงที่ฐาน
    if (o.noArrive)
      await db.tripStop.update({
        where: { id: uuid('tripStop', drop.id) },
        data: { arrivedAt: null, departedAt: null },
      });
    return { doId, uuid: d!.id, customer, soId: so.id };
  };
  const queue = async (qs = '', token = admin) =>
    (await api(app, token).get(`/v1/invoices/queue${qs}`).expect(200)).body as {
      data: Record<string, any>[];
      nextCursor: string | null;
      hasMore: boolean;
      customers: Record<string, any>[];
    };
  const ids = (b: { data: Record<string, any>[] }) => b.data.map((x) => x.id as string);
  const release = (doId: string, token = admin) =>
    api(app, token).post(`/v1/delivery-orders/${doId}/release`).send({});

  let ready: Awaited<ReturnType<typeof delivered>>;
  let podPending: Awaited<ReturnType<typeof delivered>>;
  let podWaived: Awaited<ReturnType<typeof delivered>>;
  let rateMissing: Awaited<ReturnType<typeof delivered>>;
  let provisional: Awaited<ReturnType<typeof delivered>>;
  let noArrive: Awaited<ReturnType<typeof delivered>>;

  it('เกณฑ์ตรวจรับ: POD ไม่ครบไม่ขึ้นคิวเมื่อเปิด option · RATE_MISSING ไม่ขึ้น · provisional ไม่ขึ้น', async () => {
    ready = await delivered({ podRequirements: NONE_REQ });
    podPending = await delivered(); // ค่าองค์กร: รูป + ลายเซ็นบังคับ → POD_PENDING
    podWaived = await delivered({ requirePodToBill: false });
    rateMissing = await delivered({ rate: false, podRequirements: NONE_REQ });
    provisional = await delivered({ podRequirements: NONE_REQ, billByActualQty: true });
    noArrive = await delivered({ podRequirements: NONE_REQ, noArrive: true });

    const row = (id: string) => db.deliveryOrder.findUniqueOrThrow({ where: { id } });
    expect((await row(ready.uuid)).status).toBe('UNBILLED');
    expect((await row(podPending.uuid)).status).toBe('POD_PENDING');
    expect((await row(podWaived.uuid)).status).toBe('POD_PENDING');
    expect(
      (await db.salesOrder.findUniqueOrThrow({ where: { id: rateMissing.soId } })).pricingStatus,
    ).toBe('RATE_MISSING');

    const q = await queue();
    expect(ids(q).sort()).toEqual([ready.doId, podWaived.doId, noArrive.doId].sort());
    const r = q.data.find((x) => x.id === ready.doId)!;
    expect(r).toMatchObject({
      status: 'UNBILLED',
      requirePodToBill: true,
      pod: { status: 'NONE', complete: true, checklistOk: true },
      stopTimesComplete: true,
      revenueLineCount: 1,
      sellTotal: '1750.00',
      releasedAt: null,
    });
    expect(q.data.find((x) => x.id === podWaived.doId)).toMatchObject({
      requirePodToBill: false,
      pod: { complete: false },
    });
    expect(q.data.find((x) => x.id === noArrive.doId)!.stopTimesComplete).toBe(false);

    // ตัวกรอง POD
    expect(ids(await queue('?podComplete=false'))).toEqual([podWaived.doId]);
    expect(ids(await queue('?podComplete=true'))).not.toContain(podWaived.doId);
    // ยอดรวมต่อลูกค้า (ทุกแถวที่ตรงตัวกรอง)
    expect(q.customers).toHaveLength(3);
    expect(q.customers.find((c) => c.customerId === ready.customer)).toMatchObject({
      deliveryOrderCount: 1,
      releasedCount: 0,
      sellTotal: '1750.00',
      requirePodToBill: true,
    });
  });

  it('ตัวกรองลูกค้า (id / ext:) · ช่วงวัน · 422 วันผิด · cursor', async () => {
    expect(ids(await queue(`?customerId=${ready.customer}`))).toEqual([ready.doId]);
    const ext = (
      await db.customer.findUniqueOrThrow({ where: { id: uuid('customer', ready.customer) } })
    ).externalId;
    expect(ids(await queue(`?customerId=ext:${ext}`))).toEqual([ready.doId]);
    expect((await queue('?customerId=ext:NOPE')).data).toEqual([]);
    expect((await queue('?customerId=cus_00000000000000000000000000000000')).data).toEqual([]);
    expect((await queue(`?dateFrom=${today}&dateTo=${today}`)).data).toHaveLength(3);
    expect((await queue('?dateFrom=2020-01-01&dateTo=2020-01-31')).data).toEqual([]);
    await api(app, admin).get('/v1/invoices/queue?dateFrom=2026-02-30').expect(422);
    await api(app, admin)
      .get('/v1/invoices/queue?dateFrom=2026-03-02&dateTo=2026-03-01')
      .expect(422);

    const p1 = await queue('?limit=2');
    expect(p1.data).toHaveLength(2);
    expect(p1.hasMore).toBe(true);
    const p2 = await queue(`?limit=2&cursor=${p1.nextCursor}`);
    expect(p2.data).toHaveLength(1);
    expect(new Set([...ids(p1), ...ids(p2)]).size).toBe(3);
    // ST9-T17: ตัดหน้าก่อน join รายละเอียด — ลำดับ/หน้า (ทั้งสองทิศ) เท่ากับรายการเต็ม
    const all = await queue('?limit=200');
    expect([...ids(p1), ...ids(p2)]).toEqual(ids(all));
    const d1 = await queue('?limit=2&sort=-updatedAt');
    const d2 = await queue(`?limit=2&sort=-updatedAt&cursor=${d1.nextCursor}`);
    expect([...ids(d1), ...ids(d2)]).toEqual([...ids(all)].reverse());
    expect(d2.hasMore).toBe(false);
    // review L1: updated_at ซ้ำกัน → ตัวตัดสินคือ id ข้ามขอบหน้า (limit=1 ทั้งสองทิศ ไม่ซ้ำ/ไม่ตกหล่น)
    const same = new Date(Date.now() - 3_600_000);
    await db.deliveryOrder.updateMany({
      where: { id: { in: ids(all).map((x) => uuid('deliveryOrder', x)) } },
      data: { updatedAt: same },
    });
    const walk = async (sort: string) => {
      const out: string[] = [];
      let cursor: string | null = null;
      do {
        const p: Awaited<ReturnType<typeof queue>> = await queue(
          `?limit=1${sort}${cursor ? `&cursor=${cursor}` : ''}`,
        );
        out.push(...ids(p));
        cursor = p.nextCursor;
      } while (cursor);
      return out;
    };
    const byId = [...ids(all)].sort((a, b) =>
      uuid('deliveryOrder', a) < uuid('deliveryOrder', b) ? -1 : 1,
    );
    expect(await walk('')).toEqual(byId);
    expect(await walk('&sort=-updatedAt')).toEqual([...byId].reverse());
    // customers[] ไม่ขึ้นกับหน้า
    expect(p1.customers).toHaveLength(3);
    // updatedAfter ใช้ทั้งแถวและยอดรวมต่อลูกค้า (review L)
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const none = await queue(`?updatedAfter=${encodeURIComponent(future)}`);
    expect(none.data).toEqual([]);
    expect(none.customers).toEqual([]);
  });

  it('สิทธิ์: planner 403 · viewer อ่านได้แต่ไม่เห็นยอด (prices.sell:read) · tenant อื่นไม่เห็น', async () => {
    await api(app, planner).get('/v1/invoices/queue').expect(403);
    const v = await queue('', viewer);
    expect(v.data).toHaveLength(3);
    expect(v.data[0]).not.toHaveProperty('sellTotal');
    expect(v.customers[0]).not.toHaveProperty('sellTotal');
    expect((await queue('', other)).data).toEqual([]);
  });

  it('ส่งบัญชี: สำเร็จ + audit · ส่งซ้ำไม่เปลี่ยน · If-Match ไม่ตรง 412 · กรอง released', async () => {
    const before = await api(app, admin).get(`/v1/delivery-orders/${ready.doId}`).expect(200);
    await api(app, admin)
      .post(`/v1/delivery-orders/${ready.doId}/release`)
      .set('If-Match', '"999"')
      .send({})
      .expect(412);
    const r = await api(app, admin)
      .post(`/v1/delivery-orders/${ready.doId}/release`)
      .set('If-Match', before.headers.etag as string)
      .send({ note: 'ส่งบัญชีงวดครึ่งแรก' })
      .expect(200);
    expect(r.body.releasedAt).toBeTruthy();
    expect(r.body.status).toBe('UNBILLED');
    expect(r.body.version).toBe(before.body.version + 1);
    const again = await release(ready.doId).expect(200);
    expect(again.body.version).toBe(r.body.version);
    expect(again.body.releasedAt).toBe(r.body.releasedAt);
    const audit = await db.auditLog.findMany({
      where: { tenantId, action: 'delivery_order.released', entityId: ready.uuid },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ reason: 'ส่งบัญชีงวดครึ่งแรก' });
    expect(audit[0]!.actorId).toBeTruthy();

    expect(ids(await queue('?released=true'))).toEqual([ready.doId]);
    expect(ids(await queue('?released=false'))).not.toContain(ready.doId);
    const q = await queue(`?customerId=${ready.customer}`);
    expect(q.data[0]!.releasedAt).toBe(r.body.releasedAt);
    expect(q.customers[0]).toMatchObject({ releasedCount: 1 });
  });

  it('ส่งบัญชีไม่ได้: ราคา/provisional/เวลาจุดส่ง/ระงับ/POD ตาม checklist ปัจจุบัน → 409 not_ready_to_bill', async () => {
    const reasons = async (doId: string) => {
      const r = await release(doId).expect(409);
      expect(r.body.code).toBe('not_ready_to_bill');
      return r.body.reasons as string[];
    };
    expect(await reasons(rateMissing.doId)).toEqual(
      expect.arrayContaining(['PRICING_UNAVAILABLE', 'NO_REVENUE']),
    );
    expect(await reasons(provisional.doId)).toEqual(['REVENUE_PROVISIONAL']);
    expect(await reasons(noArrive.doId)).toEqual(['STOP_TIMES_MISSING']);
    const pend = await release(podPending.doId).expect(409);
    expect(pend.body.reasons).toEqual(['POD_INCOMPLETE']);
    expect(pend.body.missing.length).toBeGreaterThan(0);

    // ลูกค้าปิด "ไม่มี POD ไม่วางบิล" → ส่งบัญชีได้แม้หลักฐานไม่ครบ
    await release(podWaived.doId).expect(200);

    // ระงับวางบิล → ไม่ขึ้นคิว + ส่งบัญชีไม่ได้
    const held = await delivered({ podRequirements: NONE_REQ });
    await db.deliveryOrder.update({ where: { id: held.uuid }, data: { billingHold: true } });
    expect(ids(await queue())).not.toContain(held.doId);
    expect(await reasons(held.doId)).toEqual(['BILLING_HOLD']);

    // checklist ของลูกค้าเปลี่ยนหลัง DO ผ่านเกณฑ์ (UNBILLED) → คิวยังแสดง (สถานะที่เก็บ) แต่ส่งบัญชีตรวจกับ checklist ปัจจุบัน
    const stale = await delivered({ podRequirements: NONE_REQ });
    await db.customer.update({
      where: { id: uuid('customer', stale.customer) },
      data: { podRequirements: {} },
    });
    const sq = (await queue()).data.find((x) => x.id === stale.doId)!;
    expect(sq.pod).toMatchObject({ complete: false, checklistOk: false }); // QA L1: ตรงกับผลส่งบัญชี
    const s = await release(stale.doId).expect(409);
    expect(s.body.reasons).toEqual(['POD_INCOMPLETE']);
    expect(s.body.missing.map((m: { key: string }) => m.key)).toEqual(['photo', 'signature']);
  });

  it('ส่งบัญชีหลายใบ: 207 ผลต่อรายการ · สิทธิ์ invoices:draft · tenant อื่น 404', async () => {
    const a = await delivered({ podRequirements: NONE_REQ });
    const body = {
      items: [
        { deliveryOrderId: a.doId },
        { deliveryOrderId: rateMissing.doId },
        { deliveryOrderId: ready.doId },
        { deliveryOrderId: `do_${'0'.repeat(32)}` },
      ],
    };
    await api(app, viewer).post('/v1/delivery-orders/bulk-release').send(body).expect(403);
    const r = await api(app, admin).post('/v1/delivery-orders/bulk-release').send(body).expect(207);
    expect(r.body.results.map((x: { outcome: string }) => x.outcome)).toEqual([
      'RELEASED',
      'FAILED',
      'UNCHANGED',
      'FAILED',
    ]);
    expect(r.body.results[1].problem).toMatchObject({ status: 409, code: 'not_ready_to_bill' });
    expect(r.body.results[3].problem).toMatchObject({ status: 404 });
    expect(r.body).toMatchObject({ succeeded: 1, unchanged: 1, failed: 2 });
    await api(app, admin)
      .post('/v1/delivery-orders/bulk-release')
      .send({ items: [{ deliveryOrderId: a.doId }, { deliveryOrderId: a.doId }] })
      .expect(422);

    await release(ready.doId, viewer).expect(403);
    await release(ready.doId, other).expect(404);
  });

  it('ราคากำหนดเอง (ORD-043) ไม่มี rate card → ขึ้นคิวและส่งบัญชีได้เหมือนราคาจาก rate card', async () => {
    const m = await delivered({ rate: false, manualPrice: '9000', podRequirements: NONE_REQ });
    // pricing_status = ผลหา rate card (ยังไม่พบ) — ราคาของใบสั่งมาจากบรรทัด FREIGHT ที่มา MANUAL
    expect((await db.salesOrder.findUniqueOrThrow({ where: { id: m.soId } })).pricingStatus).toBe(
      'RATE_MISSING',
    );
    const row = (await queue(`?customerId=${m.customer}`)).data;
    expect(row.map((x) => x.id)).toEqual([m.doId]);
    expect(row[0]).toMatchObject({ revenueLineCount: 1, sellTotal: '9000.00' });
    await release(m.doId).expect(200);
  });

  it('ค่าตั้งลูกค้า requirePodToBill: เปลี่ยนต้องมี invoices:draft · ค่าเริ่มต้นเปิด', async () => {
    const c = await newCustomer({});
    const got = await api(app, admin).get(`/v1/customers/${c}`).expect(200);
    expect(got.body.requirePodToBill).toBe(true);
    await api(app, planner)
      .patch(`/v1/customers/${c}`)
      .send({ requirePodToBill: false })
      .expect(403);
    await api(app, admin).patch(`/v1/customers/${c}`).send({ requirePodToBill: false }).expect(200);
    const audit = await db.auditLog.findFirst({
      where: { tenantId, action: 'customer.updated', entityId: uuid('customer', c) },
      orderBy: { seq: 'desc' },
    });
    expect(audit?.after).toMatchObject({ requirePodToBill: false });
  });
});
