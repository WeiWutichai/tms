import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { planAutoReschedule } from '@tms/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { requestContext } from '../src/common/request-context';
import { DbService, type Tx } from '../src/db/db.service';
import { DeliveryOrderService } from '../src/modules/delivery-orders/delivery-order.service';
import {
  OrderIntakeService,
  type UpsertOrderInput,
} from '../src/modules/orders/order-intake.service';
import { StopProjectionService } from '../src/modules/stops/stop-projection.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST4-T12 Undelivered-retain + auto-reschedule (docs/04 E2; docs/01 §4.3 FAILED → redeliver; spec/04 DRV-171) — เกณฑ์ตรวจรับ:
 * ปิดจุดด้วยเหตุผลแบบ auto-reschedule → DO ใหม่วันถัดไป (รอจัดบนกระดาน ไม่จัดรถให้เอง) · เกินจำนวนครั้ง → ใบค้าง RESCHEDULES_EXHAUSTED
 * + ไม่ติ๊กธง = ผู้จัดรถตัดสิน · idempotent (คำนวณซ้ำ/event ซ้ำ) · audit + domain_event · แยก tenant
 */
describe('auto-reschedule (ST4-T12)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let admin: string;
  let seed = 0;
  let unitTon: string;
  let vt6: string;
  const today = bangkokToday();
  const uuid = (kind: Parameters<typeof tryDecodeId>[0], id: string) => tryDecodeId(kind, id)!;
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท นัดส่งใหม่' })).id;
    const c = await db.company.create({
      data: { tenantId, legalName: 'บริษัท ผู้ออกบิล', taxId: validTaxId(911) },
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
    uuid(
      'site',
      (
        await api(app, admin)
          .post('/v1/customer-sites')
          .send({ name: `จุด ${++seed}`, kind: 'DROPOFF', address: ADDR })
          .expect(201)
      ).body.id,
    );
  const newCustomer = async () =>
    uuid(
      'customer',
      (
        await api(app, admin)
          .post('/v1/customers')
          .send({ legalName: `ลูกค้า ${++seed}`, taxId: validTaxId(9800 + seed) })
          .expect(201)
      ).body.id,
    );
  /** SO 1 ใบ (รับ → ส่ง ช่วงส่ง 09:00–12:00 ไทยของวันนี้) */
  const newOrder = async () => {
    const input: UpsertOrderInput = {
      source: 'MANUAL',
      customer: { id: await newCustomer() },
      requestedDate: today,
      stops: [
        { type: 'PICKUP', siteId: await newSite() },
        {
          type: 'DELIVERY',
          siteId: await newSite(),
          windowStart: `${today}T09:00:00+07:00`,
          windowEnd: `${today}T12:00:00+07:00`,
        },
      ],
      lines: [{ description: 'ปูนซีเมนต์', qty: '2', unitId: unitTon, weightKg: '2000' }],
    };
    const { order: so } = await run((tx) => app.get(OrderIntakeService).upsertOrder(input, tx));
    const dos = await run((tx) => app.get(DeliveryOrderService).listForOrder(so.id, {}, tx));
    return { soId: so.id, doId: dos[0]!.id };
  };
  const newVehicle = async () => {
    const v = (
      await api(app, admin)
        .post('/v1/vehicles')
        .send({
          plate: `8${++seed % 10}-${String(2000 + seed)}`,
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
        phone: `088-${String(n).padStart(3, '0')}-${String(n).padStart(4, '0')}`,
        employmentType: 'EMPLOYEE_SALARIED',
        licenceClass: 'T2',
        licenceExpiresOn: '2030-03-31',
        defaultVehicleId: v.id,
      })
      .expect(201);
    return v;
  };
  /** เที่ยวจาก DO (uuid) → จัดรถ + ปล่อยรถ */
  const dispatched = async (doId: string, tripDate = today) => {
    const vid = (await newVehicle()).id;
    const t = (
      await api(app, admin)
        .post('/v1/trips')
        .send({ tripDate, deliveryOrderIds: [encodeId('deliveryOrder', doId)], vehicleId: vid })
        .expect(201)
    ).body;
    const r = await api(app, admin)
      .post(`/v1/trips/${t.id}/assign`)
      .send({ vehicleId: vid, dispatch: true });
    if (r.status !== 200) {
      expect(r.status).toBe(409);
      await api(app, admin)
        .post(`/v1/trips/${t.id}/assign`)
        .send({
          vehicleId: vid,
          dispatch: true,
          ruleKeys: r.body.warnings.map((x: { key: string }) => x.key),
          overrideReason: 'ทดสอบนัดส่งใหม่อัตโนมัติ',
        })
        .expect(200);
    }
    const full = (await api(app, admin).get(`/v1/trips/${t.id}`).expect(200)).body;
    expect(full.status).toBe('DISPATCHED');
    const stops = full.stops as {
      id: string;
      type: string;
      windowStart: string | null;
      windowEnd: string | null;
    }[];
    return {
      id: full.id as string,
      uuid: uuid('trip', full.id),
      pickup: stops.find((s) => s.type === 'PICKUP')!,
      drop: stops.find((s) => s.type === 'DELIVERY')!,
    };
  };

  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const post = (stop: string, action: string, min: number, extra: object = {}) =>
    api(app, admin)
      .post(`/v1/stops/${stop}/${action}`)
      .send({ clientEventId: randomUUID(), occurredAt: ago(min), ...extra });
  const reason = async (code: string) =>
    encodeId(
      'reasonCode',
      (
        await db.reasonCode.findFirstOrThrow({
          where: { tenantId, category: 'DELIVERY_FAILED', code },
        })
      ).id,
    );
  /** รับของแล้วไปจุดส่ง → ปิดไม่สำเร็จด้วยเหตุผล (คืน body ของ event ปิด + เวลา) */
  const failAtDrop = async (
    t: Awaited<ReturnType<typeof dispatched>>,
    code: string,
    outcome: 'UNDELIVERED_RETAIN' | 'FAILED' = 'UNDELIVERED_RETAIN',
  ) => {
    await post(t.pickup.id, 'arrive', 55).expect(201);
    await post(t.pickup.id, 'complete', 50, { outcome: 'DELIVERED' }).expect(201);
    await post(t.drop.id, 'arrive', 40).expect(201);
    const at = ago(30);
    const body = {
      clientEventId: randomUUID(),
      occurredAt: at,
      outcome,
      reasonCodeId: await reason(code),
      note: 'ร้านปิด โทรไม่ติด',
    };
    const r = await api(app, admin).post(`/v1/stops/${t.drop.id}/complete`).send(body).expect(201);
    return { body, at, res: r.body };
  };
  const redeliveries = (doId: string) =>
    db.deliveryOrder.findMany({ where: { redeliveryOfId: doId }, orderBy: { createdAt: 'asc' } });
  const so = (id: string) =>
    db.salesOrder.findUniqueOrThrow({
      where: { id },
      include: { holdReasonCode: { select: { code: true } } },
    });
  /** SO กลับมารอจัด (RECEIVED หรือค้างด้วยเหตุของทางเข้า — ไม่ใช่ RESCHEDULES_EXHAUSTED) */
  const waiting = async (id: string) => {
    const x = await so(id);
    return (
      x.status === 'RECEIVED' ||
      (x.status === 'ON_HOLD' && x.holdReasonCode?.code !== 'RESCHEDULES_EXHAUSTED')
    );
  };
  const expectedDate = (at: string) =>
    planAutoReschedule({ autoReschedule: true, previousCount: 0, max: 2, failedAt: at, today })!
      .doDate;

  it('เกณฑ์ตรวจรับ: ปิดจุด "ของยังอยู่บนรถ" + เหตุผลแบบ auto-reschedule → DO เดิม CANCELLED (redeliver) + DO ใหม่วันถัดไป รอจัดบนกระดาน · SO กลับรอจัด · audit + domain_event · ไทม์ไลน์เที่ยวเห็น', async () => {
    const { soId, doId } = await newOrder();
    const t = await dispatched(doId);
    const { at } = await failAtDrop(t, 'SHOP_CLOSED');

    const old = await db.deliveryOrder.findUniqueOrThrow({ where: { id: doId } });
    expect(old.status).toBe('CANCELLED');
    const h = await db.docStatusHistory.findMany({
      where: { docType: 'delivery_order', docId: doId },
      orderBy: { at: 'asc' },
    });
    expect(h.map((x) => x.event)).toEqual(expect.arrayContaining(['fail', 'redeliver']));
    const [nd, ...more] = await redeliveries(doId);
    expect(more).toHaveLength(0);
    expect(nd).toMatchObject({
      status: 'DRAFT',
      tripId: null,
      tripStopId: null,
      rescheduleCount: 1,
      salesOrderId: soId,
      originSiteId: old.originSiteId,
      destSiteId: old.destSiteId,
    });
    expect(nd!.doNo).not.toBe(old.doNo);
    expect(nd!.doDate.toISOString().slice(0, 10)).toBe(expectedDate(at));
    const lines = await db.deliveryOrderLine.findMany({ where: { deliveryOrderId: nd!.id } });
    expect(lines.map((l) => [l.qtyPlanned.toString(), l.unit])).toEqual([['2', 'TON']]);
    // SO: IN_TRANSIT → PLANNED → RECEIVED (กลับกล่องรอจัด — ไม่จัดรถให้เอง) แล้วทางเข้าประเมินใบค้างใหม่ (ไม่มี rate card = RATE_MISSING)
    expect(await waiting(soId)).toBe(true);
    // เที่ยวจบ (ทุกจุดปิด) — ของที่ค้างบนรถไปกับ DO ใหม่
    expect((await db.trip.findUniqueOrThrow({ where: { id: t.uuid } })).status).toBe('COMPLETED');

    const ev = await db.domainEvent.findMany({
      where: { tenantId, type: 'delivery_order.rescheduled' },
    });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.snapshot).toMatchObject({
      redeliveryOfId: doId,
      attempt: 1,
      max: 2,
      exhausted: false,
      outcome: 'UNDELIVERED_RETAIN',
      reasonCode: 'SHOP_CLOSED',
    });
    const audit = await db.auditLog.findFirstOrThrow({
      where: { tenantId, action: 'delivery_order.redelivered', entityId: doId },
    });
    expect(audit.reason).toContain('นัดส่งใหม่อัตโนมัติ ครั้งที่ 1');
    expect(audit.reason).toContain('ลูกค้าปิดทำการ');

    // กระดานวางแผน: SO อยู่ใน "SO รอจัด" พร้อม DO ส่งซ้ำ (วันที่นัด, ช่วงเวลาเลื่อนตามวัน)
    const board = (await api(app, admin).get(`/v1/planning/board?date=${today}`).expect(200)).body;
    const card = board.pool.find((p: { id: string }) => p.id === encodeId('salesOrder', soId)) as {
      windowStart: string;
      deliveryOrders: {
        doNo: string;
        doDate: string;
        redeliveryOfNo: string | null;
        rescheduleCount: number;
      }[];
    };
    expect(card.deliveryOrders).toEqual([
      expect.objectContaining({
        doNo: nd!.doNo,
        doDate: expectedDate(at),
        redeliveryOfNo: old.doNo,
        rescheduleCount: 1,
      }),
    ]);
    expect(card.windowStart).toBe(new Date(`${expectedDate(at)}T09:00:00+07:00`).toISOString());

    // ไทม์ไลน์เที่ยว: จุดที่ไม่สำเร็จ → DO ใหม่
    const trip = (await api(app, admin).get(`/v1/trips/${t.id}`).expect(200)).body;
    const drop = trip.stops.find((s: { type: string }) => s.type === 'DELIVERY');
    expect(drop.reschedules).toEqual([
      {
        fromDeliveryOrderId: encodeId('deliveryOrder', doId),
        fromDoNo: old.doNo,
        deliveryOrderId: encodeId('deliveryOrder', nd!.id),
        doNo: nd!.doNo,
        doDate: expectedDate(at),
        status: 'DRAFT',
        attempt: 1,
      },
    ]);
    expect(trip.stops.find((s: { type: string }) => s.type === 'PICKUP').reschedules).toEqual([]);

    // DO API: ตัวนับ + อ้างใบเดิม
    const got = (
      await api(app, admin)
        .get(`/v1/delivery-orders/${encodeId('deliveryOrder', nd!.id)}`)
        .expect(200)
    ).body;
    expect(got).toMatchObject({
      rescheduleCount: 1,
      redeliveryOfId: encodeId('deliveryOrder', doId),
      status: 'DRAFT',
    });

    // จัดเที่ยวพรุ่งนี้ให้ DO ใหม่ → จุดส่งได้ช่วงเวลาของวันที่นัด (คงเวลาในวัน)
    const t2 = await dispatched(nd!.id, expectedDate(at));
    expect(t2.drop.windowStart).toBe(new Date(`${expectedDate(at)}T09:00:00+07:00`).toISOString());
    expect(t2.drop.windowEnd).toBe(new Date(`${expectedDate(at)}T12:00:00+07:00`).toISOString());
    expect((await so(soId)).status).toBe('IN_TRANSIT');
  });

  it('idempotent: คำนวณซ้ำ / ส่ง event ปิดเดิมซ้ำ (clientEventId เดิม) → ไม่สร้าง DO ซ้ำ ไม่ออก event ซ้ำ', async () => {
    const { doId } = await newOrder();
    const t = await dispatched(doId);
    const { body } = await failAtDrop(t, 'NO_RECEIVER');
    expect(await redeliveries(doId)).toHaveLength(1);
    const before = await db.domainEvent.count({ where: { tenantId } });
    await run(async (tx) => {
      const p = app.get(StopProjectionService);
      await p.lockTrip(tx, t.uuid);
      await p.project(tx, t.uuid);
    });
    const replay = await api(app, admin).post(`/v1/stops/${t.drop.id}/complete`).send(body);
    expect([200, 201, 409]).toContain(replay.status);
    expect(await redeliveries(doId)).toHaveLength(1);
    expect(await db.domainEvent.count({ where: { tenantId } })).toBe(before);
  });

  it('เหตุผลไม่ติ๊ก auto-reschedule → DO FAILED รอผู้จัดรถตัดสิน (ไม่สร้าง DO ใหม่) · outcome FAILED + เหตุผลแบบ auto ก็นัดใหม่', async () => {
    const a = await newOrder();
    const ta = await dispatched(a.doId);
    await failAtDrop(ta, 'WRONG_ADDRESS');
    expect((await db.deliveryOrder.findUniqueOrThrow({ where: { id: a.doId } })).status).toBe(
      'FAILED',
    );
    expect(await redeliveries(a.doId)).toHaveLength(0);
    expect((await so(a.soId)).status).toBe('IN_TRANSIT');

    const b = await newOrder();
    const tb = await dispatched(b.doId);
    await failAtDrop(tb, 'VEHICLE_BREAKDOWN', 'FAILED');
    expect(await redeliveries(b.doId)).toHaveLength(1);
  });

  it('นับครั้ง: เกินค่าตั้ง dispatch.maxAutoReschedules → DO ใหม่ยังสร้าง แต่ SO ขึ้นใบค้าง RESCHEDULES_EXHAUSTED · จัดรถใหม่ที่กระดานแล้วเคลียร์เอง · ค่าตั้งนอกช่วง 422', async () => {
    await api(app, admin)
      .patch('/v1/settings')
      .send({ values: { 'dispatch.maxAutoReschedules': 11 } })
      .expect(422);
    await api(app, admin)
      .patch('/v1/settings')
      .send({ values: { 'dispatch.maxAutoReschedules': 1 } })
      .expect(200);
    try {
      const { soId, doId } = await newOrder();
      const t1 = await dispatched(doId);
      await failAtDrop(t1, 'SHOP_CLOSED');
      const [d1] = await redeliveries(doId);
      expect(d1!.rescheduleCount).toBe(1);
      expect(await waiting(soId)).toBe(true);

      // ครั้งที่ 2 (เกิน 1) → ใบค้าง
      const t2 = await dispatched(d1!.id);
      await failAtDrop(t2, 'SHOP_CLOSED');
      const [d2] = await redeliveries(d1!.id);
      expect(d2).toMatchObject({ status: 'DRAFT', tripId: null, rescheduleCount: 2 });
      const held = await so(soId);
      expect(held.status).toBe('ON_HOLD');
      expect(held.holdReasonCode?.code).toBe('RESCHEDULES_EXHAUSTED');
      expect(held.holdNote).toContain('นัดส่งใหม่อัตโนมัติครบ 1 ครั้งแล้ว');
      const ev = await db.domainEvent.findFirstOrThrow({
        where: { tenantId, type: 'delivery_order.rescheduled', localId: d2!.id },
      });
      expect(ev.snapshot).toMatchObject({ attempt: 2, max: 1, exhausted: true });
      // หน้าใบค้าง (GET /v1/orders?held=true&holdReason=…) เห็นเหตุ
      const list = (
        await api(app, admin)
          .get('/v1/orders?held=true&holdReason=RESCHEDULES_EXHAUSTED&limit=100')
          .expect(200)
      ).body.data as { id: string; holdReason: { code: string } | null }[];
      expect(list.find((o) => o.id === encodeId('salesOrder', soId))?.holdReason?.code).toBe(
        'RESCHEDULES_EXHAUSTED',
      );
      // กระดาน: ยังอยู่ใน SO รอจัด (ป้ายเหตุค้าง) → จัดรถใหม่ = เคลียร์
      const board = (await api(app, admin).get(`/v1/planning/board?date=${today}`).expect(200))
        .body;
      expect(
        board.pool.find((p: { id: string }) => p.id === encodeId('salesOrder', soId))?.holdReason,
      ).toBe('RESCHEDULES_EXHAUSTED');
      await dispatched(d2!.id);
      const cleared = await so(soId);
      expect(cleared.status).toBe('IN_TRANSIT');
      expect(cleared.holdReasonCode).toBeNull();
    } finally {
      await api(app, admin)
        .patch('/v1/settings')
        .send({ values: { 'dispatch.maxAutoReschedules': 2 } })
        .expect(200);
    }
  });

  it('แก้ master ภายหลังไม่ย้อนผล: ธงใน snapshot ของ event ปิดเป็นตัวตัดสิน', async () => {
    const rc = await db.reasonCode.findFirstOrThrow({
      where: { tenantId, category: 'DELIVERY_FAILED', code: 'WRONG_ADDRESS' },
    });
    const { doId } = await newOrder();
    const t = await dispatched(doId);
    await failAtDrop(t, 'WRONG_ADDRESS');
    // ติ๊กธงที่ master หลังปิดจุด → คำนวณซ้ำไม่สร้าง DO
    await db.reasonCode.update({ where: { id: rc.id }, data: { autoReschedule: true } });
    try {
      await run(async (tx) => {
        const p = app.get(StopProjectionService);
        await p.lockTrip(tx, t.uuid);
        await p.project(tx, t.uuid);
      });
      expect(await redeliveries(doId)).toHaveLength(0);
    } finally {
      await db.reasonCode.update({ where: { id: rc.id }, data: { autoReschedule: false } });
    }
  });

  it('แยก tenant: DO ที่นัดใหม่ของ tenant อื่น → 404', async () => {
    const { doId } = await newOrder();
    const t = await dispatched(doId);
    await failAtDrop(t, 'SHOP_CLOSED');
    const [nd] = await redeliveries(doId);
    const other = (await createTenantWithDefaults(db, { name: 'บริษัท อื่น' })).id;
    const tok = await tokenFor(other);
    await api(app, tok)
      .get(`/v1/delivery-orders/${encodeId('deliveryOrder', nd!.id)}`)
      .expect(404);
    const board = (await api(app, tok).get(`/v1/planning/board?date=${today}`).expect(200)).body;
    expect(board.pool).toEqual([]);
  });
});
