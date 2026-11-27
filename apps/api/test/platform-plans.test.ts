import type { NestExpressApplication } from '@nestjs/platform-express';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signPlatformToken } from '../src/auth/tokens';
import { encodeId } from '../src/common/ids';
import { EntitlementService } from '../src/modules/entitlements/entitlement.service';
import { api, bootApp, createTenant, platform, tokenFor, truncateAll } from './helpers';

/**
 * P1-ST1-T01: Feature catalog + PlanVersion (immutable หลัง publish) + Subscription ต่อ tenant
 * เกณฑ์ตรวจรับ (plan/13): publish ราคาใหม่ = เกิด v2 ลูกค้าเดิมยังอยู่ v1 · ฟีเจอร์พื้นฐานตั้งเป็น addon → 422 basic_feature_locked ·
 * settlement/ลิงก์รถร่วม included ทุกแพ็กเกจ
 * แคตตาล็อกเป็นข้อมูลอ้างอิง (ไม่ถูกล้างระหว่าง test) → test ที่ publish ใช้แพ็กเกจชั่วคราวของไฟล์นี้ แล้วลบด้วย role เจ้าของตารางตอนจบ
 */
describe('แพ็กเกจ + เวอร์ชันราคา + subscription (P1-ST1-T01)', () => {
  let app: NestExpressApplication;
  const db = platform();
  const owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  const staff: Record<string, string> = {};
  const TP = `tp_${randomUUID().slice(0, 8)}`;
  /** แพ็กเกจชั่วคราวที่ค้างจากรอบก่อน (ล้มกลางคัน) — ลบก่อนเริ่มและตอนจบ (review N7) */
  async function dropTempPlans() {
    const temp = {
      OR: [{ code: { startsWith: 'tp_' } }, { code: { startsWith: 't' }, nameTh: 'แพ็กเกจทดสอบ' }],
    };
    const codes = (await owner.plan.findMany({ where: temp, select: { code: true } })).map(
      (p) => p.code,
    );
    if (!codes.length) return;
    await owner.tenant.deleteMany({ where: { planCode: { in: codes } } });
    await owner.subscription.deleteMany({ where: { planVersion: { planCode: { in: codes } } } });
    await owner.planVersion.deleteMany({ where: { planCode: { in: codes } } });
    await owner.plan.deleteMany({ where: { code: { in: codes } } });
  }
  /** ย้ายแพ็กเกจผ่าน Console (ทางเดียวที่ย้าย subscription — review S2) */
  const movePlan = (tenantId: string, planCode: string) =>
    as('SUPER_ADMIN')
      .patch(`/v1/platform/tenants/${encodeId('tenant', tenantId)}/plan`)
      .send({ planCode, reason: 'ย้ายแพ็กเกจระหว่างทดสอบ' })
      .expect(200);
  let tpV1 = '';
  const as = (role: string) => api(app, staff[role]!);

  async function mkStaff(role: 'SUPER_ADMIN' | 'SUPPORT' | 'BILLING') {
    const u = await db.platformUser.create({
      data: {
        email: `${role.toLowerCase()}-${randomUUID().slice(0, 6)}@innovera.test`,
        name: `ทีม ${role}`,
        role,
        passwordHash: 'x',
        totpSecret: 'x',
      },
    });
    staff[role] = await signPlatformToken({ sub: u.id, role, tv: u.tokenVersion });
  }

  beforeAll(async () => {
    await truncateAll();
    await dropTempPlans();
    app = await bootApp();
    await Promise.all([mkStaff('SUPER_ADMIN'), mkStaff('SUPPORT'), mkStaff('BILLING')]);
    // แพ็กเกจชั่วคราว = สำเนา Growth v1 (ราคา 280) — สร้างแบบ draft แล้ว publish เหมือน migration
    const std = await db.planVersion.findFirstOrThrow({
      where: { planCode: 'std', version: 1 },
      include: { entitlements: true },
    });
    await db.plan.create({ data: { code: TP, nameTh: 'แพ็กเกจทดสอบ', sortOrder: 99 } });
    const v = await db.planVersion.create({
      data: {
        planCode: TP,
        version: 1,
        pricePerVehicleMonthly: '280.00',
        minimumMonthly: '4500.00',
        annualDiscountPct: '15.00',
        vehicleMin: 16,
        vehicleMax: 60,
        effectiveFrom: new Date(Date.now() - 60_000),
      },
    });
    await db.planEntitlement.createMany({
      data: std.entitlements.map((e) => ({ ...e, planVersionId: v.id })),
    });
    await db.planVersion.update({
      where: { id: v.id },
      data: { status: 'published', publishedAt: new Date() },
    });
    tpV1 = v.id;
  });
  afterAll(async () => {
    await app.close();
    // ลบแพ็กเกจชั่วคราว (เจ้าของตารางข้าม trigger immutable ได้ — role แอป/แพลตฟอร์มทำไม่ได้)
    await dropTempPlans();
    await owner.$disconnect();
    await db.$disconnect();
  });

  it('R-06 seed: 4 tier ตาม docs/02 §2 (350/280/220/ตกลง · ขั้นต่ำ 2,500/4,500/13,500 · รายปี −15%) ติดป้ายราคาตั้งต้น', async () => {
    const res = await as('SUPPORT').get('/v1/platform/plans').expect(200);
    const byCode = Object.fromEntries(
      (res.body as { code: string; current: Record<string, unknown> | null }[]).map((p) => [
        p.code,
        p,
      ]),
    );
    const cur = (c: string) => byCode[c]!.current!;
    expect(['start', 'std', 'biz', 'ent'].map((c) => cur(c).pricePerVehicleMonthly)).toEqual([
      '350.00',
      '280.00',
      '220.00',
      null,
    ]);
    expect(['start', 'std', 'biz', 'ent'].map((c) => cur(c).minimumMonthly)).toEqual([
      '2500.00',
      '4500.00',
      '13500.00',
      null,
    ]);
    expect(['start', 'std', 'biz'].map((c) => cur(c).annualDiscountPct)).toEqual([
      '15.00',
      '15.00',
      '15.00',
    ]);
    expect(
      ['start', 'std', 'biz', 'ent'].map((c) => [cur(c).vehicleMin, cur(c).vehicleMax]),
    ).toEqual([
      [1, 15],
      [16, 60],
      [61, 200],
      [201, null],
    ]);
    for (const c of ['start', 'std', 'biz', 'ent'])
      expect(cur(c)).toMatchObject({
        version: 1,
        status: 'published',
        provisional: true,
        trialDays: 30,
        currency: 'THB',
        vatMode: 'exclusive',
      });
    expect(byCode.ent).toMatchObject({ isContactSales: true, nameTh: 'Enterprise' });
  });

  it('R-07: ฟีเจอร์ปิดเดือน (ลิงก์รถร่วม, settlement, ePOD, reason code, วางบิล, export ให้บัญชี) เป็นพื้นฐาน included ทุกแพ็กเกจ', async () => {
    const feats = (await as('BILLING').get('/v1/platform/features').expect(200)).body as {
      key: string;
      isBasic: boolean;
    }[];
    const basic = feats.filter((f) => f.isBasic).map((f) => f.key);
    expect(basic).toEqual(
      expect.arrayContaining(['sub', 'settle', 'driver', 'exc', 'bill', 'acc_export']),
    );
    const plans = (await as('BILLING').get('/v1/platform/plans').expect(200)).body as {
      code: string;
      current: { entitlements: { featureKey: string; mode: string }[] };
    }[];
    for (const p of plans.filter((x) => ['start', 'std', 'biz', 'ent'].includes(x.code)))
      for (const k of basic)
        expect(p.current.entitlements.find((e) => e.featureKey === k)?.mode, `${p.code}.${k}`).toBe(
          'included',
        );
    // แพ็กเกจเริ่มต้นใช้รถร่วม/settlement ได้จริง (entitlement ที่มีผลของ tenant)
    const t = await createTenant(db, 'บริษัท Starter');
    await db.tenant.update({ where: { id: t.id }, data: { planCode: 'start' } });
    const me = await api(app, await tokenFor(t.id))
      .get('/v1/me')
      .expect(200);
    expect(me.body.features).toEqual(
      expect.arrayContaining(['sub', 'settle', 'acc_export', 'report']),
    );
    expect(me.body.features).not.toContain('report_adv');
    expect(me.body.features).not.toContain('portal');
    expect(me.body.lockedIn).toMatchObject({ multi: 'Business', portal: 'Growth', api: 'Growth' });
  });

  it('S4 docs/02 §2: รายงานพื้นฐานทุกแพ็กเกจ · ส่งรายงานตามเวลา/Customer portal ตั้งแต่ Growth · โควตารถคงค่าเดิม (20/80/80/ไม่จำกัด)', async () => {
    const plans = (await as('BILLING').get('/v1/platform/plans').expect(200)).body as {
      code: string;
      current: { entitlements: { featureKey: string; mode: string; limit: number | null }[] };
    }[];
    const cell = (c: string, k: string) =>
      plans.find((p) => p.code === c)!.current.entitlements.find((e) => e.featureKey === k)!;
    expect(['start', 'std', 'biz', 'ent'].map((c) => cell(c, 'report').mode)).toEqual(
      Array(4).fill('included'),
    );
    expect(['start', 'std', 'biz', 'ent'].map((c) => cell(c, 'report_adv').mode)).toEqual([
      'not_available',
      'included',
      'included',
      'included',
    ]);
    expect(['start', 'std', 'biz', 'ent'].map((c) => cell(c, 'portal').mode)).toEqual([
      'not_available',
      'included',
      'included',
      'included',
    ]);
    expect(['start', 'std', 'biz', 'ent'].map((c) => cell(c, 'veh').limit)).toEqual([
      20,
      80,
      80,
      null,
    ]);
  });

  it('subscription (โค้ดแอป): tenant ใหม่ได้แถวบนเวอร์ชันที่มีผล (trial 30 วัน) · Console เปลี่ยนแพ็กเกจ = เวอร์ชันปัจจุบันของแพ็กเกจใหม่ · sandbox ไม่มีแถว · guard: tenant live ไม่มีแถว → commit ไม่ผ่าน', async () => {
    const t = await createTenant(db, 'บริษัท ทดลอง');
    const s = await db.subscription.findUniqueOrThrow({
      where: { tenantId: t.id },
      include: { planVersion: true },
    });
    expect(s).toMatchObject({
      status: 'trialing',
      billingCycle: 'monthly',
      cancelAtPeriodEnd: false,
    });
    expect(s.planVersion).toMatchObject({ planCode: 'std', version: 1 });
    const days = (s.trialEndsAt!.getTime() - s.createdAt.getTime()) / 864e5;
    expect(Math.round(days)).toBe(30);
    expect(s.currentPeriodEnd!.getTime()).toBe(s.trialEndsAt!.getTime());

    await movePlan(t.id, 'ent');
    const s2 = await db.subscription.findUniqueOrThrow({
      where: { tenantId: t.id },
      include: { planVersion: true },
    });
    expect(s2.planVersion.planCode).toBe('ent');
    expect(s2.version).toBe(s.version + 1);

    const sb = await db.tenant.create({
      data: { name: 'sandbox', mode: 'test', liveTenantId: t.id, planCode: 'ent' },
    });
    expect(await db.subscription.findUnique({ where: { tenantId: sb.id } })).toBeNull();

    // guard 0177 (deferred): สร้าง tenant live โดยไม่สร้าง subscription ใน transaction เดียวกัน → ล้มตอน commit
    await expect(db.tenant.create({ data: { name: 'ไม่มี subscription' } })).rejects.toThrow(
      /tenant_subscription_required/,
    );
    await expect(db.subscription.delete({ where: { tenantId: t.id } })).rejects.toThrow(
      /tenant_subscription_required/,
    );
  });

  it('publish ราคาใหม่ = เกิด v2 · ลูกค้าเดิมยังอยู่ v1 (ราคา + สิทธิ์เดิม) · ลูกค้าใหม่ได้ v2 · audit พร้อมเหตุผล', async () => {
    const old = await createTenant(db, 'ลูกค้าเดิม');
    await movePlan(old.id, TP);
    expect(
      (await db.subscription.findUniqueOrThrow({ where: { tenantId: old.id } })).planVersionId,
    ).toBe(tpV1);

    const reason = 'ปรับราคาตามมติ PO รอบทดสอบ';
    const draft = await as('SUPER_ADMIN')
      .post(`/v1/platform/plans/${TP}/versions`)
      .send({
        pricePerVehicleMonthly: '320.00',
        volumeTiers: [{ fromVehicle: 51, discountPct: '10.00' }],
        entitlements: [{ featureKey: 'report', mode: 'not_available' }],
        reason,
      })
      .expect(201);
    expect(draft.body).toMatchObject({
      planCode: TP,
      version: 2,
      status: 'draft',
      pricePerVehicleMonthly: '320.00',
      minimumMonthly: '4500.00', // คัดจาก v1
      volumeTiers: [{ fromVehicle: 51, discountPct: '10.00' }],
      subscribers: 0,
    });
    // draft ยังไม่มีผลกับใคร · มีได้ทีละ 1
    await as('SUPER_ADMIN').post(`/v1/platform/plans/${TP}/versions`).send({ reason }).expect(409);
    // S1 (docs/01 §5.1): ETag = rowVersion · If-Match เก่า → 412 · ถูก → แก้ได้และ rowVersion + 1
    expect(draft.headers.etag).toBe('"1"');
    const got = await as('BILLING').get(`/v1/platform/plan-versions/${draft.body.id}`).expect(200);
    expect(got.headers.etag).toBe('"1"');
    const edited = await as('SUPER_ADMIN')
      .patch(`/v1/platform/plan-versions/${draft.body.id}`)
      .set('If-Match', '"1"')
      .send({ minimumMonthly: '5000.00', reason })
      .expect(200);
    expect(edited.body).toMatchObject({
      minimumMonthly: '5000.00',
      pricePerVehicleMonthly: '320.00',
      rowVersion: 2,
    });
    expect(edited.headers.etag).toBe('"2"');
    const stale = await as('SUPER_ADMIN')
      .patch(`/v1/platform/plan-versions/${draft.body.id}`)
      .set('If-Match', '"1"')
      .send({ minimumMonthly: '6000.00', reason })
      .expect(412);
    expect(stale.body.code).toBe('precondition_failed');
    await as('SUPER_ADMIN')
      .post(`/v1/platform/plan-versions/${draft.body.id}/publish`)
      .set('If-Match', '"1"')
      .send({ reason })
      .expect(412);

    const pub = await as('SUPER_ADMIN')
      .post(`/v1/platform/plan-versions/${draft.body.id}/publish`)
      .set('If-Match', '"2"')
      .send({ reason })
      .expect(200);
    expect(pub.body).toMatchObject({ status: 'published', version: 2 });

    // ลูกค้าเดิม: v1 · ราคา 280 · ยังมีรายงาน
    const s = await db.subscription.findUniqueOrThrow({
      where: { tenantId: old.id },
      include: { planVersion: true },
    });
    expect(s.planVersion).toMatchObject({ version: 1 });
    expect(s.planVersion.pricePerVehicleMonthly?.toFixed(2)).toBe('280.00');
    app.get(EntitlementService).invalidate(old.id);
    expect((await app.get(EntitlementService).resolve(old.id)).report?.enabled).toBe(true);

    // ลูกค้าใหม่ของแพ็กเกจนี้: v2 · ไม่มีรายงาน
    const fresh = await createTenant(db, 'ลูกค้าใหม่');
    await movePlan(fresh.id, TP);
    const s2 = await db.subscription.findUniqueOrThrow({
      where: { tenantId: fresh.id },
      include: { planVersion: true },
    });
    expect(s2.planVersion).toMatchObject({ version: 2 });
    expect((await app.get(EntitlementService).resolve(fresh.id)).report?.enabled).toBe(false);

    const plans = (await as('SUPER_ADMIN').get('/v1/platform/plans').expect(200)).body as {
      code: string;
      current: { version: number };
      draft: unknown;
      versions: { version: number; subscribers: number }[];
    }[];
    const tp = plans.find((p) => p.code === TP)!;
    expect(tp.current.version).toBe(2);
    expect(tp.draft).toBeNull();
    expect(tp.versions.map((v) => [v.version, v.subscribers])).toEqual([
      [2, 1],
      [1, 1],
    ]);

    const audit = await db.platformAuditLog.findMany({
      where: { entityId: draft.body.id },
      orderBy: { seq: 'asc' },
    });
    expect(audit.map((a) => a.action)).toEqual([
      'platform.plan_version_created',
      'platform.plan_version_updated',
      'platform.plan_version_published',
    ]);
    expect(audit.every((a) => a.reason === reason && a.platformUserId)).toBe(true);

    // N1: ร่างใหม่คัดจากเวอร์ชันล่าสุด (v2) · มีเวอร์ชันตั้งวันมีผลล่วงหน้าแล้ว → publish ก่อนวันนั้นไม่ได้
    const d3 = await as('SUPER_ADMIN')
      .post(`/v1/platform/plans/${TP}/versions`)
      .send({ reason })
      .expect(201);
    expect(d3.body).toMatchObject({
      version: 3,
      pricePerVehicleMonthly: '320.00',
      minimumMonthly: '5000.00',
    });
    const future = new Date(Date.now() + 30 * 864e5).toISOString();
    await as('SUPER_ADMIN')
      .post(`/v1/platform/plan-versions/${d3.body.id}/publish`)
      .send({ effectiveFrom: future, reason })
      .expect(200);
    // v3 ยังไม่ถึงวันมีผล → เวอร์ชันที่มีผลยังเป็น v2 · ลูกค้าใหม่ได้ v2
    const t4 = await createTenant(db, 'ลูกค้าระหว่างรอ v3');
    await movePlan(t4.id, TP);
    expect(
      (
        await db.subscription.findUniqueOrThrow({
          where: { tenantId: t4.id },
          include: { planVersion: true },
        })
      ).planVersion.version,
    ).toBe(2);
    const d4 = await as('SUPER_ADMIN')
      .post(`/v1/platform/plans/${TP}/versions`)
      .send({ reason })
      .expect(201);
    expect(d4.body.version).toBe(4);
    const early = await as('SUPER_ADMIN')
      .post(`/v1/platform/plan-versions/${d4.body.id}/publish`)
      .send({ reason })
      .expect(409);
    expect(early.body.errors[0].code).toBe('version_scheduled');
    await owner.planVersion.delete({
      where: {
        id: (await db.planVersion.findFirstOrThrow({ where: { planCode: TP, version: 4 } })).id,
      },
    });
  });

  it('S3 guard ฐานข้อมูล: INSERT เวอร์ชันที่ไม่ใช่ draft ไม่ได้ · publish ที่ขาดเซลล์ฟีเจอร์พื้นฐาน included ไม่ได้', async () => {
    await expect(
      db.planVersion.create({
        data: {
          planCode: TP,
          version: 90,
          status: 'published',
          publishedAt: new Date(),
          effectiveFrom: new Date(),
        },
      }),
    ).rejects.toThrow(/plan_version_immutable/);
    const v = await db.planVersion.create({
      data: { planCode: TP, version: 91, effectiveFrom: new Date(Date.now() + 365 * 864e5) },
    });
    // มีแค่ไม่กี่เซลล์ (ไม่มี settle/sub ฯลฯ) → publish ตรงในฐานไม่ผ่าน
    await db.planEntitlement.create({
      data: { planVersionId: v.id, featureKey: 'so', mode: 'included' },
    });
    await expect(
      db.planVersion.update({
        where: { id: v.id },
        data: { status: 'published', publishedAt: new Date() },
      }),
    ).rejects.toThrow(/basic_feature_locked/);
    await db.planVersion.delete({ where: { id: v.id } }); // draft ลบได้
  });

  it('PLT-061: ตั้งฟีเจอร์พื้นฐานเป็น addon / not_available → 422 basic_feature_locked (API + ฐานข้อมูล)', async () => {
    for (const mode of ['addon', 'not_available']) {
      const r = await as('SUPER_ADMIN')
        .post('/v1/platform/plans/std/versions')
        .send({ entitlements: [{ featureKey: 'settle', mode }], reason: 'ลองล็อกฟีเจอร์ปิดเดือน' })
        .expect(422);
      expect(r.body).toMatchObject({ code: 'basic_feature_locked', featureKeys: ['settle'] });
    }
    // ไม่เกิด draft ค้างบนแพ็กเกจจริง
    expect(await db.planVersion.count({ where: { planCode: 'std', status: 'draft' } })).toBe(0);

    const d = await as('SUPER_ADMIN')
      .post(`/v1/platform/plans/${TP}/versions`)
      .send({ reason: 'ร่างสำหรับทดสอบล็อก' })
      .expect(201);
    const r = await as('SUPER_ADMIN')
      .patch(`/v1/platform/plan-versions/${d.body.id}`)
      .send({ entitlements: [{ featureKey: 'sub', mode: 'addon' }], reason: 'ลองล็อกลิงก์รถร่วม' })
      .expect(422);
    expect(r.body.code).toBe('basic_feature_locked');
    // ชั้นฐานข้อมูล (กันเขียนตรงโดยไม่ผ่าน API)
    await expect(
      db.planEntitlement.update({
        where: {
          planVersionId_featureKey: {
            planVersionId: (
              await db.planVersion.findFirstOrThrow({ where: { planCode: TP, status: 'draft' } })
            ).id,
            featureKey: 'sub',
          },
        },
        data: { mode: 'addon' },
      }),
    ).rejects.toThrow(/basic_feature_locked/);
  });

  it('PLT-060: เวอร์ชันที่ publish แล้วแก้ไม่ได้ → 409 plan_version_immutable (API + ฐานข้อมูล) · ค่าผิดรูป → 422', async () => {
    const v1 = encodeId('planVersion', tpV1);
    const r = await as('SUPER_ADMIN')
      .patch(`/v1/platform/plan-versions/${v1}`)
      .send({ pricePerVehicleMonthly: '1.00', reason: 'พยายามแก้ราคาย้อนหลัง' })
      .expect(409);
    expect(r.body.code).toBe('plan_version_immutable');
    await as('SUPER_ADMIN')
      .post(`/v1/platform/plan-versions/${v1}/publish`)
      .send({ reason: 'publish ซ้ำเวอร์ชันเดิม' })
      .expect(409);
    await expect(
      db.planVersion.update({ where: { id: tpV1 }, data: { pricePerVehicleMonthly: '1.00' } }),
    ).rejects.toThrow(/plan_version_immutable/);
    await expect(
      db.planEntitlement.updateMany({ where: { planVersionId: tpV1 }, data: { limit: 1 } }),
    ).rejects.toThrow(/plan_version_immutable/);
    await expect(db.planVersion.delete({ where: { id: tpV1 } })).rejects.toThrow();

    const d = (await db.planVersion.findFirstOrThrow({ where: { planCode: TP, status: 'draft' } }))
      .id;
    const bad = await as('SUPER_ADMIN')
      .patch(`/v1/platform/plan-versions/${encodeId('planVersion', d)}`)
      .send({
        pricePerVehicleMonthly: '12.345',
        volumeTiers: [
          { fromVehicle: 100, discountPct: '20' },
          { fromVehicle: 50, discountPct: '10' },
        ],
        vehicleMin: 61,
        vehicleMax: 60,
        entitlements: [{ featureKey: 'nope', mode: 'included' }],
        reason: 'ค่าผิดรูปหลายช่อง',
      })
      .expect(422);
    expect(bad.body.code).toBe('validation_failed');
    // MONEY_RE ใน DTO ตัดตั้งแต่ชั้นแรก (ทศนิยม 3 ตำแหน่ง)
    const fields = (bad.body.errors as { field: string }[]).map((e) => e.field);
    expect(fields.some((f) => f.startsWith('pricePerVehicleMonthly'))).toBe(true);
    const bad2 = await as('SUPER_ADMIN')
      .patch(`/v1/platform/plan-versions/${encodeId('planVersion', d)}`)
      .send({
        volumeTiers: [
          { fromVehicle: 100, discountPct: '20' },
          { fromVehicle: 50, discountPct: '10' },
        ],
        vehicleMin: 61,
        vehicleMax: 60,
        entitlements: [{ featureKey: 'nope', mode: 'included' }],
        reason: 'ค่าผิดรูปหลายช่อง',
      })
      .expect(422);
    expect((bad2.body.errors as { code: string }[]).map((e) => e.code).sort()).toEqual([
      'tiers_order',
      'unknown_feature',
      'vehicle_range',
    ]);
    await as('SUPER_ADMIN')
      .post(`/v1/platform/plan-versions/${encodeId('planVersion', d)}/publish`)
      .send({ effectiveFrom: '2020-01-01T00:00:00Z', reason: 'วันมีผลย้อนหลังไม่ได้' })
      .expect(422);
  });

  it('สิทธิ์: ดูได้ทุกบทบาท · สร้าง/แก้/publish เฉพาะ owner · token ลูกค้าเรียกไม่ได้ · id ผิด → 404', async () => {
    const body = { reason: 'ลองสร้างโดยไม่มีสิทธิ์' };
    await as('SUPPORT').post(`/v1/platform/plans/${TP}/versions`).send(body).expect(403);
    await as('BILLING').post(`/v1/platform/plans/${TP}/versions`).send(body).expect(403);
    const v1 = encodeId('planVersion', tpV1);
    await as('BILLING').get(`/v1/platform/plan-versions/${v1}`).expect(200);
    await as('SUPPORT').post(`/v1/platform/plan-versions/${v1}/publish`).send(body).expect(403);
    const t = await createTenant(db);
    await api(app, await tokenFor(t.id, '*'))
      .get('/v1/platform/plans')
      .expect(401);
    await as('SUPER_ADMIN')
      .get(`/v1/platform/plan-versions/plv_${'0'.repeat(32)}`)
      .expect(404);
    await as('SUPER_ADMIN').get('/v1/platform/plan-versions/ten_abc').expect(404);
    await as('SUPER_ADMIN').post('/v1/platform/plans/nope/versions').send(body).expect(404);
  });
});
