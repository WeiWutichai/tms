import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Clock } from '../src/common/clock';
import { encodeId, tryDecodeId } from '../src/common/ids';
import { ProblemException } from '../src/common/problem';
import { requestContext } from '../src/common/request-context';
import { DbService, type Tx } from '../src/db/db.service';
import { DeliveryOrderService } from '../src/modules/delivery-orders/delivery-order.service';
import { EntitlementService } from '../src/modules/entitlements/entitlement.service';
import { reachedLevels } from '../src/modules/entitlements/quota';
import {
  OrderIntakeService,
  type UpsertOrderInput,
} from '../src/modules/orders/order-intake.service';
import { createTenantWithDefaults } from '../src/modules/tenants/bootstrap';
import { bangkokPeriod } from '../src/modules/usage/active-vehicles';
import { QuotaAlertService } from '../src/modules/usage/quota-alert.service';
import { api, bootApp, platform, tokenFor, truncateAll, validTaxId } from './helpers';

/**
 * P1-ST1-T08 บังคับโควตา (spec/01 §7.1 PLT-079–082 · D68-14/21 · docs/02 §2 trial ≤ 20 คัน)
 * เกณฑ์ตรวจรับ: รถคันที่ 21 ใน trial → dialog เตือน + ทำต่อได้ + ผู้ดูแลได้แจ้งเตือน · ลด limit ต่ำกว่าที่ใช้อยู่ → ไม่ลบของเดิม
 */
describe('reachedLevels (PLT-082)', () => {
  it('80 / 90 / 100% แบบจำนวนเต็ม', () => {
    expect(reachedLevels(15, 20)).toEqual([]);
    expect(reachedLevels(16, 20)).toEqual([80]);
    expect(reachedLevels(18, 20)).toEqual([80, 90]);
    expect(reachedLevels(21, 20)).toEqual([80, 90, 100]);
    expect(reachedLevels(0, 0)).toEqual([]);
    expect(reachedLevels(1, 0)).toEqual([80, 90, 100]);
  });
});

