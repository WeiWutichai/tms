import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
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
 * ST4-T03 ไล่สถานะ stop event → trip_stop → trip → DO → SO (docs/04 D1, docs/01 §3.9 / §4.1–4.3) — เกณฑ์ตรวจรับ:
 * ปิด stop สุดท้าย → trip COMPLETED, DO DELIVERED, SO DELIVERED ใน transaction เดียว
 * + domain_event ครั้งเดียว, ส่งบางส่วน/ไม่สำเร็จ, event ขัดลำดับ/เวลาเพี้ยนไม่ไล่จนกว่าจะ "ใช้",
 * event ที่มาหลังเที่ยวจบ/ยกเลิก (แม้ "ใช้") ไม่เปลี่ยนเที่ยว/DO, คำนวณซ้ำได้ผลเดิม, เลขไมล์รถเมื่อจบเที่ยว
 */
describe('stop projection / status cascade (ST4-T03)', () => {
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
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท ไล่สถานะ' })).id;
    const c = await db.company.create({
      data: { tenantId, legalName: 'บริษัท ผู้ออกบิล', taxId: validTaxId(901) },
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
          .send({ legalName: `ลูกค้า ${++seed}`, taxId: validTaxId(9700 + seed) })
          .expect(201)
      ).body.id,
    );
  /** SO 1 ใบ (รับ → ส่ง) → DO ทั้งหมดของ SO */
  const newOrder = async (qty = '2', origin?: string) => {
    const input: UpsertOrderInput = {
      source: 'MANUAL',
      customer: { id: await newCustomer() },
      requestedDate: today,
      stops: [
        { type: 'PICKUP', siteId: origin ?? (await newSite()) },
        { type: 'DELIVERY', siteId: await newSite() },
      ],
      lines: [{ description: 'ปูนซีเมนต์', qty, unitId: unitTon, weightKg: '2000' }],
    };
    const { order: so } = await run((tx) => app.get(OrderIntakeService).upsertOrder(input, tx));
    const dos = await run((tx) => app.get(DeliveryOrderService).listForOrder(so.id, {}, tx));
    return { soId: so.id, dos };
  };
  const newVehicle = async () => {
    const v = (
      await api(app, admin)
        .post('/v1/vehicles')
        .send({
          plate: `7${++seed % 10}-${String(1000 + seed)}`,
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
        phone: `089-${String(n).padStart(3, '0')}-${String(n).padStart(4, '0')}`,
        employmentType: 'EMPLOYEE_SALARIED',
        licenceClass: 'T2',
        licenceExpiresOn: '2030-03-31',
        defaultVehicleId: v.id,
      })
      .expect(201);
    return v;
  };
  /** เที่ยวจาก DO (public id) → จัดรถ + ปล่อยรถ */
  const dispatched = async (doIds: string[], vehicleId?: string) => {
    const vid = vehicleId ?? (await newVehicle()).id;
    const t = (
      await api(app, admin)
        .post('/v1/trips')
        .send({ tripDate: today, deliveryOrderIds: doIds, vehicleId: vid })
        .expect(201)
    ).body;
    const r = await api(app, admin)
      .post(`/v1/trips/${t.id}/assign`)
      .send({ vehicleId: vid, dispatch: true });
    if (r.status !== 200) {
      // คำเตือนกฎจัดรถ (ถ้ามี) → ยืนยันพร้อมเหตุผล
      expect(r.status).toBe(409);
      await api(app, admin)
        .post(`/v1/trips/${t.id}/assign`)
        .send({
          vehicleId: vid,
          dispatch: true,
          ruleKeys: r.body.warnings.map((x: { key: string }) => x.key),
          overrideReason: 'ทดสอบไล่สถานะจากจุดแวะ',
        })
        .expect(200);
    }
    const full = (await api(app, admin).get(`/v1/trips/${t.id}`).expect(200)).body;
    expect(full.status).toBe('DISPATCHED');
    return {
      id: full.id as string,
      uuid: uuid('trip', full.id),
      vehicleId: uuid('vehicle', vid),
      stops: full.stops as { id: string; sequence: number; type: string }[],
    };
  };

  /** เวลาเครื่อง: `min` นาทีก่อนตอนนี้ (ไม่เข้าเกณฑ์นาฬิกาเพี้ยน) */
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const post = (stop: string, action: string, min: number, extra: object = {}) =>
    api(app, admin)
      .post(`/v1/stops/${stop}/${action}`)
      .send({ clientEventId: randomUUID(), occurredAt: ago(min), ...extra });
  const reason = async (category: 'DELIVERY_FAILED', code: string) =>
    (await db.reasonCode.findFirstOrThrow({ where: { tenantId, category, code } })).id;

  const tripRow = (id: string) => db.trip.findUniqueOrThrow({ where: { id } });
  const doStatus = async (id: string) =>
    (await db.deliveryOrder.findUniqueOrThrow({ where: { id } })).status;
  const soStatus = async (id: string) =>
    (await db.salesOrder.findUniqueOrThrow({ where: { id } })).status;
  const stopRow = (id: string) =>
    db.tripStop.findUniqueOrThrow({ where: { id: uuid('tripStop', id) } });
  const events = (localIds: string[]) =>
    db.domainEvent.findMany({
      where: { tenantId, localId: { in: localIds } },
      orderBy: { occurredAt: 'asc' },
    });
  const countByType = (rows: { type: string }[]) =>
    rows.reduce<Record<string, number>>((a, r) => ({ ...a, [r.type]: (a[r.type] ?? 0) + 1 }), {});

  it('เกณฑ์ตรวจรับ: ปิดจุดสุดท้าย → เที่ยว COMPLETED, DO DELIVERED, SO DELIVERED ในคำขอเดียว · domain_event ครั้งเดียว · เลขไมล์รถ', async () => {
    const { soId, dos } = await newOrder();
    const d = dos[0]!;
    const t = await dispatched([encodeId('deliveryOrder', d.id)]);
    // เลขไมล์ก่อนเที่ยว + ระยะเที่ยว (ไม่มีพิกัด → ตั้งตรงที่ฐาน)
    await api(app, admin)
      .post(`/v1/vehicles/${encodeId('vehicle', t.vehicleId)}/odometer`)
      .send({ readingKm: 1000, readAt: ago(180) })
      .expect(201);
    await db.trip.update({ where: { id: t.uuid }, data: { plannedDistanceKm: 85.5 } });
    const vBefore = await db.vehicle.findUniqueOrThrow({ where: { id: t.vehicleId } });
    const [pickup, drop] = [...t.stops].sort((a, b) => a.sequence - b.sequence);
    expect([pickup!.type, drop!.type]).toEqual(['PICKUP', 'DELIVERY']);
    expect(await soStatus(soId)).toBe('IN_TRANSIT');

    await post(pickup!.id, 'arrive', 60).expect(201);
    expect((await tripRow(t.uuid)).status).toBe('IN_PROGRESS');
    expect((await stopRow(pickup!.id)).status).toBe('ARRIVED');
    await post(pickup!.id, 'complete', 55, { outcome: 'DELIVERED' }).expect(201);
    expect(await doStatus(d.id)).toBe('PICKED_UP');
    expect(await soStatus(soId)).toBe('IN_TRANSIT');
    await post(drop!.id, 'depart', 50).expect(201);
    await post(drop!.id, 'arrive', 20).expect(201);
    expect((await tripRow(t.uuid)).status).toBe('IN_PROGRESS');

    const last = await post(drop!.id, 'complete', 10, { outcome: 'DELIVERED' }).expect(201);
    expect(last.body.appliedAt).toBeTruthy();
    const trip = await tripRow(t.uuid);
    expect(trip.status).toBe('COMPLETED');
    expect(trip.completedAt!.toISOString()).toBe(new Date(last.body.occurredAt).toISOString());
    expect(await doStatus(d.id)).toBe('DELIVERED');
    expect(await soStatus(soId)).toBe('DELIVERED');

    // ใน transaction/คำขอเดียวกัน: event ของจุด/เที่ยว/DO/SO ที่เกิดจากคำขอสุดท้ายมี requestId เดียวกัน
    const all = await events(
      [t.uuid, d.id, soId, pickup!.id, drop!.id].map((x) =>
        x.includes('_') ? uuid('tripStop', x) : x,
      ),
    );
    const lastReq = all.find((e) => e.type === 'trip.completed')!.requestId;
    expect(
      all
        .filter((e) => e.requestId === lastReq)
        .map((e) => e.type)
        .sort(),
    ).toEqual(
      [
        'delivery_order.status_changed',
        'order.updated',
        'stop.completed',
        'stop.departed',
        'trip.completed',
      ].sort(),
    );
    // ครั้งเดียวต่อ milestone
    const counts = countByType(all);
    expect(counts).toMatchObject({
      'stop.arrived': 2,
      'stop.completed': 2,
      'stop.departed': 2,
      'trip.started': 1,
      'trip.completed': 1,
    });
    expect(counts['stop.failed']).toBeUndefined();
    const doHist = await db.docStatusHistory.findMany({
      where: { docType: 'delivery_order', docId: d.id },
      orderBy: { at: 'asc' },
    });
    expect(doHist.map((h) => h.event)).toEqual([
      'create',
      'plan',
      'dispatch',
      'pick_up',
      'deliver',
    ]);
    expect(
      (
        await db.docStatusHistory.findMany({
          where: { docType: 'trip', docId: t.uuid },
          orderBy: { at: 'asc' },
        })
      ).map((h) => h.event),
    ).toEqual(['create', 'assign', 'dispatch', 'start', 'complete']);

    // trip_stop projection
    const ps = await stopRow(pickup!.id);
    const ds = await stopRow(drop!.id);
    expect(ps).toMatchObject({ status: 'COMPLETED', outcome: 'DELIVERED' });
    // จุดรับ: ออกจากจุด = DEPART ของจุดถัดไป
    expect(ps.departedAt!.getTime()).toBe(
      new Date(
        (
          await db.stopEvent.findFirstOrThrow({
            where: { tripStopId: ds.id, type: 'DEPART' },
          })
        ).occurredAt,
      ).getTime(),
    );
    expect(ds).toMatchObject({ status: 'COMPLETED', outcome: 'DELIVERED' });
    expect(ds.departedAt!.toISOString()).toBe(new Date(last.body.occurredAt).toISOString());
    expect(ds.lastEventId).toBe(uuid('event', last.body.id));
    expect(await db.stopEvent.count({ where: { tripId: t.uuid, appliedAt: null } })).toBe(0);

    // trip.started payload = เวลาถึงจุดแรก
    const started = all.find((e) => e.type === 'trip.started')!;
    expect((started.snapshot as { startedAt: string }).startedAt).toBe(
      (await stopRow(pickup!.id)).arrivedAt!.toISOString(),
    );

    // เลขไมล์ประมาณ: 1000 + 85.5 แหล่ง TRIP — ไม่ลงประวัติเลขไมล์ ไม่เพิ่ม version ของรถ
    const v = await db.vehicle.findUniqueOrThrow({ where: { id: t.vehicleId } });
    expect(Number(v.odometerKm)).toBe(1085.5);
    expect(v.odometerSource).toBe('TRIP');
    expect(v.version).toBe(vBefore.version);
    expect(await db.vehicleOdometerReading.count({ where: { vehicleId: t.vehicleId } })).toBe(1);
    expect(
      await db.domainEvent.count({ where: { localId: t.vehicleId, type: 'odometer.estimated' } }),
    ).toBe(1);

    // คำนวณซ้ำ (idempotent): ไม่มี domain_event / เลขไมล์ใหม่ · ส่ง event เดิมซ้ำ = 200 ไม่ไล่ซ้ำ
    const n = await db.domainEvent.count({ where: { tenantId } });
    await run(async (tx) => {
      const p = app.get(StopProjectionService);
      await p.lockTrip(tx, t.uuid);
      await p.project(tx, t.uuid);
    });
    const replay = await db.stopEvent.findFirstOrThrow({
      where: { id: uuid('event', last.body.id) },
    });
    await api(app, admin)
      .post(`/v1/stops/${drop!.id}/complete`)
      .send({
        clientEventId: replay.clientEventId,
        occurredAt: replay.occurredAt.toISOString(),
        outcome: 'DELIVERED',
      })
      .expect(200);
    expect(await db.domainEvent.count({ where: { tenantId } })).toBe(n);
    expect(
      Number((await db.vehicle.findUniqueOrThrow({ where: { id: t.vehicleId } })).odometerKm),
    ).toBe(1085.5);

    // เลขไมล์จริงที่ต่ำกว่าค่าประมาณกรอกได้ และแทนที่ค่าประมาณ (review H1 / QA M1)
    await api(app, admin)
      .post(`/v1/vehicles/${encodeId('vehicle', t.vehicleId)}/odometer`)
      .send({ readingKm: 1070, readAt: ago(1) })
      .expect(201);
    const real = await db.vehicle.findUniqueOrThrow({ where: { id: t.vehicleId } });
    expect(Number(real.odometerKm)).toBe(1070);
    expect(real.odometerSource).toBe('MANUAL');
  });

  it('ส่งบางส่วน / ไม่สำเร็จ: DO PARTIAL = DELIVERED · FAIL + เหตุผล → DO FAILED (เหตุผลในประวัติ) · SO ที่ส่งไม่สำเร็จคง IN_TRANSIT · เที่ยวจบเมื่อทุกจุดจบ', async () => {
    const origin = await newSite();
    const a = await newOrder('2', origin);
    const b = await newOrder('2', origin);
    const t = await dispatched(a.dos.concat(b.dos).map((d) => encodeId('deliveryOrder', d.id)));
    const sorted = [...t.stops].sort((x, y) => x.sequence - y.sequence);
    expect(sorted.map((s) => s.type)).toEqual(['PICKUP', 'DELIVERY', 'DELIVERY']);
    const [pk, s1, s2] = sorted;
    const dropOf = async (doId: string) =>
      encodeId(
        'tripStop',
        (await db.deliveryOrder.findUniqueOrThrow({ where: { id: doId } })).tripStopId!,
      );
    const aStop = await dropOf(a.dos[0]!.id);
    const bStop = aStop === s1!.id ? s2!.id : s1!.id;

    await post(pk!.id, 'arrive', 90).expect(201);
    await post(pk!.id, 'complete', 85, { outcome: 'DELIVERED' }).expect(201);
    await post(aStop, 'arrive', 60).expect(201);
    await post(aStop, 'complete', 55, { outcome: 'PARTIAL' }).expect(201);
    expect(await doStatus(a.dos[0]!.id)).toBe('DELIVERED');
    expect(await soStatus(a.soId)).toBe('DELIVERED');
    expect((await tripRow(t.uuid)).status).toBe('IN_PROGRESS');

    const failed = await reason('DELIVERY_FAILED', 'SHOP_CLOSED');
    await post(bStop, 'fail', 30, {
      outcome: 'FAILED',
      reasonCodeId: encodeId('reasonCode', failed),
      note: 'ร้านปิด',
    }).expect(201);
    expect(await doStatus(b.dos[0]!.id)).toBe('FAILED');
    expect(await soStatus(b.soId)).toBe('IN_TRANSIT');
    expect(await stopRow(bStop)).toMatchObject({
      status: 'FAILED',
      outcome: 'FAILED',
      failReasonCodeId: failed,
      arrivedAt: null,
    });
    const h = await db.docStatusHistory.findFirstOrThrow({
      where: { docType: 'delivery_order', docId: b.dos[0]!.id, event: 'fail' },
    });
    expect(h.reasonCodeId).toBe(failed);
    expect((await tripRow(t.uuid)).status).toBe('COMPLETED');
    const evs = await events([uuid('tripStop', bStop)]);
    // ไม่เคยถึงจุด → ไม่มีเวลาออก/ไม่มี stop.departed (review L2)
    expect(evs.map((e) => e.type)).toEqual(['stop.failed']);
    expect((await stopRow(bStop)).departedAt).toBeNull();
  });

  it('SO หลาย DO: ส่งแล้วบางใบ + ใบที่เหลือยังไม่ออก → PARTIALLY_DELIVERED · ใบที่เหลือออกรถ → IN_TRANSIT · ส่งครบ → DELIVERED', async () => {
    const { soId, dos } = await newOrder('2');
    const lines = await db.salesOrderLine.findMany({ where: { salesOrderId: soId } });
    const kids = await run((tx) =>
      app
        .get(DeliveryOrderService)
        .split(
          dos[0]!.id,
          [
            [{ salesOrderLineId: lines[0]!.id, qty: '1' }],
            [{ salesOrderLineId: lines[0]!.id, qty: '1' }],
          ],
          tx,
        ),
    );
    const t1 = await dispatched([encodeId('deliveryOrder', kids[0]!.id)]);
    const [p1, d1] = [...t1.stops].sort((x, y) => x.sequence - y.sequence);
    await post(p1!.id, 'complete', 100, { outcome: 'DELIVERED' }).expect(201);
    // ปิดงานโดยไม่กดถึง = ขัดลำดับ → ไม่ไล่ (ยังไม่นับ)
    expect(await doStatus(kids[0]!.id)).toBe('DISPATCHED');
    await post(p1!.id, 'arrive', 110).expect(201);
    expect(await doStatus(kids[0]!.id)).toBe('PICKED_UP');
    await post(d1!.id, 'arrive', 90).expect(201);
    await post(d1!.id, 'complete', 85, { outcome: 'DELIVERED' }).expect(201);
    expect(await doStatus(kids[0]!.id)).toBe('DELIVERED');
    expect(await soStatus(soId)).toBe('PARTIALLY_DELIVERED');

    const t2 = await dispatched([encodeId('deliveryOrder', kids[1]!.id)]);
    expect(await soStatus(soId)).toBe('IN_TRANSIT');
    const [p2, d2] = [...t2.stops].sort((x, y) => x.sequence - y.sequence);
    await post(p2!.id, 'arrive', 50).expect(201);
    await post(p2!.id, 'complete', 45, { outcome: 'DELIVERED' }).expect(201);
    await post(d2!.id, 'arrive', 30).expect(201);
    await post(d2!.id, 'complete', 25, { outcome: 'DELIVERED' }).expect(201);
    expect(await soStatus(soId)).toBe('DELIVERED');
    const soHist = await db.docStatusHistory.findMany({
      where: { docType: 'sales_order', docId: soId },
      orderBy: { at: 'asc' },
    });
    expect(soHist.map((x) => x.event).slice(-4)).toEqual([
      'dispatch',
      'deliver_partial',
      'resume',
      'deliver',
    ]);
  });

  it('เวลาเครื่องเพี้ยน → ไม่ไล่จนกว่าผู้จัดรถ "ใช้" (ทาง resolve ไล่สถานะ) · เที่ยวจบแล้ว event ที่มาทีหลังแม้ "ใช้" ไม่เปลี่ยนจุด/เที่ยว/DO', async () => {
    const { dos } = await newOrder();
    const t = await dispatched([encodeId('deliveryOrder', dos[0]!.id)]);
    const [pk, dr] = [...t.stops].sort((x, y) => x.sequence - y.sequence);
    // เวลาเครื่องย้อนหลัง 2 วัน → ธง CLOCK_SKEW ไม่นับ
    const skew = await api(app, admin)
      .post(`/v1/stops/${pk!.id}/arrive`)
      .send({
        clientEventId: randomUUID(),
        occurredAt: new Date(Date.now() - 48 * 3600_000).toISOString(),
      })
      .expect(201);
    expect(skew.body.flags).toEqual(['CLOCK_SKEW']);
    expect(skew.body.appliedAt).toBeNull();
    expect((await tripRow(t.uuid)).status).toBe('DISPATCHED');
    expect((await stopRow(pk!.id)).status).toBe('PENDING');
    await api(app, admin)
      .post(`/v1/stop-event-flags/${skew.body.id}/resolve`)
      .send({ decision: 'ACCEPT', reason: 'คนขับตั้งเวลาเครื่องผิด ยืนยันทางโทรศัพท์' })
      .expect(200);
    expect((await tripRow(t.uuid)).status).toBe('IN_PROGRESS');
    expect((await stopRow(pk!.id)).status).toBe('ARRIVED');
    expect(
      (await db.stopEvent.findFirstOrThrow({ where: { id: uuid('event', skew.body.id) } }))
        .appliedAt,
    ).toBeTruthy();

    await post(pk!.id, 'complete', 60, { outcome: 'DELIVERED' }).expect(201);
    await post(dr!.id, 'arrive', 40).expect(201);
    const ok = await post(dr!.id, 'complete', 35, { outcome: 'DELIVERED' }).expect(201);
    expect(await doStatus(dos[0]!.id)).toBe('DELIVERED');
    expect((await tripRow(t.uuid)).status).toBe('COMPLETED');
    // เที่ยวจบแล้ว: event ที่มาทีหลัง = LATE · "ใช้" แล้วก็ไม่เปลี่ยนจุด/เที่ยว/DO (DRV-072)
    const failed = await reason('DELIVERY_FAILED', 'SHOP_CLOSED');
    const late = await post(dr!.id, 'fail', 30, {
      outcome: 'FAILED',
      reasonCodeId: encodeId('reasonCode', failed),
      note: 'ร้านปิด',
    }).expect(201);
    expect(late.body.flags).toContain('LATE');
    const n = await db.domainEvent.count({ where: { tenantId } });
    await api(app, admin)
      .post(`/v1/stop-event-flags/${late.body.id}/resolve`)
      .send({ decision: 'ACCEPT', reason: 'ยืนยันว่าร้านปิดจริง แต่ส่งของแล้ว' })
      .expect(200);
    expect((await tripRow(t.uuid)).status).toBe('COMPLETED');
    expect(await doStatus(dos[0]!.id)).toBe('DELIVERED');
    expect(await stopRow(dr!.id)).toMatchObject({ status: 'COMPLETED', outcome: 'DELIVERED' });
    expect((await stopRow(dr!.id)).lastEventId).toBe(uuid('event', ok.body.id));
    expect(
      (await db.stopEvent.findFirstOrThrow({ where: { id: uuid('event', late.body.id) } }))
        .appliedAt,
    ).toBeNull();
    expect(await db.domainEvent.count({ where: { tenantId } })).toBe(n);
  });

  it('ปิดแข่งกันขณะเที่ยวยังวิ่ง: "ไม่ใช้" ตัวที่มีผล → จุดเปลี่ยนผลตาม event แต่ DO ที่ DELIVERED แล้วไม่ถอย (ไม่มีเส้นใน docs/01 §4.3)', async () => {
    const origin = await newSite();
    const a = await newOrder('2', origin);
    const b = await newOrder('2', origin);
    const t = await dispatched(a.dos.concat(b.dos).map((d) => encodeId('deliveryOrder', d.id)));
    const aRow = await db.deliveryOrder.findUniqueOrThrow({ where: { id: a.dos[0]!.id } });
    const aStop = encodeId('tripStop', aRow.tripStopId!);
    const pkStop = encodeId('tripStop', aRow.pickupTripStopId!);
    await post(pkStop, 'arrive', 70).expect(201);
    await post(pkStop, 'complete', 65, { outcome: 'DELIVERED' }).expect(201);
    await post(aStop, 'arrive', 60).expect(201);
    const first = await post(aStop, 'complete', 50, { outcome: 'DELIVERED' }).expect(201);
    expect(await doStatus(a.dos[0]!.id)).toBe('DELIVERED');
    const failed = await reason('DELIVERY_FAILED', 'SHOP_CLOSED');
    const second = await post(aStop, 'fail', 45, {
      outcome: 'FAILED',
      reasonCodeId: encodeId('reasonCode', failed),
      note: 'ร้านปิด',
    }).expect(201);
    expect(second.body.flags).toEqual(['SEQUENCE_CONFLICT']);
    expect((await stopRow(aStop)).outcome).toBe('DELIVERED');
    await api(app, admin)
      .post(`/v1/stop-event-flags/${first.body.id}/resolve`)
      .send({ decision: 'IGNORE', reason: 'คนขับกดผิด จริง ๆ ร้านปิด' })
      .expect(200);
    expect(await stopRow(aStop)).toMatchObject({ status: 'FAILED', failReasonCodeId: failed });
    expect(await doStatus(a.dos[0]!.id)).toBe('DELIVERED');
    // ผลจุดขัด DO → ธงแจ้ง OUTCOME_MISMATCH ที่ event ปิดงานที่มีผล + audit · รับทราบได้อย่างเดียว
    const sec = await db.stopEvent.findFirstOrThrow({
      where: { id: uuid('event', second.body.id) },
    });
    expect(sec.outcomeMismatch).toBe(true);
    expect(
      await db.auditLog.count({
        where: { entityId: sec.id, action: 'stop_event.outcome_mismatch' },
      }),
    ).toBe(1);
    const open = (
      await api(app, admin)
        .get('/v1/stop-event-flags?status=open&flag=OUTCOME_MISMATCH')
        .expect(200)
    ).body.data.map((f: { id: string }) => f.id);
    expect(open).toContain(second.body.id);
    // ธงขัดลำดับของตัวนี้ยังไม่ตัดสิน → ตัดสินพร้อมกัน (ACCEPT = ใช้ + รับทราบ)
    await api(app, admin)
      .post(`/v1/stop-event-flags/${second.body.id}/resolve`)
      .send({ decision: 'ACCEPT', reason: 'รับทราบ ร้านปิดจริง จะเปิดงานส่งใหม่' })
      .expect(200);
    const after = await db.stopEvent.findFirstOrThrow({ where: { id: sec.id } });
    expect(after.resolutionId).not.toBeNull();
    expect(await doStatus(a.dos[0]!.id)).toBe('DELIVERED');
    expect(
      (await db.stopEvent.findFirstOrThrow({ where: { id: uuid('event', first.body.id) } }))
        .appliedAt,
    ).toBeNull();
    expect((await tripRow(t.uuid)).status).toBe('IN_PROGRESS');
  });

  it('เที่ยวที่ยกเลิกหลังปล่อยรถ: event ที่มาทีหลังแม้ "ใช้" ไม่เปลี่ยนเที่ยว/จุด/DO (DRV-072)', async () => {
    const { soId, dos } = await newOrder();
    const t = await dispatched([encodeId('deliveryOrder', dos[0]!.id)]);
    await api(app, admin)
      .post(`/v1/trips/${t.id}/cancel`)
      .send({ reason: 'ลูกค้ายกเลิกงานทั้งเที่ยว' })
      .expect(200);
    expect(await doStatus(dos[0]!.id)).toBe('DRAFT');
    const pk = [...t.stops].sort((x, y) => x.sequence - y.sequence)[0]!;
    const late = await post(pk.id, 'arrive', 5).expect(201);
    expect(late.body.flags).toContain('LATE');
    await api(app, admin)
      .post(`/v1/stop-event-flags/${late.body.id}/resolve`)
      .send({ decision: 'ACCEPT', reason: 'คนขับไปถึงจริงก่อนได้รับแจ้งยกเลิก' })
      .expect(200);
    expect((await tripRow(t.uuid)).status).toBe('CANCELLED');
    expect((await stopRow(pk.id)).status).toBe('PENDING');
    expect(await doStatus(dos[0]!.id)).toBe('DRAFT');
    expect(await soStatus(soId)).not.toBe('IN_TRANSIT');
  });

  it('เลขไมล์ประมาณ: ไม่มีเลขไมล์ / ไม่ทราบระยะ / มีเลขไมล์จริงหลังจบเที่ยว → ไม่แตะ · หลายเที่ยวต่อกันสะสม', async () => {
    const run1 = async (
      vid: string | undefined,
      setup: (vehicleId: string, tripId: string) => Promise<void>,
    ) => {
      const { dos } = await newOrder();
      const t = await dispatched([encodeId('deliveryOrder', dos[0]!.id)], vid);
      await setup(t.vehicleId, t.uuid);
      for (const s of [...t.stops].sort((x, y) => x.sequence - y.sequence)) {
        await post(s.id, 'arrive', 40 - s.sequence * 10).expect(201);
        await post(s.id, 'complete', 35 - s.sequence * 10, { outcome: 'DELIVERED' }).expect(201);
      }
      expect((await tripRow(t.uuid)).status).toBe('COMPLETED');
      const v = await db.vehicle.findUniqueOrThrow({ where: { id: t.vehicleId } });
      return {
        km: v.odometerKm === null ? null : Number(v.odometerKm),
        src: v.odometerSource,
        vid: t.vehicleId,
      };
    };
    const odo = (vid: string, km: number, min: number) =>
      api(app, admin)
        .post(`/v1/vehicles/${encodeId('vehicle', vid)}/odometer`)
        .send({ readingKm: km, readAt: ago(min) })
        .expect(201);
    // ไม่มีเลขไมล์
    expect(
      (
        await run1(undefined, async (_v, tid) => {
          await db.trip.update({ where: { id: tid }, data: { plannedDistanceKm: 10 } });
        })
      ).km,
    ).toBeNull();
    // ไม่ทราบระยะ
    expect((await run1(undefined, (vid) => odo(vid, 500, 120).then(() => undefined))).km).toBe(500);
    // มีเลขไมล์จริงหลังเวลาจบเที่ยว → ค่าจริงคงอยู่
    const late = await run1(undefined, async (vid, tid) => {
      await odo(vid, 500, 120);
      await odo(vid, 505, 1);
      await db.trip.update({ where: { id: tid }, data: { plannedDistanceKm: 50 } });
    });
    expect(late).toMatchObject({ km: 505, src: 'MANUAL' });
    // สองเที่ยวต่อกันบนรถคันเดียว: สะสมจากค่าประมาณก่อนหน้า
    const a = await run1(undefined, async (vid, tid) => {
      await odo(vid, 1000, 180);
      await db.trip.update({ where: { id: tid }, data: { plannedDistanceKm: 20 } });
    });
    expect(a.km).toBe(1020);
    const b = await run1(encodeId('vehicle', a.vid), async (_v, tid) => {
      await db.trip.update({ where: { id: tid }, data: { plannedDistanceKm: 30 } });
    });
    expect(b).toMatchObject({ km: 1050, src: 'TRIP' });
  });

  it('ปิดงานส่งก่อนจุดรับปิด → ธง PICKUP_NOT_DONE ไม่ไล่ DO · รับของเสร็จ → ธงหายเอง DO ผ่าน PICKED_UP → DELIVERED (QA M2)', async () => {
    const { dos } = await newOrder();
    const t = await dispatched([encodeId('deliveryOrder', dos[0]!.id)]);
    const [pk, dr] = [...t.stops].sort((x, y) => x.sequence - y.sequence);
    await post(dr!.id, 'arrive', 30).expect(201);
    const c = await post(dr!.id, 'complete', 25, { outcome: 'DELIVERED' }).expect(201);
    expect(c.body.flags).toEqual(['PICKUP_NOT_DONE']);
    expect(c.body.appliedAt).toBeNull();
    expect(await doStatus(dos[0]!.id)).toBe('DISPATCHED');
    expect((await stopRow(dr!.id)).status).toBe('ARRIVED');
    await post(pk!.id, 'arrive', 60).expect(201);
    await post(pk!.id, 'complete', 55, { outcome: 'DELIVERED' }).expect(201);
    const row = await db.stopEvent.findFirstOrThrow({ where: { id: uuid('event', c.body.id) } });
    expect(row.pickupPending).toBe(false);
    expect(row.appliedAt).toBeTruthy();
    expect(await doStatus(dos[0]!.id)).toBe('DELIVERED');
    const hist = await db.docStatusHistory.findMany({
      where: { docType: 'delivery_order', docId: dos[0]!.id },
      orderBy: { at: 'asc' },
    });
    expect(hist.map((h) => h.event).slice(-2)).toEqual(['pick_up', 'deliver']);
    expect((await tripRow(t.uuid)).status).toBe('COMPLETED');
  });

  it('ผู้จัดรถ "ใช้" การปิดงานที่ติด PICKUP_NOT_DONE → ไล่ DO ได้โดยจุดรับยังไม่ปิด · จุดรับไม่สำเร็จ → DO FAILED, เที่ยวยังวิ่งจนจุดส่งปิด', async () => {
    const one = await newOrder();
    const t = await dispatched([encodeId('deliveryOrder', one.dos[0]!.id)]);
    const [, dr] = [...t.stops].sort((x, y) => x.sequence - y.sequence);
    await post(dr!.id, 'arrive', 30).expect(201);
    const c = await post(dr!.id, 'complete', 25, { outcome: 'DELIVERED' }).expect(201);
    await api(app, admin)
      .post(`/v1/stop-event-flags/${c.body.id}/resolve`)
      .send({ decision: 'ACCEPT', reason: 'ขึ้นของแล้วแต่คนขับลืมกดปิดจุดรับ' })
      .expect(200);
    expect(await doStatus(one.dos[0]!.id)).toBe('DELIVERED');
    expect((await tripRow(t.uuid)).status).toBe('IN_PROGRESS'); // จุดรับยังไม่ปิด

    const two = await newOrder();
    const t2 = await dispatched([encodeId('deliveryOrder', two.dos[0]!.id)]);
    const [pk2, dr2] = [...t2.stops].sort((x, y) => x.sequence - y.sequence);
    const failed = await reason('DELIVERY_FAILED', 'SHOP_CLOSED');
    await post(pk2!.id, 'fail', 40, {
      outcome: 'FAILED',
      reasonCodeId: encodeId('reasonCode', failed),
      note: 'คลังปิด',
    }).expect(201);
    expect(await doStatus(two.dos[0]!.id)).toBe('FAILED');
    expect((await stopRow(dr2!.id)).status).toBe('PENDING');
    expect((await tripRow(t2.uuid)).status).toBe('IN_PROGRESS');
    await post(dr2!.id, 'fail', 30, {
      outcome: 'FAILED',
      reasonCodeId: encodeId('reasonCode', failed),
      note: 'ไม่มีของส่ง',
    }).expect(201);
    expect((await tripRow(t2.uuid)).status).toBe('COMPLETED');
    expect(await doStatus(two.dos[0]!.id)).toBe('FAILED');
  });

  it('พร้อมกัน: สองเที่ยวของ SO เดียวส่ง event พร้อมกัน · event ∥ resolve บนเที่ยวเดียว — ไม่ deadlock สถานะสุดท้ายถูก', async () => {
    const { soId, dos } = await newOrder('2');
    const lines = await db.salesOrderLine.findMany({ where: { salesOrderId: soId } });
    const kids = await run((tx) =>
      app
        .get(DeliveryOrderService)
        .split(
          dos[0]!.id,
          [
            [{ salesOrderLineId: lines[0]!.id, qty: '1' }],
            [{ salesOrderLineId: lines[0]!.id, qty: '1' }],
          ],
          tx,
        ),
    );
    const t1 = await dispatched([encodeId('deliveryOrder', kids[0]!.id)]);
    const t2 = await dispatched([encodeId('deliveryOrder', kids[1]!.id)]);
    const st = (t: typeof t1) => [...t.stops].sort((x, y) => x.sequence - y.sequence);
    const [p1, d1] = st(t1);
    const [p2, d2] = st(t2);
    const flow = async (p: string, d: string) => {
      await post(p, 'arrive', 60).expect(201);
      await post(p, 'complete', 55, { outcome: 'DELIVERED' }).expect(201);
      await post(d, 'arrive', 30).expect(201);
      return post(d, 'complete', 25, { outcome: 'DELIVERED' });
    };
    const rs = await Promise.all([flow(p1!.id, d1!.id), flow(p2!.id, d2!.id)]);
    expect(rs.map((r) => r.status)).toEqual([201, 201]);
    expect(await soStatus(soId)).toBe('DELIVERED');
    expect((await tripRow(t1.uuid)).status).toBe('COMPLETED');
    expect((await tripRow(t2.uuid)).status).toBe('COMPLETED');

    // event ∥ resolve บนเที่ยวเดียวกัน
    const x = await newOrder();
    const t3 = await dispatched([encodeId('deliveryOrder', x.dos[0]!.id)]);
    const [p3, d3] = st(t3);
    const skew = await api(app, admin)
      .post(`/v1/stops/${p3!.id}/arrive`)
      .send({
        clientEventId: randomUUID(),
        occurredAt: new Date(Date.now() - 48 * 3600_000).toISOString(),
      })
      .expect(201);
    const [r1, r2] = await Promise.all([
      api(app, admin)
        .post(`/v1/stop-event-flags/${skew.body.id}/resolve`)
        .send({ decision: 'ACCEPT', reason: 'เวลาเครื่องผิด ยืนยันแล้ว' }),
      post(d3!.id, 'arrive', 20),
    ]);
    expect([r1.status, r2.status]).toEqual([200, 201]);
    expect((await tripRow(t3.uuid)).status).toBe('IN_PROGRESS');
    expect((await stopRow(p3!.id)).status).toBe('ARRIVED');
    expect((await stopRow(d3!.id)).status).toBe('ARRIVED');
  });
});
