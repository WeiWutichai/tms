import { Controller, Get, Module } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { createApp } from '../src/bootstrap';
import { signPlatformToken } from '../src/auth/tokens';
import { ensureSystemRoles } from '../src/auth/system-roles';
import { Clock } from '../src/common/clock';
import { RequireFeature } from '../src/common/decorators';
import { encodeId } from '../src/common/ids';
import { OVERRIDE_AUDIT_TEXT } from '../src/platform/platform-tenants.controller';
import { JobQueue } from '../src/jobs/job-queue.service';
import {
  ENTITLEMENT_TTL_MS,
  EntitlementService,
} from '../src/modules/entitlements/entitlement.service';
import { api, createTenant, platform, tokenFor, truncateAll } from './helpers';

/** endpoint ชั่วคราวเฉพาะ test — gate ด้วย `api` (docs/02 §2: Open API เริ่มที่ Growth · รถร่วม/รายงานพื้นฐานมีใน Starter ตั้งแต่ P1-ST1-T01) */
@Controller('__test/api')
class GatedController {
  @Get()
  @RequireFeature('api')
  get() {
    return { ok: true };
  }
}
@Module({ imports: [AppModule], controllers: [GatedController] })
class TestModule {}

/** ST1-T18: ปิด flag แล้ว endpoint ที่ gate ได้ 403 และ cron ของ tenant นั้นข้าม */
describe('feature flag ตามแพ็กเกจ + override', () => {
  let app: NestExpressApplication;
  const db = platform();
  let ent: EntitlementService;

  beforeAll(async () => {
    await truncateAll();
    app = await createApp(TestModule);
    ent = app.get(EntitlementService);
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  async function tenant(planCode: string) {
    const t = await createTenant(db);
    await db.tenant.update({ where: { id: t.id }, data: { planCode } });
    return { id: t.id, token: await tokenFor(t.id) };
  }

  it('แพ็กเกจ Growth มี Open API (200); Starter ไม่มี (403 feature_not_in_plan); /me บอกฟีเจอร์', async () => {
    const std = await tenant('std');
    const start = await tenant('start');
    await api(app, std.token).get('/v1/__test/api').expect(200);
    const res = await api(app, start.token).get('/v1/__test/api');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'feature_not_in_plan', featureKey: 'api' });
    const me = await api(app, start.token).get('/v1/me').expect(200);
    expect(me.body.features).toContain('so');
    expect(me.body.features).not.toContain('api');
    // P1-ST1-T01 R-07: ลิงก์รถร่วม/settlement เป็นฟีเจอร์พื้นฐาน — Starter มีด้วย
    expect(me.body.features).toEqual(expect.arrayContaining(['sub', 'settle', 'report']));
    expect(me.body.plan).toEqual({ code: 'start', name: 'Starter' });
    expect(me.body.lockedIn.api).toBe('Growth');
    expect(me.body.lockedIn.multi).toBe('Business');
    expect(me.body.lockedIn.sub).toBeUndefined();
    expect(me.body.lockedIn.so).toBeUndefined();
  });

  it('tenant ถูกระงับ → ไม่มีฟีเจอร์ใดทำงาน (job ข้ามหมด); grant ฟีเจอร์โควตาโดยไม่ระบุ limit ไม่กลายเป็นไม่จำกัด', async () => {
    const t = await tenant('std');
    await db.tenant.update({ where: { id: t.id }, data: { status: 'SUSPENDED' } });
    ent.invalidate(t.id);
    expect(await ent.resolve(t.id)).toEqual({});
    const s = await tenant('start');
    await db.tenantEntitlementOverride.create({
      data: {
        tenantId: s.id,
        featureKey: 'webhook',
        mode: 'grant',
        reason: 'ทดลอง webhook ให้ลูกค้า',
      },
    });
    ent.invalidate(s.id);
    expect((await ent.resolve(s.id)).webhook).toEqual({ enabled: true, limit: 3 });
  });

  it('ฐานข้อมูลปฏิเสธข้อมูลแพ็กเกจที่ผิด: plan ไม่มีจริง, mode พิมพ์ผิด, เหตุผลสั้นเกิน', async () => {
    const t = await tenant('std');
    await expect(
      db.tenant.update({ where: { id: t.id }, data: { planCode: 'nope' } }),
    ).rejects.toThrow();
    await expect(
      db.tenantEntitlementOverride.create({
        data: { tenantId: t.id, featureKey: 'api', mode: 'grant ', reason: 'เหตุผลยาวพอสมควร' },
      }),
    ).rejects.toThrow();
    await expect(
      db.tenantEntitlementOverride.create({
        data: { tenantId: t.id, featureKey: 'api', mode: 'grant', reason: 'สั้น' },
      }),
    ).rejects.toThrow();
  });

  it('override: revoke ปิดของแพ็กเกจ, grant เปิดให้, หมดอายุแล้วไม่มีผล, set_limit เปลี่ยนโควตา', async () => {
    const std = await tenant('std');
    await db.tenantEntitlementOverride.create({
      data: {
        tenantId: std.id,
        featureKey: 'api',
        mode: 'revoke',
        reason: 'ค้างชำระ add-on รถร่วมเกินกำหนด',
      },
    });
    ent.invalidate(std.id);
    expect((await api(app, std.token).get('/v1/__test/api')).status).toBe(403);

    const start = await tenant('start');
    await db.tenantEntitlementOverride.create({
      data: {
        tenantId: start.id,
        featureKey: 'api',
        mode: 'grant',
        reason: 'ทดลองรถร่วม 14 วัน',
        expiresAt: new Date(Date.now() + 864e5),
      },
    });
    await db.tenantEntitlementOverride.create({
      data: {
        tenantId: start.id,
        featureKey: 'veh',
        mode: 'set_limit',
        limit: 35,
        reason: 'เพิ่มโควตารถช่วงทดลอง',
      },
    });
    ent.invalidate(start.id);
    await api(app, start.token).get('/v1/__test/api').expect(200);
    expect((await ent.resolve(start.id)).veh).toEqual({ enabled: true, limit: 35 });

    await db.tenantEntitlementOverride.updateMany({
      where: { tenantId: start.id, featureKey: 'api' },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    ent.invalidate(start.id);
    expect((await api(app, start.token).get('/v1/__test/api')).status).toBe(403);
  });

  it('งานเบื้องหลังที่ผูกฟีเจอร์: tenant ที่ปิดถูกข้าม (SKIPPED), tenant ที่เปิดรันตามปกติ; tenantsWith กรองให้ cron', async () => {
    const queue = app.get(JobQueue);
    let ran = 0;
    queue.register('test.api-sync', async () => void ran++, { feature: 'api' });
    const off = await tenant('start');
    const on = await tenant('std');
    const jOff = await db.job.create({ data: { tenantId: off.id, type: 'test.api-sync' } });
    const jOn = await db.job.create({ data: { tenantId: on.id, type: 'test.api-sync' } });
    while (await queue.runOnce());
    expect((await db.job.findUniqueOrThrow({ where: { id: jOff.id } })).status).toBe('SKIPPED');
    expect((await db.job.findUniqueOrThrow({ where: { id: jOn.id } })).status).toBe('SUCCEEDED');
    expect(ran).toBe(1);
    expect(await ent.tenantsWith('api', [off.id, on.id])).toEqual([on.id]);
  });

  it('role แอปแก้แพ็กเกจ/override ไม่ได้', async () => {
    const { PrismaService } = await import('../src/db/prisma.service');
    const ps = new PrismaService();
    const t = await tenant('start');
    await expect(
      ps.app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${t.id}, true)`;
        await tx.$executeRaw`UPDATE tenant SET plan_code = 'ent' WHERE id = ${t.id}::uuid`;
      }),
    ).rejects.toThrow(/permission denied/);
    await expect(
      ps.app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${t.id}, true)`;
        await tx.$executeRaw`INSERT INTO tenant_entitlement_override (id, tenant_id, feature_key, mode, reason) VALUES (gen_random_uuid(), ${t.id}::uuid, 'multi', 'grant', 'self grant')`;
      }),
    ).rejects.toThrow(/permission denied/);
    await ps.onModuleDestroy();
  });
});