describe('quota (P1-ST1-T08)', () => {
  let app: NestExpressApplication;
  const db = platform();
  const owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  const NOW = new Date('2026-11-20T10:00:00+07:00');
  const period = bangkokPeriod(NOW);
  let seed = 0;
  const ADDR = { line1: '1 ถ.ทดสอบ', district: 'เมือง', province: 'ชลบุรี', postcode: '20000' };
  const REASON = 'ยืนยันจ่ายงานเกินโควตา ลูกค้าเร่งด่วน';
  const uuid = (kind: Parameters<typeof tryDecodeId>[0], id: string) => tryDecodeId(kind, id)!;

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    app.get(Clock).set(NOW);
  });
  afterAll(async () => {
    app.get(Clock).set(null);
    await app.close();
    await owner.$disconnect();
    await db.$disconnect();
  });

  /** tenant พร้อมผู้ออกบิล + token ผู้ดูแล */
  async function tenant(status: 'TRIALING' | 'ACTIVE' = 'TRIALING') {
    const t = await createTenantWithDefaults(db, { name: `บริษัท โควตา ${++seed}`, status });
    const c = await db.company.create({
      data: {
        tenantId: t.id,
        legalName: `บริษัท ผู้ออกบิล ${seed}`,
        taxId: validTaxId(500 + seed),
      },
    });
    await db.branch.create({
      data: {
        tenantId: t.id,
        companyId: c.id,
        branchCode: '00000',
        branchLabel: 'สำนักงานใหญ่',
        address: ADDR,
        isDefaultIssuer: true,
      },
    });
    const admin = await db.appUser.create({
      data: {
        tenantId: t.id,
        email: `admin-${randomUUID().slice(0, 6)}@x.test`,
        name: 'ผู้ดูแล',
        status: 'ACTIVE',
      },
    });
    const role = await db.role.findFirstOrThrow({ where: { tenantId: t.id, code: 'admin' } });
    await db.userRole.create({ data: { tenantId: t.id, userId: admin.id, roleId: role.id } });
    return { id: t.id, token: await tokenFor(t.id), adminId: admin.id };
  }

  /** รถ active เดือนนี้ `n` คัน (ทะเบียนสมมุติ) — เขียนด้วย owner (ตารางนับเขียนโดย trigger เท่านั้นใน role แอป) */
  async function seedActive(tenantId: string, n: number, prefix = 'ZZ') {
    for (let i = 0; i < n; i++)
      await owner.activeVehicleUsage.create({
        data: {
          tenantId,
          period,
          plateNormalized: `${prefix}${i}`,
          plate: `${prefix}-${i}`,
          rule: 'trip_started',
          firstCountedAt: NOW,
        },
      });
  }

  async function newTrip(t: { id: string; token: string }) {
    const run = <T>(fn: (tx: Tx) => Promise<T>) =>
      app
        .get(DbService)
        .withTenant(t.id, (tx) =>
          requestContext.run(
            { requestId: randomUUID(), tenantId: t.id, actorId: 'user-test', locale: 'th', tx },
            () => fn(tx),
          ),
        );
    const a = api(app, t.token);
    const site = async () =>
      uuid(
        'site',
        (
          await a
            .post('/v1/customer-sites')
            .send({ name: `จุด ${++seed}`, kind: 'DROPOFF', address: ADDR })
            .expect(201)
        ).body.id,
      );
    const customer = uuid(
      'customer',
      (
        await a
          .post('/v1/customers')
          .send({ legalName: `ลูกค้า ${++seed}`, taxId: validTaxId(9300 + seed) })
          .expect(201)
      ).body.id,
    );
    const units = (await a.get('/v1/units?limit=50').expect(200)).body.data as {
      id: string;
      code: string;
    }[];
    const input: UpsertOrderInput = {
      source: 'MANUAL',
      customer: { id: customer },
      requestedDate: '2026-11-20',
      stops: [
        { type: 'PICKUP', siteId: await site() },
        { type: 'DELIVERY', siteId: await site() },
      ],
      lines: [
        {
          description: 'สินค้า',
          qty: '1',
          unitId: uuid('unit', units.find((u) => u.code === 'TON')!.id),
          weightKg: '1000',
        },
      ],
    };
    const { order } = await run((tx) => app.get(OrderIntakeService).upsertOrder(input, tx));
    const [d] = await run((tx) => app.get(DeliveryOrderService).listForOrder(order.id, {}, tx));
    const types = (await a.get('/v1/vehicle-types?limit=50').expect(200)).body.data as {
      id: string;
      code: string;
    }[];
    const v = (
      await a
        .post('/v1/vehicles')
        .send({
          plate: `7${seed % 10}-${String(3000 + seed)}`,
          plateProvince: 'TH-10',
          vehicleTypeId: types.find((x) => x.code === '6W')!.id,
          ownership: 'OWN',
        })
        .expect(201)
    ).body as { id: string; plate: string };
    const trip = (
      await a
        .post('/v1/trips')
        .set('Idempotency-Key', randomUUID())
        .send({
          tripDate: '2026-11-20',
          deliveryOrderIds: [encodeId('deliveryOrder', d!.id)],
          plannedStartAt: '2026-11-20T13:00:00+07:00',
          plannedEndAt: '2026-11-20T15:00:00+07:00',
          vehicleId: v.id,
        })
        .expect(201)
    ).body as { id: string; warnings: { key: string; code: string; params: object }[] };
    const driver = (
      await a
        .post('/v1/drivers')
        .send({
          name: `คนขับ ${++seed}`,
          phone: `088-${String(seed).padStart(3, '0')}-${String(seed).padStart(4, '0')}`,
          employmentType: 'EMPLOYEE_SALARIED',
          licenceClass: 'T2',
          licenceExpiresOn: '2031-03-31',
        })
        .expect(201)
    ).body as { id: string };
    return { trip, vehicle: v, driverId: driver.id };
  }

  it('เกณฑ์ตรวจรับ: รถคันที่ 21 ใน trial → คำเตือน vehicle_quota_exceeded · ยืนยันแล้วจ่ายงานต่อได้ · ผู้ดูแลได้แจ้งเตือนครั้งเดียว', async () => {
    const t = await tenant('TRIALING');
    expect(await app.get(EntitlementService).vehicleLimit(t.id)).toEqual({
      limit: 20,
      source: 'trial',
    });
    await seedActive(t.id, 20);
    const { trip, vehicle, driverId } = await newTrip(t);
    const w = trip.warnings.find((x) => x.code === 'vehicle_quota_exceeded');
    expect(w).toMatchObject({ params: { limit: 20, active: 20, period } });
    // ยังไม่ยืนยัน → ปล่อยรถไม่ได้ (dialog เตือน)
    const blocked = await api(app, t.token)
      .post(`/v1/trips/${trip.id}/assign`)
      .send({ vehicleId: vehicle.id, driverId, dispatch: true });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('assignment_warnings');
    expect(blocked.body.warnings.map((x: { code: string }) => x.code)).toContain(
      'vehicle_quota_exceeded',
    );
    // "จ่ายงานต่อ" = ยืนยันคำเตือน → ปล่อยรถได้ ไม่หยุดงานขนส่ง
    const keys = blocked.body.warnings.map((x: { key: string }) => x.key);
    const ok = await api(app, t.token).post(`/v1/trips/${trip.id}/assign`).send({
      vehicleId: vehicle.id,
      driverId,
      dispatch: true,
      ruleKeys: keys,
      overrideReason: REASON,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('DISPATCHED');
    expect(
      await owner.activeVehicleUsage.count({ where: { tenantId: t.id, period, excludedAt: null } }),
    ).toBe(21);

    // แจ้งผู้ดูแล: 80/90/100 ถึงพร้อมกัน → ฉบับเดียว (ระดับสูงสุด) · รอบถัดไปไม่แจ้งซ้ำ
    const alerts = app.get(QuotaAlertService);
    expect(await alerts.check(t.id, NOW)).toBe(100);
    expect(await alerts.check(t.id, NOW)).toBeNull();
    const rows = await owner.quotaAlert.findMany({
      where: { tenantId: t.id },
      orderBy: { level: 'asc' },
    });
    expect(rows.map((r) => [r.level, r.used, r.limit, r.period])).toEqual([
      [80, 21, 20, period],
      [90, 21, 20, period],
      [100, 21, 20, period],
    ]);
    const notes = await owner.notification.findMany({
      where: { tenantId: t.id, templateCode: 'quota.threshold', channel: 'in_app' },
    });
    expect(notes.map((n) => n.recipientId)).toContain(t.adminId);
    expect(new Set(notes.map((n) => n.recipientId)).size).toBe(notes.length);
    expect(notes[0]!.title).toBe('รถ active ถึงโควตาแพ็กเกจแล้ว');
  });

  it('ทะเบียนที่ถูกนับแล้วเดือนนี้ไม่เตือน · ระดับ 80% แยกจาก 90% ในเดือนเดียวกัน · เดือนใหม่แจ้งใหม่', async () => {
    const t = await tenant('TRIALING');
    await seedActive(t.id, 16);
    const alerts = app.get(QuotaAlertService);
    expect(await alerts.check(t.id, NOW)).toBe(80);
    await seedActive(t.id, 2, 'YY');
    expect(await alerts.check(t.id, NOW)).toBe(90);
    expect(await alerts.check(t.id, NOW)).toBeNull();
    // ยังไม่เกิน → ไม่เตือนตอนจ่ายงาน
    const { trip } = await newTrip(t);
    expect(trip.warnings.map((w) => w.code)).not.toContain('vehicle_quota_exceeded');
    // เต็ม 20 แล้ว แต่ทะเบียนของเที่ยวนับไปแล้ว → ไม่เตือน
    await seedActive(t.id, 2, 'XX');
    const { trip: t2, vehicle, driverId } = await newTrip(t);
    expect(t2.warnings.map((w) => w.code)).toContain('vehicle_quota_exceeded');
    await owner.activeVehicleUsage.updateMany({
      where: { tenantId: t.id, plateNormalized: 'XX0' },
      data: { plateNormalized: vehicle.plate.replace(/[\s\-.]/g, '') },
    });
    const re = await api(app, t.token).get(`/v1/trips/${t2.id}`).expect(200);
    // ผลตรวจเป็นภาพ ณ การกระทำล่าสุด → เปลี่ยนรถ/จัดใหม่แล้วตรวจใหม่ ผ่าน assign อีกครั้ง
    await api(app, t.token)
      .post(`/v1/trips/${t2.id}/assign`)
      .send({ vehicleId: vehicle.id, driverId })
      .expect(200);
    const after = await api(app, t.token).get(`/v1/trips/${t2.id}`).expect(200);
    expect(re.body.id).toBe(t2.id);
    expect(after.body.warnings.map((w: { code: string }) => w.code)).not.toContain(
      'vehicle_quota_exceeded',
    );
    // เดือนใหม่ → ระดับเริ่มใหม่ (แถวของเดือนก่อนไม่กัน)
    expect(await alerts.check(t.id, new Date('2026-12-02T10:00:00+07:00'))).toBeNull();
  });

  it('ค่าในสัญญา / แพ็กเกจไม่จำกัด / sandbox → เพดานตามลำดับ (ไม่จำกัด = ไม่เตือน ไม่แจ้ง)', async () => {
    const t = await tenant('ACTIVE');
    const ent = app.get(EntitlementService);
    expect(await ent.vehicleLimit(t.id)).toMatchObject({ source: 'plan' });
    await db.tenant.update({ where: { id: t.id }, data: { vehicleQuota: 5 } });
    ent.invalidate(t.id);
    expect(await ent.vehicleLimit(t.id)).toEqual({ limit: 5, source: 'contract' });
    await db.tenant.update({ where: { id: t.id }, data: { vehicleQuota: null, planCode: 'ent' } });
    ent.invalidate(t.id);
    expect(await ent.vehicleLimit(t.id)).toEqual({ limit: null, source: null });
    await seedActive(t.id, 30);
    expect(await app.get(QuotaAlertService).check(t.id, NOW)).toBeNull();
    const sandbox = await db.tenant.findFirst({ where: { liveTenantId: t.id } });
    if (sandbox) expect((await ent.vehicleLimit(sandbox.id)).limit).toBeNull();
  });

  it('hard limit (PLT-079): ครบ → 409 พร้อม featureKey / used / upgradePlan · ลด limit ต่ำกว่าที่ใช้อยู่ไม่ลบของเดิม', async () => {
    const t = await tenant('ACTIVE');
    const ent = app.get(EntitlementService);
    const err = await ent.assertLimit(t.id, 'webhook_limit_reached', 'webhook', 3).catch((e) => e);
    expect(err).toBeInstanceOf(ProblemException);
    expect((err as ProblemException).code).toBe('webhook_limit_reached');
    expect((err as ProblemException).extra).toMatchObject({
      featureKey: 'webhook',
      limit: 3,
      used: 3,
      upgradePlan: { code: 'ent', name: 'Enterprise', limit: null },
    });
    await expect(
      ent.assertLimit(t.id, 'webhook_limit_reached', 'webhook', 2),
    ).resolves.toBeUndefined();
    // Console ลด limit เหลือ 1 ขณะใช้อยู่ 2 → ของเดิมยังอยู่ (ตรวจเฉพาะตอนสร้าง) สร้างเพิ่มไม่ได้
    await db.tenantEntitlementOverride.create({
      data: {
        tenantId: t.id,
        featureKey: 'webhook',
        mode: 'set_limit',
        limit: 1,
        reason: 'ทดสอบลดโควตา webhook',
      },
    });
    ent.invalidate(t.id);
    const e2 = await ent.assertLimit(t.id, 'webhook_limit_reached', 'webhook', 2).catch((e) => e);
    expect((e2 as ProblemException).extra).toMatchObject({ limit: 1, used: 2 });
  });

  it('quota_alert: RLS แยก tenant · role แอปเขียนไม่ได้', async () => {
    const a = await tenant('TRIALING');
    const b = await tenant('TRIALING');
    await seedActive(a.id, 20);
    await app.get(QuotaAlertService).check(a.id, NOW);
    const dbs = app.get(DbService);
    expect(await dbs.withTenant(a.id, (tx) => tx.quotaAlert.count())).toBe(3);
    expect(await dbs.withTenant(b.id, (tx) => tx.quotaAlert.count())).toBe(0);
    // role แอป insert ได้เฉพาะ tenant ตัวเอง (RLS) · แก้/ลบไม่ได้
    await expect(
      dbs.withTenant(b.id, (tx) =>
        tx.quotaAlert.create({
          data: { tenantId: a.id, metric: 'vehicles.active', period, level: 80, used: 1, limit: 1 },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      dbs.withTenant(a.id, (tx) => tx.quotaAlert.updateMany({ data: { used: 0 } })),
    ).rejects.toThrow();
    await expect(dbs.withTenant(a.id, (tx) => tx.quotaAlert.deleteMany({}))).rejects.toThrow();
  });

  it('review N1: แจ้งไม่สำเร็จ → ไม่มีแถว quota_alert (ย้อนทั้ง transaction) · รอบถัดไปแจ้งได้', async () => {
    const t = await tenant('TRIALING');
    await seedActive(t.id, 16);
    const alerts = app.get(QuotaAlertService);
    const n = (alerts as unknown as { notifications: { notify: (...a: unknown[]) => unknown } })
      .notifications;
    const orig = n.notify;
    n.notify = () => Promise.reject(new Error('smtp down'));
    await expect(alerts.check(t.id, NOW)).rejects.toThrow('smtp down');
    n.notify = orig;
    expect(await owner.quotaAlert.count({ where: { tenantId: t.id } })).toBe(0);
    expect(await alerts.check(t.id, NOW)).toBe(80);
  });
});
