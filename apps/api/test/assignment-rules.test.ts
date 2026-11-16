import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SYSTEM_ROLES } from '@tms/domain';
import request from 'supertest';
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
import { addDays, bangkokToday } from '../src/modules/vehicle-documents/expiry';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

/**
 * ST3-T14 กฎตอนจัดรถ — D-07 (PO 16 พ.ย. 2569 "ผสม"): กฎเอกสาร/ใบขับขี่ = บล็อก (ยกเว้นได้โดย `trips:override` + เหตุผล + audit),
 * ที่เหลือ = คำเตือน (บันทึกได้ ต้องยืนยันพร้อมเหตุผลก่อนปล่อยรถ) — ทางเข้าเดียวกันทั้ง POST /v1/trips (+ รถ), /schedule, /assign,
 * /dispatch และ /confirm-rules
 */
describe('assignment rules (ST3-T14)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let otherId: string;
  let admin: string;
  let manager: string;
  let planner: string;
  let other: string;
  let seed = 0;
  let unitTon: string;
  let vt6: string;
  let vtTrl: string;
  const today = bangkokToday();
  const at = (hhmm: string, d = today) => `${d}T${hhmm}:00+07:00`;
  const uuid = (kind: Parameters<typeof tryDecodeId>[0], id: string) => tryDecodeId(kind, id)!;
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };
  const REASON = 'ลูกค้ายืนยันรับของตามแผนเดิม';
  const jur = (n: number) => {
    const base = `0105${String(70_000 + n).padStart(8, '0')}`;
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(base[i]) * (13 - i);
    return base + String((11 - (sum % 11)) % 10);
  };

  beforeAll(async () => {
    process.env.FILES_ROOT = mkdtempSync(join(tmpdir(), 'tms-files-'));
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenantWithDefaults(db, { name: 'บริษัท กฎจัดรถ' })).id;
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
    manager = await tokenFor(tenantId, SYSTEM_ROLES.manager.permissions.join(' '), 'u-mgr');
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
    vtTrl = types.find((t) => t.code === 'TRL')!.id;
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
  const site = async (extra: object = {}) =>
    uuid(
      'site',
      (
        await api(app, admin)
          .post('/v1/customer-sites')
          .send({ name: `จุด ${++seed}`, kind: 'DROPOFF', address: ADDR, ...extra })
          .expect(201)
      ).body.id,
    );
  /** SO ใหม่ (น้ำหนัก `kg`) → DO public id */
  const newDo = async (kg = '1000', dest?: string) => {
    const customer = uuid(
      'customer',
      (
        await api(app, admin)
          .post('/v1/customers')
          .send({ legalName: `ลูกค้า ${++seed}`, taxId: validTaxId(9300 + seed) })
          .expect(201)
      ).body.id,
    );
    const input: UpsertOrderInput = {
      source: 'MANUAL',
      customer: { id: customer },
      requestedDate: today,
      stops: [
        { type: 'PICKUP', siteId: await site() },
        { type: 'DELIVERY', siteId: dest ?? (await site()) },
      ],
      lines: [{ description: 'สินค้า', qty: '1', unitId: unitTon, weightKg: kg }],
    };
    const { order } = await run((tx) => app.get(OrderIntakeService).upsertOrder(input, tx));
    const [d] = await run((tx) => app.get(DeliveryOrderService).listForOrder(order.id, {}, tx));
    return encodeId('deliveryOrder', d!.id);
  };
  const newVehicle = async (extra: object = {}) =>
    (
      await api(app, admin)
        .post('/v1/vehicles')
        .send({
          plate: `6${++seed % 10}-${String(2000 + seed)}`,
          plateProvince: 'TH-10',
          vehicleTypeId: vt6,
          ownership: 'OWN',
          ...extra,
        })
        .expect(201)
    ).body as { id: string; plate: string };
  const newDriver = async (extra: object = {}) =>
    (
      await api(app, admin)
        .post('/v1/drivers')
        .send({
          name: `คนขับ ${++seed}`,
          phone: `088-${String(seed).padStart(3, '0')}-${String(seed).padStart(4, '0')}`,
          employmentType: 'EMPLOYEE_SALARIED',
          licenceClass: 'T2',
          licenceExpiresOn: '2031-03-31',
          ...extra,
        })
        .expect(201)
    ).body as { id: string; name: string };
  const path = (url: string) => new URL(url).pathname + new URL(url).search;
  const upload = async () => {
    const r = await api(app, admin)
      .post('/v1/documents')
      .send({ kind: 'VEHICLE_DOC', mime: 'application/pdf', bytes: PDF.length, filename: 'd.pdf' })
      .expect(201);
    await request(app.getHttpServer())
      .put(path(r.body.uploadUrl))
      .set('Content-Type', 'application/octet-stream')
      .send(PDF)
      .expect(200);
    return r.body.id as string;
  };
  /** เอกสารรถ หมดในอีก `expires` วัน (ติดลบ = หมดแล้ว) */
  const addDoc = async (vehicleId: string, docType: string, expires: number, extra: object = {}) =>
    api(app, admin)
      .post(`/v1/vehicles/${vehicleId}/documents`)
      .send({
        docType,
        docNo: `${docType}-${++seed}`,
        startsOn: addDays(today, Math.min(expires - 365, -30)),
        expiresOn: addDays(today, expires),
        fileDocumentIds: [await upload()],
        ...extra,
      })
      .expect(201);
  /** รถบริษัทที่ พ.ร.บ. (ตั้งบังคับก่อนจ่ายงาน) หมดเมื่อวาน → บล็อก DOC_CMI_EXPIRED (D-07) */
  const blockedVehicle = async () => {
    const v = await newVehicle();
    await addDoc(v.id, 'COMPULSORY_ACT', -1);
    return v;
  };
  const create = (doId: string, vehicleId: string | null, extra: object = {}, token = admin) =>
    api(app, token)
      .post('/v1/trips')
      .set('Idempotency-Key', randomUUID())
      .send({
        tripDate: today,
        deliveryOrderIds: [doId],
        plannedStartAt: at('08:00'),
        plannedEndAt: at('10:00'),
        ...(vehicleId ? { vehicleId } : {}),
        ...extra,
      });
  const act = (id: string, verb: string, body: object = {}, token = admin) =>
    api(app, token).post(`/v1/trips/${id}/${verb}`).send(body);
  const audits = (tripId: string) =>
    db.auditLog.findMany({
      where: { entityId: uuid('trip', tripId), action: 'trip.rules_overridden' },
      orderBy: { at: 'asc' },
    });
  const codes = (ws: { code: string }[]) => ws.map((w) => w.code);

  it('create + รถติดกฎเอกสาร → 409 assignment_blocked (ไม่สร้างอะไร) · planner ยกเว้น → 403 · เหตุผลสั้น → 422 · ผู้จัดการยกเว้น → 201 + rule_overrides + audit', async () => {
    const v = await blockedVehicle();
    const doId = await newDo();
    const before = await db.trip.count({ where: { tenantId } });
    const r = await create(doId, v.id).expect(409);
    expect(r.body.code).toBe('assignment_blocked');
    expect(
      r.body.blocks.map((b: { code: string; severity: string }) => [b.code, b.severity]),
    ).toEqual([['DOC_CMI_EXPIRED', 'block']]);
    expect(r.body.overrideScope).toBe('trips:override');
    expect(await db.trip.count({ where: { tenantId } })).toBe(before);
    expect(
      (await db.deliveryOrder.findUniqueOrThrow({ where: { id: uuid('deliveryOrder', doId) } }))
        .tripId,
    ).toBeNull();
    // planner (ไม่มี trips:override) ส่งยกเว้น → 403
    const p = await create(doId, v.id, { overrideBlocks: true, overrideReason: REASON }, planner);
    expect(p.status).toBe(403);
    expect(p.body).toMatchObject({ code: 'permission_denied', required: ['trips:override'] });
    // เหตุผลสั้น → 422 (ก่อนทำงาน)
    const s = await create(doId, v.id, { overrideBlocks: true, overrideReason: 'สั้นไป' }, manager);
    expect(s.status).toBe(422);
    expect(s.body.errors[0]).toMatchObject({ field: 'overrideReason', code: 'too_short' });
    // ผู้จัดการยกเว้น
    const ok = await create(
      doId,
      v.id,
      { overrideBlocks: true, overrideReason: REASON },
      manager,
    ).expect(201);
    expect(ok.body.status).toBe('PLANNING');
    expect(
      ok.body.warnings.find((w: { code: string }) => w.code === 'DOC_CMI_EXPIRED'),
    ).toMatchObject({
      severity: 'block',
      confirmed: true,
    });
    expect(ok.body.ruleOverrides).toEqual([
      expect.objectContaining({
        code: 'DOC_CMI_EXPIRED',
        kind: 'OVERRIDE',
        reason: REASON,
        actorId: 'u-mgr',
        active: true,
      }),
    ]);
    const a = await audits(ok.body.id);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ reason: REASON, actorId: 'u-mgr' });
    expect(JSON.stringify(a[0]!.after)).toContain('DOC_CMI_EXPIRED');
    // ยกเว้นแล้ว → schedule ปรับเวลาบนรถเดิมได้โดยไม่ต้องยกเว้นซ้ำ
    await act(ok.body.id, 'schedule', { plannedEndAt: at('11:00') }, planner).expect(200);
  });

  it('schedule ย้ายไปรถติดกฎ → 409 · ยกเว้นผูกกับรถ: ย้ายไปรถติดกฎคันอื่นต้องยกเว้นใหม่ (PLN-090)', async () => {
    const ok = await newVehicle();
    const b1 = await blockedVehicle();
    const b2 = await blockedVehicle();
    const t = (await create(await newDo(), ok.id).expect(201)).body;
    const r = await act(t.id, 'schedule', { vehicleId: b1.id }, planner).expect(409);
    expect(r.body.code).toBe('assignment_blocked');
    // ไม่เปลี่ยนอะไร (rollback ทั้งคำขอ)
    expect((await api(app, admin).get(`/v1/trips/${t.id}`).expect(200)).body.vehicle.id).toBe(
      ok.id,
    );
    const m = await act(
      t.id,
      'schedule',
      { vehicleId: b1.id, overrideBlocks: true, overrideReason: REASON },
      manager,
    ).expect(200);
    expect(m.body.vehicle.id).toBe(b1.id);
    expect((await act(t.id, 'schedule', { vehicleId: b2.id }, manager).expect(409)).body.code).toBe(
      'assignment_blocked',
    );
    const back = await act(
      t.id,
      'schedule',
      { vehicleId: b2.id, overrideBlocks: true, overrideReason: REASON },
      manager,
    ).expect(200);
    expect(back.body.ruleOverrides.map((o: { active: boolean }) => o.active)).toEqual([
      false,
      true,
    ]);
    expect(await audits(t.id)).toHaveLength(2);
  });

  it('assign: ใบขับขี่หมด / ชั้นไม่ถึงรถพ่วง (MD-090) → 409 บล็อก · ผู้จัดการยกเว้นได้', async () => {
    const v = await newVehicle();
    const expired = await newDriver({ licenceExpiresOn: addDays(today, -1) });
    const t = (await create(await newDo(), null).expect(201)).body;
    const r = await act(t.id, 'assign', { vehicleId: v.id, driverId: expired.id }, planner).expect(
      409,
    );
    expect(codes(r.body.blocks)).toEqual(['DRIVER_LICENCE_EXPIRED']);
    // รถพ่วง (ใบขับขี่ขั้นต่ำ ท.3) + คนขับ ท.2
    const trl = await newVehicle({ vehicleTypeId: vtTrl });
    const t2 = (await create(await newDo(), null).expect(201)).body;
    const cls = await act(t2.id, 'assign', {
      vehicleId: trl.id,
      driverId: (await newDriver()).id,
    }).expect(409);
    expect(codes(cls.body.blocks)).toEqual(['DRIVER_LICENCE_CLASS']);
    expect(cls.body.blocks[0].message).toMatch(/ไม่ถึงชั้น ท\.3/);
    const ok = await act(
      t.id,
      'assign',
      { vehicleId: v.id, driverId: expired.id, overrideBlocks: true, overrideReason: REASON },
      manager,
    ).expect(200);
    expect(ok.body.status).toBe('ASSIGNED');
  });

  it('เกณฑ์ตรวจรับ: รถร่วม พ.ร.บ. หมด assign ไม่ได้ถ้าไม่ใช่ผู้มีสิทธิ์ยกเว้น', async () => {
    const car = (
      await api(app, admin)
        .post('/v1/carriers')
        .send({ legalName: `หจก. รถร่วม ${++seed}`, entityType: 'JURISTIC', taxId: jur(seed) })
        .expect(201)
    ).body as { id: string };
    const sub = await newVehicle({ ownership: 'SUBCONTRACT', carrierId: car.id });
    await addDoc(sub.id, 'INSURANCE', 200);
    await addDoc(sub.id, 'COMPULSORY_ACT', -3);
    const t = (await create(await newDo(), null).expect(201)).body;
    await act(t.id, 'offer', { carrierId: car.id }, planner).expect(200);
    expect((await act(t.id, 'assign', { vehicleId: sub.id }, planner).expect(409)).body.code).toBe(
      'assignment_blocked',
    );
    expect(
      (
        await act(
          t.id,
          'assign',
          { vehicleId: sub.id, overrideBlocks: true, overrideReason: REASON },
          planner,
        ).expect(403)
      ).body.code,
    ).toBe('permission_denied');
    const ok = await act(
      t.id,
      'assign',
      { vehicleId: sub.id, overrideBlocks: true, overrideReason: REASON },
      admin,
    ).expect(200);
    expect(ok.body).toMatchObject({ status: 'ASSIGNED', assignmentStatus: 'ACCEPTED' });
    expect(await audits(t.id)).toHaveLength(1);
  });

  it('เกณฑ์ตรวจรับ: จัดงานเกินน้ำหนัก → คำเตือน (บันทึกได้) · กระดานค้าง "รออนุมัติ" · ปล่อยรถไม่ได้จนยืนยัน · ยืนยันต้องมีเหตุผลและอยู่ใน audit', async () => {
    const v = await newVehicle();
    const drv = await newDriver({ defaultVehicleId: v.id });
    const t = (await create(await newDo('6800'), v.id).expect(201)).body;
    const ow = t.warnings.find((w: { code: string }) => w.code === 'OVERWEIGHT');
    expect(ow).toMatchObject({ severity: 'warning', confirmed: false, params: { over: '800' } });
    expect(ow.message).toBe('น้ำหนักเกิน 800 กก. (6,800 / 6,000 กก.)');
    const board = async () =>
      (
        (await api(app, admin).get(`/v1/planning/board?date=${today}`).expect(200)).body.trips as {
          id: string;
          pendingRules: { code: string; severity: string }[];
          confirmedRules: number;
        }[]
      ).find((x) => x.id === t.id)!;
    expect((await board()).pendingRules).toEqual([
      expect.objectContaining({ code: 'OVERWEIGHT', severity: 'warning' }),
    ]);
    const a = await act(t.id, 'assign', { vehicleId: v.id, driverId: drv.id }).expect(200);
    const d = await act(a.body.id, 'dispatch').expect(409);
    expect(d.body.code).toBe('assignment_warnings');
    expect(codes(d.body.warnings)).toEqual(['OVERWEIGHT']);
    // ยืนยันภายหลัง (กระดาน "… · ขออนุมัติ") — เหตุผลบังคับ
    expect((await act(t.id, 'confirm-rules', {}, planner).expect(422)).body.code).toBe(
      'validation_failed',
    );
    const c = await act(t.id, 'confirm-rules', { overrideReason: REASON }, planner).expect(200);
    expect(c.body.ruleOverrides).toEqual([
      expect.objectContaining({
        code: 'OVERWEIGHT',
        kind: 'ACKNOWLEDGE',
        actorId: 'u-plan',
        reason: REASON,
      }),
    ]);
    expect(await board()).toMatchObject({ pendingRules: [], confirmedRules: 1 });
    expect((await audits(t.id))[0]).toMatchObject({ reason: REASON, actorId: 'u-plan' });
    // ไม่มีอะไรค้าง → confirm ซ้ำไม่เปลี่ยน
    expect(
      (await act(t.id, 'confirm-rules', { overrideReason: REASON }, planner).expect(200)).body
        .version,
    ).toBe(c.body.version);
    await act(t.id, 'dispatch').expect(200);
  });

  it('ปล่อยรถ: ยืนยันคำเตือนในคำขอเดียวกันได้ (acknowledgeWarnings + เหตุผล)', async () => {
    const v = await newVehicle();
    const drv = await newDriver();
    const t = (await create(await newDo('7000'), null).expect(201)).body;
    await act(t.id, 'assign', { vehicleId: v.id, driverId: drv.id }).expect(200);
    await act(t.id, 'dispatch', { acknowledgeWarnings: true, overrideReason: 'สั้น' }).expect(422);
    const r = await act(t.id, 'dispatch', {
      acknowledgeWarnings: true,
      overrideReason: REASON,
    }).expect(200);
    expect(r.body.status).toBe('DISPATCHED');
    expect(r.body.ruleOverrides.map((o: { code: string }) => o.code)).toEqual(['OVERWEIGHT']);
  });

  it('คำเตือนอื่นตาม D-07: จุดส่งไม่รับประเภทรถ (LOCATION_VEHICLE_LIMIT), ชั่วโมงขับเกิน 8 ชม., ซ้อนเวลา — ไม่บล็อก', async () => {
    const v = await newVehicle({ vehicleTypeId: vtTrl });
    const drv = await newDriver({ licenceClass: 'T3' });
    const narrow = await site({ maxVehicleClass: '6W' });
    const t1 = (
      await create(await newDo('1000', narrow), v.id, {
        plannedStartAt: at('06:00'),
        plannedEndAt: at('11:00'),
      }).expect(201)
    ).body;
    expect(
      t1.warnings.find((w: { code: string }) => w.code === 'LOCATION_VEHICLE_LIMIT'),
    ).toMatchObject({
      severity: 'warning',
    });
    await act(t1.id, 'assign', { vehicleId: v.id, driverId: drv.id }).expect(200);
    const t2 = (
      await create(await newDo(), v.id, {
        plannedStartAt: at('10:00'),
        plannedEndAt: at('15:00'),
      }).expect(201)
    ).body;
    expect(codes(t2.warnings)).toContain('vehicle_overlap');
    const a2 = await act(t2.id, 'assign', { vehicleId: v.id, driverId: drv.id }).expect(200);
    const dh = a2.body.warnings.find((w: { code: string }) => w.code === 'DRIVING_HOURS_EXCEEDED');
    expect(dh).toMatchObject({ severity: 'warning', params: { hours: '10.0', limit: 8 } });
    expect(a2.body.warnings.every((w: { severity: string }) => w.severity !== 'block')).toBe(true);
  });

  it('แยก tenant: confirm-rules เที่ยวของบริษัทอื่น → 404', async () => {
    const t = (await create(await newDo(), null).expect(201)).body;
    await act(t.id, 'confirm-rules', { overrideReason: REASON }, other).expect(404);
  });
});
