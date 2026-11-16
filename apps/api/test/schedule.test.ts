import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SYSTEM_ROLES } from '@tms/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { requestContext } from '../src/common/request-context';
import { DbService, type Tx } from '../src/db/db.service';
import { DeliveryOrderService } from '../src/modules/delivery-orders/delivery-order.service';
import { OrderIntakeService } from '../src/modules/orders/order-intake.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { addDays, bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

interface Entry {
  id: string;
  kind: 'LEAVE' | 'NOTE';
  driver: { id: string; name: string } | null;
  vehicle: { id: string; plate: string } | null;
  startsOn: string;
  endsOn: string;
  note: string;
  cancelledAt: string | null;
  version: number;
}

/**
 * ST3-T19 ตารางรถ/คนขับรายวัน — วันลาคนขับ/โน้ตรายวัน (`/v1/schedule-entries`) และผลกับกระดาน (ST3-T12),
 * กฎตอนจัด `driver_on_leave` (ST3-T14), คนขับประจำใน eligibility `driverHints` (ST3-T15)
 */
describe('schedule entries (ST3-T19)', () => {
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
  let vt6: string;
  const today = bangkokToday();
  const d1 = addDays(today, 1);
  const d2 = addDays(today, 2);
  const uuid = (kind: Parameters<typeof tryDecodeId>[0], id: string) => tryDecodeId(kind, id)!;
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท ตารางรถ' })).id;
    otherId = (await createTenantWithDefaults(db, { name: 'บริษัท อื่น' })).id;
    for (const tid of [tenantId, otherId]) {
      const c = await db.company.create({
        data: { tenantId: tid, legalName: `บริษัท ${++seed}`, taxId: validTaxId(900 + seed) },
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
    const types = (await api(app, admin).get('/v1/vehicle-types?limit=50').expect(200)).body
      .data as { id: string; code: string }[];
    vt6 = types.find((t) => t.code === '6W')!.id;
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
  const newDo = async (date: string) => {
    const customer = uuid(
      'customer',
      (
        await api(app, admin)
          .post('/v1/customers')
          .send({ legalName: `ลูกค้า ${++seed}`, taxId: validTaxId(7700 + ++seed) })
          .expect(201)
      ).body.id,
    );
    const stops = [
      { type: 'PICKUP' as const, siteId: await site() },
      { type: 'DELIVERY' as const, siteId: await site() },
    ];
    const { order: so } = await run((tx) =>
      app.get(OrderIntakeService).upsertOrder(
        {
          source: 'MANUAL',
          customer: { id: customer },
          requestedDate: date,
          stops,
          lines: [{ description: 'สินค้า', qty: '1', unitId: unitTon, weightKg: '1000' }],
        },
        tx,
      ),
    );
    const [d] = await run((tx) => app.get(DeliveryOrderService).listForOrder(so.id, {}, tx));
    return encodeId('deliveryOrder', d!.id);
  };
  const newVehicle = async () =>
    (
      await api(app, admin)
        .post('/v1/vehicles')
        .send({
          plate: `7${++seed % 10}-${String(4000 + seed)}`,
          plateProvince: 'TH-10',
          vehicleTypeId: vt6,
          ownership: 'OWN',
          payloadKg: 6000,
        })
        .expect(201)
    ).body as { id: string; plate: string };
  const newDriver = async (extra: object = {}, token = admin) => {
    const n = ++seed;
    return (
      await api(app, token)
        .post('/v1/drivers')
        .send({
          name: `คนขับ ${n}`,
          phone: `089-${String(n).padStart(3, '0')}-${String(n).padStart(4, '0')}`,
          employmentType: 'EMPLOYEE_SALARIED',
          licenceClass: 'T2',
          licenceExpiresOn: '2030-03-31',
          ...extra,
        })
        .expect(201)
    ).body as { id: string; name: string };
  };
  const addEntry = (body: object, token = planner) =>
    api(app, token).post('/v1/schedule-entries').send(body);
  const leave = async (driverId: string, startsOn: string, endsOn = startsOn) =>
    (await addEntry({ kind: 'LEAVE', driverId, startsOn, endsOn, note: 'ลาป่วย' }).expect(201))
      .body as Entry;

  it('เกณฑ์ตรวจรับ: ใส่วันลาคนขับ → กระดานคืนวันลาในวันนั้น (ไม่ใช่ "ว่าง") · วันอื่นไม่กระทบ · audit', async () => {
    const v = await newVehicle();
    const d = await newDriver({ defaultVehicleId: v.id });
    const e = await leave(d.id, d1);
    expect(e).toMatchObject({
      kind: 'LEAVE',
      driver: { id: d.id, name: d.name },
      vehicle: null,
      startsOn: d1,
      endsOn: d1,
      note: 'ลาป่วย',
      cancelledAt: null,
      version: 1,
    });
    expect(e.id).toMatch(/^sch_/);
    const b = (await api(app, planner).get(`/v1/planning/board?date=${today}&days=7`).expect(200))
      .body as {
      vehicles: { id: string; driver: { id: string; status: string } | null }[];
      schedule: Entry[];
    };
    expect(b.vehicles.find((x) => x.id === v.id)!.driver).toMatchObject({
      id: d.id,
      status: 'ACTIVE',
    });
    expect(b.schedule.map((x) => x.id)).toContain(e.id);
    // วันนี้อย่างเดียว → ไม่ทับ
    const b1 = (await api(app, planner).get(`/v1/planning/board?date=${today}`).expect(200)).body;
    expect((b1.schedule as Entry[]).map((x) => x.id)).not.toContain(e.id);
    const list = (
      await api(app, viewer)
        .get(`/v1/schedule-entries?from=${today}&to=${d2}&driverId=${d.id}`)
        .expect(200)
    ).body.data as Entry[];
    expect(list.map((x) => x.id)).toEqual([e.id]);
    const audit = await db.auditLog.findMany({
      where: { tenantId, entityType: 'schedule_entry', entityId: uuid('scheduleEntry', e.id) },
    });
    expect(audit.map((a) => a.action)).toEqual(['schedule_entry.created']);
    expect(audit[0]!.after).toMatchObject({ kind: 'LEAVE', startsOn: d1, note: 'ลาป่วย' });
  });

  it('กฎตอนจัด (ST3-T14): จัดคนขับที่ลาวันนั้น → คำเตือน driver_on_leave พร้อมวัน · ใส่วันลาหลังจัด → เที่ยวตรวจใหม่ · ยกเลิกวันลา → หาย', async () => {
    const v = await newVehicle();
    const d = await newDriver();
    const t = (
      await api(app, admin)
        .post('/v1/trips')
        .send({ tripDate: d2, deliveryOrderIds: [await newDo(d2)] })
        .expect(201)
    ).body as { id: string };
    const assigned = (
      await api(app, admin)
        .post(`/v1/trips/${t.id}/assign`)
        .send({ vehicleId: v.id, driverId: d.id })
        .expect(200)
    ).body as { warnings: { code: string }[]; version: number };
    expect(assigned.warnings.map((w) => w.code)).not.toContain('driver_on_leave');
    // ใส่วันลาหลังจัดแล้ว → ตรวจกฎเที่ยวของคนขับใหม่ (PLN-088)
    const e = await leave(d.id, d1, d2);
    const after = (await api(app, admin).get(`/v1/trips/${t.id}`).expect(200)).body as {
      warnings: { code: string; message: string; severity: string }[];
      version: number;
    };
    const w = after.warnings.find((x) => x.code === 'driver_on_leave')!;
    expect(w).toMatchObject({ severity: 'warning' });
    expect(w.message).toBe(`คนขับ ${d.name} ลาวันที่ ${thai(d2)}`);
    expect(after.version).toBeGreaterThan(assigned.version);
    // ยกเลิกวันลา → คำเตือนหาย
    await api(app, planner)
      .post(`/v1/schedule-entries/${e.id}/cancel`)
      .send({ reason: 'คนขับแจ้งยกเลิกการลาแล้ว' })
      .expect(200);
    const back = (await api(app, admin).get(`/v1/trips/${t.id}`).expect(200)).body;
    expect((back.warnings as { code: string }[]).map((x) => x.code)).not.toContain(
      'driver_on_leave',
    );
  });

  it('รถที่รับได้ (ST3-T15): คนขับประจำลาบางวัน → driverHints รายวัน (ไม่เปลี่ยนระดับ)', async () => {
    const v = await newVehicle();
    const d = await newDriver({ defaultVehicleId: v.id });
    await leave(d.id, d1);
    await newDo(today);
    const e = (
      await api(app, planner)
        .get(`/v1/planning/eligibility?vehicleId=${v.id}&date=${today}&days=7`)
        .expect(200)
    ).body as {
      items: { driverHints: { code: string; date: string | null; message: string }[] }[];
    };
    expect(e.items.length).toBeGreaterThan(0);
    for (const it of e.items)
      expect(it.driverHints.filter((h) => h.code === 'driver_on_leave')).toEqual([
        {
          code: 'driver_on_leave',
          severity: 'info',
          date: d1,
          message: `คนขับ ${d.name} ลาวันที่ ${thai(d1)}`,
        },
      ]);
  });

  it('วันลาทับกัน → 409 · โน้ตทับได้ · โน้ตของรถ', async () => {
    const v = await newVehicle();
    const d = await newDriver();
    const e = await leave(d.id, d1, d2);
    const r = await addEntry({
      kind: 'LEAVE',
      driverId: d.id,
      startsOn: d2,
      endsOn: addDays(d2, 3),
      note: 'ลากิจ',
    }).expect(409);
    expect(r.body).toMatchObject({ code: 'conflict', existing: { id: e.id } });
    expect(r.body.detail).toContain('ทับ');
    await addEntry({
      kind: 'NOTE',
      driverId: d.id,
      startsOn: d1,
      endsOn: d1,
      note: 'เข้าเวรเช้า',
    }).expect(201);
    const n = (
      await addEntry({
        kind: 'NOTE',
        vehicleId: v.id,
        startsOn: today,
        endsOn: today,
        note: 'นัดเปลี่ยนยางบ่าย',
      }).expect(201)
    ).body as Entry;
    expect(n).toMatchObject({ kind: 'NOTE', driver: null, vehicle: { id: v.id, plate: v.plate } });
  });

  it('validation 422 + สิทธิ์ 403', async () => {
    const v = await newVehicle();
    const d = await newDriver();
    const bad = async (body: object, field: string, code: string) => {
      const r = await addEntry(body).expect(422);
      expect(r.body.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field, code })]),
      );
    };
    const base = { kind: 'LEAVE', driverId: d.id, startsOn: d1, endsOn: d1, note: 'ลา' };
    await bad({ ...base, vehicleId: v.id }, 'vehicleId', 'not_allowed');
    await bad({ ...base, driverId: undefined }, 'driverId', 'exactly_one');
    await bad({ kind: 'NOTE', startsOn: d1, endsOn: d1, note: 'x' }, 'driverId', 'exactly_one');
    await bad({ ...base, endsOn: today }, 'endsOn', 'before_start');
    await bad(
      { ...base, startsOn: '2026-02-30', endsOn: '2026-03-01' },
      'startsOn',
      'invalid_date',
    );
    await bad({ ...base, endsOn: addDays(d1, 400) }, 'endsOn', 'range_too_long');
    await bad({ ...base, note: '   ' }, 'note', 'minLength');
    await bad(
      { ...base, driverId: 'drv_00000000000000000000000000000000' },
      'driverId',
      'invalid_reference',
    );
    const gone = await newDriver();
    await db.driver.update({
      where: { id: uuid('driver', gone.id) },
      data: { status: 'INACTIVE' },
    });
    await bad({ ...base, driverId: gone.id }, 'driverId', 'driver_inactive');
    await api(app, viewer).post('/v1/schedule-entries').send(base).expect(403);
    await api(app, admin)
      .get(`/v1/schedule-entries?from=${today}&to=${addDays(today, 80)}`)
      .expect(422);
  });

  it('ยกเลิก: เหตุผล ≥ 10 · If-Match ไม่ตรง 412 · ยกเลิกซ้ำ 409 · ไม่ลบแถว + audit', async () => {
    const d = await newDriver();
    const e = await leave(d.id, d1);
    await api(app, planner)
      .post(`/v1/schedule-entries/${e.id}/cancel`)
      .send({ reason: 'สั้น' })
      .expect(422);
    await api(app, planner)
      .post(`/v1/schedule-entries/${e.id}/cancel`)
      .set('If-Match', '"9"')
      .send({ reason: 'บันทึกผิดคน ต้องยกเลิก' })
      .expect(412);
    const c = await api(app, planner)
      .post(`/v1/schedule-entries/${e.id}/cancel`)
      .set('If-Match', '"1"')
      .send({ reason: 'บันทึกผิดคน ต้องยกเลิก' })
      .expect(200);
    expect(c.body).toMatchObject({ version: 2, cancelReason: 'บันทึกผิดคน ต้องยกเลิก' });
    expect(c.body.cancelledAt).not.toBeNull();
    await api(app, planner)
      .post(`/v1/schedule-entries/${e.id}/cancel`)
      .send({ reason: 'บันทึกผิดคน ต้องยกเลิก' })
      .expect(409);
    // ยกเลิกแล้วไม่อยู่ในรายการ/กระดาน แต่ยังเปิดดูได้ · ใส่วันลาเดิมใหม่ได้
    const list = (
      await api(app, admin).get(`/v1/schedule-entries?from=${today}&to=${d2}`).expect(200)
    ).body.data as Entry[];
    expect(list.map((x) => x.id)).not.toContain(e.id);
    await api(app, admin).get(`/v1/schedule-entries/${e.id}`).expect(200);
    await leave(d.id, d1);
    const audit = await db.auditLog.findMany({
      where: { entityType: 'schedule_entry', entityId: uuid('scheduleEntry', e.id) },
      orderBy: { at: 'asc' },
    });
    expect(audit.map((a) => [a.action, a.reason])).toEqual([
      ['schedule_entry.created', null],
      ['schedule_entry.cancelled', 'บันทึกผิดคน ต้องยกเลิก'],
    ]);
  });

  it('แยก tenant: id ของบริษัทอื่น → 404 · อ้างคนขับบริษัทอื่น → 422 · รายการไม่ปน', async () => {
    const d = await newDriver();
    const e = await leave(d.id, d1);
    await api(app, other).get(`/v1/schedule-entries/${e.id}`).expect(404);
    await api(app, other)
      .post(`/v1/schedule-entries/${e.id}/cancel`)
      .send({ reason: 'พยายามยกเลิกข้ามบริษัท' })
      .expect(404);
    const r = await api(app, other)
      .post('/v1/schedule-entries')
      .send({ kind: 'LEAVE', driverId: d.id, startsOn: d1, endsOn: d1, note: 'ลา' })
      .expect(422);
    expect(r.body.errors[0]).toMatchObject({ field: 'driverId', code: 'invalid_reference' });
    const list = (
      await api(app, other).get(`/v1/schedule-entries?from=${today}&to=${d2}`).expect(200)
    ).body.data;
    expect(list).toEqual([]);
  });
});

const M = [
  'ม.ค.',
  'ก.พ.',
  'มี.ค.',
  'เม.ย.',
  'พ.ค.',
  'มิ.ย.',
  'ก.ค.',
  'ส.ค.',
  'ก.ย.',
  'ต.ค.',
  'พ.ย.',
  'ธ.ค.',
];
function thai(ymd: string) {
  const [y, m, d] = ymd.split('-').map(Number);
  return `${d} ${M[m! - 1]} ${y! + 543}`;
}
