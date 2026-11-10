import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth/password';
import { ensureSystemRoles } from '../src/auth/system-roles';
import { signStepUpToken } from '../src/auth/tokens';
import { api, bootApp, createTenant, loginFull, platform, tokenFor, truncateAll } from './helpers';

/** ST1-T17 ค่าตั้งองค์กร: แก้ใน API แล้วส่วนอื่นอ่านค่าใหม่; ค่าผิด type ถูกปฏิเสธ */
describe('settings registry', () => {
  let app: NestExpressApplication;
  const db = platform();
  let tenantId: string;
  let admin: string;
  let ip = 0;
  const PW = 'settings-test-password-2569';

  beforeAll(async () => {
    await truncateAll();
    app = await bootApp();
    tenantId = (await createTenant(db, 'บริษัท ตั้งค่า')).id;
    admin = await tokenFor(tenantId, 'settings:read settings:write');
  });
  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  const get = async () =>
    Object.fromEntries(
      (
        (await api(app, admin).get('/v1/settings').expect(200)).body.data as {
          key: string;
          value: unknown;
          version: number;
        }[]
      ).map((s) => [s.key, s]),
    );

  it('ไม่ตั้ง = ค่า default ตาม registry', async () => {
    const s = await get();
    expect(s['security.idleTimeoutMinutes']).toMatchObject({ value: 480, isDefault: true });
    expect(s['tax.invoiceModePolicy']).toMatchObject({ value: 'PER_CUSTOMER' });
    expect(s['org.name']).toMatchObject({ value: 'บริษัท ตั้งค่า' });
    expect(s['org.yearStyle']).toMatchObject({ value: 'BE' });
  });

  it('ค่าผิด type / key ไม่รู้จัก → 422 ทั้งก้อน (ไม่มีอะไรถูกบันทึก)', async () => {
    const res = await api(app, admin)
      .patch('/v1/settings')
      .send({
        values: { 'tax.wht1Enabled': false, 'security.idleTimeoutMinutes': 45, 'x.unknown': 1 },
      });
    expect(res.status).toBe(422);
    expect(res.body.errors.map((e: { field: string }) => e.field).sort()).toEqual([
      'values.security.idleTimeoutMinutes',
      'values.x.unknown',
    ]);
    expect((await get())['tax.wht1Enabled']!.value).toBe(true);
    const blank = await api(app, admin)
      .patch('/v1/settings')
      .send({ values: { 'org.name': '  ' } });
    expect(blank.status).toBe(422);
  });

  it('แก้แล้ว API อ่านค่าใหม่; key ที่เก็บในตาราง tenant (ชื่อ/รูปแบบปี) เปลี่ยนที่ /me ด้วย; ลง audit', async () => {
    await api(app, admin)
      .patch('/v1/settings')
      .send({
        values: { 'org.yearStyle': 'CE', 'org.name': 'บริษัท ใหม่', 'tax.wht3Enabled': false },
      })
      .expect(200);
    const s = await get();
    expect(s['tax.wht3Enabled']).toMatchObject({ value: false, isDefault: false, version: 1 });
    const me = await api(app, admin).get('/v1/me').expect(200);
    expect(me.body.tenant).toMatchObject({ yearStyle: 'CE', name: 'บริษัท ใหม่' });
    const audit = await db.auditLog.findMany({
      where: { tenantId, action: 'tenant_setting.updated' },
    });
    expect(audit.map((a) => a.entityId).sort()).toEqual([
      'org.name',
      'org.yearStyle',
      'tax.wht3Enabled',
    ]);
  });

  it('สิทธิ์: อ่านได้ด้วย settings:read แก้ไม่ได้', async () => {
    const ro = await tokenFor(tenantId, 'settings:read');
    expect((await api(app, ro).get('/v1/settings')).status).toBe(200);
    expect(
      (
        await api(app, ro)
          .patch('/v1/settings')
          .send({ values: { 'tax.wht1Enabled': false } })
      ).status,
    ).toBe(403);
  });

  it('บังคับ 2FA ทั้งองค์กร → role ที่ไม่บังคับก็ต้องตั้ง TOTP; idle timeout ใหม่มีผลกับ session ถัดไป', async () => {
    const roles = await ensureSystemRoles(db, tenantId);
    const u = await db.appUser.create({
      data: {
        tenantId,
        email: 'p@settings.test',
        name: 'ทดสอบ',
        status: 'ACTIVE',
        passwordHash: await hashPassword(PW),
      },
    });
    await db.userRole.create({ data: { tenantId, userId: u.id, roleId: roles.planner! } });
    await api(app, admin)
      .patch('/v1/settings')
      .send({ values: { 'security.require2faAll': true, 'security.idleTimeoutMinutes': 30 } })
      .expect(200);
    const r = await loginFull(app, 'p@settings.test', PW, `10.30.0.${++ip}`);
    expect(r.secret).toBeTruthy(); // ถูกพาไปตั้ง 2FA
    const rt = await db.refreshToken.findFirstOrThrow({
      where: { userId: u.id },
      orderBy: { createdAt: 'desc' },
    });
    const idleMin = (rt.idleExpiresAt.getTime() - rt.createdAt.getTime()) / 60000;
    expect(idleMin).toBeGreaterThan(29);
    expect(idleMin).toBeLessThan(31);
  });

  it('optimistic lock: version ไม่ตรง → 412 และไม่บันทึก', async () => {
    const v = (await get())['tax.separateVatDocs']!.version as number;
    await api(app, admin)
      .patch('/v1/settings')
      .send({ values: { 'tax.separateVatDocs': true }, versions: { 'tax.separateVatDocs': v } })
      .expect(200);
    const stale = await api(app, admin)
      .patch('/v1/settings')
      .send({ values: { 'tax.separateVatDocs': false }, versions: { 'tax.separateVatDocs': v } });
    expect(stale.status).toBe(412);
    expect((await get())['tax.separateVatDocs']!.value).toBe(true);
  });

  it('ลดความปลอดภัย (ปิดบังคับ 2FA / ปิดออกจากระบบอัตโนมัติ / ยืด timeout) ต้อง step-up', async () => {
    for (const values of [
      { 'security.require2faAll': false },
      { 'security.autoLogout': false },
      { 'security.idleTimeoutMinutes': 480 },
    ]) {
      const res = await api(app, admin).patch('/v1/settings').send({ values });
      expect(res.status, JSON.stringify(values)).toBe(403);
      expect(res.body.code).toBe('step_up_required');
    }
    // เพิ่มความปลอดภัยไม่ต้อง step-up
    await api(app, admin)
      .patch('/v1/settings')
      .send({ values: { 'security.idleTimeoutMinutes': 30 } })
      .expect(200);
    const su = await signStepUpToken('user-test', tenantId);
    await api(app, admin)
      .patch('/v1/settings')
      .set('X-Step-Up', su)
      .send({ values: { 'security.require2faAll': false, 'security.idleTimeoutMinutes': 480 } })
      .expect(200);
    // step-up ของ tenant อื่นใช้ไม่ได้
    const other = await signStepUpToken('user-test', (await createTenant(db)).id);
    await api(app, admin)
      .patch('/v1/settings')
      .send({ values: { 'security.require2faAll': true } })
      .expect(200);
    const res = await api(app, admin)
      .patch('/v1/settings')
      .set('X-Step-Up', other)
      .send({ values: { 'security.require2faAll': false } });
    expect(res.status).toBe(403);
  });

  it('แยก tenant: tenant อื่นตั้งค่าแล้วไม่กระทบ tenant นี้', async () => {
    const t2 = (await createTenant(db, 'บริษัท อื่น')).id;
    const other = await tokenFor(t2, 'settings:read settings:write');
    await api(app, other)
      .patch('/v1/settings')
      .send({ values: { 'tax.wht1Enabled': false, 'org.name': 'บริษัท อื่นแก้' } })
      .expect(200);
    const mine = await get();
    expect(mine['tax.wht1Enabled']!.value).toBe(true);
    expect(mine['org.name']!.value).toBe('บริษัท ใหม่');
    const rows = await db.tenantSetting.findMany({ where: { tenantId: t2 } });
    expect(rows.map((r) => r.key)).toEqual(['tax.wht1Enabled']);
  });

  it('role แอปแก้คอลัมน์สถานะของ tenant ไม่ได้ (แก้ได้แค่ชื่อ/รูปแบบปี)', async () => {
    const { PrismaService } = await import('../src/db/prisma.service');
    const ps = new PrismaService();
    await expect(
      ps.app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;
        await tx.$executeRaw`UPDATE tenant SET status = 'ACTIVE' WHERE id = ${tenantId}::uuid`;
      }),
    ).rejects.toThrow(/permission denied/);
    await ps.onModuleDestroy();
  });
});
