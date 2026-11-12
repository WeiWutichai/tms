import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { requestContext } from '../src/common/request-context';
import { DbService } from '../src/db/db.service';
import {
  OrderIntakeService,
  type UpsertOrderInput,
} from '../src/modules/orders/order-intake.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { addDays, bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { hashPassword } from '../src/auth/password';
import { ensureSystemRoles } from '../src/auth/system-roles';
import { api, bootApp, loginFull, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST3-T03 Open API orders: POST (+Idempotency-Key), GET list/one, PATCH, PUT /external/{externalId}
 * เกณฑ์ตรวจรับ: PUT externalId เดิม 2 ครั้ง = 1 order · แก้ช่องต้องห้ามหลัง in_transit → 409
 */
describe('orders API (ST3-T03)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let otherId: string;
  let admin: string;
  let other: string;
  let seed = 0;
  let vt6: string;
  let unitTon: string;
  const today = bangkokToday();
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };

  async function company(tid: string, isDefaultIssuer = true) {
    const c = await db.company.create({
      data: { tenantId: tid, legalName: `บริษัท ออกบิล ${++seed}`, taxId: validTaxId(700 + seed) },
    });
    await db.branch.create({
      data: {
        tenantId: tid,
        companyId: c.id,
        branchCode: '00000',
        branchLabel: 'สำนักงานใหญ่',
        address: ADDR,
        isDefaultIssuer,
      },
    });
    return c.id;
  }

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท ขนส่ง เอ' })).id;
    otherId = (await createTenantWithDefaults(db, { name: 'บริษัท ขนส่ง บี' })).id;
    await company(tenantId);
    await company(otherId);
    admin = await tokenFor(tenantId);
    other = await tokenFor(otherId);
    const types = (await api(app, admin).get('/v1/vehicle-types?limit=50').expect(200)).body.data;
    vt6 = types.find((t: { code: string }) => t.code === '6W').id;
    const us = (await api(app, admin).get('/v1/units?limit=50').expect(200)).body.data;
    unitTon = us.find((u: { code: string }) => u.code === 'TON').id;
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  const newSite = async (token = admin) =>
    (
      await api(app, token)
        .post('/v1/customer-sites')
        .send({ name: `จุด ${++seed}`, kind: 'DROPOFF', address: ADDR })
        .expect(201)
    ).body.id as string;
  const newCustomer = async (token = admin) =>
    (
      await api(app, token)
        .post('/v1/customers')
        .send({ legalName: `ลูกค้า ${++seed}`, taxId: validTaxId(9500 + seed) })
        .expect(201)
    ).body.id as string;
  const approveRate = async (k: { customer: string; origin: string; dest: string }) => {
    const r = (
      await api(app, admin)
        .post('/v1/rate-cards')
        .send({
          customerId: k.customer,
          originId: k.origin,
          destinationId: k.dest,
          vehicleTypeId: vt6,
          validFrom: addDays(today, -30),
          pricingModel: 'PER_TRIP',
          sellRate: '4500',
          includedStops: 2,
        })
        .expect(201)
    ).body;
    await api(app, admin)
      .post(`/v1/rate-cards/${r.id}/approve`)
      .send({ reason: 'อนุมัติตามใบเสนอราคา' })
      .expect(200);
  };
  const key = async () => ({
    customer: await newCustomer(),
    origin: await newSite(),
    dest: await newSite(),
  });
  const body = (k: { customer: string; origin: string; dest: string }, extra: object = {}) => ({
    customer: { id: k.customer },
    requestedDate: today,
    vehicleTypeId: vt6,
    stops: [
      { type: 'PICKUP', siteId: k.origin, windowStart: `${today}T07:00:00+07:00` },
      { type: 'DELIVERY', siteId: k.dest, windowEnd: `${today}T16:00:00+07:00` },
    ],
    lines: [{ description: 'ปูนซีเมนต์', qty: '12.5', unitId: unitTon, weightKg: '12500' }],
    ...extra,
  });
  const setStatus = (id: string, status: 'PLANNED' | 'IN_TRANSIT' | 'DELIVERED' | 'CANCELLED') =>
    db.salesOrder.update({
      where: { id: tryDecodeId('salesOrder', id)! },
      data: { status },
    });
  /** เรียก upsertOrder ตรง (เหมือน connector ST3-T05) */
  const upsertDirect = (input: UpsertOrderInput, tid = tenantId) =>
    app
      .get(DbService)
      .withTenant(tid, (tx) =>
        requestContext.run(
          { requestId: randomUUID(), tenantId: tid, actorId: 'connector-test', locale: 'th', tx },
          () => app.get(OrderIntakeService).upsertOrder(input, tx),
        ),
      );
  const count = (externalId: string) => db.salesOrder.count({ where: { tenantId, externalId } });

  it('POST /orders: สร้าง (ที่มา API, ord_ id, ETag, เลข SO, ราคา) · Idempotency-Key ส่งซ้ำ = ผลเดิม, body ต่าง = 422', async () => {
    const k = await key();
    await approveRate(k);
    const idem = `idem-${randomUUID()}`;
    const res = await api(app, admin)
      .post('/v1/orders')
      .set('Idempotency-Key', idem)
      .send(body(k, { customerRef: 'PO-001' }))
      .expect(201);
    const o = res.body;
    expect(o.id).toMatch(/^ord_[0-9a-f]{32}$/);
    expect(res.headers.etag).toBe(`"${o.version}"`);
    expect(o).toMatchObject({
      status: 'received',
      source: 'API',
      sourceType: 'API',
      connector: null,
      externalId: null,
      customerRef: 'PO-001',
      pricingStatus: 'AVAILABLE',
      sellTotal: '4500.00',
      holdReason: null,
      holdCodes: [],
      requestedDate: today,
      vehicleTypeId: vt6,
    });
    expect(o.soNo).toMatch(/^SO-\d{4}-\d{4}$/);
    expect(o.customer.id).toBe(k.customer);
    expect(o.customer.legalName).toMatch(/^ลูกค้า/);
    expect(o.stops.map((s: { siteId: string }) => s.siteId)).toEqual([k.origin, k.dest]);
    expect(o.stops[0].siteText).toMatch(/^จุด/);
    expect(o.lines[0]).toMatchObject({ qty: '12.5', unitId: unitTon, unit: 'TON' });
    expect(o.sellCharges[0]).toMatchObject({
      kind: 'FREIGHT',
      origin: 'RATE_CARD',
      sellAmount: '4500.00',
      vatType: 'EXEMPT_TRANSPORT',
    });

    const again = await api(app, admin)
      .post('/v1/orders')
      .set('Idempotency-Key', idem)
      .send(body(k, { customerRef: 'PO-001' }))
      .expect(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body.id).toBe(o.id);
    expect(await db.salesOrder.count({ where: { tenantId, customerRef: 'PO-001' } })).toBe(1);
    const mismatch = await api(app, admin)
      .post('/v1/orders')
      .set('Idempotency-Key', idem)
      .send(body(k, { customerRef: 'PO-002' }))
      .expect(422);
    expect(mismatch.body.code).toBe('idempotency_mismatch');

    // GET by id และ ext: ไม่มี (ไม่มี externalId) · ETag
    const got = await api(app, admin).get(`/v1/orders/${o.id}`).expect(200);
    expect(got.body).toEqual(o);
    expect(got.headers.etag).toBe(`"${o.version}"`);
  });

  it('PUT /orders/external/{externalId} 2 ครั้ง = 1 order (201 → 200, version เดิม) · แก้ = ใบเดิม version+1 · If-Match ผิด → 412 · GET ext:', async () => {
    const k = await key();
    await approveRate(k);
    const ext = 'KRS-SO-2026-000123';
    const first = await api(app, admin).put(`/v1/orders/external/${ext}`).send(body(k)).expect(201);
    const second = await api(app, admin)
      .put(`/v1/orders/external/${ext}`)
      .send(body(k))
      .expect(200);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.version).toBe(first.body.version);
    expect(second.body.externalId).toBe(ext);
    expect(await count(ext)).toBe(1);

    const changed = await api(app, admin)
      .put(`/v1/orders/external/${ext}`)
      .set('If-Match', second.headers.etag as string)
      .send(body(k, { customerRef: 'PO-NEW' }))
      .expect(200);
    expect(changed.body.version).toBe(first.body.version + 1);
    expect(changed.body.customerRef).toBe('PO-NEW');
    const stale = await api(app, admin)
      .put(`/v1/orders/external/${ext}`)
      .set('If-Match', second.headers.etag as string)
      .send(body(k, { customerRef: 'PO-OLD' }))
      .expect(412);
    expect(stale.body.code).toBe('precondition_failed');
    expect(await count(ext)).toBe(1);

    const byExt = await api(app, admin).get(`/v1/orders/ext:${ext}`).expect(200);
    expect(byExt.body.id).toBe(first.body.id);
    await api(app, admin)
      .put(`/v1/orders/external/${'x'.repeat(101)}`)
      .send(body(k))
      .expect(422);
  });

  it('externalId ของใบจากช่องทางอื่น (ERP:krs) → PUT external 409 external_id_conflict ไม่ทับ', async () => {
    const k = await key();
    const ext = 'KRS-ACME-SO-9';
    const krs = await upsertDirect({
      source: 'ERP:krs',
      externalId: ext,
      customer: { externalId: 'C-ไม่รู้จัก' },
      requestedDate: today,
      stops: [
        { type: 'PICKUP', siteText: 'คลังบางนา' },
        { type: 'DELIVERY', siteText: 'ร้านค้าชลบุรี' },
      ],
    });
    const res = await api(app, admin).put(`/v1/orders/external/${ext}`).send(body(k)).expect(409);
    expect(res.body).toMatchObject({
      code: 'external_id_conflict',
      existingSource: 'CONNECTOR',
      existingConnector: 'krs',
    });
    const got = await api(app, admin)
      .get(`/v1/orders/${encodeId('salesOrder', krs.order.id)}`)
      .expect(200);
    expect(got.body).toMatchObject({
      source: 'ERP:krs',
      sourceType: 'CONNECTOR',
      connector: 'krs',
      status: 'on_hold',
      holdReason: { code: 'CUSTOMER_UNMAPPED' },
    });
    expect(got.body.holdReason.label).toBeTruthy();
    expect(got.body.holdCodes).toEqual(['CUSTOMER_UNMAPPED', 'LOCATION_UNMAPPED', 'RATE_MISSING']);
    expect(got.body.version).toBe(krs.order.version);
  });

  it('แก้ช่องต้องห้ามหลัง in_transit → 409 order_locked_for_update (ระบุช่อง + editableFields); PLANNED แก้ช่วงเวลาได้; ปิด/ยกเลิกแก้ไม่ได้', async () => {
    const k = await key();
    await approveRate(k);
    const ext = 'LOCK-API-1';
    const o = (await api(app, admin).put(`/v1/orders/external/${ext}`).send(body(k)).expect(201))
      .body;

    // ก่อนวางแผน: PATCH แก้ได้ทุกช่อง (สินค้า) — ราคา/สถานะประเมินใหม่
    const p1 = await api(app, admin)
      .patch(`/v1/orders/${o.id}`)
      .send({ lines: [{ description: 'ปูนถุง', qty: '10', unitId: unitTon }] })
      .expect(200);
    expect(p1.body.lines).toHaveLength(1);
    expect(p1.body.lines[0]).toMatchObject({ description: 'ปูนถุง', qty: '10' });
    expect(p1.body.version).toBe(o.version + 1);
    // PATCH ค่าเดิม = ไม่เปลี่ยน version
    const same = await api(app, admin)
      .patch(`/v1/orders/${o.id}`)
      .send({ customerRef: null })
      .expect(200);
    expect(same.body.version).toBe(p1.body.version);

    // PLANNED: ช่วงเวลา + PO แก้ได้ · ปลายทางไม่ได้
    await setStatus(o.id, 'PLANNED');
    const stops = p1.body.stops.map((s: Record<string, unknown>) => ({
      type: s.type,
      siteId: s.siteId,
      windowStart: s.windowStart,
      windowEnd: s.windowEnd,
    }));
    const win = await api(app, admin)
      .patch(`/v1/orders/${o.id}`)
      .send({ stops: [stops[0], { ...stops[1], windowEnd: `${today}T18:00:00+07:00` }] })
      .expect(200);
    expect(win.body.stops[1].windowEnd).toBe(new Date(`${today}T18:00:00+07:00`).toISOString());
    expect(win.body.status).toBe('planned');
    const dest = await api(app, admin)
      .patch(`/v1/orders/${o.id}`)
      .send({ stops: [stops[0], { ...stops[1], siteId: await newSite() }] })
      .expect(409);
    expect(dest.body.code).toBe('order_locked_for_update');
    expect(dest.body.errors).toEqual([
      { field: 'stops[1].siteId', code: 'locked', message: expect.any(String) },
    ]);
    expect(dest.body.editableFields).toEqual(['customerRef', 'stops.window']);

    // IN_TRANSIT: PO แก้ได้ · ช่วงเวลา/สินค้า/วันที่ → 409
    await setStatus(o.id, 'IN_TRANSIT');
    const po = await api(app, admin)
      .patch(`/v1/orders/${o.id}`)
      .send({ customerRef: 'PO-ระหว่างทาง' })
      .expect(200);
    expect(po.body).toMatchObject({ customerRef: 'PO-ระหว่างทาง', status: 'in_transit' });
    const locked = await api(app, admin)
      .patch(`/v1/orders/${o.id}`)
      .send({
        requestedDate: addDays(today, 1),
        lines: [{ description: 'ปูนถุง', qty: '11', unitId: unitTon }],
        stops: [stops[0], { ...stops[1], windowEnd: `${today}T20:00:00+07:00` }],
      })
      .expect(409);
    expect(locked.body.code).toBe('order_locked_for_update');
    expect(locked.body.status).toBe(409);
    expect(locked.body.orderStatus).toBe('IN_TRANSIT');
    expect(locked.body.editableFields).toEqual(['customerRef']);
    expect(locked.body.errors.map((e: { field: string }) => e.field).sort()).toEqual(
      ['lines[0].qty', 'requestedDate', 'stops[1].windowEnd'].sort(),
    );
    // PUT external ที่เปลี่ยนจุดหลัง in_transit ก็ 409 เช่นกัน · ส่งซ้ำค่าเดิมไม่ error
    const put = await api(app, admin)
      .put(`/v1/orders/external/${ext}`)
      .send(body(k, { customerRef: 'PO-ระหว่างทาง' }))
      .expect(409);
    expect(put.body.code).toBe('order_locked_for_update');
    const unchanged = (await api(app, admin).get(`/v1/orders/${o.id}`).expect(200)).body;
    expect(unchanged.lines[0].qty).toBe('10');
    expect(unchanged.version).toBe(po.body.version);

    // ยกเลิกแล้ว: ไม่มีช่องที่แก้ได้
    await setStatus(o.id, 'CANCELLED');
    const done = await api(app, admin)
      .patch(`/v1/orders/${o.id}`)
      .send({ customerRef: 'หลังยกเลิก' })
      .expect(409);
    expect(done.body).toMatchObject({ code: 'order_locked_for_update', editableFields: [] });
  });

  it('สิทธิ์: orders:read อ่านได้แต่สร้าง/แก้ไม่ได้ · ไม่มี prices.sell:read = ไม่เห็นราคา · ไม่มี orders:read = 403', async () => {
    const k = await key();
    await approveRate(k);
    const o = (await api(app, admin).post('/v1/orders').send(body(k)).expect(201)).body;
    const reader = await tokenFor(tenantId, 'orders:read');
    const pricedReader = await tokenFor(tenantId, 'orders:read prices.sell:read');
    const noOrders = await tokenFor(tenantId, 'master:read');

    const plain = (await api(app, reader).get(`/v1/orders/${o.id}`).expect(200)).body;
    expect(plain).not.toHaveProperty('sellTotal');
    expect(plain).not.toHaveProperty('sellCharges');
    expect(plain.pricingStatus).toBe('AVAILABLE');
    const list = (await api(app, reader).get(`/v1/orders?externalId=nope`).expect(200)).body;
    expect(list.data).toEqual([]);
    const priced = (await api(app, pricedReader).get(`/v1/orders/${o.id}`).expect(200)).body;
    expect(priced.sellTotal).toBe('4500.00');

    expect((await api(app, reader).post('/v1/orders').send(body(k)).expect(403)).body.code).toBe(
      'permission_denied',
    );
    await api(app, reader).patch(`/v1/orders/${o.id}`).send({ customerRef: 'x' }).expect(403);
    await api(app, reader).put('/v1/orders/external/PERM-1').send(body(k)).expect(403);
    await api(app, noOrders).get('/v1/orders').expect(403);
    await api(app, noOrders).get(`/v1/orders/${o.id}`).expect(403);
  });

  it('แยก tenant: อีก tenant GET/PATCH/ext: → 404 · externalId เดียวกัน = คนละใบ · list ไม่เห็นกัน', async () => {
    const k = await key();
    const mine = (
      await api(app, admin).put('/v1/orders/external/SHARED-1').send(body(k)).expect(201)
    ).body;
    await api(app, other).get(`/v1/orders/${mine.id}`).expect(404);
    await api(app, other).get('/v1/orders/ext:SHARED-1').expect(404);
    const patch = await api(app, other)
      .patch(`/v1/orders/${mine.id}`)
      .send({ customerRef: 'ข้าม tenant' })
      .expect(404);
    expect(patch.headers['content-type']).toContain('application/problem+json');
    // อ้างลูกค้า/สถานที่ของ tenant อื่น → 422 reference_not_found (ไม่รั่วข้อมูล)
    const cross = await api(app, other)
      .put('/v1/orders/external/SHARED-1')
      .send(body(k))
      .expect(422);
    expect(cross.body.errors.map((e: { code: string }) => e.code)).toContain('reference_not_found');
    const theirs = await api(app, other)
      .put('/v1/orders/external/SHARED-1')
      .send({
        requestedDate: today,
        stops: [
          { type: 'PICKUP', siteText: 'คลัง' },
          { type: 'DELIVERY', siteText: 'ร้าน' },
        ],
      })
      .expect(201);
    expect(theirs.body.id).not.toBe(mine.id);
    const list = (await api(app, other).get('/v1/orders?limit=200').expect(200)).body.data;
    expect(list.map((x: { id: string }) => x.id)).toEqual([theirs.body.id]);
  });

  it('422 รวมทุกช่อง (path ตามกฎชุดเดียว): id ผิดชนิด, จำนวนเป็น number, วันที่ผิด, ช่องแปลกปลอม', async () => {
    const k = await key();
    const res = await api(app, admin)
      .post('/v1/orders')
      .send(
        body(k, {
          requestedDate: '2026-02-30',
          stops: [{ type: 'PICKUP', siteId: k.customer }],
          lines: [{ description: 'x', qty: 5, unitId: unitTon }],
        }),
      )
      .expect(422);
    const f = res.body.errors.map((e: { field: string; code: string }) => `${e.field}:${e.code}`);
    expect(f).toEqual(
      expect.arrayContaining([
        'requestedDate:invalid_date',
        'stops[0].siteId:invalid_id',
        'lines[0].qty:invalid_type',
      ]),
    );
    const extra = await api(app, admin)
      .post('/v1/orders')
      .send(body(k, { source: 'MANUAL' }))
      .expect(422);
    expect(extra.body.errors[0].field).toBe('source');
  });

  it('list: keyset ไม่ซ้ำไม่ตก + กรอง status / holdReason / customer / source / ช่วงวันที่ / externalId / q · fields', async () => {
    const k = await key();
    await approveRate(k);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++)
      ids.push(
        (
          await api(app, admin)
            .put(`/v1/orders/external/LIST-${i}`)
            .send(
              body(k, {
                customerRef: `LISTPO-${i}`,
                requestedDate: addDays(today, i),
              }),
            )
            .expect(201)
        ).body.id,
      );
    // ไม่มี rate (ลูกค้าอื่น) → ON_HOLD RATE_MISSING
    const k2 = await key();
    const held = (
      await api(app, admin)
        .put('/v1/orders/external/LIST-HELD')
        .send(body(k2, { customerRef: 'LISTPO-held' }))
        .expect(201)
    ).body;
    expect(held.holdReason.code).toBe('RATE_MISSING');
    const krs = await upsertDirect({
      source: 'ERP:krs',
      externalId: 'LIST-KRS',
      customer: { id: tryDecodeId('customer', held.customer.id)! },
      customerRef: 'LISTPO-krs',
      requestedDate: today,
      stops: [{ type: 'PICKUP', siteText: 'คลัง' }],
    });

    const get = async (qs: string) =>
      (await api(app, admin).get(`/v1/orders?${qs}`).expect(200)).body as {
        data: { id: string; [k: string]: unknown }[];
        nextCursor: string | null;
        hasMore: boolean;
      };
    // เดิน cursor ทีละ 2
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const p = await get(`q=LISTPO&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...p.data.map((x) => x.id));
      cursor = p.nextCursor;
      expect(p.hasMore).toBe(cursor !== null);
    } while (cursor);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);

    const desc = await get('q=LISTPO&sort=-updatedAt&limit=200');
    expect(desc.data.map((x) => x.id)).toEqual([...seen].reverse());
    expect((await get('q=LISTPO&status=on_hold')).data.map((x) => x.id).sort()).toEqual(
      [held.id, encodeId('salesOrder', krs.order.id)].sort(),
    );
    // เหตุค้าง = เหตุใดก็ได้ของ holdCodes (ใบ KRS ค้างหลัก CUSTOMER_UNMAPPED แต่มี RATE_MISSING เป็นเหตุรอง)
    const krsId = encodeId('salesOrder', krs.order.id);
    expect((await get('q=LISTPO&holdReason=RATE_MISSING')).data.map((x) => x.id).sort()).toEqual(
      [held.id, krsId].sort(),
    );
    expect((await get('q=LISTPO&holdReason=LOCATION_UNMAPPED')).data.map((x) => x.id)).toEqual([
      krsId,
    ]);
    expect(
      (await get('q=LISTPO&holdReason=SOURCE_ERROR,LOCATION_UNMAPPED')).data.map((x) => x.id),
    ).toEqual([krsId]);
    expect((await get(`customerId=${k.customer}`)).data).toHaveLength(5);
    expect((await get('q=LISTPO&source=ERP:krs')).data.map((x) => x.id)).toEqual([
      encodeId('salesOrder', krs.order.id),
    ]);
    expect((await get('q=LISTPO&source=ERP')).data).toHaveLength(1);
    expect((await get('q=LISTPO&source=API')).data).toHaveLength(6);
    expect((await get('q=LISTPO&source=MANUAL,EXCEL')).data).toHaveLength(0);
    expect(
      (
        await get(
          `customerId=${k.customer}&requestedFrom=${addDays(today, 1)}&requestedTo=${addDays(today, 3)}`,
        )
      ).data,
    ).toHaveLength(3);
    expect((await get('externalId=LIST-3')).data.map((x) => x.id)).toEqual([ids[3]]);
    const soNo = (await api(app, admin).get(`/v1/orders/${ids[2]}`).expect(200)).body.soNo;
    expect((await get(`q=${soNo}`)).data.map((x) => x.id)).toEqual([ids[2]]);
    expect((await get('q=listpo-4')).data.map((x) => x.id)).toEqual([ids[4]]);
    const slim = await get('externalId=LIST-0&fields=soNo,status');
    expect(Object.keys(slim.data[0]!).sort()).toEqual(['id', 'soNo', 'status']);
    await api(app, admin).get('/v1/orders?status=bogus').expect(422);
    await api(app, admin).get('/v1/orders?requestedFrom=2026-02-30').expect(422);
    await api(app, admin).get('/v1/orders?cursor=xxx').expect(422);
    // cursor ผูกกับ sort — ใช้กับ sort อื่น → 422
    const asc = await get('q=LISTPO&limit=2');
    const bad = await api(app, admin)
      .get(`/v1/orders?q=LISTPO&limit=2&sort=-updatedAt&cursor=${asc.nextCursor}`)
      .expect(422);
    expect(bad.body.errors[0]).toMatchObject({ field: 'cursor', code: 'invalid_cursor' });
    // field ไม่รู้จัก → 422
    const f = await api(app, admin).get('/v1/orders?fields=soNo,bogus').expect(422);
    expect(f.body.errors[0]).toMatchObject({ field: 'fields', code: 'unknown_field' });
  });

  it('วันรับของ 1980–2100 · ส่งร่าง (submit) = version +1 ครั้งเดียว + audit 1 แถวที่มีสถานะเปลี่ยน', async () => {
    const k = await key();
    await approveRate(k);
    for (const d of ['1979-12-31', '2101-01-01']) {
      const r = await api(app, admin)
        .post('/v1/orders')
        .send(body(k, { requestedDate: d }))
        .expect(422);
      expect(r.body.errors[0]).toMatchObject({ field: 'requestedDate', code: 'invalid_date' });
    }
    const d = (
      await api(app, admin)
        .post('/v1/orders')
        .send(body(k, { draft: true }))
        .expect(201)
    ).body;
    expect(d).toMatchObject({ status: 'draft', soNo: null, version: 1 });
    const sub = (
      await api(app, admin).patch(`/v1/orders/${d.id}`).send({ draft: false }).expect(200)
    ).body;
    expect(sub.status).toBe('received');
    expect(sub.soNo).toMatch(/^SO-/);
    expect(sub.version).toBe(2);
    const audits = await db.auditLog.findMany({
      where: { entityType: 'sales_order', entityId: tryDecodeId('salesOrder', d.id)! },
      orderBy: { seq: 'asc' },
    });
    expect(audits.map((a) => a.action)).toEqual(['sales_order.created', 'sales_order.updated']);
    expect(JSON.stringify({ ...audits[1], seq: undefined })).toContain('RECEIVED');
  });

  it('null ใน customer / stops / lines (และสมาชิก array) → 422 ทุกทาง (POST / PUT / PATCH) ไม่ใช่ 500', async () => {
    const k = await key();
    const o = (await api(app, admin).post('/v1/orders').send(body(k)).expect(201)).body;
    const cases: [string, object][] = [
      ['customer', { customer: null }],
      ['stops', { stops: null }],
      ['lines', { lines: null }],
      ['stops', { stops: [null] }],
      ['lines', { lines: [null] }],
    ];
    for (const [field, extra] of cases) {
      for (const call of [
        () => api(app, admin).post('/v1/orders').send(body(k, extra)),
        () => api(app, admin).put('/v1/orders/external/NULL-1').send(body(k, extra)),
        () => api(app, admin).patch(`/v1/orders/${o.id}`).send(extra),
      ]) {
        const res = await call();
        expect(res.status, `${field} ${JSON.stringify(extra)}`).toBe(422);
        expect(res.body.code).toBe('validation_failed');
        expect(res.body.errors[0].field).toMatch(new RegExp(`^${field}`));
      }
    }
    expect(await count('NULL-1')).toBe(0);
  });

  it('ใบเดิม: อ้างอิงเดิมที่ถูกปิดใช้ภายหลังไม่ขวาง (แก้ PO ใบ PLANNED ได้) · อ้างอิงใหม่ที่ปิดใช้ → 422 · ไม่ส่ง billingCompanyId = คงของเดิม', async () => {
    const k = await key();
    await approveRate(k);
    const box = await db.unit.create({
      data: { tenantId, code: `BOX${++seed}`, nameTh: `กล่อง ${seed}`, kind: 'COUNT' },
    });
    const boxId = encodeId('unit', box.id);
    const co2Id = await company(tenantId);
    const co2 = encodeId('company', co2Id);
    const ext = 'REF-KEEP-1';
    const o = (
      await api(app, admin)
        .put(`/v1/orders/external/${ext}`)
        .send(
          body(k, {
            billingCompanyId: co2,
            lines: [{ description: 'กล่อง', qty: '3', unitId: boxId }],
          }),
        )
        .expect(201)
    ).body;
    expect(o.billingCompanyId).toBe(co2);
    await db.unit.update({ where: { id: box.id }, data: { status: 'INACTIVE' } });
    await setStatus(o.id, 'PLANNED');
    const po = await api(app, admin)
      .patch(`/v1/orders/${o.id}`)
      .send({ customerRef: 'PO-หลังปิดหน่วย' })
      .expect(200);
    expect(po.body.customerRef).toBe('PO-หลังปิดหน่วย');
    // PUT ไม่ส่ง billingCompanyId → คงนิติบุคคลเดิม (ไม่ routing ใหม่ → ไม่ถูกมองว่าเปลี่ยนแล้ว 409)
    const put = await api(app, admin)
      .put(`/v1/orders/external/${ext}`)
      .send(
        body(k, {
          customerRef: 'PO-2',
          lines: [{ description: 'กล่อง', qty: '3', unitId: boxId }],
        }),
      )
      .expect(200);
    expect(put.body.billingCompanyId).toBe(co2);
    // ใบใหม่ / บรรทัดใหม่ที่อ้างหน่วยปิดใช้ → 422
    const bad = await api(app, admin)
      .post('/v1/orders')
      .send(body(k, { lines: [{ description: 'กล่อง', qty: '1', unitId: boxId }] }))
      .expect(422);
    expect(bad.body.errors[0]).toMatchObject({
      field: 'lines[0].unitId',
      code: 'reference_inactive',
    });
    // นิติบุคคลเดิมถูกปิดใช้ก็ยังแก้ใบได้ (คงของเดิม) — และให้ test อื่นกลับไปมีนิติบุคคลเดียว (routing ค่าเริ่มต้น)
    await db.company.update({ where: { id: co2Id }, data: { status: 'INACTIVE' } });
    await api(app, admin).patch(`/v1/orders/${o.id}`).send({ customerRef: 'PO-3' }).expect(200);
  });

  it('Idempotency replay คืนสถานะเดิม (201/200) + ETag เดิม', async () => {
    const k = await key();
    const ext = `IDEM-${++seed}`;
    const key1 = `k1-${randomUUID()}`;
    const a = await api(app, admin)
      .post('/v1/orders')
      .set('Idempotency-Key', key1)
      .send(body(k, { externalId: ext }))
      .expect(201);
    const a2 = await api(app, admin)
      .post('/v1/orders')
      .set('Idempotency-Key', key1)
      .send(body(k, { externalId: ext }))
      .expect(201);
    expect(a2.headers['idempotent-replayed']).toBe('true');
    expect(a2.headers.etag).toBe(a.headers.etag);
    // POST externalId เดิม (key ใหม่) = อัปเดตใบเดิม 200 → replay ก็ 200
    const key2 = `k2-${randomUUID()}`;
    const b = await api(app, admin)
      .post('/v1/orders')
      .set('Idempotency-Key', key2)
      .send(body(k, { externalId: ext, customerRef: 'PO-B' }))
      .expect(200);
    expect(b.body.id).toBe(a.body.id);
    const b2 = await api(app, admin)
      .post('/v1/orders')
      .set('Idempotency-Key', key2)
      .send(body(k, { externalId: ext, customerRef: 'PO-B' }))
      .expect(200);
    expect(b2.headers['idempotent-replayed']).toBe('true');
    expect(b2.headers.etag).toBe(b.headers.etag);
    expect(b2.headers.etag).toBe(`"${b.body.version}"`);
  });

  it('If-Match กับ PUT: ใบยังไม่มี + If-Match (ETag หรือ *) → 412 ไม่สร้าง · มีแล้ว + * → อัปเดตได้', async () => {
    const k = await key();
    await api(app, admin)
      .put('/v1/orders/external/IFM-1')
      .set('If-Match', '"1"')
      .send(body(k))
      .expect(412);
    await api(app, admin)
      .put('/v1/orders/external/IFM-1')
      .set('If-Match', '*')
      .send(body(k))
      .expect(412);
    expect(await count('IFM-1')).toBe(0);
    await api(app, admin).put('/v1/orders/external/IFM-1').send(body(k)).expect(201);
    const r = await api(app, admin)
      .put('/v1/orders/external/IFM-1')
      .set('If-Match', '*')
      .send(body(k, { customerRef: 'PO-*' }))
      .expect(200);
    expect(r.body.customerRef).toBe('PO-*');
    await api(app, admin)
      .patch(`/v1/orders/${r.body.id}`)
      .set('If-Match', '*')
      .send({ customerRef: 'P2' })
      .expect(200);
  });

  it('ที่มา: ผู้ใช้ที่ login จริง (session) POST = MANUAL · PUT external จากผู้ใช้ = API · source filter ผิด → 422', async () => {
    const PW = 'orders-user-password-2569';
    const roles = await ensureSystemRoles(db, tenantId);
    const u = await db.appUser.create({
      data: {
        tenantId,
        email: 'planner@orders.test',
        name: 'ผู้วางแผน',
        status: 'ACTIVE',
        passwordHash: await hashPassword(PW),
      },
    });
    await db.userRole.create({ data: { tenantId, userId: u.id, roleId: roles.planner! } });
    const user = (await loginFull(app, 'planner@orders.test', PW, '10.71.0.1')).access;
    const k = await key();
    const m = (await api(app, user).post('/v1/orders').send(body(k)).expect(201)).body;
    expect(m).toMatchObject({ source: 'MANUAL', sourceType: 'MANUAL', connector: null });
    const p = (await api(app, user).put('/v1/orders/external/UI-PUT-1').send(body(k)).expect(201))
      .body;
    expect(p.source).toBe('API');
    await api(app, admin).get('/v1/orders?source=FOO').expect(422);
    await api(app, admin).get('/v1/orders?source=ERP:').expect(422);
  });

  it('call path: POST / PUT external / PATCH เขียนผ่าน OrderIntakeService.upsertOrder ทุกครั้ง', async () => {
    const intake = app.get(OrderIntakeService);
    const spy = vi.spyOn(intake, 'upsertOrder');
    try {
      const k = await key();
      const o = (await api(app, admin).post('/v1/orders').send(body(k)).expect(201)).body;
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![0]).toMatchObject({ source: { source: 'API' } });
      await api(app, admin).put('/v1/orders/external/PATH-1').send(body(k)).expect(201);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls[1]![0]).toMatchObject({ externalId: 'PATH-1' });
      await api(app, admin).patch(`/v1/orders/${o.id}`).send({ customerRef: 'P' }).expect(200);
      expect(spy).toHaveBeenCalledTimes(3);
      expect(spy.mock.calls[2]![0]).toMatchObject({ customerRef: 'P' });
      expect(spy.mock.calls[2]![0].id).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });
});
