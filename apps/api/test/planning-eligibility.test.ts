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
import { eligibilityLevel } from '../src/modules/planning/eligibility.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { addDays, bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

interface Issue {
  code: string;
  severity: 'block' | 'warning' | 'info';
  message: string;
  date: string | null;
}
interface Item {
  vehicleId: string;
  orderId: string | null;
  tripId: string | null;
  level: 'OK' | 'WARNING' | 'BLOCK';
  issues: Issue[];
}
interface Elig {
  from: string;
  to: string;
  subject: string;
  items: Item[];
}

/**
 * ST3-T15 Filter รถที่รับได้สองทาง — GET /v1/planning/eligibility (orderId / vehicleId / tripId)
 * กฎชุดเดียวกับ ST3-T14 (อ่านอย่างเดียว): ห้องเย็น/ขนาด (ความเข้ากันได้) · น้ำหนัก · เอกสารรถ/ใบขับขี่ (ต่อวัน) · ซ้อนเวลา (เที่ยว)
 */
describe('planning eligibility (ST3-T15)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let otherId: string;
  let admin: string;
  let planner: string;
  let other: string;
  let seed = 0;
  let unitTon: string;
  let vt6: string;
  let ref6: string;
  const today = bangkokToday();
  const at = (hh: string) => `${today}T${hh}:00+07:00`;
  const uuid = (kind: Parameters<typeof tryDecodeId>[0], id: string) => tryDecodeId(kind, id)!;
  /** เลขผู้เสียภาษีนิติบุคคล (0105…) ที่ตรวจหลักถูก */
  const jur = (n: number) => {
    const base = `0105${String(600_000 + n).padStart(8, '0')}`;
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
    return base + String((11 - (sum % 11)) % 10);
  };
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท รถที่รับได้' })).id;
    otherId = (await createTenantWithDefaults(db, { name: 'บริษัท อื่น' })).id;
    for (const tid of [tenantId, otherId]) {
      const c = await db.company.create({
        data: {
          tenantId: tid,
          legalName: `บริษัท ผู้ออกบิล ${++seed}`,
          taxId: validTaxId(900 + seed),
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
    other = await tokenFor(otherId);
    const us = (await api(app, admin).get('/v1/units?limit=50').expect(200)).body.data as {
      id: string;
      code: string;
    }[];
    unitTon = uuid('unit', us.find((u) => u.code === 'TON')!.id);
    const types = (await api(app, admin).get('/v1/vehicle-types?limit=50').expect(200)).body
      .data as { id: string; code: string }[];
    vt6 = types.find((t) => t.code === '6W')!.id;
    ref6 = types.find((t) => t.code === 'REF6')!.id;
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
  const site = async () =>
    uuid(
      'site',
      (
        await api(app, admin)
          .post('/v1/customer-sites')
          .send({ name: `จุด ${++seed}`, kind: 'DROPOFF', address: ADDR })
          .expect(201)
      ).body.id,
    );
  const customer = async () =>
    uuid(
      'customer',
      (
        await api(app, admin)
          .post('/v1/customers')
          .send({ legalName: `ลูกค้า ${++seed}`, taxId: validTaxId(7700 + ++seed) })
          .expect(201)
      ).body.id,
    );
  const newOrder = async (o: { weightKg: string; vehicleTypeId?: string }) => {
    const input: UpsertOrderInput = {
      source: 'MANUAL',
      customer: { id: await customer() },
      requestedDate: today,
      ...(o.vehicleTypeId ? { vehicleTypeId: uuid('vehicleType', o.vehicleTypeId) } : {}),
      stops: [
        { type: 'PICKUP', siteId: await site() },
        { type: 'DELIVERY', siteId: await site() },
      ],
      lines: [{ description: 'สินค้า', qty: '1', unitId: unitTon, weightKg: o.weightKg }],
    };
    const { order: so } = await run((tx) => app.get(OrderIntakeService).upsertOrder(input, tx));
    const dos = await run((tx) => app.get(DeliveryOrderService).listForOrder(so.id, {}, tx));
    return {
      soId: encodeId('salesOrder', so.id),
      doIds: dos.map((d) => encodeId('deliveryOrder', d.id)),
    };
  };
  const newVehicle = async (vehicleTypeId: string, payloadKg: number, extra: object = {}) =>
    (
      await api(app, admin)
        .post('/v1/vehicles')
        .send({
          plate: `7${++seed % 10}-${String(3000 + seed)}`,
          plateProvince: 'TH-10',
          vehicleTypeId,
          ownership: 'OWN',
          payloadKg,
          ...extra,
        })
        .expect(201)
    ).body as { id: string; plate: string };
  const elig = async (q: string, token = admin) =>
    (await api(app, token).get(`/v1/planning/eligibility?${q}`).expect(200)).body as Elig;
  const of = (e: Elig, vehicleId: string) => e.items.find((i) => i.vehicleId === vehicleId)!;

  it('เกณฑ์ตรวจรับ: คลิก SO ห้องเย็น → เน้นเฉพาะรถห้องเย็นที่น้ำหนักพอ (รถธรรมดา/ห้องเย็นเล็กเกิน = คำเตือน ไม่เน้น)', async () => {
    const coldBig = await newVehicle(ref6, 6000);
    const coldSmall = await newVehicle(ref6, 3000);
    const dry = await newVehicle(vt6, 6000);
    const o = await newOrder({ weightKg: '4000', vehicleTypeId: ref6 });

    const e = await elig(`orderId=${o.soId}`, planner);
    expect(e).toMatchObject({ subject: 'ORDER', from: today, to: today });
    expect(of(e, coldBig.id)).toMatchObject({ orderId: o.soId, level: 'OK', issues: [] });
    expect(of(e, coldSmall.id)).toMatchObject({
      level: 'WARNING',
      issues: [
        {
          code: 'OVERWEIGHT',
          severity: 'warning',
          message: 'น้ำหนักเกิน 1,000 กก. (4,000 / 3,000 กก.)',
          date: null,
        },
      ],
    });
    expect(of(e, dry.id)).toMatchObject({
      level: 'WARNING',
      issues: [
        {
          code: 'CAPABILITY_MISSING',
          severity: 'warning',
          message: 'งานนี้ต้องใช้รถห้องเย็น แต่ประเภทรถที่เลือกไม่มี',
        },
      ],
    });
    // ทุกคันบนกระดาน (หนึ่งรายการต่อรถ)
    expect(new Set(e.items.map((i) => i.vehicleId)).size).toBe(e.items.length);
    expect(e.items.filter((i) => i.level === 'OK').map((i) => i.vehicleId)).toEqual([coldBig.id]);
  });

  it('คลิกรถ → SO รอจัดที่รถรับได้ (ทางกลับ) · ข้อความเดียวกับผลตรวจของเที่ยวเมื่อวางจริง', async () => {
    const v = await newVehicle(vt6, 6000);
    const ok = await newOrder({ weightKg: '2000', vehicleTypeId: vt6 });
    const heavy = await newOrder({ weightKg: '6800', vehicleTypeId: vt6 });
    const cold = await newOrder({ weightKg: '1000', vehicleTypeId: ref6 });
    const e = await elig(`vehicleId=${v.id}&days=7`);
    expect(e).toMatchObject({ subject: 'VEHICLE', from: today, to: addDays(today, 6) });
    const byOrder = (id: string) => e.items.find((i) => i.orderId === id)!;
    expect(byOrder(ok.soId)).toMatchObject({ vehicleId: v.id, level: 'OK' });
    expect(byOrder(heavy.soId).issues.map((i) => i.code)).toEqual(['OVERWEIGHT']);
    expect(byOrder(cold.soId).issues.map((i) => i.code)).toEqual(['CAPABILITY_MISSING']);
    // วางจริง → คำเตือนของเที่ยวตรงกับที่เน้นไว้ (แหล่งความจริงเดียว)
    const r = await api(app, admin)
      .post('/v1/trips')
      .set('Idempotency-Key', randomUUID())
      .send({
        tripDate: today,
        deliveryOrderIds: heavy.doIds,
        vehicleId: v.id,
        plannedStartAt: at('09:00'),
        plannedEndAt: at('12:00'),
      })
      .expect(201);
    const w = (r.body.warnings as { code: string; message: string }[]).find(
      (x) => x.code === 'OVERWEIGHT',
    )!;
    expect(w.message).toBe(byOrder(heavy.soId).issues[0]!.message);
    // ลงเที่ยวแล้ว → ไม่อยู่ใน SO รอจัด
    const after = await elig(`vehicleId=${v.id}`);
    expect(after.items.find((i) => i.orderId === heavy.soId)).toBeUndefined();
  });

  it('เอกสาร: รถร่วมไม่มีเอกสารบังคับ = BLOCK ทุกวัน (date null) · พ.ร.บ. หมดกลางช่วง 7 วัน = BLOCK เฉพาะวันหลังหมด', async () => {
    const carrier = (
      await api(app, admin)
        .post('/v1/carriers')
        .send({
          legalName: `หจก. รถร่วม ${++seed}`,
          entityType: 'JURISTIC',
          taxId: jur(seed),
        })
        .expect(201)
    ).body as { id: string };
    const sub = await newVehicle(vt6, 6000, { ownership: 'SUBCONTRACT', carrierId: carrier.id });
    const own = await newVehicle(vt6, 6000);
    await db.vehicleDocument.create({
      data: {
        tenantId,
        vehicleId: uuid('vehicle', own.id),
        docType: 'COMPULSORY_ACT',
        startsOn: new Date(`${addDays(today, -300)}T00:00:00Z`),
        expiresOn: new Date(`${addDays(today, 2)}T00:00:00Z`),
        isRequiredForDispatch: true,
      },
    });
    const o = await newOrder({ weightKg: '1000' });
    const e = await elig(`orderId=${o.soId}&days=7`);
    const s = of(e, sub.id);
    expect(s.level).toBe('BLOCK');
    expect(s.issues.filter((i) => i.severity === 'block').every((i) => i.date === null)).toBe(true);
    expect(s.issues.map((i) => i.code)).toContain('DOC_MISSING');
    const w = of(e, own.id);
    expect(w.level).toBe('BLOCK');
    expect(w.issues.map((i) => [i.code, i.date])).toEqual(
      [3, 4, 5, 6].map((n) => ['DOC_CMI_EXPIRED', addDays(today, n)]),
    );
    // วันนี้ (วันเดียว) ยังไม่หมด → ผ่าน
    expect(of(await elig(`orderId=${o.soId}`), own.id).level).toBe('OK');
  });

  it('ย้ายไปรถอื่น (tripId): ประเมิน DO ทั้งเที่ยว + รถที่มีเที่ยวซ้อนเวลา = คำเตือน vehicle_overlap', async () => {
    const a = await newVehicle(vt6, 6000);
    const b = await newVehicle(vt6, 6000);
    const c = await newVehicle(vt6, 6000);
    const mk = async (vehicleId: string, s: string, e: string) =>
      (
        await api(app, admin)
          .post('/v1/trips')
          .set('Idempotency-Key', randomUUID())
          .send({
            tripDate: today,
            deliveryOrderIds: (await newOrder({ weightKg: '3000' })).doIds,
            vehicleId,
            plannedStartAt: at(s),
            plannedEndAt: at(e),
          })
          .expect(201)
      ).body as { id: string; tripNo: string };
    const t = await mk(a.id, '09:00', '12:00');
    const busy = await mk(b.id, '11:00', '14:00');
    await mk(c.id, '13:00', '15:00');
    const e = await elig(`tripId=${t.id}`);
    expect(e).toMatchObject({ subject: 'TRIP', from: today, to: today });
    expect(of(e, b.id)).toMatchObject({
      tripId: t.id,
      orderId: null,
      level: 'WARNING',
      issues: [{ code: 'vehicle_overlap', message: expect.stringContaining(busy.tripNo) }],
    });
    expect(of(e, c.id).level).toBe('OK');
    // รถคันเดิมไม่ซ้อนกับตัวเอง
    expect(of(e, a.id).level).toBe('OK');
  });

  it('ต้องส่ง id อย่างเดียว (422) · id ของ tenant อื่น/ผิดรูปแบบ → 404 · ไม่มีสิทธิ์อ่านงาน → 403', async () => {
    const v = await newVehicle(vt6, 6000);
    const o = await newOrder({ weightKg: '1000' });
    const bad = await api(app, admin).get('/v1/planning/eligibility').expect(422);
    expect(bad.body.errors[0]).toMatchObject({ code: 'exactly_one' });
    await api(app, admin)
      .get(`/v1/planning/eligibility?orderId=${o.soId}&vehicleId=${v.id}`)
      .expect(422);
    await api(app, admin)
      .get(`/v1/planning/eligibility?orderId=${o.soId}&date=2026-02-30`)
      .expect(422);
    for (const q of [`orderId=${o.soId}`, `vehicleId=${v.id}`, 'tripId=trp_nope', 'orderId=xyz'])
      await api(app, other).get(`/v1/planning/eligibility?${q}`).expect(404);
    const noOrders = await tokenFor(tenantId, 'trips:read', 'u-trips-only');
    await api(app, noOrders).get(`/v1/planning/eligibility?orderId=${o.soId}`).expect(403);
    const noTrips = await tokenFor(tenantId, 'orders:read', 'u-orders-only');
    await api(app, noTrips).get(`/v1/planning/eligibility?orderId=${o.soId}`).expect(403);
  });

  it('รถหลายคันประเมินในคำขอเดียว (ไม่ N+1): 40 คันตอบภายในเวลาที่กระดานยอมรับ', async () => {
    for (let i = 0; i < 40; i++) await newVehicle(i % 2 ? ref6 : vt6, 6000);
    const o = await newOrder({ weightKg: '1000', vehicleTypeId: ref6 });
    const t0 = Date.now();
    const e = await elig(`orderId=${o.soId}&days=7`);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(e.items.length).toBeGreaterThanOrEqual(40);
  });

  it('eligibilityLevel: บล็อก > คำเตือน > ผ่าน (info ไม่นับ)', () => {
    expect(eligibilityLevel([])).toBe('OK');
    expect(eligibilityLevel([{ severity: 'info' }])).toBe('OK');
    expect(eligibilityLevel([{ severity: 'info' }, { severity: 'warning' }])).toBe('WARNING');
    expect(eligibilityLevel([{ severity: 'warning' }, { severity: 'block' }])).toBe('BLOCK');
  });
});
