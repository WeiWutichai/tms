import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SYSTEM_ROLES, TRIP_AVG_SPEED_KMH } from '@tms/domain';
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
 * ST3-T16 Multi-drop: เรียงจุดแวะเอง (`POST /v1/trips/:id/reorder-stops`), ระยะ/เวลาช่วงวิ่ง + ยอดรวม,
 * กันลำดับผิด (เกณฑ์ตรวจรับ: ย้ายจุดส่งไปก่อนจุดรับของ DO เดียวกัน → ถูกปฏิเสธพร้อมข้อความ), If-Match, audit,
 * ตรวจกฎตอนจัดใหม่ (ST3-T14), สิทธิ์, แยก tenant
 */
describe('trip stops — multi-drop (ST3-T16)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let otherId: string;
  let admin: string;
  let planner: string;
  let viewer: string;
  let other: string;
  let seed = 0;
  let unitTon: string;
  const today = bangkokToday();
  const uuid = (kind: Parameters<typeof tryDecodeId>[0], id: string) => tryDecodeId(kind, id)!;
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท หลายจุด' })).id;
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
    planner = await tokenFor(tenantId, SYSTEM_ROLES.planner.permissions.join(' '), 'u-planner');
    viewer = await tokenFor(tenantId, SYSTEM_ROLES.viewer.permissions.join(' '), 'u-view');
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
          { requestId: randomUUID(), tenantId: tid, actorId: 'user-test', locale: 'th', tx },
          () => fn(tx),
        ),
      );

  /** สถานที่ (พิกัดไม่ส่ง = ไม่มีพิกัด) → public id */
  const site = async (coords?: [number, number], token = admin) =>
    (
      await api(app, token)
        .post('/v1/customer-sites')
        .send({
          name: `จุดรับส่ง ${++seed}`,
          kind: 'DROPOFF',
          address: ADDR,
          ...(coords ? { lat: coords[0], lng: coords[1] } : {}),
        })
        .expect(201)
    ).body.id as string;
  const customer = async (token = admin) =>
    uuid(
      'customer',
      (
        await api(app, token)
          .post('/v1/customers')
          .send({ legalName: `ลูกค้า ${++seed}`, taxId: validTaxId(9600 + seed) })
          .expect(201)
      ).body.id,
    );
  /** SO 1 ใบ (รับ → ส่ง) → DO */
  const newDo = async (
    origin: string,
    dest: string,
    window?: [string, string],
    tid = tenantId,
    cust?: string,
  ) => {
    const input: UpsertOrderInput = {
      source: 'MANUAL',
      customer: { id: cust ?? (await customer()) },
      requestedDate: today,
      stops: [
        { type: 'PICKUP', siteId: uuid('site', origin) },
        {
          type: 'DELIVERY',
          siteId: uuid('site', dest),
          ...(window ? { windowStart: window[0], windowEnd: window[1] } : {}),
        },
      ],
      lines: [{ description: 'ปูนซีเมนต์', qty: '1', unitId: unitTon, weightKg: '1000' }],
    };
    const { order: so } = await run(
      (tx) => app.get(OrderIntakeService).upsertOrder(input, tx),
      tid,
    );
    const [d] = await run((tx) => app.get(DeliveryOrderService).listForOrder(so.id, {}, tx), tid);
    return { id: encodeId('deliveryOrder', d!.id), doNo: d!.doNo! };
  };
  const at = (hh: string) => `${today}T${hh}:00+07:00`;

  type Stop = {
    id: string;
    sequence: number;
    type: string;
    siteId: string;
    siteName: string;
    deliveryOrderIds: string[];
    legDistanceKm: string | null;
    legMinutes: number | null;
    legSource: string | null;
  };
  type Trip = {
    id: string;
    version: number;
    stops: Stop[];
    route: {
      distanceKm: string | null;
      minutes: number | null;
      missingLegs: number;
      estimated: boolean;
    };
    warnings: { code: string; params: Record<string, unknown> }[];
    weightKg: string;
  };
  const getTrip = async (id: string) =>
    (await api(app, admin).get(`/v1/trips/${id}`).expect(200)).body as Trip;
  const reorder = (id: string, stopIds: string[], token = admin, ifMatch?: number) => {
    const r = api(app, token).post(`/v1/trips/${id}/reorder-stops`);
    if (ifMatch !== undefined) r.set('If-Match', `"${ifMatch}"`);
    return r.send({ stopIds });
  };

  /**
   * เที่ยว 2 DO: A (รับ pA → ส่ง qA 10:00) และ B (รับ pB → ส่ง qB 14:00) → ลำดับเริ่มต้น pA pB qA qB
   * พิกัด: กรุงเทพฯ → ชลบุรี / อยุธยา → ระยอง (qB ไม่มีพิกัด ถ้า `noCoordsB`)
   */
  const twoDropTrip = async (noCoordsB = false) => {
    const pA = await site([13.7563, 100.5018]);
    const qA = await site([13.3611, 100.9847]);
    const pB = await site([14.3532, 100.5689]);
    const qB = noCoordsB ? await site() : await site([12.6814, 101.2816]);
    const a = await newDo(pA, qA, [at('10:00'), at('11:00')]);
    const b = await newDo(pB, qB, [at('14:00'), at('15:00')]);
    const t = (
      await api(app, admin)
        .post('/v1/trips')
        .send({ tripDate: today, deliveryOrderIds: [a.id, b.id] })
        .expect(201)
    ).body as Trip;
    const by = (siteId: string) => t.stops.find((s) => s.siteId === siteId)!.id;
    return {
      t,
      a,
      b,
      s: { pA: by(pA), qA: by(qA), pB: by(pB), qB: by(qB) },
      sites: { pA, qA, pB, qB },
    };
  };

  it('สร้างเที่ยวหลายจุด → ระยะ/เวลาช่วงวิ่งต่อจุด (ค่าประมาณจากพิกัด) + ยอดรวม + น้ำหนักรวม', async () => {
    const { t, s } = await twoDropTrip();
    expect(t.stops.map((x) => x.id)).toEqual([s.pA, s.pB, s.qA, s.qB]);
    expect(t.stops[0]!.legSource).toBeNull();
    expect(t.stops[0]!.siteName).toMatch(/^จุดรับส่ง /);
    for (const x of t.stops.slice(1)) {
      expect(x.legSource).toBe('ESTIMATE');
      expect(Number(x.legDistanceKm)).toBeGreaterThan(0);
      expect(x.legMinutes).toBe(Math.round((Number(x.legDistanceKm) / TRIP_AVG_SPEED_KMH) * 60));
    }
    const sum = t.stops.slice(1).reduce((a, x) => a + Number(x.legDistanceKm), 0);
    expect(Number(t.route.distanceKm)).toBeCloseTo(sum, 1);
    expect(t.route).toMatchObject({ missingLegs: 0, estimated: true });
    expect(t.route.minutes).toBe(t.stops.slice(1).reduce((a, x) => a + x.legMinutes!, 0));
    expect(t.weightKg).toBe('2000');
    // กระดาน (ST3-T12) อ่านระยะรวมจากคอลัมน์เดียวกัน
    const row = await db.trip.findUniqueOrThrow({ where: { id: uuid('trip', t.id) } });
    expect(row.plannedDistanceKm?.toFixed(1)).toBe(t.route.distanceKm);
    expect(row.plannedDurationMin).toBe(t.route.minutes);
  });

  it('เกณฑ์ตรวจรับ: ย้ายจุดส่งไปก่อนจุดรับของ DO เดียวกัน → 422 stop_order_invalid พร้อมข้อความ + ไม่มีอะไรเปลี่ยน', async () => {
    const { t, a, s } = await twoDropTrip();
    const r = await reorder(t.id, [s.qA, s.pA, s.pB, s.qB]).expect(422);
    expect(r.body.code).toBe('stop_order_invalid');
    expect(r.body.detail).toContain(a.doNo);
    expect(r.body.detail).toContain('ต้องรับของก่อนส่ง');
    expect(r.body.violations).toEqual([
      expect.objectContaining({
        deliveryOrderId: a.id,
        doNo: a.doNo,
        pickupStopId: s.pA,
        dropStopId: s.qA,
        pickupSequence: 2,
        dropSequence: 1,
      }),
    ]);
    expect(r.body.errors[0]).toMatchObject({ field: 'stopIds', code: 'delivery_before_pickup' });
    // ย้ายจุดรับไปท้าย → ผิดทั้งคู่ที่รับที่นั่น
    const r2 = await reorder(t.id, [s.pB, s.qA, s.qB, s.pA]).expect(422);
    expect(r2.body.violations.map((v: { doNo: string }) => v.doNo)).toEqual([a.doNo]);
    const after = await getTrip(t.id);
    expect(after.version).toBe(t.version);
    expect(after.stops.map((x) => x.id)).toEqual([s.pA, s.pB, s.qA, s.qB]);
    expect(
      await db.auditLog.count({
        where: { entityId: uuid('trip', t.id), action: 'trip.stops_reordered' },
      }),
    ).toBe(0);
  });

  it('เรียงเองสำเร็จ: ลำดับใหม่ + version/ETag + ระยะช่วงวิ่งตามลำดับใหม่ (route master มาก่อน) + audit + event · ลำดับเดิม = ไม่เปลี่ยน', async () => {
    const { t, s, sites } = await twoDropTrip();
    // เส้นทาง pA → qA ใน route master (ทิศทางมีผล)
    await api(app, admin)
      .post('/v1/routes')
      .send({
        originId: sites.pA,
        destinationId: sites.qA,
        distanceKm: 95,
        standardMinutes: 110,
      })
      .expect(201);
    const res = await reorder(t.id, [s.pA, s.qA, s.pB, s.qB], admin, t.version).expect(200);
    const r = res.body as Trip;
    expect(res.headers.etag).toBe(`"${r.version}"`);
    expect(r.version).toBeGreaterThan(t.version);
    expect(r.stops.map((x) => [x.id, x.sequence])).toEqual([
      [s.pA, 1],
      [s.qA, 2],
      [s.pB, 3],
      [s.qB, 4],
    ]);
    expect(r.stops[1]).toMatchObject({
      legDistanceKm: '95.0',
      legMinutes: 110,
      legSource: 'ROUTE',
    });
    expect(r.stops[2]!.legSource).toBe('ESTIMATE');
    const sum = r.stops.slice(1).reduce((a, x) => a + Number(x.legDistanceKm), 0);
    expect(Number(r.route.distanceKm)).toBeCloseTo(sum, 1);
    const log = await db.auditLog.findFirstOrThrow({
      where: { entityId: uuid('trip', t.id), action: 'trip.stops_reordered' },
    });
    expect((log.before as { stops: { sequence: number }[] }).stops).toHaveLength(4);
    expect((log.after as { stops: { id: string }[] }).stops.map((x) => x.id)).toEqual(
      [s.pA, s.qA, s.pB, s.qB].map((x) => uuid('tripStop', x)),
    );
    expect(
      await db.domainEvent.count({ where: { localId: uuid('trip', t.id), type: 'trip.updated' } }),
    ).toBeGreaterThan(0);
    // ส่งลำดับเดิมซ้ำ → ไม่เปลี่ยน version
    const same = (await reorder(t.id, [s.pA, s.qA, s.pB, s.qB]).expect(200)).body as Trip;
    expect(same.version).toBe(r.version);
    // If-Match เก่า → 412
    await reorder(t.id, [s.pA, s.pB, s.qA, s.qB], admin, t.version).expect(412);
  });

  it('ลำดับที่เรียงเองคงอยู่เมื่อเพิ่ม DO · ช่วงที่ไม่มีพิกัดและไม่มีเส้นทาง = ไม่ทราบ (missingLegs)', async () => {
    const { t, s } = await twoDropTrip(true);
    expect(t.stops.find((x) => x.id === s.qB)!.legSource).toBeNull();
    expect(t.route.missingLegs).toBe(1);
    const r = (await reorder(t.id, [s.pA, s.qA, s.pB, s.qB]).expect(200)).body as Trip;
    const c = await newDo(await site([13.5, 100.7]), await site([13.6, 100.8]));
    const after = (
      await api(app, admin)
        .post(`/v1/trips/${t.id}/attach`)
        .send({ deliveryOrderIds: [c.id] })
        .expect(200)
    ).body as Trip;
    // จุดเดิมคงลำดับ (รับใหม่แทรกหลังจุดรับต้นเที่ยว, ส่งใหม่ต่อท้าย)
    const kept = after.stops
      .filter((x) => [s.pA, s.qA, s.pB, s.qB].includes(x.id))
      .map((x) => x.id);
    expect(kept).toEqual([s.pA, s.qA, s.pB, s.qB]);
    expect(after.stops).toHaveLength(6);
    expect(after.route.missingLegs).toBeGreaterThanOrEqual(1);
    expect(r.version).toBeLessThan(after.version);
  });

  it('ตรวจกฎตอนจัดใหม่หลังเรียง (ST3-T14): เวลาตามแผนถอยหลัง → คำเตือน stop_sequence_window_order · เรียงกลับ → หาย', async () => {
    const { t, s } = await twoDropTrip();
    expect(t.warnings.map((w) => w.code)).not.toContain('stop_sequence_window_order');
    // ส่ง B (14:00) ก่อน A (10:00)
    const r = (await reorder(t.id, [s.pA, s.pB, s.qB, s.qA]).expect(200)).body as Trip;
    const w = r.warnings.find((x) => x.code === 'stop_sequence_window_order');
    expect(w?.params.sequence).toBe(4);
    const back = (await reorder(t.id, [s.pA, s.pB, s.qA, s.qB]).expect(200)).body as Trip;
    expect(back.warnings.map((x) => x.code)).not.toContain('stop_sequence_window_order');
  });

  it('ชุดจุดไม่ครบ/ซ้ำ/ของเที่ยวอื่น → 422 stop_set_mismatch · id ผิดรูป → 422', async () => {
    const { t, s } = await twoDropTrip();
    const o = await twoDropTrip();
    for (const ids of [
      [s.pA, s.pB, s.qA],
      [s.pA, s.pB, s.qA, s.qA],
      [s.pA, s.pB, s.qA, o.s.qB],
      [s.pA, s.pB, s.qA, s.qB, o.s.qB],
    ]) {
      const r = await reorder(t.id, ids).expect(422);
      expect(r.body.errors[0]).toMatchObject({ field: 'stopIds', code: 'stop_set_mismatch' });
    }
    await reorder(t.id, ['stp_x']).expect(422);
    await api(app, admin).post(`/v1/trips/${t.id}/reorder-stops`).send({}).expect(422);
  });

  it('สถานะที่แก้ไม่ได้ (ยกเลิกแล้ว) → 409 · สิทธิ์: planner ได้, viewer 403 · tenant อื่น 404', async () => {
    const { t, s } = await twoDropTrip();
    const order = [s.pA, s.qA, s.pB, s.qB];
    await reorder(t.id, order, viewer).expect(403);
    await reorder(t.id, order, other).expect(404);
    await reorder(t.id, order, planner).expect(200);
    await api(app, admin)
      .post(`/v1/trips/${t.id}/cancel`)
      .send({ reason: 'ลูกค้ายกเลิกงานทั้งหมด' })
      .expect(200);
    const r = await reorder(t.id, [s.pA, s.pB, s.qA, s.qB]).expect(409);
    expect(r.body.code).toBe('invalid_state_transition');
  });
});
