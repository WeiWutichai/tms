import { Controller, Get, Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { createApp } from '../src/bootstrap';
import { RequireFeature } from '../src/common/decorators';
import { JobQueue } from '../src/jobs/job-queue.service';
import { EntitlementService } from '../src/modules/entitlements/entitlement.service';
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
