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
 * ST3-T10 ยกเลิก/คืนสถานะ + ต้นทางแก้หลังวางแผน (docs/04 C, docs/01 §3.3 + §4.1)
 * เกณฑ์ตรวจรับ: upsert ที่เปลี่ยนปลายทางหลัง PLANNED ไม่ทับข้อมูล แต่ขึ้นใบค้างพร้อม diff
 */
describe('order cancel + source change after plan (ST3-T10)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let otherId: string;
  let admin: string;
  let planner: string;
  let dispatcher: string;
  let other: string;
  let seed = 0;
  let unitTon: string;
  const today = bangkokToday();
  const uuid = (kind: Parameters<typeof tryDecodeId>[0], id: string) => tryDecodeId(kind, id)!;
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };

  async function company(tid: string) {
    const c = await db.company.create({
      data: {
        tenantId: tid,
        legalName: `บริษัท ผู้ออกบิล ${++seed}`,
        taxId: validTaxId(1300 + seed),
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
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท ยกเลิก' })).id;
    otherId = (await createTenantWithDefaults(db, { name: 'บริษัท อื่น' })).id;
    await company(tenantId);
    await company(otherId);
    admin = await tokenFor(tenantId);
    planner = await tokenFor(tenantId, SYSTEM_ROLES.planner.permissions.join(' '), 'u-planner');
    dispatcher = await tokenFor(tenantId, SYSTEM_ROLES.dispatcher.permissions.join(' '), 'u-disp');
    other = await tokenFor(otherId);
    const us = (await api(app, admin).get('/v1/units?limit=50').expect(200)).body.data as {
      id: string;
      code: string;
    }[];
    unitTon = uuid('unit', us.find((u) => u.code === 'TON')!.id);
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
          { requestId: randomUUID(), tenantId: tid, actorId: 'connector:krs', locale: 'th', tx },
          () => fn(tx),
        ),
      );
  const upsert = (input: UpsertOrderInput, tid = tenantId) =>
    run((tx) => app.get(OrderIntakeService).upsertOrder(input, tx), tid);
  const errOf = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      return e as { code?: string; errors?: { field: string; code: string }[] };
    }
    throw new Error('expected failure');
  };

  const newSite = async (name?: string) =>
    uuid(
      'site',
      (
        await api(app, admin)
          .post('/v1/customer-sites')
          .send({ name: name ?? `จุดรับส่ง ${++seed}`, kind: 'DROPOFF', address: ADDR })
          .expect(201)
      ).body.id,
    );
  const newCustomer = async () =>
    uuid(
      'customer',
      (
        await api(app, admin)
          .post('/v1/customers')
          .send({ legalName: `ลูกค้า ${++seed}`, taxId: validTaxId(9300 + seed) })
          .expect(201)
      ).body.id,
    );
  type Key = { customer: string; origin: string; dest: string };
  const key = async (): Promise<Key> => ({
    customer: await newCustomer(),
    origin: await newSite(),
    dest: await newSite(`คลังปลายทางเดิม ${++seed}`),
  });
  /** ใบจาก connector (ERP:krs) ด้วย externalId */
  const erp = (k: Key, ext: string, dest = k.dest): UpsertOrderInput => ({
    source: 'ERP:krs',
    externalId: ext,
    customer: { id: k.customer },
    requestedDate: today,
    stops: [
      { type: 'PICKUP', siteId: k.origin },
      { type: 'DELIVERY', siteId: dest },
    ],
    lines: [{ description: 'ปูนซีเมนต์', qty: '10', unitId: unitTon, weightKg: '10000' }],
    rawPayload: { soNo: ext, dest },
  });
  const doOf = async (soId: string) =>
    (await run((tx) => app.get(DeliveryOrderService).listForOrder(soId, {}, tx))).filter(
      (d) => d.status !== 'CANCELLED',
    );
  const so = (id: string) =>
    db.salesOrder.findUniqueOrThrow({
      where: { id },
      include: { stops: { orderBy: { sequence: 'asc' } }, holdReasonCode: true },
    });
  const createTrip = (deliveryOrderIds: string[]) =>
    api(app, admin).post('/v1/trips').send({ tripDate: today, deliveryOrderIds }).expect(201);
  /** ใบ connector ที่ลงเที่ยวแล้ว (PLANNED) */
  const planned = async (ext: string) => {
    const k = await key();
    const input = erp(k, ext);
    const { order } = await upsert(input);
    const [d] = await doOf(order.id);
    const trip = (await createTrip([encodeId('deliveryOrder', d!.id)])).body as { id: string };
    expect((await so(order.id)).status).toBe('PLANNED');
    return { k, input, id: order.id, pub: encodeId('salesOrder', order.id), doId: d!.id, trip };
  };
  const reason = 'ลูกค้ายืนยันทางโทรศัพท์แล้ว';

  it('เกณฑ์ตรวจรับ: connector เปลี่ยนปลายทางหลัง PLANNED → ไม่ทับข้อมูล + ธง SOURCE_CHANGED_AFTER_PLAN + diff (สถานะคงเดิม)', async () => {
    const p = await planned('KRS-ACC-1');
    const before = await so(p.id);
    const newDest = await newSite('คลังปลายทางใหม่ ลาดกระบัง');
    const r = await upsert(erp(p.k, 'KRS-ACC-1', newDest));
    expect(r.changed).toBe(true);
    expect(r.sourceChange?.status).toBe('PENDING');
    const after = await so(p.id);
    // ไม่ทับ: ปลายทาง/สถานะ/ข้อมูลเดิม
    expect(after.status).toBe('PLANNED');
    expect(after.stops[1]!.siteId).toBe(p.k.dest);
    expect(after.inputHash).toBe(before.inputHash);
    expect(after.version).toBe(before.version + 1);
    expect(after.sourceChangedAfterPlan).toBe(true);
    expect(after.sourceDiff).toEqual([
      {
        group: 'stops',
        field: 'stops[1].siteId',
        before: before.stops[1]!.siteText,
        after: 'คลังปลายทางใหม่ ลาดกระบัง',
        kind: 'text',
      },
    ]);
    const changes = await db.orderSourceChange.findMany({ where: { salesOrderId: p.id } });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      status: 'PENDING',
      source: 'CONNECTOR',
      sourceConnector: 'krs',
      orderStatus: 'PLANNED',
      baseVersion: before.version,
    });
    expect(changes[0]!.rawPayload).toEqual({ soNo: 'KRS-ACC-1', dest: newDest });
    // DO ในเที่ยวไม่ถูกแตะ
    expect(
      (await db.deliveryOrder.findUniqueOrThrow({ where: { id: p.doId } })).tripId,
    ).not.toBeNull();
    expect(
      await db.auditLog.count({ where: { entityId: p.id, action: 'sales_order.source_changed' } }),
    ).toBe(1);
    const ev = await db.domainEvent.findMany({
      where: { localId: p.id, type: 'order.updated', occurredAt: { gte: changes[0]!.createdAt } },
    });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.previousAttributes).toEqual({ sourceChangedAfterPlan: false });
    expect(ev[0]!.snapshot).toMatchObject({ status: 'PLANNED', sourceChangedAfterPlan: true });
    // ต้นทางส่งชุดเดิมซ้ำ = ไม่มีอะไรเปลี่ยน
    const again = await upsert(erp(p.k, 'KRS-ACC-1', newDest));
    expect(again.changed).toBe(false);
    expect(again.sourceChange).toEqual({ id: changes[0]!.id, status: 'PENDING' });
    expect((await so(p.id)).version).toBe(after.version);
    // API: GET ใบมีชุดรอตัดสิน + กรองหน้างานค้างด้วยเหตุ SOURCE_CHANGED_AFTER_PLAN
    const g = (await api(app, admin).get(`/v1/orders/${p.pub}`).expect(200)).body;
    expect(g.status).toBe('planned');
    expect(g.sourceChangedAfterPlan).toBe(true);
    expect(g.sourceChange).toMatchObject({
      id: encodeId('orderSourceChange', changes[0]!.id),
      status: 'PENDING',
      source: 'ERP:krs',
      orderStatus: 'planned',
      changes: [{ field: 'stops[1].siteId', after: 'คลังปลายทางใหม่ ลาดกระบัง' }],
    });
    const held = await api(app, admin)
      .get('/v1/orders?holdReason=SOURCE_CHANGED_AFTER_PLAN')
      .expect(200);
    expect(held.body.data.map((o: { id: string }) => o.id)).toEqual([p.pub]);
  });

  it('Open API (PUT external) แก้ช่องที่ล็อกหลังวางแผน → ยัง 409 order_locked_for_update (docs/04 C) ไม่เก็บ diff', async () => {
    const k = await key();
    const input: UpsertOrderInput = { ...erp(k, 'API-LOCK-1'), source: 'API' };
    const { order } = await upsert(input);
    const [d] = await doOf(order.id);
    await createTrip([encodeId('deliveryOrder', d!.id)]);
    const e = await errOf(
      upsert({ ...input, stops: [input.stops[0]!, { type: 'DELIVERY', siteId: await newSite() }] }),
    );
    expect(e.code).toBe('order_locked_for_update');
    expect(await db.orderSourceChange.count({ where: { salesOrderId: order.id } })).toBe(0);
  });

  it('รับการเปลี่ยนแปลง: DO ยังอยู่ในเที่ยว → 409 order_on_trip · ถอดจากเที่ยวแล้วรับ → เขียนผ่าน upsertOrder (DO ชุดใหม่) + เหตุผล + audit', async () => {
    const p = await planned('KRS-ACC-2');
    const newDest = await newSite('คลังใหม่ บางนา');
    const { sourceChange } = await upsert(erp(p.k, 'KRS-ACC-2', newDest));
    const changeId = encodeId('orderSourceChange', sourceChange!.id);
    const url = `/v1/orders/${p.pub}/source-changes/${changeId}`;
    // เหตุผลสั้น → 422
    expect(
      (await api(app, admin).post(`${url}/accept`).send({ reason: 'สั้น' }).expect(422)).body.code,
    ).toBe('validation_failed');
    // ยังอยู่ในเที่ยว
    const blocked = await api(app, planner).post(`${url}/accept`).send({ reason }).expect(409);
    expect(blocked.body).toMatchObject({
      code: 'order_on_trip',
      orderStatus: 'PLANNED',
      lockedFields: ['stops'],
    });
    expect((await so(p.id)).stops[1]!.siteId).toBe(p.k.dest);
    // ถอด DO ออกจากเที่ยว (ST3-T11) → SO กลับเข้ากองงาน (ธงยังอยู่ — ไม่ทับอัตโนมัติ)
    await api(app, admin)
      .post(`/v1/trips/${p.trip.id}/detach`)
      .send({ deliveryOrderIds: [encodeId('deliveryOrder', p.doId)] })
      .expect(200);
    const detached = await so(p.id);
    expect(['RECEIVED', 'ON_HOLD']).toContain(detached.status);
    expect(detached.sourceChangedAfterPlan).toBe(true);
    expect(detached.stops[1]!.siteId).toBe(p.k.dest);
    // รับ
    const ok = await api(app, planner).post(`${url}/accept`).send({ reason }).expect(200);
    expect(ok.headers.etag).toBe(`"${ok.body.version}"`);
    expect(ok.body.sourceChangedAfterPlan).toBe(false);
    expect(ok.body.sourceChange).toBeNull();
    expect(ok.body.stops[1].siteId).toBe(encodeId('site', newDest));
    const row = await db.orderSourceChange.findUniqueOrThrow({ where: { id: sourceChange!.id } });
    expect(row).toMatchObject({
      status: 'ACCEPTED',
      decidedBy: 'u-planner',
      decisionReason: reason,
    });
    expect(row.decidedAt).toBeTruthy();
    const a = await db.auditLog.findFirstOrThrow({
      where: { entityId: p.id, action: 'sales_order.source_change_accepted' },
    });
    expect(a.reason).toBe(reason);
    // raw ของต้นทางถูกเก็บตอนรับ · DO เดิมยกเลิก → ชุดใหม่ไปปลายทางใหม่ (ORD-085)
    const final = await so(p.id);
    expect(final.rawPayload).toEqual({ soNo: 'KRS-ACC-2', dest: newDest });
    expect((await db.deliveryOrder.findUniqueOrThrow({ where: { id: p.doId } })).status).toBe(
      'CANCELLED',
    );
    const live = await doOf(p.id);
    expect(live).toHaveLength(1);
    expect(live[0]!.destSiteId).toBe(newDest);
    // รับซ้ำ → 409
    expect(
      (await api(app, planner).post(`${url}/accept`).send({ reason }).expect(409)).body.code,
    ).toBe('source_change_not_pending');
    // ต้นทางส่งชุดที่รับแล้วซ้ำ = no-op
    expect((await upsert(erp(p.k, 'KRS-ACC-2', newDest))).changed).toBe(false);
  });

  it('ไม่รับ: ข้อมูลคงเดิม ปลดธง + เหตุผล + event · ส่งชุดเดิมซ้ำไม่ขึ้นใหม่ · ชุดใหม่แทนชุดเก่า (SUPERSEDED) · ต้นทางกลับเป็นค่าเดิม = ปิดเอง', async () => {
    const p = await planned('KRS-REJ-1');
    const d1 = await newSite('ปลายทาง ก');
    const d2 = await newSite('ปลายทาง ข');
    const c1 = (await upsert(erp(p.k, 'KRS-REJ-1', d1))).sourceChange!;
    const before = await so(p.id);
    const url = `/v1/orders/${p.pub}/source-changes/${encodeId('orderSourceChange', c1.id)}`;
    const r = await api(app, admin)
      .post(`${url}/reject`)
      .send({ reason: 'ลูกค้าแจ้งว่าใช้ปลายทางเดิม' })
      .expect(200);
    expect(r.body.sourceChangedAfterPlan).toBe(false);
    expect(r.body.status).toBe('planned');
    expect(r.body.stops[1].siteId).toBe(encodeId('site', p.k.dest));
    expect(r.body.version).toBe(before.version + 1);
    expect(await db.orderSourceChange.findUniqueOrThrow({ where: { id: c1.id } })).toMatchObject({
      status: 'REJECTED',
      decisionReason: 'ลูกค้าแจ้งว่าใช้ปลายทางเดิม',
    });
    expect(
      (
        await db.auditLog.findFirstOrThrow({
          where: { entityId: p.id, action: 'sales_order.source_change_rejected' },
        })
      ).reason,
    ).toBe('ลูกค้าแจ้งว่าใช้ปลายทางเดิม');
    // ชุดเดิมซ้ำ → ไม่ขึ้นใหม่
    const again = await upsert(erp(p.k, 'KRS-REJ-1', d1));
    expect(again).toMatchObject({
      changed: false,
      sourceChange: { id: c1.id, status: 'REJECTED' },
    });
    expect((await so(p.id)).sourceChangedAfterPlan).toBe(false);
    // ชุดใหม่ 2 ชุดติดกัน → ชุดแรก SUPERSEDED ชี้ชุดใหม่
    const c2 = (await upsert(erp(p.k, 'KRS-REJ-1', d2))).sourceChange!;
    const c3 = (await upsert({ ...erp(p.k, 'KRS-REJ-1', d2), customerRef: 'PO-ใหม่' }))
      .sourceChange!;
    expect(c3.id).not.toBe(c2.id);
    expect(await db.orderSourceChange.findUniqueOrThrow({ where: { id: c2.id } })).toMatchObject({
      status: 'SUPERSEDED',
      supersededById: c3.id,
    });
    expect((await so(p.id)).sourceDiff).toEqual([
      expect.objectContaining({ field: 'customerRef', before: null, after: 'PO-ใหม่' }),
      expect.objectContaining({ field: 'stops[1].siteId', after: 'ปลายทาง ข' }),
    ]);
    // ตัดสินชุดที่ถูกแทนแล้ว → 409
    expect(
      (
        await api(app, admin)
          .post(`/v1/orders/${p.pub}/source-changes/${encodeId('orderSourceChange', c2.id)}/reject`)
          .send({ reason })
          .expect(409)
      ).body.code,
    ).toBe('source_change_not_pending');
    // ต้นทางกลับเป็นข้อมูลเดียวกับ TMS → ชุดที่รอถูกปิดเอง + ปลดธง
    const back = await upsert(erp(p.k, 'KRS-REJ-1'));
    expect(back.order.sourceChangedAfterPlan).toBe(false);
    expect((await db.orderSourceChange.findUniqueOrThrow({ where: { id: c3.id } })).status).toBe(
      'SUPERSEDED',
    );
    expect(
      await db.auditLog.count({
        where: { entityId: p.id, action: 'sales_order.source_change_superseded' },
      }),
    ).toBe(1);
  });

  it('หลังวางแผน ต้นทางแก้เฉพาะช่องที่แก้ได้ (เลข PO/ช่วงเวลา) → เขียนเลยไม่ขึ้น diff และแทนชุดที่รอ', async () => {
    const p = await planned('KRS-PO-1');
    await upsert(erp(p.k, 'KRS-PO-1', await newSite()));
    expect((await so(p.id)).sourceChangedAfterPlan).toBe(true);
    const r = await upsert({ ...erp(p.k, 'KRS-PO-1'), customerRef: 'PO-777' });
    expect(r.sourceChange).toBeUndefined();
    const after = await so(p.id);
    expect(after.customerRef).toBe('PO-777');
    expect(after.sourceChangedAfterPlan).toBe(false);
    expect(
      await db.orderSourceChange.count({ where: { salesOrderId: p.id, status: 'PENDING' } }),
    ).toBe(0);
  });

  it('ยกเลิก: RECEIVED + DO ร่าง → SO/DO CANCELLED ด้วยเหตุผล + reason code, ประวัติ, order.cancelled, audit · ยกเลิกซ้ำ/แก้หลังยกเลิก → 409', async () => {
    const k = await key();
    const { order } = await upsert({ ...erp(k, 'KRS-CXL-1'), source: 'MANUAL', externalId: null });
    const [d] = await doOf(order.id);
    const pub = encodeId('salesOrder', order.id);
    const rcs = (await api(app, admin).get('/v1/reason-codes?category=CANCEL&limit=50').expect(200))
      .body.data as { id: string; code: string }[];
    const rc = rcs.find((x) => x.code === 'CUSTOMER_CANCELLED')!;
    const cur = (await api(app, admin).get(`/v1/orders/${pub}`).expect(200)).body;
    // If-Match เก่า → 412
    expect(
      (
        await api(app, admin)
          .post(`/v1/orders/${pub}/cancel`)
          .set('If-Match', '"999"')
          .send({ reason })
      ).status,
    ).toBe(412);
    const r = await api(app, planner)
      .post(`/v1/orders/${pub}/cancel`)
      .set('If-Match', `"${cur.version}"`)
      .send({ reason: 'ลูกค้ายกเลิกคำสั่งทางอีเมล', reasonCodeId: rc.id })
      .expect(200);
    expect(r.body.status).toBe('cancelled');
    expect(r.body.editableFields).toEqual([]);
    expect(r.headers.etag).toBe(`"${r.body.version}"`);
    expect((await db.deliveryOrder.findUniqueOrThrow({ where: { id: d!.id } })).status).toBe(
      'CANCELLED',
    );
    const h = await db.docStatusHistory.findFirstOrThrow({
      where: { docType: 'sales_order', docId: order.id, event: 'cancel' },
    });
    expect(h).toMatchObject({
      fromStatus: order.status,
      toStatus: 'CANCELLED',
      reasonCodeId: uuid('reasonCode', rc.id),
      note: 'ลูกค้ายกเลิกคำสั่งทางอีเมล',
      actorId: 'u-planner',
    });
    const dh = await db.docStatusHistory.findFirstOrThrow({
      where: { docType: 'delivery_order', docId: d!.id, toStatus: 'CANCELLED' },
    });
    expect(dh.reasonCodeId).toBe(uuid('reasonCode', rc.id));
    expect(
      await db.domainEvent.count({ where: { localId: order.id, type: 'order.cancelled' } }),
    ).toBe(1);
    const a = await db.auditLog.findFirstOrThrow({
      where: { entityId: order.id, action: 'sales_order.cancelled' },
    });
    expect(a.reason).toBe('ลูกค้ายกเลิกคำสั่งทางอีเมล');
    expect(a.after).toMatchObject({ deliveryOrdersCancelled: [d!.doNo] });
    // ยกเลิกซ้ำ → 409 · แก้หลังยกเลิก → 409
    expect(
      (await api(app, admin).post(`/v1/orders/${pub}/cancel`).send({ reason }).expect(409)).body
        .code,
    ).toBe('invalid_state_transition');
    await api(app, admin)
      .patch(`/v1/orders/${pub}`)
      .send({ customerRef: 'หลังยกเลิก' })
      .expect(409);
  });

  it('ยกเลิกใบที่มี DO อยู่ในเที่ยว → 409 order_on_trip (ไม่ถอดให้เอง) · ใบที่ต้นทางแก้รอตัดสินอยู่ ยกเลิกแล้วชุดนั้นปิด', async () => {
    const p = await planned('KRS-CXL-2');
    await upsert(erp(p.k, 'KRS-CXL-2', await newSite()));
    const r = await api(app, admin).post(`/v1/orders/${p.pub}/cancel`).send({ reason }).expect(409);
    expect(r.body.code).toBe('order_on_trip');
    expect(r.body.deliveryOrders).toHaveLength(1);
    expect((await so(p.id)).status).toBe('PLANNED');
    // ถอดจากเที่ยวก่อน แล้วยกเลิกได้
    await api(app, admin)
      .post(`/v1/trips/${p.trip.id}/detach`)
      .send({ deliveryOrderIds: [encodeId('deliveryOrder', p.doId)] })
      .expect(200);
    const ok = await api(app, admin)
      .post(`/v1/orders/${p.pub}/cancel`)
      .send({ reason })
      .expect(200);
    expect(ok.body).toMatchObject({
      status: 'cancelled',
      sourceChangedAfterPlan: false,
      sourceChange: null,
    });
    expect(
      await db.orderSourceChange.count({ where: { salesOrderId: p.id, status: 'SUPERSEDED' } }),
    ).toBe(1);
    // ต้นทางส่งมาอีกหลังยกเลิก → 409 (ไม่เก็บ diff ของใบที่ยกเลิก)
    expect((await errOf(upsert(erp(p.k, 'KRS-CXL-2', await newSite())))).code).toBe(
      'order_locked_for_update',
    );
  });

  it('ยกเลิกร่าง → CANCELLED ไม่ออกเลข · เหตุผลสั้น/reason code ผิดหมวด → 422 · สิทธิ์ · แยก tenant', async () => {
    const k = await key();
    const { order } = await upsert({
      ...erp(k, 'X'),
      source: 'MANUAL',
      externalId: null,
      draft: true,
    });
    const pub = encodeId('salesOrder', order.id);
    expect(
      (
        await api(app, admin)
          .post(`/v1/orders/${pub}/cancel`)
          .send({ reason: 'สั้นไป' })
          .expect(422)
      ).body.errors[0].field,
    ).toBe('reason');
    const hold = (
      await api(app, admin).get('/v1/reason-codes?category=ORDER_HOLD&limit=50').expect(200)
    ).body.data[0] as { id: string };
    expect(
      (
        await api(app, admin)
          .post(`/v1/orders/${pub}/cancel`)
          .send({ reason, reasonCodeId: hold.id })
          .expect(422)
      ).body.errors[0].field,
    ).toBe('reasonCodeId');
    // dispatcher ไม่มี orders:cancel / orders:write
    await api(app, dispatcher).post(`/v1/orders/${pub}/cancel`).send({ reason }).expect(403);
    // tenant อื่น → 404
    expect(
      (await api(app, other).post(`/v1/orders/${pub}/cancel`).send({ reason }).expect(404)).body
        .code,
    ).toBe('not_found');
    const r = await api(app, admin).post(`/v1/orders/${pub}/cancel`).send({ reason }).expect(200);
    expect(r.body).toMatchObject({ status: 'cancelled', soNo: null });

    // รับ/ไม่รับ: สิทธิ์ + ชุดของใบอื่น/tenant อื่น → 404
    const p = await planned('KRS-PERM-1');
    const c = (await upsert(erp(p.k, 'KRS-PERM-1', await newSite()))).sourceChange!;
    const cid = encodeId('orderSourceChange', c.id);
    await api(app, dispatcher)
      .post(`/v1/orders/${p.pub}/source-changes/${cid}/reject`)
      .send({ reason })
      .expect(403);
    await api(app, other)
      .post(`/v1/orders/${p.pub}/source-changes/${cid}/reject`)
      .send({ reason })
      .expect(404);
    await api(app, admin)
      .post(`/v1/orders/${pub}/source-changes/${cid}/reject`)
      .send({ reason })
      .expect(404);
    await api(app, admin)
      .post(`/v1/orders/${p.pub}/source-changes/osc_bad/reject`)
      .send({ reason })
      .expect(404);
    expect((await so(p.id)).sourceChangedAfterPlan).toBe(true);
  });

  it('constraint: ผลตัดสินต้องมีผู้ตัดสิน/เหตุผล ≥ 10, PENDING ได้ชุดเดียวต่อใบ, ธง ⇔ diff, tms_app ลบไม่ได้', async () => {
    const p = await planned('KRS-DB-1');
    const c = (await upsert(erp(p.k, 'KRS-DB-1', await newSite()))).sourceChange!;
    await expect(
      db.$executeRaw`UPDATE order_source_change SET status = 'REJECTED', decided_at = now(), decided_by = 'x', decision_reason = 'สั้น' WHERE id = ${c.id}::uuid`,
    ).rejects.toThrow(/order_source_change_decision/);
    const row = await db.orderSourceChange.findUniqueOrThrow({ where: { id: c.id } });
    await expect(
      db.orderSourceChange.create({
        data: {
          tenantId,
          salesOrderId: p.id,
          source: 'CONNECTOR',
          sourceConnector: 'krs',
          orderStatus: 'PLANNED',
          baseVersion: 1,
          input: row.input as object,
          inputHash: 'x',
          changes: [],
        },
      }),
    ).rejects.toThrow(/order_source_change_one_pending|Unique constraint/);
    await expect(
      db.$executeRaw`UPDATE sales_order SET source_diff = NULL WHERE id = ${p.id}::uuid`,
    ).rejects.toThrow(/sales_order_source_diff/);
    const appDb = new PrismaClient({ datasources: { db: { url: process.env.APP_DATABASE_URL } } });
    try {
      await expect(
        appDb.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
          await tx.$executeRaw`DELETE FROM order_source_change WHERE id = ${c.id}::uuid`;
        }),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await appDb.$disconnect();
    }
  });
});
