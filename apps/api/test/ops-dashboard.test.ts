import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SYSTEM_ROLES } from '@tms/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Clock } from '../src/common/clock';
import { tryDecodeId } from '../src/common/ids';
import { requestContext } from '../src/common/request-context';
import { DbService, type Tx } from '../src/db/db.service';
import { DeliveryOrderService } from '../src/modules/delivery-orders/delivery-order.service';
import {
  OrderIntakeService,
  type UpsertOrderInput,
} from '../src/modules/orders/order-intake.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * ST9-T01 Dashboard ปฏิบัติการ — เกณฑ์ตรวจรับ: ตัวเลขแต่ละการ์ด = จำนวนแถวของรายการเมื่อคลิกเข้าไป (ตัวกรองเดียวกัน)
 * ตัวนับมาจาก `GET /orders/summary`, `/trips/summary`, `/delivery-orders/summary`, `/vehicles/summary` (fleet)
 * เทียบกับจำนวนแถวจริงของ `GET /orders|/trips|/delivery-orders|/vehicles` ที่เดินครบทุกหน้า
 * + "วันนี้" ตามเวลาไทย (ขอบ 17:00 UTC), สิทธิ์, แยก tenant
 */
describe('ops dashboard (ST9-T01)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let otherId: string;
  let admin: string;
  let other: string;
  let seed = 0;
  let unitTon: string;
  let vt6: string;
  let clock: Clock;
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };
  /** วันในแบบทดสอบ (เวลาไทย) — ขอบวันอยู่ที่ 17:00 UTC */
  const D1 = '2026-11-18';
  const D2 = '2026-11-19';
  const jur = (n: number) => {
    const base = `0105${String(70_000 + n).padStart(8, '0')}`;
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
    return base + String((11 - (sum % 11)) % 10);
  };
  const uuid = (kind: Parameters<typeof tryDecodeId>[0], id: string) => tryDecodeId(kind, id)!;

  async function company(tid: string) {
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

  const run = <T>(fn: (tx: Tx) => Promise<T>, tid = tenantId) =>
    app
      .get(DbService)
      .withTenant(tid, (tx) =>
        requestContext.run(
          { requestId: randomUUID(), tenantId: tid, actorId: 'user-test', locale: 'th', tx },
          () => fn(tx),
        ),
      );

  const newSite = async (token: string) =>
    uuid(
      'site',
      (
        await api(app, token)
          .post('/v1/customer-sites')
          .send({ name: `จุดรับส่ง ${++seed}`, kind: 'DROPOFF', address: ADDR })
          .expect(201)
      ).body.id,
    );
  const newCustomer = async (token: string) =>
    uuid(
      'customer',
      (
        await api(app, token)
          .post('/v1/customers')
          .send({ legalName: `ลูกค้า ${++seed}`, taxId: validTaxId(9500 + seed) })
          .expect(201)
      ).body.id,
    );
  const order = (k: {
    customer?: string;
    text?: string;
    o: string;
    d: string;
    day?: string;
  }): UpsertOrderInput => ({
    source: 'MANUAL',
    customer: k.customer ? { id: k.customer } : { text: k.text! },
    requestedDate: k.day ?? D1,
    stops: [
      { type: 'PICKUP', siteId: k.o },
      { type: 'DELIVERY', siteId: k.d },
    ],
    lines: [{ description: 'ปูนซีเมนต์', qty: '1', unitId: unitTon, weightKg: '1000' }],
  });

  let cust: string;
  let o: string;
  let d: string;
  let vehicleTypeId: string;
  /** DO ใหม่ (DRAFT ไม่อยู่ในเที่ยว) ของ tenant หลัก */
  const newDo = async () => {
    const { order: so } = await run((tx) =>
      app.get(OrderIntakeService).upsertOrder(order({ customer: cust, o, d }), tx),
    );
    const [x] = await run((tx) => app.get(DeliveryOrderService).listForOrder(so.id, {}, tx));
    return x!.id;
  };
  const newVehicle = async (token = admin) =>
    (
      await api(app, token)
        .post('/v1/vehicles')
        .send({
          plate: `7${seed % 10}-${String(2000 + ++seed)}`,
          plateProvince: 'TH-10',
          vehicleTypeId: vt6,
          ownership: 'OWN',
        })
        .expect(201)
    ).body as { id: string };
  let tripN = 0;
  const trip = async (
    status: 'PLANNING' | 'OFFERED' | 'DISPATCHED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED',
    opts: {
      vehicleId?: string;
      trailerId?: string;
      carrierId?: string;
      tid?: string;
      vtId?: string;
    } = {},
  ) => {
    const tid = opts.tid ?? tenantId;
    return db.trip.create({
      data: {
        tenantId: tid,
        tripNo: `TRP-DASH-${++tripN}`,
        tripDate: new Date(`${D1}T00:00:00Z`),
        status,
        ...(opts.vehicleId
          ? {
              vehicleId: opts.vehicleId,
              vehiclePlateSnapshot: 'ทดสอบ',
              vehicleTypeId: opts.vtId ?? vehicleTypeId,
            }
          : {}),
        ...(opts.trailerId ? { trailerId: opts.trailerId, trailerPlateSnapshot: 'หาง' } : {}),
        ...(opts.carrierId
          ? {
              carrierId: opts.carrierId,
              carrierNameSnapshot: 'รถร่วม',
              assignmentStatus: 'OFFERED',
            }
          : {}),
        ...(status === 'CANCELLED'
          ? { cancelledAt: new Date(), cancelReason: 'ยกเลิกเที่ยวทดสอบ dashboard' }
          : {}),
      },
    });
  };
  /** ตั้งสถานะ/วันที่ของ DO ตรง ๆ (ทดสอบตัวนับ ไม่ใช่ state machine) */
  const setDo = (id: string, status: string, doDate: string, tripId: string | null) =>
    db.deliveryOrder.update({
      where: { id },
      data: {
        status: status as never,
        doDate: new Date(`${doDate}T00:00:00Z`),
        ...(tripId ? { tripId } : {}),
      },
    });

  /** จำนวนแถวจริงของรายการ (เดิน nextCursor ครบทุกหน้า) */
  async function rows(path: string, token = admin): Promise<number> {
    let n = 0;
    let cursor: string | null = null;
    do {
      const sep = path.includes('?') ? '&' : '?';
      const r: { body: { data: unknown[]; nextCursor: string | null } } = await api(app, token)
        .get(`${path}${sep}limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
        .expect(200);
      n += r.body.data.length;
      cursor = r.body.nextCursor;
    } while (cursor);
    return n;
  }

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    clock = app.get(Clock);
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท แดชบอร์ด' })).id;
    otherId = (await createTenantWithDefaults(db, { name: 'บริษัท อื่น' })).id;
    await company(tenantId);
    await company(otherId);
    admin = await tokenFor(tenantId);
    other = await tokenFor(otherId);
    const us = (await api(app, admin).get('/v1/units?limit=50').expect(200)).body.data as {
      id: string;
      code: string;
    }[];
    unitTon = uuid('unit', us.find((u) => u.code === 'TON')!.id);
    const types = (await api(app, admin).get('/v1/vehicle-types?limit=50').expect(200)).body
      .data as { id: string; code: string }[];
    vt6 = types.find((t) => t.code === '6W')!.id;
    vehicleTypeId = uuid('vehicleType', vt6);
    cust = await newCustomer(admin);
    o = await newSite(admin);
    d = await newSite(admin);
  });
  afterAll(async () => {
    clock?.set(null);
    await app.close();
    await db.$disconnect();
  });

  it('ทุกการ์ด = จำนวนแถวของรายการที่กรองเดียวกัน (หลายสถานะ + ขอบวันเวลาไทย)', async () => {
    // ---------- SO: รอจัด (RECEIVED) 2 + ค้างจับคู่ลูกค้าไม่ได้ 1 ----------
    for (let i = 0; i < 2; i++)
      await run((tx) =>
        app.get(OrderIntakeService).upsertOrder(order({ customer: cust, o, d }), tx),
      );
    await run((tx) =>
      app.get(OrderIntakeService).upsertOrder(order({ text: 'ลูกค้าไม่มีในระบบ', o, d }), tx),
    );
    // วันรับของไกลกว่าพรุ่งนี้ → ไม่นับรอจัดรถ · เลยกำหนดรับ (2 วันก่อน) → นับ + บรรทัดรอง "เลยกำหนดรับ"
    await run((tx) =>
      app
        .get(OrderIntakeService)
        .upsertOrder(order({ customer: cust, o, d, day: '2026-11-23' }), tx),
    );
    await run((tx) =>
      app
        .get(OrderIntakeService)
        .upsertOrder(order({ customer: cust, o, d, day: '2026-11-16' }), tx),
    );

    // ---------- เที่ยว + รถ ----------
    const vIdle = await newVehicle();
    const vRun = await newVehicle();
    const vProg = await newVehicle();
    const vTrailer = await newVehicle();
    const vFix = await newVehicle();
    const vDone = await newVehicle();
    await db.vehicle.update({
      where: { id: uuid('vehicle', vFix.id) },
      data: { status: 'MAINTENANCE' },
    });
    const carrier = (
      await api(app, admin)
        .post('/v1/carriers')
        .send({ legalName: 'หจก. รถร่วมแดชบอร์ด', entityType: 'JURISTIC', taxId: jur(1) })
        .expect(201)
    ).body as { id: string };
    const tRun = await trip('DISPATCHED', {
      vehicleId: uuid('vehicle', vRun.id),
      trailerId: uuid('vehicle', vTrailer.id),
    });
    await trip('IN_PROGRESS', { vehicleId: uuid('vehicle', vProg.id) });
    await trip('COMPLETED', { vehicleId: uuid('vehicle', vDone.id) });
    // รถซ่อมที่ยังค้างในเที่ยวที่ปล่อยแล้ว → นับ "ซ่อม" อย่างเดียว (ไม่นับ "ใช้งาน")
    await trip('DISPATCHED', { vehicleId: uuid('vehicle', vFix.id) });
    await trip('OFFERED', { carrierId: uuid('carrier', carrier.id) });
    await trip('OFFERED', { carrierId: uuid('carrier', carrier.id) });
    await trip('PLANNING');
    await trip('CANCELLED');

    // ---------- DO: D1 (ส่งแล้ว 2, ล้มเหลว 1, ระหว่างส่ง 1, ยกเลิก 1) · D2 (ส่งแล้ว 1, ร่าง 1) ----------
    const plan: [string, string, boolean][] = [
      ['DELIVERED', D1, true],
      ['POD_PENDING', D1, true],
      ['FAILED', D1, true],
      ['DISPATCHED', D1, true],
      ['CANCELLED', D1, false],
      ['DELIVERED', D2, true],
      ['DRAFT', D2, false],
    ];
    for (const [st, day, onTrip] of plan)
      await setDo(await newDo(), st, day, onTrip ? tRun.id : null);
    // DO ของคำสั่งรอจัดชุดแรก (DRAFT วันที่ D1 ตาม requestedDate) ยังนับใน "งานวันนี้" ของ D1

    // ---------- tenant อื่น: ข้อมูลที่ต้องไม่ถูกนับ ----------
    const oTypes = (await api(app, other).get('/v1/vehicle-types?limit=50').expect(200)).body
      .data as { id: string; code: string }[];
    const oVeh = (
      await api(app, other)
        .post('/v1/vehicles')
        .send({
          plate: '71-9999',
          plateProvince: 'TH-10',
          vehicleTypeId: oTypes.find((t) => t.code === '6W')!.id,
          ownership: 'OWN',
        })
        .expect(201)
    ).body as { id: string };
    const oCar = (
      await api(app, other)
        .post('/v1/carriers')
        .send({ legalName: 'หจก. รถร่วมอื่น', entityType: 'JURISTIC', taxId: jur(2) })
        .expect(201)
    ).body as { id: string };
    await trip('DISPATCHED', {
      tid: otherId,
      vehicleId: uuid('vehicle', oVeh.id),
      vtId: uuid('vehicleType', oTypes.find((t) => t.code === '6W')!.id),
    });
    await trip('OFFERED', { tid: otherId, carrierId: uuid('carrier', oCar.id) });

    // ---------- SO ----------
    clock.set(new Date(`${D1}T05:00:00Z`));
    const so = (await api(app, admin).get('/v1/orders/summary').expect(200)).body;
    expect(so.today).toBe(D1);
    expect(so.waiting).toBe(
      await rows('/v1/orders?status=received,on_hold&requestedTo=2026-11-19'),
    );
    expect(so.waiting).toBeGreaterThanOrEqual(4);
    expect(so.waiting).toBeLessThan(await rows('/v1/orders?status=received,on_hold'));
    expect(so.waitingOverdue).toBe(
      await rows('/v1/orders?status=received,on_hold&requestedTo=2026-11-17'),
    );
    expect(so.waitingOverdue).toBe(1);
    clock.set(null);
    for (const h of so.holdReasons as { code: string; count: number }[])
      expect(h.count, h.code).toBe(await rows(`/v1/orders?held=true&holdReason=${h.code}`));
    expect(
      (so.holdReasons as { code: string; count: number }[]).find(
        (h) => h.code === 'CUSTOMER_UNMAPPED',
      )!.count,
    ).toBe(1);

    // ---------- เที่ยว ----------
    const tr = (await api(app, admin).get('/v1/trips/summary').expect(200)).body;
    expect(tr).toEqual({
      running: 1,
      offered: 2,
      planning: 3,
      inTransit: 3,
      done: 1,
      subcon: 2,
      total: 8,
    });
    expect(tr.total).toBe(await rows('/v1/trips'));
    expect(tr.running).toBe(await rows('/v1/trips?status=IN_PROGRESS'));
    expect(tr.offered).toBe(await rows('/v1/trips?status=OFFERED'));
    // หน้า `/trips` (UAT 24 พ.ย.) — การ์ด = จำนวนแถวของแท็บ/ตัวกรองเดียวกัน
    expect(tr.planning).toBe(await rows('/v1/trips?status=PLANNING,OFFERED,ASSIGNED'));
    expect(tr.inTransit).toBe(await rows('/v1/trips?status=DISPATCHED,IN_PROGRESS'));
    expect(tr.done).toBe(await rows('/v1/trips?status=COMPLETED,COSTED,SETTLED'));
    expect(tr.subcon).toBe(
      await rows(
        '/v1/trips?ownership=SUBCON&status=PLANNING,OFFERED,ASSIGNED,DISPATCHED,IN_PROGRESS,COMPLETED,COSTED,SETTLED',
      ),
    );
    // ตัวกรองค้นของหน้า `/trips` (มีคำนี้ ไม่สนตัวพิมพ์)
    expect(await rows('/v1/trips?ownership=OWN')).toBe(6);
    expect(await rows('/v1/trips?ownership=SUBCON')).toBe(2);
    expect(await rows('/v1/trips?vehiclePlate=%E0%B8%AB%E0%B8%B2%E0%B8%87')).toBe(1); // "หาง"
    expect(await rows(`/v1/trips?driverName=${encodeURIComponent('รถร่วม')}`)).toBe(2);
    expect(await rows(`/v1/trips?tripNo=${tRun.tripNo!.toLowerCase()}`)).toBe(1);
    expect(await rows('/v1/trips?tripNo=TRP_DASH')).toBe(0);
    expect(await rows('/v1/trips?vehiclePlate=%25')).toBe(0);
    // คอลัมน์ รายได้ / ค่าเที่ยว — มีในรายการ (ไม่มีบรรทัด = 0.00)
    const tl = (await api(app, admin).get('/v1/trips?limit=50').expect(200)).body.data as {
      id: string;
      sellAmount?: string;
      buyTotal?: string;
    }[];
    for (const x of tl) {
      expect(x.sellAmount).toMatch(/^\d+\.\d{2}$/);
      expect(x.buyTotal).toMatch(/^-?\d+\.\d{2}$/);
    }

    // ---------- รถ (บริษัท) ----------
    const fl = (await api(app, admin).get('/v1/vehicles/summary').expect(200)).body.fleet;
    // ใช้งาน = รถ 2 คัน + หาง 1 คันของเที่ยวที่ปล่อยแล้ว · ว่าง = vIdle + vDone (เที่ยวปิดแล้ว) · ซ่อม = vFix
    expect(fl).toEqual({ available: 2, inUse: 3, maintenance: 1 });
    expect(fl.available).toBe(await rows('/v1/vehicles?ownership=OWN&status=ready&busy=false'));
    expect(fl.inUse).toBe(await rows('/v1/vehicles?ownership=OWN&busy=true'));
    expect(fl.maintenance).toBe(await rows('/v1/vehicles?ownership=OWN&status=maintenance'));
    // ว่าง + ใช้งาน + ซ่อม = รถบริษัททั้งหมด (ไม่ซ้อนกัน)
    expect(fl.available + fl.inUse + fl.maintenance).toBe(await rows('/v1/vehicles?ownership=OWN'));
    expect(vIdle.id).toBeTruthy();

    // ---------- DO: ขอบวันเวลาไทย ----------
    const doCards = async (day: string) => {
      const s = (await api(app, admin).get('/v1/delivery-orders/summary').expect(200)).body;
      expect(s.date).toBe(day);
      const q = (st: string) => `/v1/delivery-orders?dateFrom=${day}&dateTo=${day}&status=${st}`;
      expect(s.today).toBe(
        await rows(
          q(
            'DRAFT,PLANNED,DISPATCHED,PICKED_UP,DELIVERED,FAILED,RETURNED,POD_PENDING,UNBILLED,BILLED',
          ),
        ),
      );
      expect(s.delivered).toBe(await rows(q('DELIVERED,POD_PENDING,UNBILLED,BILLED')));
      expect(s.failed).toBe(await rows(q('FAILED')));
      return s;
    };
    // 23:59:59 เวลาไทยของ D1 (16:59:59 UTC) → ยังเป็น D1
    clock.set(new Date(`${D1}T16:59:59Z`));
    const s1 = await doCards(D1);
    // DO ของ SO รอจัด 2 ใบ (DRAFT, D1) + ส่งแล้ว 2 + ล้มเหลว 1 + ระหว่างส่ง 1 (ยกเลิกไม่นับ)
    expect(s1).toMatchObject({ today: 6, delivered: 2, failed: 1 });
    // 00:00 เวลาไทยของ D2 (17:00 UTC ของ D1) → D2
    clock.set(new Date(`${D1}T17:00:00Z`));
    const s2 = await doCards(D2);
    expect(s2).toMatchObject({ today: 2, delivered: 1, failed: 0 });
    clock.set(null);
    // หน้า `/do` (UAT 24 พ.ย.) — การ์ดทุกวันที่ = จำนวนแถวของแท็บเดียวกัน
    const all = (await api(app, admin).get('/v1/delivery-orders/summary').expect(200)).body;
    expect(all.draft).toBe(await rows('/v1/delivery-orders?status=DRAFT,PLANNED'));
    expect(all.inTransit).toBe(await rows('/v1/delivery-orders?status=DISPATCHED,PICKED_UP'));
    expect(all.unbilled).toBe(
      await rows('/v1/delivery-orders?status=DELIVERED,POD_PENDING,UNBILLED'),
    );
    expect(all.unbilled).toBe(3);
    expect(all.failedTotal).toBe(await rows('/v1/delivery-orders?status=FAILED,RETURNED'));
    expect(all.failedTotal).toBe(1);
    expect(all.deliveredClean).toBe(
      await rows('/v1/delivery-orders?status=DELIVERED,POD_PENDING,UNBILLED&rejected=false'),
    );
    expect(all.rejected).toBe(
      await rows('/v1/delivery-orders?status=DELIVERED,POD_PENDING,UNBILLED&rejected=true'),
    );
    expect(all.deliveredClean + all.rejected).toBe(all.unbilled);
    expect(all.billed).toBe(await rows('/v1/delivery-orders?status=BILLED'));
    expect(all.total).toBe(await rows('/v1/delivery-orders'));
    expect(all.inTransit).toBe(1);
    expect(all.sellUnbilledAmount).toMatch(/^\d+\.\d{2}$/);
    // ตัวกรองค้นของหน้า `/do`
    const total = await rows('/v1/delivery-orders');
    // ค้นชื่อจุดรับ/ส่ง · อักขระ LIKE (% _) ค้นตามตัวอักษร ไม่ใช่ wildcard
    expect(await rows(`/v1/delivery-orders?route=${encodeURIComponent('จุดรับส่ง')}`)).toBe(total);
    expect(await rows('/v1/delivery-orders?route=%25')).toBe(0);
    expect(await rows('/v1/delivery-orders?doNo=_')).toBe(0);
    // กระดานหน้า `/trips`: DO รอเข้าเที่ยว = ไม่อยู่ในเที่ยวที่ยังใช้งาน
    const inTrip = await rows('/v1/delivery-orders?inTrip=true');
    expect(inTrip).toBe(5);
    expect(inTrip + (await rows('/v1/delivery-orders?inTrip=false'))).toBe(total);
    expect(await rows(`/v1/delivery-orders?product=${encodeURIComponent('ปูน')}`)).toBe(total);
    expect(await rows(`/v1/delivery-orders?customerName=${encodeURIComponent('ลูกค้า')}`)).toBe(
      total,
    );
    expect(await rows(`/v1/delivery-orders?vehiclePlate=${encodeURIComponent('ทดสอบ')}`)).toBe(5);
    expect(await rows(`/v1/delivery-orders?driverName=${encodeURIComponent('ไม่มีคนนี้')}`)).toBe(
      0,
    );
    const anyDo = (await api(app, admin).get('/v1/delivery-orders?limit=1').expect(200)).body
      .data[0] as { doNo: string };
    expect(
      await rows(`/v1/delivery-orders?doNo=${encodeURIComponent(anyDo.doNo.toLowerCase())}`),
    ).toBe(1);

    // ---------- รายการ DO มีชื่อสำหรับแสดง (ลูกค้า/จุด/เที่ยว) ----------
    const one = (
      await api(app, admin)
        .get(`/v1/delivery-orders?dateFrom=${D1}&dateTo=${D1}&status=FAILED`)
        .expect(200)
    ).body.data[0];
    expect(one).toMatchObject({ tripNo: tRun.tripNo, vehiclePlate: 'ทดสอบ' });
    expect(one).toHaveProperty('vehicleTypeName');
    expect(one.customerName).toMatch(/^ลูกค้า /);
    expect(one.originSiteName).toMatch(/^จุดรับส่ง /);
  });

  it('แยก tenant: ตัวนับของบริษัทอื่นไม่รวมข้อมูลของเรา', async () => {
    const tr = (await api(app, other).get('/v1/trips/summary').expect(200)).body;
    expect(tr).toEqual({
      running: 0,
      offered: 1,
      planning: 1,
      inTransit: 1,
      done: 0,
      subcon: 1,
      total: 2,
    });
    const so = (await api(app, other).get('/v1/orders/summary').expect(200)).body;
    expect(so.waiting).toBe(0);
    const fl = (await api(app, other).get('/v1/vehicles/summary').expect(200)).body.fleet;
    expect(fl).toEqual({ available: 0, inUse: 1, maintenance: 0 });
    const ds = (await api(app, other).get('/v1/delivery-orders/summary').expect(200)).body;
    expect([
      ds.today,
      ds.delivered,
      ds.failed,
      ds.draft,
      ds.inTransit,
      ds.unbilled,
      ds.deliveredClean,
      ds.rejected,
      ds.failedTotal,
      ds.billed,
      ds.total,
    ]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(ds.sellUnbilledAmount).toBe('0.00');
    expect(await rows('/v1/trips?ownership=SUBCON', other)).toBe(1);
  });

  it('สิทธิ์: ไม่มี scope ของรายการ → 403 (การ์ดนั้นไม่แสดง) · role ปฏิบัติการเห็นครบ · ไม่มีฟิลด์เงิน', async () => {
    const ordersOnly = await tokenFor(tenantId, 'orders:read', 'u-orders');
    await api(app, ordersOnly).get('/v1/trips/summary').expect(403);
    await api(app, ordersOnly).get('/v1/vehicles/summary').expect(403);
    await api(app, ordersOnly).get('/v1/delivery-orders/summary').expect(200);
    const tripsOnly = await tokenFor(tenantId, 'trips:read', 'u-trips');
    await api(app, tripsOnly).get('/v1/orders/summary').expect(403);
    await api(app, tripsOnly).get('/v1/delivery-orders/summary').expect(403);
    const disp = await tokenFor(
      tenantId,
      SYSTEM_ROLES.dispatcher.permissions.join(' '),
      'u-dispatch',
    );
    for (const p of [
      '/v1/orders/summary',
      '/v1/trips/summary',
      '/v1/delivery-orders/summary',
      '/v1/vehicles/summary',
    ]) {
      const r = await api(app, disp).get(p).expect(200);
      expect(JSON.stringify(r.body)).not.toMatch(/amount|price|revenue|outstanding/i);
    }
    // รายการเที่ยวของ dispatcher: เห็นค่าเที่ยว (prices.buy:read) แต่ไม่เห็นรายได้ (ไม่มี prices.sell:read)
    const dt = (await api(app, disp).get('/v1/trips?limit=5').expect(200)).body.data as Record<
      string,
      unknown
    >[];
    expect(dt.length).toBeGreaterThan(0);
    for (const x of dt) {
      expect(x).not.toHaveProperty('sellAmount');
      expect(x).toHaveProperty('buyTotal');
    }
    const viewer = await tokenFor(tenantId, 'trips:read', 'u-viewer');
    const vt = (await api(app, viewer).get('/v1/trips?limit=5').expect(200)).body.data as Record<
      string,
      unknown
    >[];
    for (const x of vt) {
      expect(x).not.toHaveProperty('buyTotal');
      expect(x).not.toHaveProperty('sellAmount');
    }
    // amounts=false → ไม่มียอดเงินแม้มีสิทธิ์
    const na = (await api(app, admin).get('/v1/trips?limit=5&amounts=false').expect(200)).body
      .data as Record<string, unknown>[];
    for (const x of na) expect(x).not.toHaveProperty('sellAmount');
    // รายการ DO ของ dispatcher (ไม่มีสิทธิ์ราคา) ไม่มีรายได้
    const l = await api(app, disp).get('/v1/delivery-orders?limit=5').expect(200);
    expect(JSON.stringify(l.body)).not.toMatch(/revenue|price/i);
  });
});