/**
 * P1-ST1-T02: EntitlementService.resolve ฉบับเต็ม — เกณฑ์ตรวจรับ (plan/13):
 * override `revoke` แล้ว endpoint ของฟีเจอร์ได้ 403 ภายใน 60 วิ · ฟีเจอร์พื้นฐานไม่ขึ้น 🔒 ในทุกกรณี
 */
describe('entitlement ฉบับเต็ม + override จาก Console (P1-ST1-T02)', () => {
  let app: NestExpressApplication;
  const db = platform();
  let ent: EntitlementService;
  let clock: Clock;
  const staff: Record<string, string> = {};

  async function tenant(planCode: string) {
    const t = await createTenant(db);
    await db.tenant.update({ where: { id: t.id }, data: { planCode } });
    return { id: t.id, enc: encodeId('tenant', t.id), token: await tokenFor(t.id) };
  }
  async function mkStaff(role: 'SUPER_ADMIN' | 'SUPPORT') {
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
  const as = (role: string) => api(app, staff[role]!);
  const REASON = 'ลูกค้าค้างชำระ add-on ตามสัญญา';

  beforeAll(async () => {
    await truncateAll();
    app = await createApp(TestModule);
    ent = app.get(EntitlementService);
    clock = app.get(Clock);
    await Promise.all([mkStaff('SUPER_ADMIN'), mkStaff('SUPPORT')]);
  });
  afterEach(() => clock.set(null));
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  it('เกณฑ์ตรวจรับ: Console revoke → 403 ทันทีใน instance นี้; instance อื่น (แก้ตรงในฐาน) → 403 ภายใน 60 วิ', async () => {
    const t = await tenant('std');
    await api(app, t.token).get('/v1/__test/api').expect(200);
    // ทาง Console: ล้าง cache ของ instance นี้ทันที
    const r = await as('SUPER_ADMIN')
      .put(`/v1/platform/tenants/${t.enc}/entitlement-overrides/api`)
      .send({ mode: 'revoke', reason: REASON })
      .expect(200);
    expect(r.body).toMatchObject({
      featureKey: 'api',
      mode: 'revoke',
      limit: null,
      expired: false,
    });
    const res = await api(app, t.token).get('/v1/__test/api');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'feature_not_in_plan', featureKey: 'api' });

    // อีก instance (worker / API ตัวอื่น) เปลี่ยนสิทธิ์ — cache ของ instance นี้ไม่ถูกล้าง
    const u = await tenant('std');
    const t0 = new Date();
    clock.set(t0);
    await api(app, u.token).get('/v1/__test/api').expect(200); // เติม cache
    await db.tenantEntitlementOverride.create({
      data: { tenantId: u.id, featureKey: 'api', mode: 'revoke', reason: REASON },
    });
    clock.set(new Date(t0.getTime() + ENTITLEMENT_TTL_MS - 1000));
    await api(app, u.token).get('/v1/__test/api').expect(200); // ยังอยู่ในรอบ cache
    clock.set(new Date(t0.getTime() + ENTITLEMENT_TTL_MS));
    expect((await api(app, u.token).get('/v1/__test/api')).status).toBe(403);

    // ลบ override → กลับตามแพ็กเกจ + audit ทั้งสองครั้ง
    clock.set(null);
    await as('SUPER_ADMIN')
      .post(`/v1/platform/tenants/${t.enc}/entitlement-overrides/api/remove`)
      .send({ reason: 'ลูกค้าชำระ add-on แล้ว' })
      .expect(204);
    await api(app, t.token).get('/v1/__test/api').expect(200);
    const audit = await db.auditLog.findMany({
      where: { tenantId: t.id, action: { startsWith: 'platform.entitlement_override' } },
      orderBy: { at: 'asc' },
    });
    expect(audit.map((a) => a.action)).toEqual([
      'platform.entitlement_override_set',
      'platform.entitlement_override_removed',
    ]);
    // PLT-066: เหตุผลภายในไม่อยู่ใน audit ของ tenant (ลูกค้าเห็น) — อยู่ใน platform_audit_log
    for (const a of audit) {
      expect(a.reason).toBe(OVERRIDE_AUDIT_TEXT);
      expect(JSON.stringify([a.before, a.after])).not.toContain(REASON);
    }
    expect(audit[1]!.before).toMatchObject({ featureKey: 'api', mode: 'revoke' });
    const pa = await db.platformAuditLog.findMany({
      where: {
        entityType: 'tenant',
        entityId: t.id,
        action: { startsWith: 'platform.entitlement_override' },
      },
      orderBy: { seq: 'asc' },
    });
    expect(pa.map((a) => [a.action, a.reason])).toEqual([
      ['platform.entitlement_override_set', REASON],
      ['platform.entitlement_override_removed', 'ลูกค้าชำระ add-on แล้ว'],
    ]);
  });

  it('grant ที่หมดอายุ: cache หมดตรงเวลาหมดอายุ (ไม่ค้างถึง 60 วิ)', async () => {
    const t = await tenant('start');
    const t0 = new Date();
    clock.set(t0);
    await as('SUPER_ADMIN')
      .put(`/v1/platform/tenants/${t.enc}/entitlement-overrides/api`)
      .send({
        mode: 'grant',
        reason: 'ทดลอง Open API 10 วินาที',
        expiresAt: new Date(t0.getTime() + 10_000).toISOString(),
      })
      .expect(200);
    await api(app, t.token).get('/v1/__test/api').expect(200);
    clock.set(new Date(t0.getTime() + 10_001));
    expect((await api(app, t.token).get('/v1/__test/api')).status).toBe(403);
    const list = await as('SUPPORT')
      .get(`/v1/platform/tenants/${t.enc}/entitlement-overrides`)
      .expect(200);
    expect(list.body).toEqual([
      expect.objectContaining({ featureKey: 'api', mode: 'grant', expired: true }),
    ]);
  });

  it('ตั้ง override: owner เท่านั้น · ฟีเจอร์พื้นฐาน 422 basic_feature_locked · ค่าผิด 422', async () => {
    const t = await tenant('std');
    const put = (role: string, key: string, body: object) =>
      as(role).put(`/v1/platform/tenants/${t.enc}/entitlement-overrides/${key}`).send(body);
    expect((await put('SUPPORT', 'api', { mode: 'revoke', reason: REASON })).status).toBe(403);
    const basic = await put('SUPER_ADMIN', 'settle', { mode: 'revoke', reason: REASON });
    expect(basic.status).toBe(422);
    expect(basic.body).toMatchObject({ code: 'basic_feature_locked', featureKey: 'settle' });
    expect((await put('SUPER_ADMIN', 'nope', { mode: 'grant', reason: REASON })).status).toBe(422);
    expect((await put('SUPER_ADMIN', 'api', { mode: 'revoke', reason: 'สั้น' })).status).toBe(422);
    expect((await put('SUPER_ADMIN', 'veh', { mode: 'set_limit', reason: REASON })).status).toBe(
      422,
    );
    // ฟีเจอร์เปิด/ปิด (boolean) ส่ง limit ไม่ได้
    expect(
      (await put('SUPER_ADMIN', 'report', { mode: 'grant', limit: 3, reason: REASON })).status,
    ).toBe(422);
    expect(
      (await put('SUPER_ADMIN', 'report', { mode: 'set_limit', limit: 3, reason: REASON })).status,
    ).toBe(422);
    const past = await put('SUPER_ADMIN', 'api', {
      mode: 'grant',
      reason: REASON,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(past.status).toBe(422);
    await put('SUPER_ADMIN', 'veh', { mode: 'set_limit', limit: 35, reason: REASON }).expect(200);
    expect((await ent.resolve(t.id)).veh).toEqual({ enabled: true, limit: 35 });
    // ลบแถวที่ไม่มี = 404
    expect(
      (
        await as('SUPER_ADMIN')
          .post(`/v1/platform/tenants/${t.enc}/entitlement-overrides/api/remove`)
          .send({ reason: REASON })
      ).status,
    ).toBe(404);
  });

  it('เกณฑ์ตรวจรับ: ฟีเจอร์พื้นฐานไม่ขึ้น 🔒 ทุกกรณี (แพ็กเกจต่ำสุด / ระงับ) · locks บอกแพ็กเกจ ราคา และ add-on', async () => {
    const basic = (await db.feature.findMany({ where: { isBasic: true } })).map((f) => f.key);
    expect(basic).toEqual(expect.arrayContaining(['so', 'sub', 'settle', 'bill']));
    const s = await tenant('start');
    const me = (await api(app, s.token).get('/v1/me').expect(200)).body;
    for (const k of basic) expect(me.locks[k], k).toBeUndefined();
    const growth = await db.planVersion.findFirstOrThrow({
      where: { planCode: 'std', status: 'published' },
      orderBy: { version: 'desc' },
    });
    expect(me.locks.api).toEqual({
      planCode: 'std',
      planName: 'Growth',
      pricePerVehicleMonthly: growth.pricePerVehicleMonthly?.toFixed(2) ?? null,
      addon: expect.any(Boolean),
      reason: 'not_in_plan',
    });
    expect(me.lockedIn.api).toBe('Growth');

    // ระงับ: ไม่มีฟีเจอร์ใดทำงาน แต่เมนูไม่ขึ้น 🔒 ทั้งพื้นฐานและฟีเจอร์ที่แพ็กเกจมี (สถานะ ≠ ไม่รวมในแพ็กเกจ)
    const g = await tenant('std');
    await db.tenant.update({ where: { id: g.id }, data: { status: 'SUSPENDED' } });
    ent.invalidate(g.id);
    const detail = await ent.detail(g.id);
    expect(detail.effective).toEqual({});
    expect(detail.beforeStatus.api?.enabled).toBe(true);
    const meS = (await api(app, g.token).get('/v1/me').expect(200)).body;
    expect(meS.features).toEqual([]);
    for (const k of [...basic, 'api', 'report']) expect(meS.locks[k], k).toBeUndefined();

    // override revoke ฟีเจอร์ที่ไม่ใช่พื้นฐาน → 🔒 (ไม่รวมในแพ็กเกจ)
    const r = await tenant('std');
    await db.tenantEntitlementOverride.create({
      data: { tenantId: r.id, featureKey: 'report', mode: 'revoke', reason: REASON },
    });
    ent.invalidate(r.id);
    // แพ็กเกจรวมอยู่แต่ถูก revoke → reason revoked ไม่ชี้ไปแพ็กเกจอื่น (ไม่แนะนำ "อัปเกรด" ที่เป็นดาวน์เกรด — review M1)
    const meR = (await api(app, r.token).get('/v1/me').expect(200)).body;
    expect(meR.locks.report).toEqual({
      planCode: null,
      planName: null,
      pricePerVehicleMonthly: null,
      addon: false,
      reason: 'revoked',
    });
    expect(meR.lockedIn.report).toBeUndefined();
    expect(me.locks.api.reason).toBe('not_in_plan');
  });

  it('แจ้งผู้ดูแลระบบ: แจ้งผู้มีสิทธิ์จัดการแพ็กเกจ (ไม่รวมผู้ขอ) · ซ้ำใน 24 ชม. ไม่ส่ง · ฟีเจอร์ที่ไม่ล็อก 422', async () => {
    const t = await tenant('start');
    const roles = await ensureSystemRoles(db, t.id);
    const mk = async (role: string, email: string) => {
      const u = await db.appUser.create({
        data: { tenantId: t.id, email, name: email, status: 'ACTIVE', locale: 'th' },
      });
      await db.userRole.create({ data: { tenantId: t.id, userId: u.id, roleId: roles[role]! } });
      return u.id;
    };
    const admin = await mk('admin', `adm-${randomUUID().slice(0, 6)}@ent.test`);
    const planner = await mk('planner', `pl-${randomUUID().slice(0, 6)}@ent.test`);
    const asPlanner = api(app, await tokenFor(t.id, '*', planner));
    const first = await asPlanner
      .post('/v1/me/feature-requests')
      .send({ featureKey: 'api' })
      .expect(200);
    expect(first.body).toEqual({ notified: expect.any(Number), alreadyRequested: false });
    expect(first.body.notified).toBeGreaterThanOrEqual(1);
    const rows = await db.notification.findMany({
      where: { tenantId: t.id, templateCode: 'feature.upgrade_requested', channel: 'in_app' },
    });
    expect(rows.map((n) => n.recipientId)).toContain(admin);
    expect(rows.map((n) => n.recipientId)).not.toContain(planner);
    expect(rows[0]!.body).toContain('ไม่รวมในแพ็กเกจปัจจุบัน');
    const again = await asPlanner
      .post('/v1/me/feature-requests')
      .send({ featureKey: 'api' })
      .expect(200);
    expect(again.body).toEqual({ notified: 0, alreadyRequested: true });
    expect(
      (await asPlanner.post('/v1/me/feature-requests').send({ featureKey: 'so' })).status,
    ).toBe(422);
    // API key / token ที่ไม่ใช่ผู้ใช้ → 403
    expect(
      (await api(app, t.token).post('/v1/me/feature-requests').send({ featureKey: 'api' })).status,
    ).toBe(403);
  });

  it('connector ที่ประกาศ conn + Growth: Starter 403 · Growth ผ่าน · Starter ที่ได้ grant ผ่าน (R-09)', async () => {
    const req = { feature: 'conn', minTier: 'growth' as const };
    const s = await tenant('start');
    const err = await ent.assertConnector(s.id, req).catch((e) => e);
    expect(err).toMatchObject({
      code: 'feature_not_in_plan',
      extra: { featureKey: 'conn', minTier: 'growth' },
    });
    const g = await tenant('std');
    await expect(ent.assertConnector(g.id, req)).resolves.toBeUndefined();
    await db.tenantEntitlementOverride.create({
      data: { tenantId: s.id, featureKey: 'conn', mode: 'grant', limit: 1, reason: REASON },
    });
    ent.invalidate(s.id);
    await expect(ent.assertConnector(s.id, req)).resolves.toBeUndefined();
  });
});
